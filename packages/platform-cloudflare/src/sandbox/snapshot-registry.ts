/**
 * Deletes container snapshots from Cloudflare's registry. A Worker can't
 * delete one through ctx.container, so this goes through the registry with
 * an account API token, as `wrangler containers images delete` does:
 * short-lived registry credentials from the Cloudflare API, then registry
 * calls, then a request to garbage-collect the layers nothing references.
 *
 * What the registry does (verified live, 2026-10-02):
 *   - A snapshot is a manifest on the application's image with two tags:
 *     `rootfs-snapshot-<sha256 hex of its snapshot id>` and
 *     `rootfs-set-<sha256 hex of its snapshot_set_id>`. The set id is in the
 *     manifest's config blob (with snapshot_id, parent_snapshot_id,
 *     send_mode, ...).
 *   - DELETE on a tag works (eventually: HEAD 404s after about 10 s) and
 *     removes that tag only. DELETE by digest answers 204 and does nothing,
 *     so both tags are deleted by tag, then the layers are collected.
 *   - Snapshots are deltas (send_mode "delta"): each needs its parent. So a
 *     sandbox's snapshots are deleted together (erasure), never one by one.
 *
 * Opt-in: without a token, snapshots are left to expire (30 days unused).
 */

/** Where and how to delete snapshots (from the Worker's secrets). */
export interface SnapshotDeletionOptions {
  /** Cloudflare account id. */
  accountId: string;
  /** Account API token allowed to manage Containers (registry push). */
  apiToken: string;
}

export interface SnapshotRegistryOptions extends SnapshotDeletionOptions {
  /** Registry host. Default "registry.cloudflare.com". */
  registry?: string;
  /** Cloudflare API base. Default "https://api.cloudflare.com/client/v4". */
  apiBase?: string;
  /** Give up on each registry or API call after this long. Default 15 s. */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

/** The registry tag of a snapshot id: `rootfs-snapshot-` and the SHA-256 (hex) of the id. */
export async function snapshotTag(id: string): Promise<string> {
  if (id.startsWith("rootfs-snapshot-")) return id;
  return `rootfs-snapshot-${await sha256Hex(id)}`;
}

const MANIFEST_ACCEPT = "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The registry tag of a snapshot set id: `rootfs-set-` and the SHA-256 (hex) of the id. */
export async function snapshotSetTag(setId: string): Promise<string> {
  return `rootfs-set-${await sha256Hex(setId)}`;
}

/**
 * The repository of a container image reference, e.g.
 * "registry.cloudflare.com/<account>/<repo>:<tag>" -> "<repo>"; undefined
 * when the reference doesn't name one.
 */
export function imageRepository(imageRef: string, accountId: string): string | undefined {
  const withoutDigest = imageRef.split("@")[0];
  const path = withoutDigest.replace(/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?\//i, "");
  const withoutTag = path.replace(/:[^/]*$/, "");
  const repo = withoutTag.startsWith(`${accountId}/`) ? withoutTag.slice(accountId.length + 1) : withoutTag;
  return repo && !repo.includes(" ") ? repo : undefined;
}

export class SnapshotRegistry {
  private readonly registry: string;
  private readonly apiBase: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: SnapshotRegistryOptions) {
    this.registry = options.registry ?? "registry.cloudflare.com";
    this.apiBase = options.apiBase ?? "https://api.cloudflare.com/client/v4";
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * Delete the snapshots `ids` of the image repository `repository`.
   * Returns how many were deleted; one already gone (expired) counts as
   * missing, not as an error. The layer garbage collection after it is best
   * effort: if it fails, `warning` says so (the registry collects later).
   */
  async delete(repository: string, ids: string[]): Promise<{ deleted: number; missing: number; warning?: string }> {
    if (ids.length === 0) return { deleted: 0, missing: 0 };
    const auth = await this.credentials();
    let deleted = 0;
    let missing = 0;
    const warnings: string[] = [];
    for (const id of ids) {
      const tag = await snapshotTag(id);
      // The set tag is named from the set id in the snapshot's config.
      const setId = await this.snapshotSetId(repository, tag, auth);
      if (setId === null) {
        missing++;
        continue;
      }
      const setTag = setId ? await snapshotSetTag(setId) : undefined;
      if (!setTag) warnings.push(`${tag}: no snapshot_set_id in its config, so its rootfs-set tag remains`);
      for (const reference of setTag ? [tag, setTag] : [tag]) {
        const response = await this.manifest(repository, reference, "DELETE", auth);
        if (!response.ok && response.status !== 404) {
          throw new Error(`snapshot registry: deleting ${reference} failed: HTTP ${response.status}`);
        }
      }
      deleted++;
    }
    if (deleted === 0) return { deleted, missing, ...(warnings.length ? { warning: warnings.join("; ") } : {}) };
    // As wrangler does after deleting an image: free the deleted tags' layers.
    try {
      const gc = await this.fetcher(`https://${this.registry}/v2/gc/layers`, {
        method: "PUT",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      });
      await gc.body?.cancel();
      if (!gc.ok) warnings.push(`layer garbage collection failed: HTTP ${gc.status}`);
    } catch (err) {
      warnings.push(`layer garbage collection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { deleted, missing, ...(warnings.length ? { warning: warnings.join("; ") } : {}) };
  }

  /**
   * The snapshot_set_id in the config of the snapshot tagged `tag`: null when
   * the tag is gone (expired, or deleted before), "" when the config has none.
   */
  private async snapshotSetId(repository: string, tag: string, auth: string): Promise<string | null> {
    const base = `https://${this.registry}/v2/${this.options.accountId}/${repository}`;
    const manifest = await this.get(`${base}/manifests/${tag}`, auth, MANIFEST_ACCEPT);
    if (manifest.status === 404) return null;
    if (!manifest.ok) throw new Error(`snapshot registry: reading ${tag} failed: HTTP ${manifest.status}`);
    const configDigest = ((await manifest.json()) as { config?: { digest?: string } }).config?.digest;
    if (!configDigest) return "";
    const config = await this.get(`${base}/blobs/${configDigest}`, auth, "application/json");
    if (!config.ok) throw new Error(`snapshot registry: reading the config of ${tag} failed: HTTP ${config.status}`);
    const setId = ((await config.json()) as { snapshot_set_id?: unknown }).snapshot_set_id;
    return typeof setId === "string" ? setId : "";
  }

  private get(url: string, auth: string, accept: string): Promise<Response> {
    return this.fetcher(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { authorization: `Basic ${auth}`, accept } });
  }

  /** DELETE one manifest by tag; the body is discarded. */
  private async manifest(repository: string, reference: string, method: "DELETE", auth: string): Promise<Response> {
    const url = `https://${this.registry}/v2/${this.options.accountId}/${repository}/manifests/${reference}`;
    const response = await this.fetcher(url, {
      method,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { authorization: `Basic ${auth}`, accept: MANIFEST_ACCEPT },
    });
    await response.body?.cancel();
    return response;
  }

  /** Basic credentials for the registry, valid for a few minutes. */
  private async credentials(): Promise<string> {
    const url = `${this.apiBase}/accounts/${this.options.accountId}/containers/registries/${this.registry}/credentials`;
    const response = await this.fetcher(url, {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { authorization: `Bearer ${this.options.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ expiration_minutes: 5, permissions: ["pull", "push"] }),
    });
    const body = (await response.json().catch(() => ({}))) as { result?: { password?: string }; password?: string };
    const password = body.result?.password ?? body.password;
    if (!response.ok || !password) {
      throw new Error(`snapshot registry: no registry credentials (HTTP ${response.status}); check the API token`);
    }
    return btoa(`v1:${password}`);
  }
}

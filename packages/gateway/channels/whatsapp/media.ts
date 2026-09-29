/**
 * AgentForEach Channels — WhatsApp Media
 *
 * Inbound download is two steps, and BOTH need the bearer token:
 *
 *   GET /{version}/{media_id}            -> { url, mime_type, file_size }
 *   GET <url>  (Authorization: Bearer)   -> bytes
 *
 * The second URL is not publicly fetchable; a plain download without the
 * header returns 401. This differs from Telegram, where the token is embedded
 * in the file URL, and is the single easiest thing to get wrong here.
 *
 * Files are fetched into memory as base64 — no disk I/O, because the gateway
 * runs on Azure Functions. That is also why the size gate matters: a 100 MB
 * document (Meta's document ceiling) becomes roughly 133 MB of base64 inside a
 * function heap, so the plugin caps well below the platform limits.
 *
 * @see channels/telegram/media.ts — same shape, simpler auth
 */

import { createHash } from "node:crypto";
import { loadWhatsAppConfig, graphUrl, phoneNumberUrl } from "./config.js";
import { resolveTtlStore, type TtlStore } from "./kv-store.js";
import type {
  WhatsAppMediaMetadata,
  WhatsAppMediaUploadResponse,
} from "./types.js";

const METADATA_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 60_000;

/** Platform ceilings, for reference and for refusing obvious nonsense early. */
export const PLATFORM_MEDIA_LIMITS = {
  image: 5 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
  sticker: 512 * 1024,
} as const;

/** MIME types we accept for vision. */
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export function isSupportedImageType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

export interface DownloadedMedia {
  base64: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Download an inbound media object by id.
 *
 * Returns undefined on any failure — a message whose attachment could not be
 * fetched still reaches the agent as text, which is better than dropping the
 * turn entirely.
 */
export async function downloadWhatsAppMedia(
  mediaId: string,
): Promise<DownloadedMedia | undefined> {
  const cfg = loadWhatsAppConfig();
  if (!cfg.accessToken) return undefined;

  try {
    // Step 1 — metadata (gives us the short-lived, authorised download URL).
    const metaRes = await fetch(
      `${graphUrl(cfg)}/${encodeURIComponent(mediaId)}`,
      {
        headers: { Authorization: `Bearer ${cfg.accessToken}` },
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      },
    );

    if (!metaRes.ok) return undefined;

    const meta = (await metaRes.json()) as WhatsAppMediaMetadata;
    if (!meta.url) return undefined;

    const declaredSize = meta.file_size ?? 0;
    if (declaredSize > cfg.maxInboundMediaBytes) {
      console.warn(
        `[whatsapp] media ${mediaId} is ${declaredSize} bytes, over the ` +
          `${cfg.maxInboundMediaBytes} byte cap — skipped`,
      );
      return undefined;
    }

    // Step 2 — the bytes. The bearer token is required here too.
    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });

    if (!fileRes.ok) return undefined;

    const buffer = Buffer.from(await fileRes.arrayBuffer());

    // Meta's declared size can be absent; re-check against what actually
    // arrived before it becomes a base64 string a third larger again.
    if (buffer.byteLength > cfg.maxInboundMediaBytes) {
      console.warn(
        `[whatsapp] media ${mediaId} downloaded at ${buffer.byteLength} bytes, ` +
          `over the ${cfg.maxInboundMediaBytes} byte cap — discarded`,
      );
      return undefined;
    }

    return {
      base64: buffer.toString("base64"),
      mimeType: meta.mime_type ?? "application/octet-stream",
      sizeBytes: buffer.byteLength,
    };
  } catch (err) {
    console.error(
      `[whatsapp] media download failed for ${mediaId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/**
 * Upload bytes and return a reusable `media_id`.
 *
 * Prefer this over sending a `link`. A link makes Meta fetch the URL through
 * a shared forward proxy that is rate-limited by ASN, which produces
 * intermittent 131053 / HTTP 429 failures depending on what other tenants
 * sharing the egress address are doing — a class of bug that is close to
 * undiagnosable from our side. Uploading bypasses that path entirely.
 *
 * Uploaded media is retained for 30 days, so an id is worth caching for
 * anything sent repeatedly.
 */
export async function uploadWhatsAppMedia(
  base64: string,
  mimeType: string,
  filename = "upload",
): Promise<string | undefined> {
  const cfg = loadWhatsAppConfig();
  if (!cfg.accessToken || !cfg.phoneNumberId) return undefined;

  try {
    const bytes = Buffer.from(base64, "base64");

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([bytes], { type: mimeType }), filename);

    const res = await fetch(`${phoneNumberUrl(cfg)}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(
        `[whatsapp] media upload failed: ${res.status} ${res.statusText}`,
      );
      return undefined;
    }

    const body = (await res.json()) as WhatsAppMediaUploadResponse;
    return body.id;
  } catch (err) {
    console.error(
      `[whatsapp] media upload threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/**
 * Whether this deployment wants a given inbound media kind at all.
 *
 * Defaults to images only, matching Telegram's behaviour of passing
 * vision-capable media through and skipping the rest.
 */
export function acceptsMediaKind(
  kind: "image" | "document" | "audio" | "video",
): boolean {
  return loadWhatsAppConfig().acceptInboundMedia.includes(kind);
}

// ============================================================================
// Media id cache
// ============================================================================

/**
 * Kept comfortably inside Meta's 30-day retention.
 *
 * The gap is deliberate: an id that expires while cached fails with 131052,
 * and although that is recovered from (see resolveMediaId's callers), a cache
 * that routinely hands out dead handles turns a cheap send into two round
 * trips plus a re-upload.
 */
const MEDIA_ID_TTL_SECONDS = 25 * 24 * 60 * 60;

let _cache: TtlStore | undefined;
let _cachePromise: Promise<TtlStore> | undefined;

async function cache(): Promise<TtlStore> {
  if (_cache) return _cache;
  if (!_cachePromise) {
    const backend = loadWhatsAppConfig().mediaCacheStore;
    _cachePromise = resolveTtlStore("whatsapp-media", backend).then((s) => {
      _cache = s;
      return s;
    });
  }
  return _cachePromise;
}

/**
 * Cache key: the content itself, not a filename.
 *
 * Two sends of the same bytes under different names are the same upload, and
 * the same name with different bytes is not — so the hash is the only honest
 * key. The mime type joins it because it is part of what was uploaded.
 */
export function mediaCacheKey(base64: string, mimeType: string): string {
  const digest = createHash("sha256").update(base64).digest("hex");
  return `${digest}:${mimeType}`;
}

/** A media handle, and whether it came from the cache. */
export interface ResolvedMediaId {
  id: string;
  cached: boolean;
}

/**
 * Get a reusable media handle for these bytes, uploading only if needed.
 *
 * The `cached` flag lets the caller tell a first-attempt failure (a genuine
 * problem) from a stale-handle failure (recoverable by re-uploading), which is
 * the whole reason to distinguish them.
 */
export async function resolveMediaId(
  base64: string,
  mimeType: string,
  filename = "upload",
): Promise<ResolvedMediaId | undefined> {
  const key = mediaCacheKey(base64, mimeType);

  const store = await cache();
  const hit = await store.get(key);
  if (hit) return { id: hit, cached: true };

  const id = await uploadWhatsAppMedia(base64, mimeType, filename);
  if (!id) return undefined;

  await store.set(key, id, MEDIA_ID_TTL_SECONDS);
  return { id, cached: false };
}

/**
 * Forget a media handle that the API has rejected.
 *
 * Called when a cached id turns out to be past retention; the next send
 * re-uploads instead of replaying a handle that will never work again.
 */
export async function invalidateMediaId(
  base64: string,
  mimeType: string,
): Promise<void> {
  const store = await cache();
  await store.delete(mediaCacheKey(base64, mimeType));
}

/** Test helper — forget the resolved cache. */
export function resetMediaIdCache(): void {
  _cache = undefined;
  _cachePromise = undefined;
}

/** Test helper — inject a cache directly. */
export function setMediaIdCache(store: TtlStore): void {
  _cache = store;
  _cachePromise = Promise.resolve(store);
}

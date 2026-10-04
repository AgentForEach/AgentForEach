import test from "node:test";
import assert from "node:assert/strict";

import { SnapshotRegistry, imageRepository, snapshotSetTag, snapshotTag } from "./snapshot-registry.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/**
 * A fake Cloudflare registry that behaves as the live one did (2026-10-02):
 * a snapshot is a manifest with two tags (rootfs-snapshot-<sha(id)> and
 * rootfs-set-<sha(set id)>) and a config blob naming its set and parent;
 * DELETE on a tag removes that tag only; DELETE by digest answers 204 and
 * does nothing.
 */
function fakeRegistry(options: { gc?: number; statuses?: Record<string, number> } = {}) {
  const tags = new Map<string, string>(); // tag -> manifest digest
  const configs = new Map<string, Record<string, unknown>>(); // manifest digest -> config
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, headers: init?.headers as Record<string, string>, body: init?.body as string });
    if (url.endsWith("/credentials")) {
      return new Response(JSON.stringify({ success: true, result: { password: "reg-pass" } }), { status: 200 });
    }
    if (url.endsWith("/v2/gc/layers")) return new Response(JSON.stringify({ deleted: [] }), { status: options.gc ?? 200 });
    const [, kind, reference] = /\/(manifests|blobs)\/(.+)$/.exec(url) ?? [];
    const forced = options.statuses?.[`${method} ${reference}`];
    if (forced) return new Response(null, { status: forced });
    if (kind === "blobs") {
      const digest = reference.replace("config-of-", "");
      return configs.has(digest) ? Response.json(configs.get(digest)) : new Response(null, { status: 404 });
    }
    if (reference.startsWith("sha256:")) return new Response(null, { status: method === "DELETE" ? 204 : 200 }); // a no-op
    const digest = tags.get(reference);
    if (!digest) return new Response(null, { status: 404 });
    if (method === "DELETE") {
      tags.delete(reference);
      return new Response(null, { status: 204 });
    }
    return Response.json({ schemaVersion: 2, config: { digest: `config-of-${digest}` }, layers: [] });
  }) as typeof fetch;
  return { tags, configs, calls, fetcher };
}

/** A snapshot as Cloudflare stores it: one manifest, two tags, a config naming its set and parent. */
async function addSnapshot(registry: ReturnType<typeof fakeRegistry>, id: string, setId: string, parent?: string) {
  const digest = `sha256:${id}`;
  registry.tags.set(await snapshotTag(id), digest);
  registry.tags.set(await snapshotSetTag(setId), digest);
  registry.configs.set(digest, { snapshot_id: id, snapshot_set_id: setId, parent_snapshot_id: parent ?? null, send_mode: parent ? "delta" : "full" });
}

test("a snapshot's tag is rootfs-snapshot- and the SHA-256 of its id (seen live)", async () => {
  // From the live check on 2026-10-02: this snapshot id appeared as this tag.
  assert.equal(
    await snapshotTag("0f1ce021-3cd3-4435-bf0e-824511b0aa71"),
    "rootfs-snapshot-78be9e3d5fa4846afec4dcc693dcc4945b45b3c68915e2e0226c48d99afededa",
  );
  assert.equal(await snapshotTag("rootfs-snapshot-abc123"), "rootfs-snapshot-abc123", "a tag passes through");
});

test("image repositories", () => {
  assert.equal(imageRepository("registry.cloudflare.com/acct/my-app-sandbox:wrangler-x1", "acct"), "my-app-sandbox");
  assert.equal(imageRepository("registry.cloudflare.com/acct/my-app-sandbox@sha256:00ff", "acct"), "my-app-sandbox");
  assert.equal(imageRepository("my-app-sandbox:tag", "acct"), "my-app-sandbox");
});

test("a snapshot's set tag is rootfs-set- and the SHA-256 of its snapshot_set_id (seen live)", async () => {
  assert.match(await snapshotSetTag("set-1"), /^rootfs-set-[0-9a-f]{64}$/);
  assert.notEqual(await snapshotSetTag("set-1"), await snapshotSetTag("set-2"));
});

test("deleting a snapshot deletes both its tags by tag, never by digest, then collects the layers once (live check)", async () => {
  const registry = fakeRegistry();
  await addSnapshot(registry, "snap-a", "set-a");
  await addSnapshot(registry, "snap-b", "set-b", "snap-a");
  await addSnapshot(registry, "other", "set-o");
  const client = new SnapshotRegistry({ accountId: "acct", apiToken: "api-token", fetch: registry.fetcher });

  assert.deepEqual(await client.delete("my-app-sandbox", ["snap-a", "snap-b", "gone"]), { deleted: 2, missing: 1 });
  assert.deepEqual([...registry.tags.keys()].sort(), [await snapshotTag("other"), await snapshotSetTag("set-o")].sort(), "only the other snapshot's tags remain");

  const deletes = registry.calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/manifests/")[1]);
  assert.deepEqual(deletes, [await snapshotTag("snap-a"), await snapshotSetTag("set-a"), await snapshotTag("snap-b"), await snapshotSetTag("set-b")]);
  assert.equal(registry.calls.some((c) => c.url.includes("/manifests/sha256:")), false, "a digest delete does nothing on this registry");
  assert.equal(registry.calls.filter((c) => c.url.endsWith("/gc/layers")).length, 1, "one collection for the batch");
  assert.equal(registry.calls.filter((c) => c.url.endsWith("/credentials")).length, 1, "one credentials call for the batch");

  const [credentials, manifest, config] = registry.calls;
  assert.equal(credentials.url, "https://api.cloudflare.com/client/v4/accounts/acct/containers/registries/registry.cloudflare.com/credentials");
  assert.equal(credentials.headers.authorization, "Bearer api-token");
  assert.deepEqual(JSON.parse(credentials.body!), { expiration_minutes: 5, permissions: ["pull", "push"] });
  assert.equal(manifest.url, `https://registry.cloudflare.com/v2/acct/my-app-sandbox/manifests/${await snapshotTag("snap-a")}`);
  assert.equal(manifest.headers.authorization, `Basic ${btoa("v1:reg-pass")}`);
  assert.equal(config.url, "https://registry.cloudflare.com/v2/acct/my-app-sandbox/blobs/config-of-sha256:snap-a");
});

test("a config without a set id still deletes the snapshot tag, and says the set tag remains", async () => {
  const registry = fakeRegistry();
  registry.tags.set(await snapshotTag("snap-a"), "sha256:snap-a");
  registry.configs.set("sha256:snap-a", { snapshot_id: "snap-a" });
  const result = await new SnapshotRegistry({ accountId: "acct", apiToken: "t", fetch: registry.fetcher }).delete("repo", ["snap-a"]);
  assert.equal(result.deleted, 1);
  assert.match(result.warning ?? "", /no snapshot_set_id in its config, so its rootfs-set tag remains/);
  assert.equal(registry.tags.size, 0);
});

test("nothing to delete makes no calls; a refused token, read or delete is an error", async () => {
  const quiet = fakeRegistry();
  assert.deepEqual(await new SnapshotRegistry({ accountId: "acct", apiToken: "t", fetch: quiet.fetcher }).delete("repo", []), { deleted: 0, missing: 0 });
  assert.equal(quiet.calls.length, 0);

  const refused = new SnapshotRegistry({
    accountId: "acct",
    apiToken: "bad",
    fetch: (async () => new Response(JSON.stringify({ success: false }), { status: 403 })) as typeof fetch,
  });
  await assert.rejects(refused.delete("repo", ["x"]), /no registry credentials \(HTTP 403\)/);

  const tag = await snapshotTag("x");
  const unreadable = fakeRegistry({ statuses: { [`GET ${tag}`]: 500 } });
  await assert.rejects(new SnapshotRegistry({ accountId: "acct", apiToken: "t", fetch: unreadable.fetcher }).delete("repo", ["x"]), /reading rootfs-snapshot-[0-9a-f]{64} failed: HTTP 500/);

  const failing = fakeRegistry({ statuses: { [`DELETE ${tag}`]: 500 } });
  await addSnapshot(failing, "x", "set-x");
  await assert.rejects(new SnapshotRegistry({ accountId: "acct", apiToken: "t", fetch: failing.fetcher }).delete("repo", ["x"]), /deleting rootfs-snapshot-[0-9a-f]{64} failed: HTTP 500/);
});

test("a registry that never answers fails after the timeout instead of hanging (review R2)", async () => {
  // A request that never answers still holds its socket open; without that, Node 22
  // ends the test when only AbortSignal.timeout's unref'd timer is left.
  const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const socket = setInterval(() => {}, 1000);
      init?.signal?.addEventListener("abort", () => {
        clearInterval(socket);
        reject(init.signal!.reason);
      });
    })) as typeof fetch;
  const registry = new SnapshotRegistry({ accountId: "acct", apiToken: "t", timeoutMs: 20, fetch: hanging });
  await assert.rejects(registry.delete("repo", ["x"]), (err: Error) => err.name === "TimeoutError");
});

test("a failed layer garbage collection is a warning, not a failed deletion", async () => {
  const registry = fakeRegistry({ gc: 500 });
  await addSnapshot(registry, "x", "set-x");
  assert.deepEqual(await new SnapshotRegistry({ accountId: "acct", apiToken: "t", fetch: registry.fetcher }).delete("repo", ["x"]), {
    deleted: 1,
    missing: 0,
    warning: "layer garbage collection failed: HTTP 500",
  });
  const none = fakeRegistry();
  assert.deepEqual(await new SnapshotRegistry({ accountId: "acct", apiToken: "t", fetch: none.fetcher }).delete("repo", ["x"]), { deleted: 0, missing: 1 });
  assert.equal(none.calls.some((c) => c.url.endsWith("/gc/layers")), false, "no collection when nothing was deleted");
});

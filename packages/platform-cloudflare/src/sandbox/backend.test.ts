import test from "node:test";
import assert from "node:assert/strict";

import { CloudflareContainersSandbox } from "./backend.js";
import { UNINDEXED_HEADER } from "./protocol.js";

/** A fake namespace: sandbox objects that answer like server.mjs, and index objects. */
function fakeNamespace() {
  const objects = new Map<string, FakeObject>();
  class FakeObject {
    running = false;
    unindexed = false;
    keys = new Map<string, unknown>();
    async request(request: { path: string; body?: string }) {
      if (!this.running) this.unindexed = true;
      this.running = true;
      const body = request.path === "/exec" ? { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false } : { success: true };
      return new Response(JSON.stringify(body), { status: 200, headers: this.unindexed ? { [UNINDEXED_HEADER]: "1" } : {} });
    }
    async indexed() {
      this.unindexed = false;
    }
    async setEgressCredentials() {}
    /** Set to make the next track() fail, as when the index object is unreachable. */
    failTrack = false;
    async track(identifier: string) {
      if (this.failTrack) {
        this.failTrack = false;
        throw new Error("index unavailable");
      }
      this.keys.set(identifier, 1);
    }
    async untrack(identifier: string) {
      this.keys.delete(identifier);
    }
    async tracked() {
      return [...this.keys.keys()];
    }
    /** Set to make the next forget() fail, as when the registry refuses a deletion. */
    failForget = false;
    async forget() {
      if (this.failForget) {
        this.failForget = false;
        throw new Error("1 of 1 snapshots could not be deleted from the registry");
      }
      const existed = this.running;
      this.running = false;
      this.keys.clear();
      return existed;
    }
  }
  const namespace = {
    getByName(name: string) {
      if (!objects.has(name)) objects.set(name, new FakeObject());
      return objects.get(name)!;
    },
  };
  return { namespace: namespace as unknown as ConstructorParameters<typeof CloudflareContainersSandbox>[0], objects };
}

test("identifiers are JSON, so a user id with a colon can't reach another user's sandbox", () => {
  const { namespace } = fakeNamespace();
  const perConversation = new CloudflareContainersSandbox(namespace, { identifierStrategy: "sessionId" });
  assert.equal(perConversation.resolveIdentifier("alice", "s1"), '["alice","s1"]');
  assert.notEqual(perConversation.resolveIdentifier("alice", "s1"), perConversation.resolveIdentifier("alice:s1"));
  assert.equal(new CloudflareContainersSandbox(namespace).resolveIdentifier("alice", "s1"), '["alice"]');
});

test("a sandbox is indexed under its owner on every start, so erasure finds one made again after an erasure", async () => {
  const { namespace, objects } = fakeNamespace();
  const backend = new CloudflareContainersSandbox(namespace, { identifierStrategy: "sessionId" });
  const id = backend.resolveIdentifier("alice:x", "s1");
  await backend.exec({ command: "true" }, id);
  assert.deepEqual(await objects.get('idx:alice:x')!.tracked(), [id]);
  assert.equal(await backend.deleteUserSandboxes("alice:x"), 1);
  // The same isolate, after the erasure: the next call starts the sandbox again and indexes it again.
  await backend.exec({ command: "true" }, id);
  assert.deepEqual(await objects.get('idx:alice:x')!.tracked(), [id]);
  assert.equal(await backend.deleteUserSandboxes("alice:x"), 1);
  assert.equal(objects.has("idx:alice"), false, "a user named alice is never touched");
});

test("setting egress credentials indexes the sandbox too (its object keeps them)", async () => {
  const { namespace, objects } = fakeNamespace();
  const backend = new CloudflareContainersSandbox(namespace);
  const id = backend.resolveIdentifier("bob");
  await backend.setEgressCredentials([], id);
  assert.deepEqual(await objects.get("idx:bob")!.tracked(), [id]);
});

test("a sandbox whose snapshots couldn't be deleted stays indexed, and erasure says so (multi-tenant review)", async () => {
  const { namespace, objects } = fakeNamespace();
  const backend = new CloudflareContainersSandbox(namespace, { identifierStrategy: "sessionId" });
  const ok = backend.resolveIdentifier("carol", "s1");
  const stuck = backend.resolveIdentifier("carol", "s2");
  await backend.exec({ command: "true" }, ok);
  await backend.exec({ command: "true" }, stuck);
  objects.get(`sbx:${stuck}`)!.failForget = true;

  await assert.rejects(backend.deleteUserSandboxes("carol"), /1 of 2 sandboxes not fully deleted \(1 deleted\).*registry/);
  assert.deepEqual(await objects.get("idx:carol")!.tracked(), [stuck], "only the failed one is kept, for a retry");
  assert.equal(await backend.deleteUserSandboxes("carol"), 1);
  assert.deepEqual(await objects.get("idx:carol")!.tracked(), []);
});

test("without snapshot deletion configured, erasure notes that snapshots stay until they expire", () => {
  const { namespace } = fakeNamespace();
  assert.match(new CloudflareContainersSandbox(namespace).erasureNotes.join(), /until they expire/);
  const configured = new CloudflareContainersSandbox(namespace, { snapshotDeletion: { accountId: "a", apiToken: "t" } });
  assert.deepEqual(configured.erasureNotes, []);
});

test("a sandbox whose indexing failed after its start is indexed on the next call (multi-tenant review)", async () => {
  const { namespace, objects } = fakeNamespace();
  const backend = new CloudflareContainersSandbox(namespace);
  const id = backend.resolveIdentifier("dave");
  (namespace as unknown as { getByName(name: string): unknown }).getByName("idx:dave");
  objects.get("idx:dave")!.failTrack = true;

  const first = await backend.exec({ command: "true" }, id);
  assert.equal(first.exitCode, 0, "the call itself still succeeds");
  assert.deepEqual(await objects.get("idx:dave")!.tracked(), []);

  await backend.exec({ command: "true" }, id);
  assert.deepEqual(await objects.get("idx:dave")!.tracked(), [id], "the sandbox kept asking, so erasure will find it");
  assert.equal(objects.get(`sbx:${id}`)!.unindexed, false);
});

/**
 * S3 checkpoints (checkpoints.ts) and the owner's lease and generation
 * (workspace-store.ts), on a fake S3 and the in-memory database.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryStorage } from "@agentforeach/storage";
import { CheckpointFencedError, S3WorkspaceCheckpoints } from "./checkpoints.js";
import { FakeS3 } from "./agentcore.testkit.js";
import { ownerHash } from "./session-store.js";
import { AwsWorkspaceStore, DRAIN_MS, LEASE_MS, WorkspaceBusyError, WorkspaceLeaseLostError } from "./workspace-store.js";

const owner = ownerHash("alice");
const KEY = `afe-${owner}-${"a".repeat(24)}`;
const checkpoints = (s3: FakeS3) => new S3WorkspaceCheckpoints("afe-test-workspaces", s3, 1024, "123456789012");

test("conditional writes fence a stale writer: only the latest fenced operation can commit", async () => {
  const s3 = new FakeS3();
  const store = checkpoints(s3);
  const a = await store.fence(KEY, "a", 0);
  assert.equal(a.archive, null);
  const b = await store.fence(KEY, "b", 0);
  await assert.rejects(store.commit(KEY, a, "old", "a", 0), { name: "PreconditionFailed" });
  await store.commit(KEY, b, "new", "b", 0);
  assert.equal((await store.fence(KEY, "c", 0)).archive, "new");
});

test("erasure: the erased generation can't write or read again; the next one starts empty", async () => {
  const s3 = new FakeS3();
  const store = checkpoints(s3);
  const fenced = await store.fence(KEY, "a", 0);
  await store.commit(KEY, fenced, "erase me", "a", 0);
  const inFlight = await store.fence(KEY, "b", 0);

  await store.erase(KEY, 0);
  assert.equal(s3.checkpoint(KEY)?.deleted, true);
  assert.equal(s3.checkpoint(KEY)?.archive, undefined, "the archive is overwritten");
  await assert.rejects(store.commit(KEY, inFlight, "resurrected", "b", 0), { name: "PreconditionFailed" });
  await assert.rejects(store.fence(KEY, "c", 0), CheckpointFencedError);

  const next = await store.fence(KEY, "d", 1);
  assert.equal(next.archive, null, "generation 1 doesn't see generation 0's files");
  await store.commit(KEY, next, "fresh", "d", 1);
  await assert.rejects(store.fence(KEY, "e", 0), CheckpointFencedError, "an old writer finds a newer generation");
  // A late erasure of generation 0 leaves generation 1's checkpoint alone.
  await store.erase(KEY, 0);
  assert.equal((await store.fence(KEY, "f", 1)).archive, "fresh");
});

test("erasure fences a key no one has written yet, so a late writer can't create it", async () => {
  const s3 = new FakeS3();
  const store = checkpoints(s3);
  await store.erase(KEY, 0);
  await assert.rejects(store.fence(KEY, "late", 0), CheckpointFencedError);
});

test("a bucket that ever had versioning is refused", async () => {
  for (const status of ["Enabled", "Suspended"] as const) {
    const s3 = new FakeS3();
    s3.versioning = status;
    await assert.rejects(checkpoints(s3).fence(KEY, "a", 0), /versioning/);
  }
  assert.throws(() => new S3WorkspaceCheckpoints("Bad_Bucket", new FakeS3(), 1024), /bucket/);
  await assert.rejects(checkpoints(new FakeS3()).fence("not-a-key", "a", 0), /Invalid workspace key/);
});

test("a stored checkpoint over the size limit is refused", async () => {
  const s3 = new FakeS3();
  const big = checkpoints(s3);
  const fenced = await big.fence(KEY, "a", 0);
  await assert.rejects(big.commit(KEY, fenced, "x".repeat(2000), "a", 0), /larger than the limit/);
  const generous = new S3WorkspaceCheckpoints("afe-test-workspaces", s3, 10_000);
  await generous.commit(KEY, fenced, "x".repeat(2000), "a", 0);
  await assert.rejects(big.fence(KEY, "b", 0), /larger than the limit|invalid/);
});

test("the lease: one operation at a time; an expired one loses it and its compute isn't reused", async () => {
  let now = 0;
  const store = new AwsWorkspaceStore(new InMemoryStorage(), () => now);
  const a = await store.acquire(KEY, owner, "arn", "v1");
  await assert.rejects(store.acquire(KEY, owner, "arn", "v1"), WorkspaceBusyError);
  now = LEASE_MS + 1;
  const b = await store.acquire(KEY, owner, "arn", "v1");
  assert.notEqual(b.physicalId, a.physicalId, "unclean compute is replaced");
  await assert.rejects(store.assertLease(a), WorkspaceLeaseLostError);
  await store.release(a, true); // a stale release changes nothing
  await store.assertLease(b);
  await store.release(b, true);
  const c = await store.acquire(KEY, owner, "arn", "v1");
  assert.equal(c.physicalId, b.physicalId, "clean compute is reused");
  await store.release(c, true);
  const d = await store.acquire(KEY, owner, "arn", "v2");
  assert.notEqual(d.physicalId, c.physicalId, "another endpoint gets new compute");
});

test("erasure raises the generation, ends the lease, and asks for a retry while it may still run", async () => {
  let now = 0;
  const store = new AwsWorkspaceStore(new InMemoryStorage(), () => now);
  assert.equal(await store.generation(owner), 0);
  const lease = await store.acquire(KEY, owner, "arn");
  assert.deepEqual(await store.erase(owner), { generation: 0, keys: [KEY] });
  assert.equal(await store.generation(owner), 1);
  await assert.rejects(store.assertLease(lease), WorkspaceLeaseLostError);
  await assert.rejects(store.assertQuiescent(owner), /erase again/);
  await store.release(lease, true);

  const next = await store.acquire(KEY, owner, "arn");
  assert.equal(next.generation, 1);
  assert.notEqual(next.physicalId, lease.physicalId);
  await store.release(next, true);
  now = LEASE_MS + DRAIN_MS + 1;
  await store.assertQuiescent(owner);
  // An erasure with no operation running needs no wait.
  await store.erase(owner);
  await store.assertQuiescent(owner);
});

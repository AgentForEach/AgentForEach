/**
 * The aws-agentcore backend against a stand-in AgentCore Runtime that runs
 * the real sandbox server (server.mjs) per runtime session
 * (agentcore.testkit.ts): the sandbox conformance suite in both storage
 * modes, then what the suite can't see.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { InMemoryStorage } from "@agentforeach/storage";
import { runSandboxConformance } from "@agentforeach/platform/sandbox/conformance";
import { encodeSandboxIdentifier } from "@agentforeach/platform";
import { AwsAgentCoreSandbox, sandboxKey, type AwsAgentCoreSandboxOptions } from "./backend.js";
import { FakeAgentCore, FakeS3 } from "./agentcore.testkit.js";
import { ownerHash } from "./session-store.js";

const ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/afe_sandbox-abc123";
const TOKEN = "runtime-token-0123456789abcdef";
const LIMITS = { maxBytes: 256 * 1024, maxFiles: 200 };
const RUNTIME_ENV = {
  SANDBOX_SERVER_TOKEN: TOKEN,
  SANDBOX_ARCHIVE_MAX_BYTES: String(LIMITS.maxBytes),
  SANDBOX_ARCHIVE_MAX_FILES: String(LIMITS.maxFiles),
};

const runtimes: FakeAgentCore[] = [];
after(async () => {
  await Promise.all(runtimes.map((r) => r.close()));
});

function setup(overrides: Partial<AwsAgentCoreSandboxOptions> = {}, shared: { runtime?: FakeAgentCore; storage?: InMemoryStorage; s3?: FakeS3 } = {}) {
  const runtime = shared.runtime ?? new FakeAgentCore(RUNTIME_ENV);
  if (!shared.runtime) runtimes.push(runtime);
  const storage = shared.storage ?? new InMemoryStorage();
  const s3 = shared.s3 ?? new FakeS3();
  const backend = new AwsAgentCoreSandbox({
    runtimeArn: ARN,
    serverToken: TOKEN,
    storage,
    agentCore: runtime,
    s3,
    workspaceBucket: "afe-test-workspaces",
    persistenceLimits: LIMITS,
    defaultTimeoutSec: 30,
    ...overrides,
  });
  return { backend, runtime, storage, s3 };
}

/** The data folder of the session a call last started (commands run there, outside a container). */
function lastDataDir(runtime: FakeAgentCore): string {
  const ids = [...runtime.sessions.keys()];
  return ids.length ? realpathSync(join(runtime.root, sessionFolder(ids.at(-1)!), "data")) : "/mnt/data";
}
/** agentcore.testkit.ts names each session's folder by a hash of its id. */
const sessionFolder = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex").slice(0, 16);

{
  const ephemeral = setup({ storageMode: "ephemeral" });
  runSandboxConformance({
    name: "aws-agentcore, ephemeral (stand-in runtime over server.mjs)",
    createBackend: () => ephemeral.backend,
    dataDir: () => lastDataDir(ephemeral.runtime),
    timeoutMs: 60_000,
  });

  const checkpoint = setup({ storageMode: "s3-checkpoint" });
  runSandboxConformance({
    name: "aws-agentcore, s3-checkpoint (stand-in runtime and S3)",
    createBackend: () => checkpoint.backend,
    // Sleep: AgentCore ends every session; the next call restores from S3 onto new compute.
    sleep: () => checkpoint.runtime.expire(),
    dataDir: () => lastDataDir(checkpoint.runtime),
    timeoutMs: 60_000,
  });
}

test("configuration is checked; capabilities follow the storage mode", () => {
  const storage = new InMemoryStorage();
  const base = { runtimeArn: ARN, serverToken: TOKEN, storage, agentCore: { send: async () => ({}) } } as AwsAgentCoreSandboxOptions;
  assert.throws(() => new AwsAgentCoreSandbox({ ...base, runtimeArn: "arn:aws:lambda:us-east-1:123456789012:function:x" }), /runtime ARN/);
  assert.throws(() => new AwsAgentCoreSandbox({ ...base, region: "eu-west-1" }), /region/);
  assert.throws(() => new AwsAgentCoreSandbox({ ...base, serverToken: "short" }), /SANDBOX_SERVER_TOKEN/);
  assert.throws(() => new AwsAgentCoreSandbox({ ...base, maxTimeoutSec: 999 }), /timeouts/);
  assert.throws(() => new AwsAgentCoreSandbox({ ...base, qualifier: "bad-qualifier" }), /qualifier/);
  assert.throws(() => new AwsAgentCoreSandbox({ ...base, storageMode: "s3-checkpoint" }), /bucket/);
  assert.throws(
    () => new AwsAgentCoreSandbox({ ...base, storageMode: "s3-checkpoint", workspaceBucket: "b-1", persistenceLimits: { maxBytes: 65 * 1024 * 1024, maxFiles: 1 } }),
    /64 MiB/,
  );
  const ephemeral = new AwsAgentCoreSandbox(base);
  assert.deepEqual(ephemeral.capabilities, { browser: false, egressCredentials: false, persistence: "disk" });
  const kept = new AwsAgentCoreSandbox({ ...base, storageMode: "s3-checkpoint", workspaceBucket: "b-1", browser: true });
  assert.deepEqual(kept.capabilities, {
    browser: true,
    egressCredentials: false,
    persistence: "data",
    persistenceLimits: { maxBytes: 32 * 1024 * 1024, maxFiles: 10_000 },
  });
  assert.equal(kept.erasureNotes.length, 1);
});

test("runtime session ids are hashes scoped to the owner; no user id reaches AWS", async () => {
  const { backend, runtime } = setup({ storageMode: "ephemeral", identifierStrategy: "sessionId" });
  const alice = backend.resolveIdentifier("alice@example.com", "conv-1");
  assert.equal(alice, encodeSandboxIdentifier("alice@example.com", "conv-1"));
  assert.notEqual(sandboxKey(alice).key, sandboxKey(backend.resolveIdentifier("alice@example.com", "conv-2")).key);
  assert.notEqual(sandboxKey(alice).key, sandboxKey(backend.resolveIdentifier("bob", "conv-1")).key);
  await backend.exec({ command: "true" }, alice);
  const input = runtime.calls.find((c) => c.name === "InvokeAgentRuntimeCommand")!.input;
  assert.equal(input.runtimeSessionId, `afe-${ownerHash("alice@example.com")}-${sandboxKey(alice).key.slice(-24)}-0`);
  assert.equal(input.agentRuntimeArn, ARN);
  const sent = JSON.stringify({ ...input, payload: Buffer.from(input.payload as Uint8Array).toString() });
  assert.ok(!sent.includes("alice"), "the user id is not in the request");
  assert.ok(sent.includes(TOKEN), "the token travels in the envelope");
});

test("an ambiguous invocation failure is reported, never retried, and the session stays recorded", async () => {
  const { backend, runtime, storage } = setup({ storageMode: "ephemeral" });
  const id = backend.resolveIdentifier("carol");
  runtime.failNext = Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
  await assert.rejects(backend.exec({ command: "echo side effect" }, id), /socket hang up/);
  assert.equal(runtime.calls.filter((c) => c.name === "InvokeAgentRuntimeCommand").length, 1);
  const records = await (await storage.collection({ name: "aws-sandbox-sessions", partitionKey: "owner" })).find({ partitionKey: ownerHash("carol") });
  assert.equal(records.length, 1, "recorded before the call, so erasure can stop it");
});

test("erasure stops every session, keeps a failed one for a retry, and the next call is a new generation", async () => {
  const { backend, runtime } = setup({ storageMode: "ephemeral", identifierStrategy: "sessionId" });
  const a = backend.resolveIdentifier("dave", "a");
  const b = backend.resolveIdentifier("dave", "b");
  await backend.fileWrite({ filename: "x.txt", content: "x" }, a);
  await backend.fileWrite({ filename: "y.txt", content: "y" }, b);
  await backend.exec({ command: "true" }, backend.resolveIdentifier("erin", "a"));

  const realSend = runtime.send.bind(runtime);
  let failStops = true;
  runtime.send = async (command) => {
    if (command.constructor.name === "StopRuntimeSessionCommand" && failStops) throw new Error("AccessDenied");
    return realSend(command);
  };
  await assert.rejects(backend.deleteUserSandboxes("dave"), /2 of 2 AgentCore sessions not stopped/);
  failStops = false;
  assert.equal(await backend.deleteUserSandboxes("dave"), 2);
  assert.equal(runtime.sessions.size, 1, "erin's session is untouched");

  await backend.exec({ command: "true" }, a);
  const last = runtime.calls.filter((c) => c.name === "InvokeAgentRuntimeCommand").at(-1)!.input;
  assert.match(String(last.runtimeSessionId), /-2$/, "two erasures: generation 2");
});

test("a session recorded on another runtime is not stopped through this one", async () => {
  const storage = new InMemoryStorage();
  const runtime = new FakeAgentCore(RUNTIME_ENV);
  runtimes.push(runtime);
  const old = setup({ storageMode: "ephemeral", runtimeArn: `${ARN}-old` }, { runtime, storage }).backend;
  await old.exec({ command: "true" }, old.resolveIdentifier("frank"));
  const current = setup({ storageMode: "ephemeral" }, { runtime, storage }).backend;
  await assert.rejects(current.deleteUserSandboxes("frank"), /another runtime/);
  assert.equal(await old.deleteUserSandboxes("frank"), 1);
});

test("s3-checkpoint: a failed save is not acknowledged, and the next call has the last saved files", async () => {
  const { backend, s3 } = setup({ storageMode: "s3-checkpoint" });
  const id = backend.resolveIdentifier("grace");
  await backend.fileWrite({ filename: "f.txt", content: "saved" }, id);
  s3.failPut = { match: '"archive":"H4sI', error: Object.assign(new Error("InternalError"), { name: "InternalError" }) };
  await assert.rejects(backend.fileWrite({ filename: "f.txt", content: "unsaved" }, id), /InternalError/);
  assert.equal((await backend.fileRead({ filename: "f.txt" }, id)).content, "saved");
});

test("s3-checkpoint: two gateway instances on one owner take turns through the lease", async () => {
  const storage = new InMemoryStorage();
  const s3 = new FakeS3();
  const runtime = new FakeAgentCore(RUNTIME_ENV);
  runtimes.push(runtime);
  const one = setup({ storageMode: "s3-checkpoint" }, { runtime, storage, s3 }).backend;
  const two = setup({ storageMode: "s3-checkpoint" }, { runtime, storage, s3 }).backend;
  const id = one.resolveIdentifier("heidi");
  const [first, second] = await Promise.all([
    one.exec({ command: "sleep 1; echo one >> log.txt" }, id),
    two.exec({ command: "echo two >> log.txt" }, id),
  ]);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  const log = (await one.fileRead({ filename: "log.txt" }, id)).content.trim().split("\n").sort();
  assert.deepEqual(log, ["one", "two"], "both saved: neither overwrote the other");
});

test("s3-checkpoint: env vars come back on new compute without being saved in the checkpoint", async () => {
  const { backend, runtime, s3 } = setup({ storageMode: "s3-checkpoint" });
  const id = backend.resolveIdentifier("ivan");
  await backend.setEnv({ AFE_SECRET: "in-memory-only" }, id);
  await backend.exec({ command: "true" }, id);
  await runtime.expire();
  assert.equal((await backend.exec({ command: 'printf %s "$AFE_SECRET"' }, id)).stdout, "in-memory-only");
  const stored = JSON.stringify([...s3.objects.values()]);
  assert.ok(!stored.includes("in-memory-only"));
});

test("s3-checkpoint: an erasure during an operation fences it, reports the wait, and the user can start again", async () => {
  let now = 1_000_000;
  const { backend, runtime, s3 } = setup({ storageMode: "s3-checkpoint", now: () => now });
  const id = backend.resolveIdentifier("judy");
  await backend.fileWrite({ filename: "secret.txt", content: "erase me" }, id);

  const running = backend.exec({ command: "sleep 1; echo late > late.txt" }, id);
  // Its compute is stopped under it, or its lease is gone: either way it fails, and saves nothing.
  const fenced = assert.rejects(running);
  await new Promise((r) => setTimeout(r, 400));
  await assert.rejects(backend.deleteUserSandboxes("judy"), /erase again in/);
  const { key } = sandboxKey(id);
  assert.equal(s3.checkpoint(key)?.deleted, true);
  assert.ok(!JSON.stringify(s3.checkpoint(key)).includes("H4sI"), "no archive left in the object");
  await fenced;

  now += 16 * 60_000; // past the lease and the drain allowance
  assert.ok((await backend.deleteUserSandboxes("judy")) >= 1);
  assert.deepEqual(await backend.fileList(id), [], "a new generation starts empty");
  assert.equal(runtime.sessions.size, 1);
});

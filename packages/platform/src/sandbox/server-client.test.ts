import test from "node:test";
import assert from "node:assert/strict";

import { SandboxServerClient, SandboxServerError, type SandboxServerTransport } from "./server-client.js";

/** A transport answering each path with a canned JSON body (or a Response). */
function transport(routes: Record<string, unknown>, calls: Array<{ path: string; body?: unknown }> = []): SandboxServerTransport {
  return async (_id, path, init) => {
    calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = routes[path];
    if (answer instanceof Response) return answer;
    if (answer === undefined) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
}

test("exec clamps the timeout, cuts long output, and reports truncation", async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const client = new SandboxServerClient({
    maxTimeoutSec: 200,
    maxOutputChars: 5,
    transport: transport({ "/exec": { stdout: "0123456789", stderr: "", exitCode: 0, timedOut: false, truncated: false } }, calls),
  });
  const result = await client.exec({ command: "x", timeout: 999 }, "u1");
  assert.deepEqual(calls[0].body, { command: "x", timeout: 200 });
  assert.equal(result.stdout, "01234");
  assert.equal(result.truncated, true);
  assert.equal(result.sessionId, "u1");
});

test("a missing file is a 404 SandboxServerError; other read errors are 500", async () => {
  const missing = new SandboxServerClient({
    transport: transport({ "/files/read": { content: "", filename: "a", sizeBytes: 0, error: "ENOENT: no such file or directory" } }),
  });
  await assert.rejects(missing.fileRead({ filename: "a" }, "u1"), (err: unknown) => {
    assert.ok(err instanceof SandboxServerError);
    assert.equal(err.status, 404);
    return true;
  });
  const denied = new SandboxServerClient({
    transport: transport({ "/files/read": { content: "", filename: "a", sizeBytes: 0, error: "EACCES" } }),
  });
  await assert.rejects(denied.fileRead({ filename: "a" }, "u1"), { status: 500 });
});

test("reads stop at the size limit instead of buffering a huge file", async () => {
  const big = "x".repeat(1_200_000); // past the cap: content limit plus 1 MB of room for the JSON
  const client = new SandboxServerClient({
    maxOutputChars: 1000,
    maxExportBytes: 10_000,
    transport: transport({ "/files/read": { content: big, filename: "big.txt", sizeBytes: big.length } }),
  });
  await assert.rejects(client.fileRead({ filename: "big.txt" }, "u1"), /too large to read whole/);
  await assert.rejects(client.fileReadBinary({ filename: "big.txt" }, "u1"), /too large for export/);
});

test("server errors carry their status; setEnv sends safe keys; a failed write throws", async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const client = new SandboxServerClient({
    transport: transport(
      {
        "/env": { success: true, count: 1 },
        "/files/write": { success: false, error: "disk full" },
        "/exec": new Response("boom", { status: 503 }),
      },
      calls,
    ),
  });
  await client.setEnv({ "my-key": "v" }, "u1");
  assert.deepEqual(calls[0].body, { vars: { my_key: "v" } });
  await assert.rejects(client.fileWrite({ filename: "a", content: "b" }, "u1"), /disk full/);
  await assert.rejects(client.exec({ command: "x" }, "u1"), { status: 503 });
});

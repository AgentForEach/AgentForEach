/**
 * The sandbox server as Bedrock AgentCore Runtime runs it: GET /ping and
 * POST /invocations (a JSON envelope with the token), and /archive within
 * SANDBOX_ARCHIVE_MAX_BYTES / SANDBOX_ARCHIVE_MAX_FILES.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, stopServer } from "./server-process.testkit.js";

const TOKEN = "invocations-token-0123456789abcdef";
const JSON_TYPE = { "content-type": "application/json" };

type Envelope = { status: number; body: Record<string, unknown> };

async function withServer(env: Record<string, string>, run: (url: (path: string) => string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "afe-sbx-inv-"));
  const { proc, port } = await startServer(
    { SANDBOX_DATA_DIR: root, SANDBOX_ENV_FILE: "memory", ...env },
    async (p) => (await fetch(`http://127.0.0.1:${p}/ping`)).ok,
  );
  try {
    await run((path) => `http://127.0.0.1:${port}${path}`);
  } finally {
    await stopServer(proc);
    rmSync(root, { recursive: true, force: true });
  }
}

function invoke(url: (path: string) => string, envelope: unknown, headers: Record<string, string> = JSON_TYPE) {
  return fetch(url("/invocations"), { method: "POST", headers, body: typeof envelope === "string" ? envelope : JSON.stringify(envelope) });
}

async function call(url: (path: string) => string, path: string, method: "GET" | "POST", body?: unknown): Promise<Envelope> {
  const response = await invoke(url, { token: TOKEN, path, method, body });
  assert.equal(response.status, 200);
  return (await response.json()) as Envelope;
}

test("/ping needs no token; /invocations without the right token is always 401", async () => {
  await withServer({ SANDBOX_SERVER_TOKEN: TOKEN }, async (url) => {
    const ping = await fetch(url("/ping"));
    assert.equal(ping.status, 200);
    assert.equal(((await ping.json()) as { status: string }).status, "Healthy");
    assert.equal((await fetch(url("/ping"), { method: "POST", headers: JSON_TYPE, body: "{}" })).status, 401, "only GET /ping is open");

    const exec = { path: "/exec", method: "POST", body: { command: "touch pwned" } };
    for (const [what, envelope] of [
      ["no token", exec],
      ["wrong token", { ...exec, token: "invocations-token-0123456789abcdeX" }],
      ["shorter token", { ...exec, token: "invocations" }],
      ["token not a string", { ...exec, token: 42 }],
      ["unknown route", { path: "/nope", method: "GET" }],
      ["not JSON", "{token:"],
      ["not an object", JSON.stringify("text")],
    ] as const) {
      assert.equal((await invoke(url, envelope)).status, 401, what);
    }
    // The header token alone doesn't open the envelope.
    assert.equal((await invoke(url, exec, { ...JSON_TYPE, "x-sandbox-token": TOKEN })).status, 401);
    // JSON only: what a page's no-cors request can send is refused before the token is read.
    const plain = await invoke(url, { ...exec, token: TOKEN }, { "content-type": "text/plain" });
    assert.equal(plain.status, 415);
    assert.equal((await call(url, "/exec", "POST", { command: "ls pwned 2>/dev/null || echo absent" })).body.stdout, "absent\n");
  });

  await withServer({}, async (url) => {
    const response = await invoke(url, { token: "", path: "/health", method: "GET" });
    assert.equal(response.status, 401, "a server without a token serves no envelope");
  });
});

test("/invocations dispatches to the same routes, with the route's own status", async () => {
  await withServer({ SANDBOX_SERVER_TOKEN: TOKEN }, async (url) => {
    const exec = await call(url, "/exec", "POST", { command: "printf ok; exit 3" });
    assert.deepEqual([exec.status, exec.body.stdout, exec.body.exitCode], [200, "ok", 3]);
    assert.equal((await call(url, "/files/write", "POST", { filename: "a/b.txt", content: "héllo" })).body.success, true);
    assert.equal((await call(url, "/files/read", "POST", { filename: "a/b.txt" })).body.content, "héllo");
    assert.equal((await call(url, "/env", "POST", { vars: { K: "v" } })).body.count, 1);
    assert.equal((await call(url, "/exec", "POST", { command: 'printf %s "$K"' })).body.stdout, "v");
    assert.equal((await call(url, "/health", "GET")).status, 200);
    assert.equal((await call(url, "/nope", "GET")).status, 404);
    assert.equal((await call(url, "/exec", "POST", {})).status, 400);
    assert.equal((await invoke(url, { token: TOKEN, path: "exec", method: "POST" })).status, 400);
  });
});

test("/ping says HealthyBusy while a request runs", async () => {
  await withServer({ SANDBOX_SERVER_TOKEN: TOKEN }, async (url) => {
    const slow = call(url, "/exec", "POST", { command: "sleep 1" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(((await (await fetch(url("/ping"))).json()) as { status: string }).status, "HealthyBusy");
    await slow;
    const idle = (await (await fetch(url("/ping"))).json()) as { status: string; time_of_last_update: number };
    assert.equal(idle.status, "Healthy");
    assert.ok(Number.isInteger(idle.time_of_last_update));
  });
});

test("bounded /archive: base64 in the envelope, refused whole over a bound, never cut short", async () => {
  const limits = { SANDBOX_SERVER_TOKEN: TOKEN, SANDBOX_ARCHIVE_MAX_BYTES: "4096", SANDBOX_ARCHIVE_MAX_FILES: "8" };
  let archive = "";
  await withServer(limits, async (url) => {
    await call(url, "/files/write", "POST", { filename: "notes.txt", content: "kept" });
    await call(url, "/files/write", "POST", { filename: "sub/deep.txt", content: "deep" });
    const made = await call(url, "/archive", "GET");
    assert.equal(made.status, 200);
    archive = made.body.archive as string;
    assert.equal(made.body.files, 3);

    await call(url, "/exec", "POST", { command: "head -c 5000 /dev/zero > big.bin" });
    const over = await call(url, "/archive", "GET");
    assert.equal(over.status, 413);
    assert.equal(over.body.code, "archive_limit");
    assert.equal(over.body.archive, undefined);
    const overHttp = await fetch(url("/archive"), { headers: { "x-sandbox-token": TOKEN } });
    assert.equal(overHttp.status, 413, "over HTTP too: an error, not a truncated stream");
    assert.equal(((await overHttp.json()) as { code: string }).code, "archive_limit");
  });

  await withServer(limits, async (url) => {
    await call(url, "/files/write", "POST", { filename: "stale.txt", content: "replaced" });
    const restored = await call(url, "/archive", "POST", { archive });
    assert.deepEqual([restored.status, restored.body.restored], [200, true]);
    assert.equal((await call(url, "/exec", "POST", { command: "cat notes.txt sub/deep.txt; ls stale.txt 2>/dev/null" })).body.stdout, "keptdeep");
    // The archive the folder already matches isn't unpacked again.
    assert.equal((await call(url, "/archive", "POST", { archive })).body.restored, false);
    assert.equal((await call(url, "/archive", "POST", { archive: "not base64!" })).status, 400);
    const emptied = await call(url, "/archive", "POST", { archive: null });
    assert.equal(emptied.body.restored, true);
    assert.equal((await call(url, "/files", "GET")).body.files instanceof Array, true);
    assert.deepEqual((await call(url, "/files", "GET")).body.files, []);
  });

  await withServer({ SANDBOX_SERVER_TOKEN: TOKEN }, async (url) => {
    assert.equal((await call(url, "/archive", "GET")).status, 400, "unbounded: no archive in an envelope");
  });
});

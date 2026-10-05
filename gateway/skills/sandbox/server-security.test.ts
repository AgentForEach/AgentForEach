/**
 * The sandbox server refuses callers that aren't the gateway: a page in the
 * sandbox's browser can reach 127.0.0.1:8080 too (review finding S-M3).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serverPath, startServer, stopServer } from "./server-process.testkit.js";

function sandboxDirs() {
  const root = mkdtempSync(join(tmpdir(), "afe-sbx-sec-"));
  return { root, env: { SANDBOX_DATA_DIR: root, SANDBOX_ENV_FILE: join(root, "env.json") } };
}

test("with a token, every route needs it; commands don't inherit it", async () => {
  const { root, env } = sandboxDirs();
  const token = "per-start-token-0123456789abcdef";
  const { proc, port } = await startServer({ ...env, SANDBOX_SERVER_TOKEN: token });
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  const json = { "content-type": "application/json" };
  try {
    assert.equal((await fetch(url("/health"))).status, 401);
    assert.equal((await fetch(url("/files"), { headers: { "x-sandbox-token": "wrong" } })).status, 401);
    const denied = await fetch(url("/exec"), { method: "POST", headers: json, body: JSON.stringify({ command: "touch /tmp/pwned" }) });
    assert.equal(denied.status, 401);

    const ok = await fetch(url("/exec"), {
      method: "POST",
      headers: { ...json, "x-sandbox-token": token },
      body: JSON.stringify({ command: 'printf %s "${SANDBOX_SERVER_TOKEN:-absent}"' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { stdout: string }).stdout, "absent", "the token is not in commands' environment");
    assert.equal((await fetch(url("/health"), { headers: { "x-sandbox-token": token } })).status, 200);
  } finally {
    await stopServer(proc);
    rmSync(root, { recursive: true, force: true });
  }
});

test("without a token (Dynamic Sessions), POSTs must still be JSON: a page's no-cors request is refused", async () => {
  const { root, env } = sandboxDirs();
  const { proc, port } = await startServer(env);
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  try {
    // What fetch(..., { mode: "no-cors" }) can send: text/plain, form data, no custom headers.
    for (const type of ["text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const response = await fetch(url("/exec"), { method: "POST", headers: { "content-type": type }, body: '{"command":"id"}' });
      assert.equal(response.status, 415, type);
    }
    const noType = await fetch(url("/env"), { method: "POST", body: '{"vars":{"A":"1"}}' });
    assert.equal(noType.status, 415);
    const ok = await fetch(url("/exec"), {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ command: "echo hi" }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(url("/health"))).status, 200, "GET routes stay open without a token, as before");
  } finally {
    await stopServer(proc);
    rmSync(root, { recursive: true, force: true });
  }
});

test("with SANDBOX_ENV_FILE=memory, env vars never touch the disk (review S-L1)", async () => {
  const { root } = sandboxDirs();
  const home = mkdtempSync(join(tmpdir(), "afe-sbx-home-"));
  const json = { "content-type": "application/json" };
  const env = { SANDBOX_DATA_DIR: root, SANDBOX_ENV_FILE: "memory", HOME: home };
  let server = await startServer(env);
  const call = (port: number, path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: json, body: JSON.stringify(body) });
  try {
    assert.equal((await call(server.port, "/env", { vars: { LEGACY_KEY: "real-secret" } })).status, 200);
    const seen = (await (await call(server.port, "/exec", { command: 'printf %s "$LEGACY_KEY"' })).json()) as { stdout: string };
    assert.equal(seen.stdout, "real-secret");
    assert.equal(existsSync(join(home, ".agentforeach")), false, "no env file under HOME");
    assert.deepEqual(readdirSync(root), [], "nothing written in the data directory either");
    // A restart (or a restore) starts with no env: the caller applies it again.
    await stopServer(server.proc);
    server = await startServer(env);
    const after = (await (await call(server.port, "/exec", { command: 'printf %s "${LEGACY_KEY:-gone}"' })).json()) as { stdout: string };
    assert.equal(after.stdout, "gone");
  } finally {
    await stopServer(server.proc);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("an image with the browser won't run the server without a token (review R4)", async () => {
  const { root, env } = sandboxDirs();
  const browserDir = join(root, "browser");
  mkdirSync(browserDir);
  try {
    const refused = spawnSync(process.execPath, [serverPath()], {
      env: { ...process.env, ...env, SANDBOX_BROWSER_DIR: browserDir, SANDBOX_SERVER_TOKEN: "", SANDBOX_PORT: "0" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /SANDBOX_SERVER_TOKEN must be set/);

    const token = "per-start-token-0123456789abcdef";
    const { proc, port } = await startServer({ ...env, SANDBOX_BROWSER_DIR: browserDir, SANDBOX_SERVER_TOKEN: token });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { headers: { "x-sandbox-token": token } })).status, 200);
    } finally {
      await stopServer(proc);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with a token, /archive moves /mnt/data between two servers; without one it doesn't exist (live run 3)", async () => {
  const from = sandboxDirs();
  const to = sandboxDirs();
  const token = "per-start-token-0123456789abcdef";
  const auth = { "x-sandbox-token": token };
  const a = await startServer({ ...from.env, SANDBOX_SERVER_TOKEN: token });
  const b = await startServer({ ...to.env, SANDBOX_SERVER_TOKEN: token });
  const open = await startServer(sandboxDirs().env);
  try {
    const write = (port: number, filename: string, content: string) =>
      fetch(`http://127.0.0.1:${port}/files/write`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ filename, content }),
      });
    assert.equal((await write(a.port, "notes.txt", "kept across the upgrade")).status, 200);
    assert.equal((await write(a.port, ".browser/profile/Cookies", "session")).status, 200);

    const archive = await fetch(`http://127.0.0.1:${a.port}/archive`, { headers: auth });
    assert.equal(archive.status, 200);
    assert.equal(archive.headers.get("content-type"), "application/gzip");
    const bytes = new Uint8Array(await archive.arrayBuffer());
    assert.ok(bytes.length > 20);

    const unpacked = await fetch(`http://127.0.0.1:${b.port}/archive`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/gzip" },
      body: bytes,
    });
    assert.equal(unpacked.status, 200);
    const read = await fetch(`http://127.0.0.1:${b.port}/files/read`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ filename: "notes.txt" }),
    });
    assert.equal(((await read.json()) as { content: string }).content, "kept across the upgrade");

    assert.equal((await fetch(`http://127.0.0.1:${a.port}/archive`)).status, 401, "the token is required");
    assert.equal((await fetch(`http://127.0.0.1:${open.port}/archive`)).status, 404, "no token configured: no archive route");
    const noTokenPost = await fetch(`http://127.0.0.1:${open.port}/archive`, { method: "POST", headers: { "content-type": "application/gzip" }, body: bytes });
    assert.equal(noTokenPost.status, 415, "without a token, POSTs stay JSON-only");
  } finally {
    await Promise.all([stopServer(a.proc), stopServer(b.proc), stopServer(open.proc)]);
    rmSync(from.root, { recursive: true, force: true });
    rmSync(to.root, { recursive: true, force: true });
  }
});

test("two servers started at once each answer on their own port, with their own folder", async () => {
  const dirs = [sandboxDirs(), sandboxDirs()];
  const servers = await Promise.all(dirs.map((d) => startServer(d.env)));
  try {
    assert.notEqual(servers[0].port, servers[1].port);
    for (const [i, { port }] of servers.entries()) {
      const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { workDir: string };
      assert.equal(health.workDir, dirs[i].root);
    }
  } finally {
    await Promise.all(servers.map((s) => stopServer(s.proc)));
    for (const d of dirs) rmSync(d.root, { recursive: true, force: true });
  }
});

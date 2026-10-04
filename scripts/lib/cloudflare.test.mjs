// Tests for the Cloudflare deploy helper (scripts/lib/cloudflare.mjs), with a
// fake Cloudflare API: nothing here reaches an account.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { hyperdriveOrigin, originMoved, pgpass, sandboxImageVars, sandboxesOn, secretsPlan } from "./cloudflare.mjs";

const HELPER = fileURLToPath(new URL("./cloudflare.mjs", import.meta.url));

describe("deploy-cloudflare helper", () => {
  it("plans secrets: upload what the Worker lacks, replace only with --update, generate or ask for the needed ones", () => {
    const onWorker = new Set(["REALTIME_SIGNING_KEY", "OPENAI_API_KEY", "QUICKSTART_JWT_SECRET"]);
    const shell = new Set(["OPENAI_API_KEY", "QUICKSTART_JWT_SECRET", "ANTHROPIC_API_KEY"]);
    const names = ["REALTIME_SIGNING_KEY", "OBJECT_STORE_S3_ACCESS_KEY_ID", "OPENAI_API_KEY", "QUICKSTART_JWT_SECRET", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN"];
    const plan = (update) => Object.fromEntries(secretsPlan(names, { onWorker, inShell: (n) => shell.has(n), update }).map(([a, n]) => [n, a]));
    assert.deepEqual(plan(false), {
      REALTIME_SIGNING_KEY: "present",
      OBJECT_STORE_S3_ACCESS_KEY_ID: "ask",
      OPENAI_API_KEY: "keep",
      QUICKSTART_JWT_SECRET: "keep",
      ANTHROPIC_API_KEY: "upload",
      TELEGRAM_BOT_TOKEN: "unset",
    });
    const updated = plan(true);
    assert.equal(updated.OPENAI_API_KEY, "upload", "a corrected key replaces the Worker's");
    assert.equal(updated.QUICKSTART_JWT_SECRET, "upload", "a regenerated trial secret replaces the Worker's");
    assert.equal(updated.REALTIME_SIGNING_KEY, "present", "never regenerated when the Worker has one");
    const fresh = Object.fromEntries(secretsPlan(["REALTIME_SIGNING_KEY"], { onWorker: new Set(), inShell: () => false }).map(([a, n]) => [n, a]));
    assert.equal(fresh.REALTIME_SIGNING_KEY, "generate");
  });

  it("keeps the database password off psql's command line, whatever the URL's shape", () => {
    const plain = pgpass("postgres://us%3Aer:p%40ss%3Aw%5Cd@db.example.com:6543/agent?sslmode=require");
    assert.equal(plain.url, "postgres://us%3Aer@db.example.com:6543/agent?sslmode=require");
    assert.deepEqual(plain.lines, ["db.example.com:6543:agent:us\\:er:p@ss\\:w\\\\d"], "libpq's escaping of : and \\");
    assert.deepEqual(pgpass("postgres://u:pw@h/d").lines, ["h:5432:d:u:pw"]);
    // IPv6: the address without brackets, its colons escaped.
    const v6 = pgpass("postgres://u:pw@[2001:db8::1]:5433/d");
    assert.equal(v6.url, "postgres://u@[2001:db8::1]:5433/d");
    assert.deepEqual(v6.lines, ["2001\\:db8\\:\\:1:5433:d:u:pw"]);
    // Several hosts: a line for each.
    const multi = pgpass("postgres://u:pw@h1:5432,h2:5433/d?target_session_attrs=read-write");
    assert.equal(multi.url, "postgres://u@h1:5432,h2:5433/d?target_session_attrs=read-write");
    assert.deepEqual(multi.lines, ["h1:5432:d:u:pw", "h2:5433:d:u:pw"]);
    // A socket, or hosts in the query: pgpass can't say, so the password goes in psql's environment.
    for (const u of ["postgres://u:pw@/d?host=/var/run/postgresql", "postgres://u:pw@h/d?host=other"]) {
      const { url, lines, password } = pgpass(u);
      assert.equal(lines, null, u);
      assert.ok(!url.includes("pw"), u);
      assert.equal(password, "pw");
    }
  });

  it("reads a password from the query too, and never leaves it in the URL psql gets", () => {
    const { url, lines, password } = pgpass("postgres://u@h/d?sslmode=require&password=q%40pw&application_name=x");
    assert.equal(url, "postgres://u@h/d?sslmode=require&application_name=x");
    assert.equal(password, "q@pw");
    assert.deepEqual(lines, ["h:5432:d:u:q@pw"]);
    assert.equal(hyperdriveOrigin("postgres://u@h/d?password=qpw").password, "qpw", "Hyperdrive gets the same password");
  });

  it("parses psql's and Hyperdrive's view of a URL the same way, and refuses an ambiguous @", () => {
    const encoded = "postgres://us%40er:p%40ss@db.example.com:6543/agent";
    const { password } = pgpass(encoded);
    const origin = hyperdriveOrigin(encoded);
    assert.equal(password, "p@ss");
    assert.equal(origin.password, password, "both see the same password");
    assert.equal(origin.user, "us@er");
    assert.equal(origin.host, "db.example.com");
    for (const ambiguous of ["postgres://u:p@ss@h/d", "postgres://u@x:p@h/d"]) {
      assert.throws(() => pgpass(ambiguous), /encode an "@" .* as %40/);
      assert.throws(() => hyperdriveOrigin(ambiguous), /encode an "@" .* as %40/);
    }
  });

  it("gives Hyperdrive exactly one host", () => {
    assert.throws(() => hyperdriveOrigin("postgres://u:pw@h1:5432,h2:5433/d"), /exactly one host.*2 hosts.*HYPERDRIVE_DATABASE_URL/);
    assert.throws(() => hyperdriveOrigin("postgres://u:pw@/d?host=/var/run/postgresql"), /exactly one host.*socket/);
    assert.throws(() => hyperdriveOrigin("postgres://u:pw@h/d?host=other"), /exactly one host/);
    assert.deepEqual(hyperdriveOrigin("postgres://u:pw@[2001:db8::1]:6543/d"), {
      scheme: "postgres",
      host: "2001:db8::1",
      port: 6543,
      database: "d",
      user: "u",
      password: "pw",
    });
  });

  it("writes the pgpass file owner-only and prints the URL without the password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afe-pgpass-"));
    const file = join(dir, "pgpass");
    const out = await new Promise((resolve, reject) =>
      execFile(process.execPath, [HELPER, "pgpass", file], { env: { ...process.env, DATABASE_URL: "postgres://u:s3cret@h:5432/d" } }, (err, stdout) =>
        err ? reject(err) : resolve(stdout.trim()),
      ),
    );
    assert.equal(out, "file\npostgres://u@h:5432/d");
    assert.equal(readFileSync(file, "utf8"), "h:5432:d:u:s3cret\n");
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("knows when sandboxes are on, and when Hyperdrive's origin moved", () => {
    assert.equal(sandboxesOn({ skills: { enabled: true, sandbox: { enabled: true } } }), true);
    assert.equal(sandboxesOn({ skills: { enabled: false, sandbox: { enabled: true } } }), false);
    assert.equal(sandboxesOn({ skills: { sandbox: { enabled: false } } }), false);
    const origin = { scheme: "postgres", host: "db1", port: 5432, database: "agent", user: "u", password: "x" };
    assert.equal(originMoved({ host: "db1", port: 5432, database: "agent", user: "u" }, origin), false);
    assert.equal(originMoved({ host: "db0", port: 5432, database: "agent", user: "u" }, origin), true);
    assert.equal(originMoved(undefined, origin), true);
  });

  /** Runs `ensure` against a fake API whose Hyperdrive points at old-db; resolves with the calls and the outcome. */
  async function ensureAgainstFake({ env = {}, input = "" } = {}) {
    const calls = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/accounts/acc/hyperdrive/configs") && req.method === "GET") {
        return res.end(JSON.stringify({ success: true, result: [{ id: "hd1", name: "agentforeach", origin: { host: "old-db", port: 5432, database: "agent", user: "u" }, caching: { disabled: true } }] }));
      }
      if (req.url === "/accounts/acc/hyperdrive/configs/hd1" && req.method === "PATCH") return res.end(JSON.stringify({ success: true, result: {} }));
      if (req.url.startsWith("/accounts/acc/r2/buckets")) {
        return res.end(JSON.stringify({ success: true, result: req.method === "GET" ? { buckets: [{ name: "skills" }, { name: "user-exports" }] } : {} }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, errors: [{ code: 1, message: "no route" }] }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const state = join(mkdtempSync(join(tmpdir(), "afe-state-")), "state.json");
      const childEnv = {
        ...process.env,
        CLOUDFLARE_API_BASE: `http://127.0.0.1:${server.address().port}`,
        CLOUDFLARE_API_TOKEN: "t",
        ACCOUNT_ID: "acc",
        WORKER_NAME: "agentforeach",
        HYPERDRIVE_NAME: "agentforeach",
        DATABASE_URL: "postgres://u:newpw@new-db:5432/agent",
        PUBLIC_BASE_URL: "https://agentforeach.example.workers.dev",
        ...env,
      };
      delete childEnv.DEPLOY_YES;
      if (env.DEPLOY_YES) childEnv.DEPLOY_YES = env.DEPLOY_YES;
      const outcome = await new Promise((resolve) => {
        const child = execFile(process.execPath, [HELPER, "ensure", state], { env: childEnv }, (err, _out, stderr) => resolve({ ok: !err, stderr, state }));
        child.stdin.end(input);
      });
      return { calls, ...outcome };
    } finally {
      server.close();
    }
  }

  it("points an existing Hyperdrive at the database DATABASE_URL names, after asking", async () => {
    const { calls, ok, stderr, state } = await ensureAgainstFake({ input: "y\n" });
    assert.ok(ok, stderr);
    assert.match(stderr, /connects the live Worker to old-db:5432\/agent; DATABASE_URL names new-db:5432\/agent\. Move it\?/);
    const patch = calls.find((c) => c.method === "PATCH");
    assert.equal(patch.body.origin.host, "new-db");
    assert.equal(patch.body.origin.password, "newpw");
    assert.deepEqual(patch.body.caching, { disabled: true }, "the cache stays off");
    assert.equal(JSON.parse(readFileSync(state, "utf8")).hyperdriveId, "hd1");
  });

  it("leaves Hyperdrive alone when the move isn't confirmed", async () => {
    for (const input of ["n\n", ""]) {
      const { calls, ok, stderr } = await ensureAgainstFake({ input });
      assert.equal(ok, false, `answer ${JSON.stringify(input)}`);
      assert.match(stderr, /Stopped: Hyperdrive "agentforeach" still connects to old-db/);
      assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
    }
  });

  it("moves Hyperdrive without asking under DEPLOY_YES, and refreshes it without asking when nothing moved", async () => {
    const yes = await ensureAgainstFake({ env: { DEPLOY_YES: "1" } });
    assert.ok(yes.ok, yes.stderr);
    assert.equal(yes.calls.filter((c) => c.method === "PATCH").length, 1);
    const same = await ensureAgainstFake({ env: { DATABASE_URL: "postgres://u:rotated@old-db:5432/agent" } });
    assert.ok(same.ok, same.stderr);
    assert.doesNotMatch(same.stderr, /Move it\?/);
    assert.equal(same.calls.find((c) => c.method === "PATCH").body.origin.password, "rotated", "a rotated password still reaches Hyperdrive");
  });
});

it("the sandbox image is built with the browser when the Cloudflare sandbox declares it", () => {
  const on = (containers) => ({ skills: { sandbox: { enabled: true, containers } } });
  assert.deepEqual(sandboxImageVars(on({ browser: true })), ["SANDBOX_IMAGE_BROWSER=1"]);
  assert.deepEqual(sandboxImageVars(on({ browser: false })), []);
  assert.deepEqual(sandboxImageVars(on(undefined)), []);
  assert.deepEqual(sandboxImageVars({ skills: { sandbox: { enabled: false, containers: { browser: true } } } }), []);
});

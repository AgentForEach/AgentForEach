#!/usr/bin/env node
/**
 * Cloudflare steps for scripts/deploy-cloudflare.sh: the parts that need
 * JSON from Cloudflare's API rather than wrangler's tables. Every step is
 * idempotent: it finds what exists by name and creates only what is missing.
 *
 *   cloudflare.mjs account                      the account id (CLOUDFLARE_ACCOUNT_ID, or the only account wrangler sees)
 *   cloudflare.mjs ensure <state.json>          Hyperdrive and the R2 buckets; the Worker's public URL. Writes the state file
 *   cloudflare.mjs config-args <state.json>     arguments for scripts/cloudflare-config.mjs, one per line
 *   cloudflare.mjs missing-secrets <state.json> <NAME>...   the names not yet set on the Worker
 *   cloudflare.mjs secrets-plan <state.json> [--update] <NAME>...
 *       what to do with each secret, one "<action> <NAME>" per line: "upload", "keep" (on the
 *       Worker and in the shell; replaced only with --update), "present" (on the Worker only),
 *       "generate", "ask" or "unset"
 *   cloudflare.mjs secret-refs <agentforeach.json>          the "$NAME" values the config reads from the environment
 *   cloudflare.mjs sandboxes-on <agentforeach.json>         "yes" when the config turns sandboxes on
 *   cloudflare.mjs image-vars <agentforeach.json>           the sandbox image's build variables, KEY=VALUE per line
 *   cloudflare.mjs pgpass <file>                            for psql without the password on its command line:
 *       prints "file" or "env", then DATABASE_URL without its password. "file": the password is in
 *       <file> (0600 pgpass lines). "env": pgpass can't express this URL (a socket, or hosts in the
 *       query string); pass the password in psql's environment, from `pg-password`
 *   cloudflare.mjs pg-password                              DATABASE_URL's password (for PGPASSWORD)
 *
 * `ensure` reads: ACCOUNT_ID, WORKER_NAME, DATABASE_URL (Hyperdrive's origin),
 * HYPERDRIVE_NAME, and optionally R2_BUCKET_PREFIX (buckets are
 * <prefix>skills and <prefix>user-exports) and PUBLIC_BASE_URL (default: the
 * Worker's workers.dev URL).
 *
 * The API token is CLOUDFLARE_API_TOKEN, or wrangler's own (`wrangler auth
 * token`). WRANGLER (default "npx wrangler") and CLOUDFLARE_API_BASE
 * (default https://api.cloudflare.com/client/v4) can be replaced, which is
 * how the script is tested without an account.
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const API = process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4";
const WRANGLER = process.env.WRANGLER ?? "npx wrangler";

const say = (line) => console.error(`    ${line}`);
const fail = (message) => {
  console.error(`\nError: ${message}`);
  process.exit(1);
};

function wrangler(args) {
  const run = spawnSync(`${WRANGLER} ${args}`, { shell: true, encoding: "utf8", cwd: ROOT });
  return { ok: run.status === 0, out: run.stdout ?? "", err: run.stderr ?? "" };
}

let cachedToken;
function apiToken() {
  if (cachedToken) return cachedToken;
  if (process.env.CLOUDFLARE_API_TOKEN) return (cachedToken = process.env.CLOUDFLARE_API_TOKEN);
  const run = wrangler("auth token");
  const token = run.out.trim().split("\n").filter(Boolean).at(-1);
  if (!run.ok || !token) fail(`wrangler has no token to use (${run.err.trim() || "not logged in"}). Run: npx wrangler login`);
  return (cachedToken = token);
}

/** One API call; `allow404` returns null for a missing resource. */
async function api(method, path, body, { allow404 = false } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allow404 && response.status === 404) return null;
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.success === false) {
    const errors = (json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    fail(`Cloudflare API ${method} ${path} failed with ${response.status}${errors ? ` (${errors})` : ""}`);
  }
  return json;
}

// ── account ───────────────────────────────────────────────────────────────

function accountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const run = wrangler("whoami --json");
  if (!run.ok) fail("wrangler isn't logged in. Run: npx wrangler login");
  const accounts = JSON.parse(run.out).accounts ?? [];
  if (accounts.length === 1) return accounts[0].id;
  if (accounts.length === 0) fail("wrangler sees no Cloudflare account.");
  fail(`wrangler sees ${accounts.length} accounts. Choose one: CLOUDFLARE_ACCOUNT_ID=<id>\n${accounts.map((a) => `  ${a.id}  ${a.name}`).join("\n")}`);
}

// ── ensure ────────────────────────────────────────────────────────────────

/** Hyperdrive's origin, from a postgres:// connection string. */
export function hyperdriveOrigin(connectionString) {
  const { hosts, user, password, database, params } = parsePostgresUrl(connectionString);
  if (hosts.length !== 1 || params.has("host") || params.has("hostaddr")) {
    throw new Error(
      "Hyperdrive connects to exactly one host over the network; this URL names " +
        (hosts.length > 1 ? `${hosts.length} hosts` : "a socket or a host in its query string") +
        ". Set HYPERDRIVE_DATABASE_URL to a single-host postgres:// URL.",
    );
  }
  return {
    scheme: "postgres",
    host: hosts[0].host,
    port: Number(hosts[0].port),
    database: database || "postgres",
    user: user || params.get("user") || "",
    password,
  };
}

/**
 * Hyperdrive pools connections; its query cache is off. Today it would cache
 * nothing of the gateway's (every document read filters on now(), which
 * Hyperdrive never caches), and off it stays that way: a cached read could
 * return rows for up to its max_age after they were deleted, erasure included.
 */
const HYPERDRIVE_CACHING = { disabled: true };

/** Whether Hyperdrive's `current` origin is somewhere other than `wanted` (the password can't be read back). */
export function originMoved(current = {}, wanted) {
  return ["host", "port", "database", "user"].some((k) => String(current[k] ?? "") !== String(wanted[k] ?? ""));
}

async function ensureHyperdrive(account, name, connectionString) {
  const { result: configs = [] } = await api("GET", `/accounts/${account}/hyperdrive/configs`);
  const existing = configs.find((c) => c.name === name);
  let origin;
  try {
    origin = hyperdriveOrigin(connectionString);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  if (existing) {
    // Always follow DATABASE_URL: the schema is applied there, so the Worker must use the same
    // database, and the password (which the API never returns) may have been rotated.
    const moved = originMoved(existing.origin, origin);
    if (moved && !process.env.DEPLOY_YES) {
      const from = existing.origin?.host ? `${existing.origin.host}:${existing.origin.port}/${existing.origin.database}` : "its current database";
      const to = `${origin.host}:${origin.port}/${origin.database}`;
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      // A closed stdin (no one to ask) counts as no.
      const answer = await new Promise((resolve) => {
        rl.once("close", () => resolve(""));
        rl.question(`    Hyperdrive "${name}" connects the live Worker to ${from}; DATABASE_URL names ${to}. Move it? [y/N] `).then(resolve, () => resolve(""));
      });
      rl.close();
      process.stderr.write("\n");
      if (!/^y/i.test(answer.trim())) fail(`Stopped: Hyperdrive "${name}" still connects to ${from}. Check DATABASE_URL (or set DEPLOY_YES=1).`);
    }
    await api("PATCH", `/accounts/${account}/hyperdrive/configs/${existing.id}`, { origin, caching: HYPERDRIVE_CACHING });
    say(
      moved
        ? `Hyperdrive "${name}": now connects to ${origin.host}:${origin.port}/${origin.database}` +
            (existing.origin?.host ? ` (was ${existing.origin.host}:${existing.origin.port}/${existing.origin.database})` : "")
        : `Hyperdrive "${name}": exists (${existing.id}); connection details refreshed`,
    );
    return existing.id;
  }
  const { result } = await api("POST", `/accounts/${account}/hyperdrive/configs`, {
    name,
    origin,
    caching: HYPERDRIVE_CACHING,
  });
  say(`Hyperdrive "${name}": created (${result.id})`);
  return result.id;
}

async function ensureBuckets(account, names) {
  const have = new Set();
  let cursor = "";
  do {
    const json = await api("GET", `/accounts/${account}/r2/buckets?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const bucket of json.result?.buckets ?? []) have.add(bucket.name);
    cursor = json.result_info?.cursor ?? "";
  } while (cursor);
  for (const name of names) {
    if (have.has(name)) {
      say(`R2 bucket "${name}": exists`);
      continue;
    }
    await api("POST", `/accounts/${account}/r2/buckets`, { name });
    say(`R2 bucket "${name}": created`);
  }
}

async function workersDevUrl(account, worker) {
  const json = await api("GET", `/accounts/${account}/workers/subdomain`, undefined, { allow404: true });
  const subdomain = json?.result?.subdomain;
  if (!subdomain) {
    fail("This account has no workers.dev subdomain yet. Open Workers & Pages in the dashboard once to choose one, or set PUBLIC_BASE_URL to the Worker's own domain.");
  }
  return `https://${worker}.${subdomain}.workers.dev`;
}

async function ensure(statePath) {
  const env = process.env;
  for (const name of ["ACCOUNT_ID", "WORKER_NAME", "DATABASE_URL", "HYPERDRIVE_NAME"]) {
    if (!env[name]) fail(`${name} is not set`);
  }
  const prefix = env.R2_BUCKET_PREFIX ?? "";
  const buckets = { skills: `${prefix}skills`, "user-exports": `${prefix}user-exports` };
  const state = {
    accountId: env.ACCOUNT_ID,
    workerName: env.WORKER_NAME,
    hyperdriveId: await ensureHyperdrive(env.ACCOUNT_ID, env.HYPERDRIVE_NAME, env.DATABASE_URL),
    buckets,
    publicBaseUrl: env.PUBLIC_BASE_URL || (await workersDevUrl(env.ACCOUNT_ID, env.WORKER_NAME)),
  };
  await ensureBuckets(env.ACCOUNT_ID, Object.values(buckets));
  say(`Public URL: ${state.publicBaseUrl}`);
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ── config ────────────────────────────────────────────────────────────────

/** The deployment's values, as scripts/cloudflare-config.mjs arguments. */
export function configArgs(state) {
  const args = ["--name", state.workerName, "--hyperdrive-id", state.hyperdriveId];
  const vars = {
    OBJECT_STORE_S3_ENDPOINT: `https://${state.accountId}.r2.cloudflarestorage.com`,
    PUBLIC_BASE_URL: state.publicBaseUrl,
  };
  // Buckets named other than their containers (R2_BUCKET_PREFIX).
  if (Object.entries(state.buckets ?? {}).some(([container, bucket]) => container !== bucket)) {
    vars.OBJECT_STORE_S3_BUCKETS = JSON.stringify(state.buckets);
  }
  for (const [key, value] of Object.entries(vars)) args.push("--var", `${key}=${value}`);
  return args;
}

// ── secrets ───────────────────────────────────────────────────────────────

async function missingSecrets(statePath, names) {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const json = await api("GET", `/accounts/${state.accountId}/workers/scripts/${state.workerName}/secrets`, undefined, { allow404: true });
  const set = new Set((json?.result ?? []).map((s) => s.name));
  for (const name of names) if (!set.has(name)) console.log(name);
}

/** Secrets the deploy generates when the Worker lacks them, and the ones it asks for. */
const GENERATED = new Set(["REALTIME_SIGNING_KEY"]);
const ASKED = new Set(["OBJECT_STORE_S3_ACCESS_KEY_ID", "OBJECT_STORE_S3_SECRET_ACCESS_KEY"]);

/**
 * What to do with each secret: upload one set in the shell that the Worker
 * lacks (or, with `update`, every one set in the shell, so a rotated or
 * corrected value replaces the old); keep one the Worker has; generate or
 * ask for the ones the Worker needs; report the rest as unset.
 */
export function secretsPlan(names, { onWorker, inShell, update = false }) {
  return names.map((name) => {
    if (inShell(name)) return [onWorker.has(name) && !update ? "keep" : "upload", name];
    if (onWorker.has(name)) return ["present", name];
    if (GENERATED.has(name)) return ["generate", name];
    if (ASKED.has(name)) return ["ask", name];
    return ["unset", name];
  });
}

async function workerSecrets(statePath) {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const json = await api("GET", `/accounts/${state.accountId}/workers/scripts/${state.workerName}/secrets`, undefined, { allow404: true });
  return new Set((json?.result ?? []).map((s) => s.name));
}

/**
 * A Postgres URL's parts: the one parser for psql's credentials and
 * Hyperdrive's origin, so the two never disagree. Not WHATWG URL, which
 * can't parse multi-host URLs. A password may be in the userinfo or in the
 * query (`?password=`); `withoutPassword` has neither.
 */
export function parsePostgresUrl(connectionString) {
  const authority = /^postgres(?:ql)?:\/\/([^/?#]*)/.exec(connectionString)?.[1];
  if (authority === undefined) throw new Error("DATABASE_URL must be a postgres:// connection string");
  if ((authority.match(/@/g) ?? []).length > 1) {
    throw new Error('The database URL has more than one "@" before its host: encode an "@" in the user name or password as %40.');
  }
  const m = /^(postgres(?:ql)?:\/\/)(?:([^@/?#]*)@)?([^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/.exec(connectionString);
  if (!m) throw new Error("DATABASE_URL must be a postgres:// connection string");
  const [, scheme, userinfo, hostlist, path = "", rawQuery = ""] = m;
  const colon = userinfo === undefined ? -1 : userinfo.indexOf(":");
  const user = userinfo === undefined ? "" : decodeURIComponent(colon < 0 ? userinfo : userinfo.slice(0, colon));
  const params = new URLSearchParams(rawQuery.slice(1));
  const password = colon >= 0 ? decodeURIComponent(userinfo.slice(colon + 1)) : (params.get("password") ?? "");
  // Neither place keeps the password in the URL psql sees.
  const kept = rawQuery
    .slice(1)
    .split("&")
    .filter((pair) => pair && decodeURIComponent(pair.split("=")[0]) !== "password");
  const query = kept.length ? `?${kept.join("&")}` : "";
  const rawUser = userinfo === undefined ? undefined : colon < 0 ? userinfo : userinfo.slice(0, colon);
  const hosts = hostlist
    ? hostlist.split(",").map((h) => {
        const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(h);
        if (v6) return { host: v6[1], port: v6[2] || "5432" };
        const [host, port] = h.split(":");
        return { host: decodeURIComponent(host), port: port || "5432" };
      })
    : [];
  return {
    user,
    password,
    hosts,
    database: decodeURIComponent(path.slice(1)),
    params,
    withoutPassword: `${scheme}${rawUser !== undefined ? `${rawUser}@` : ""}${hostlist}${path}${query}`,
  };
}

/**
 * DATABASE_URL without its password, and pgpass lines with it (libpq's
 * escaping: \\ and \:; one line per host). `lines` is null when pgpass can't
 * express the URL: a socket (no host), or hosts given in the query string.
 */
export function pgpass(connectionString) {
  const { user, password, hosts, database, params, withoutPassword } = parsePostgresUrl(connectionString);
  const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  const expressible = hosts.length > 0 && !params.has("host") && !params.has("hostaddr") && !params.has("port");
  const lines = expressible
    ? hosts.map(({ host, port }) => [esc(host), esc(port), database ? esc(database) : "*", user ? esc(user) : "*", esc(password)].join(":"))
    : null;
  return { url: withoutPassword, lines, password };
}

/** Whether a config turns sandboxes on (skills and skills.sandbox both enabled). */
export function sandboxesOn(config) {
  return config?.skills?.enabled !== false && config?.skills?.sandbox?.enabled === true;
}

/**
 * The sandbox image's build variables a config needs, as KEY=VALUE: the
 * browser (Chromium and its driver) when the Cloudflare sandbox declares it.
 */
export function sandboxImageVars(config) {
  if (!sandboxesOn(config)) return [];
  return config.skills.sandbox.containers?.browser === true ? ["SANDBOX_IMAGE_BROWSER=1"] : [];
}

/** "$NAME" references in a config (env var names only). */
export function secretRefs(config) {
  const refs = new Set();
  const walk = (value) => {
    if (typeof value === "string") {
      const m = /^\$([A-Z_][A-Z0-9_]*)$/.exec(value);
      if (m) refs.add(m[1]);
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(config);
  return [...refs].sort();
}

// ── main ──────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "account") console.log(accountId());
  else if (command === "ensure" && args[0]) await ensure(args[0]);
  else if (command === "config-args" && args[0]) console.log(configArgs(JSON.parse(readFileSync(args[0], "utf8"))).join("\n"));
  else if (command === "missing-secrets" && args[0]) await missingSecrets(args[0], args.slice(1));
  else if (command === "secret-refs" && args[0]) console.log(secretRefs(JSON.parse(readFileSync(args[0], "utf8"))).join("\n"));
  else if (command === "secrets-plan" && args[0]) {
    const update = args.includes("--update");
    const names = args.slice(1).filter((a) => a !== "--update");
    const plan = secretsPlan(names, { onWorker: await workerSecrets(args[0]), inShell: (n) => !!process.env[n], update });
    console.log(plan.map(([action, name]) => `${action} ${name}`).join("\n"));
  } else if (command === "sandboxes-on" && args[0]) console.log(sandboxesOn(JSON.parse(readFileSync(args[0], "utf8"))) ? "yes" : "no");
  else if (command === "image-vars" && args[0]) {
    const vars = sandboxImageVars(JSON.parse(readFileSync(args[0], "utf8")));
    if (vars.length) console.log(vars.join("\n"));
  }
  else if (command === "pgpass" && args[0]) {
    if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set");
    let parsed;
    try {
      parsed = pgpass(process.env.DATABASE_URL);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    const { url, lines } = parsed;
    if (lines) writeFileSync(args[0], `${lines.join("\n")}\n`, { mode: 0o600 });
    console.log(`${lines ? "file" : "env"}\n${url}`);
  } else if (command === "pg-password") {
    if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set");
    process.stdout.write(pgpass(process.env.DATABASE_URL).password);
  }
  else {
    console.error("usage: cloudflare.mjs account | ensure <state> | config-args <state> | missing-secrets <state> <NAME>... | secrets-plan <state> [--update] <NAME>... | secret-refs <agentforeach.json> | sandboxes-on <agentforeach.json> | image-vars <agentforeach.json> | pgpass <file> | pg-password");
    process.exit(2);
  }
}

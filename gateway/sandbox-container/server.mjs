/**
 * AgentForEach Sandbox — HTTP Server for Custom Container Sessions
 *
 * Lightweight HTTP server that handles command execution and file operations
 * inside an ACA Dynamic Sessions custom container. Uses only Node.js built-in
 * modules (no npm dependencies needed).
 *
 * Endpoints:
 *   POST /exec         — Execute a shell command via bash
 *   POST /files/write  — Write a file to /mnt/data/
 *   POST /files/read   — Read a file from /mnt/data/
 *   GET  /files        — List files in /mnt/data/
 *   GET  /health       — Health check + runtime info
 *   POST /env          — Replace the env vars every later /exec gets
 *   GET  /archive      — /mnt/data as a gzipped tar (with a token only)
 *   POST /archive      — Unpack a gzipped tar into /mnt/data (with a token only)
 *   GET  /ping         — Health for Bedrock AgentCore Runtime ("Healthy" or "HealthyBusy")
 *   POST /invocations  — One of the routes above in a JSON envelope (with a token only)
 *
 * ACA routing: The session pool management endpoint forwards requests to this
 * server. The path after the pool endpoint maps directly to the routes above.
 *
 * AgentCore routing: InvokeAgentRuntime delivers its payload to POST
 * /invocations, so a call is the envelope {token, path, method, body}: the
 * token (compared in constant time; missing or wrong is always 401), a route
 * above, and its JSON body. The answer is {status, body}, the route's own
 * status and body, with HTTP 200, so AgentCore passes it through unchanged.
 * Archives travel base64 in the envelope: GET answers {archive}, POST takes
 * {archive} (null empties /mnt/data).
 *
 * Archive bounds: with SANDBOX_ARCHIVE_MAX_BYTES / SANDBOX_ARCHIVE_MAX_FILES
 * set (persistence that keeps /mnt/data outside the sandbox),
 * /archive is checked and bounded (workspace-archive.mjs): over a bound it
 * answers 413 {code: "archive_limit"} and never a truncated archive, and
 * POST replaces /mnt/data rather than adding to it. Unset, /archive streams
 * plain tar as before. Either way the browser saves its storage before an
 * archive is made (browser-checkpoint.mjs).
 *
 * Security: Commands do NOT run with sudo. No interactive TTY.
 *
 * Callers: a browser page inside the sandbox can reach 127.0.0.1:8080 too, so
 *   - with SANDBOX_SERVER_TOKEN set (the Cloudflare backend sets a new one on
 *     every start), every route needs it in the x-sandbox-token header; the
 *     server drops it from its own environment, so commands don't inherit it;
 *   - every POST must be application/json, which a page's no-cors request
 *     can't send, so even without a token a page can't make the server act;
 *   - an image with the browser needs the token, as a page that rebinds its
 *     own hostname to 127.0.0.1 can send JSON: without one the server
 *     refuses to start.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, readdir, stat, mkdir, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

import { createBrowserCheckpoint } from "./browser-checkpoint.mjs";
import {
  ArchiveInvalidError,
  ArchiveLimitError,
  archiveLimitsFromEnv,
  maxCompressedBytes,
  packWorkspace,
  unpackWorkspace,
} from "./workspace-archive.mjs";

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.SANDBOX_PORT ?? "8080", 10);
// Overridable so the server can run outside a container (tests, local development).
const DATA_DIR = process.env.SANDBOX_DATA_DIR ?? "/mnt/data";
// The vars set with POST /env, kept on disk so they survive a restart or a
// snapshot restore, as ACA Sandboxes keep theirs (~/.agentforeach/env).
// SANDBOX_ENV_FILE=memory keeps them in memory only: the Cloudflare backend
// sets that and applies them again after each start, so no snapshot holds them.
const ENV_IN_MEMORY = process.env.SANDBOX_ENV_FILE === "memory";
const ENV_FILE =
  process.env.SANDBOX_ENV_FILE ?? join(process.env.HOME || "/root", ".agentforeach", "env.json");
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Read once, then dropped from the environment so no command inherits it.
const SERVER_TOKEN = process.env.SANDBOX_SERVER_TOKEN || undefined;
delete process.env.SANDBOX_SERVER_TOKEN;
// Where provision-aca.sh installs the browser driver (SANDBOX_IMAGE_BROWSER=1).
const BROWSER_DIR = process.env.SANDBOX_BROWSER_DIR ?? "/opt/agentforeach/browser";
if (!SERVER_TOKEN && existsSync(BROWSER_DIR)) {
  console.error(
    `AgentForEach sandbox server: this image has the browser (${BROWSER_DIR}), so SANDBOX_SERVER_TOKEN must be set: ` +
      "a page in the browser could otherwise reach this server through DNS rebinding. " +
      "Set it to a random secret and send it in the x-sandbox-token header.",
  );
  process.exit(1);
}

// Bounds for /archive, or undefined for unbounded tar streams (see the header).
let ARCHIVE_LIMITS;
try {
  ARCHIVE_LIMITS = archiveLimitsFromEnv();
} catch (err) {
  console.error(`AgentForEach sandbox server: ${err.message}`);
  process.exit(1);
}
// The largest /invocations envelope: a tool call, or a bounded archive in base64.
const MAX_INVOCATION_BYTES = Math.max(
  8 * 1024 * 1024,
  ARCHIVE_LIMITS ? Math.ceil(maxCompressedBytes(ARCHIVE_LIMITS) / 3) * 4 + 1024 * 1024 : 0,
);
const browserCheckpoint = createBrowserCheckpoint({ dataDir: DATA_DIR });

/** The managed env vars: loaded at start, replaced by POST /env. */
let managedEnv = loadManagedEnv();

function loadManagedEnv() {
  if (ENV_IN_MEMORY) return {};
  try {
    const vars = JSON.parse(readFileSync(ENV_FILE, "utf-8"));
    return vars && typeof vars === "object" ? vars : {};
  } catch {
    return {};
  }
}
const MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 220;

// =============================================================================
// Routes
// =============================================================================

/** POST /exec — Execute a shell command */
async function handleExec(body) {
  const { command, timeout: timeoutSec = DEFAULT_TIMEOUT_SEC } = body;

  if (!command || typeof command !== "string") {
    return { status: 400, body: { error: "Missing required field: command" } };
  }

  const effectiveTimeout = Math.min(
    Math.max(1, Number(timeoutSec) || DEFAULT_TIMEOUT_SEC),
    MAX_TIMEOUT_SEC,
  );

  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const proc = spawn("bash", ["-c", command], {
      cwd: DATA_DIR,
      env: { ...process.env, ...managedEnv },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: effectiveTimeout * 1000,
    });

    proc.stdout.on("data", (chunk) => {
      if (stdoutLen < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      } else {
        truncated = true;
      }
    });

    proc.stderr.on("data", (chunk) => {
      if (stderrLen < MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      } else {
        truncated = true;
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, effectiveTimeout * 1000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      const stdout = Buffer.concat(stdoutChunks)
        .toString("utf-8")
        .slice(0, MAX_OUTPUT_BYTES);
      const stderr = Buffer.concat(stderrChunks)
        .toString("utf-8")
        .slice(0, MAX_OUTPUT_BYTES);

      resolve({
        status: 200,
        body: {
          stdout,
          stderr,
          exitCode: timedOut ? -1 : (code ?? -1),
          timedOut,
          truncated,
        },
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      resolve({
        status: 200,
        body: {
          stdout: "",
          stderr: err.message,
          exitCode: -1,
          timedOut: false,
          truncated: false,
        },
      });
    });
  });
}

/** POST /files/write — Write a file to /mnt/data/ */
async function handleFileWrite(body) {
  const { filename, content } = body;

  if (!filename || typeof filename !== "string") {
    return { status: 400, body: { error: "Missing required field: filename" } };
  }
  if (content === undefined || content === null) {
    return { status: 400, body: { error: "Missing required field: content" } };
  }

  // Sanitize: prevent path traversal
  const safe = sanitizePath(filename);
  if (!safe) {
    return { status: 400, body: { error: "Invalid filename" } };
  }

  const filepath = join(DATA_DIR, safe);

  try {
    await mkdir(dirname(filepath), { recursive: true });
    await writeFile(filepath, String(content), "utf-8");
    const stats = await stat(filepath);

    return {
      status: 200,
      body: {
        success: true,
        filename: safe,
        sizeBytes: stats.size,
      },
    };
  } catch (err) {
    return {
      status: 200,
      body: { success: false, error: err.message },
    };
  }
}

/** POST /files/read — Read a file from /mnt/data/ */
async function handleFileRead(body) {
  const { filename, encoding } = body;

  if (!filename || typeof filename !== "string") {
    return { status: 400, body: { error: "Missing required field: filename" } };
  }

  const safe = sanitizePath(filename);
  if (!safe) {
    return { status: 400, body: { error: "Invalid filename" } };
  }

  const filepath = join(DATA_DIR, safe);

  try {
    const stats = await stat(filepath);

    // Binary mode: return base64-encoded content
    if (encoding === "base64") {
      const buffer = await readFile(filepath);
      return {
        status: 200,
        body: {
          content: buffer.toString("base64"),
          filename: safe,
          sizeBytes: stats.size,
          encoding: "base64",
        },
      };
    }

    // Default: UTF-8 text
    const content = await readFile(filepath, "utf-8");

    return {
      status: 200,
      body: {
        content,
        filename: safe,
        sizeBytes: stats.size,
      },
    };
  } catch (err) {
    return {
      status: 200,
      body: { content: "", filename: safe, sizeBytes: 0, error: err.message },
    };
  }
}

/** GET /files — List files in /mnt/data/ */
async function handleFileList() {
  try {
    const entries = await readdir(DATA_DIR, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      if (entry.isFile()) {
        const stats = await stat(join(DATA_DIR, entry.name));
        files.push({
          filename: entry.name,
          size: stats.size,
          lastModified: stats.mtime.toISOString(),
        });
      }
    }

    return { status: 200, body: { files } };
  } catch (err) {
    return { status: 200, body: { files: [], error: err.message } };
  }
}

/** GET /health — Health check + runtime info */
function handleHealth() {
  const runtimes = {};

  const checks = [
    ["python3", "python3 --version 2>&1"],
    ["node", "node --version 2>&1"],
    ["java", "java --version 2>&1 | head -1"],
    ["php", "php --version 2>&1 | head -1"],
    ["ruby", "ruby --version 2>&1"],
    ["go", "go version 2>&1"],
  ];

  for (const [name, cmd] of checks) {
    try {
      runtimes[name] = execSync(cmd, { timeout: 5000 })
        .toString()
        .trim();
    } catch {
      runtimes[name] = "not available";
    }
  }

  return {
    status: 200,
    body: {
      status: "ok",
      runtimes,
      workDir: DATA_DIR,
      arch: process.arch,
      platform: process.platform,
    },
  };
}

/**
 * POST /env — Replace the env vars every later /exec gets.
 *
 * The whole set is replaced, so a var left out (a revoked credential) is
 * gone. Kept in ENV_FILE (mode 600), so it survives a restart.
 */
async function handleEnv(body) {
  const { vars } = body;

  if (!vars || typeof vars !== "object") {
    return { status: 400, body: { error: "Missing required field: vars (object)" } };
  }

  const next = {};
  for (const [key, value] of Object.entries(vars)) {
    if (ENV_KEY.test(key) && typeof value === "string") next[key] = value;
  }

  if (!ENV_IN_MEMORY) {
    await mkdir(dirname(ENV_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${ENV_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await rename(tmp, ENV_FILE);
  }
  managedEnv = next;

  return {
    status: 200,
    body: { success: true, count: Object.keys(next).length },
  };
}

// =============================================================================
// Path Sanitization
// =============================================================================

function sanitizePath(filename) {
  // Remove null bytes
  let safe = filename.replace(/\0/g, "");
  // Strip path traversal
  let prev = "";
  while (safe !== prev) {
    prev = safe;
    safe = safe.replace(/\.\./g, "");
  }
  // Remove leading slashes
  safe = safe.replace(/^\/+/, "");
  // Must have something left
  return safe || null;
}

// =============================================================================
// Callers
// =============================================================================

/** A refusal for a caller that isn't the gateway, or null to serve it. */
function refuseCaller(req, method, path) {
  // /ping answers AgentCore's health checks, which carry no token and learn
  // nothing else; /invocations carries its token in the envelope.
  if (method === "GET" && path === "/ping") return null;
  if (method === "POST" && path === "/invocations") {
    const type = String(req.headers["content-type"] ?? "").toLowerCase();
    return type.startsWith("application/json") ? null : { status: 415, body: { error: "Content-Type must be application/json" } };
  }
  if (SERVER_TOKEN) {
    const given = Buffer.from(String(req.headers["x-sandbox-token"] ?? ""));
    const expected = Buffer.from(SERVER_TOKEN);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { status: 401, body: { error: "Missing or wrong x-sandbox-token" } };
    }
  }
  if (method === "POST") {
    const type = String(req.headers["content-type"] ?? "").toLowerCase();
    // The one non-JSON body: an archive, from a caller that sent the token.
    if (SERVER_TOKEN && type === "application/gzip" && path === "/archive") return null;
    if (!type.startsWith("application/json")) {
      return { status: 415, body: { error: "Content-Type must be application/json" } };
    }
  }
  return null;
}

// =============================================================================
// Archive (moving /mnt/data to a sandbox on a new image, or to storage)
// =============================================================================

/**
 * GET /archive makes DATA_DIR a gzipped tar; POST /archive unpacks one into
 * it. Only with a token: the backend that set it is the only caller, and
 * moves a sandbox's files when its image changes or keeps them between
 * sessions (env vars are in memory and credentials outside the sandbox, so
 * neither travels).
 *
 * Unbounded (no SANDBOX_ARCHIVE_MAX_* set), the tar streams through `tar`
 * and POST adds to DATA_DIR. Bounded, both go through workspace-archive.mjs:
 * checked, within the bounds or refused whole, and POST replaces DATA_DIR.
 */
function sendArchive(res) {
  return new Promise((resolve) => {
    const tar = spawn("tar", ["-czf", "-", "-C", DATA_DIR, "."], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    tar.stderr.on("data", (d) => (stderr += d).length > 4000 && (stderr = stderr.slice(-4000)));
    res.writeHead(200, { "Content-Type": "application/gzip" });
    tar.stdout.pipe(res);
    tar.on("close", (code) => {
      // A failed tar cuts the stream short, which the caller sees as a broken archive.
      if (code !== 0) {
        console.error(`[archive] tar exited ${code}: ${stderr.trim()}`);
        res.destroy(new Error(`tar exited ${code}`));
      }
      resolve();
    });
  });
}

function receiveArchive(req) {
  return new Promise((resolve) => {
    const tar = spawn("tar", ["-xzf", "-", "-C", DATA_DIR], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let bytes = 0;
    tar.stderr.on("data", (d) => (stderr += d).length > 4000 && (stderr = stderr.slice(-4000)));
    req.on("data", (chunk) => (bytes += chunk.length));
    req.pipe(tar.stdin);
    tar.on("close", (code) =>
      resolve(code === 0 ? { status: 200, body: { ok: true, bytes } } : { status: 500, body: { error: `tar exited ${code}: ${stderr.trim()}` } }),
    );
  });
}

/** SHA-256 of the archive DATA_DIR last matched (made or unpacked), so the same one isn't unpacked again. */
let archiveDigest;
const digestOf = (archive) => createHash("sha256").update(archive ?? "empty").digest("hex");

/** A bounded archive of DATA_DIR: {archive} or a refusal. */
async function makeBoundedArchive() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const made = await browserCheckpoint.snapshot(() => packWorkspace(DATA_DIR, ARCHIVE_LIMITS));
    archiveDigest = digestOf(made.archive);
    return { status: 200, archive: made.archive, files: made.files, bytes: made.bytes };
  } catch (err) {
    return archiveRefusal(err);
  }
}

/**
 * Replace DATA_DIR with a bounded archive (null: empty). The archive DATA_DIR
 * already matches is not unpacked again, so a running browser keeps its files.
 */
async function restoreBoundedArchive(archive) {
  try {
    const digest = digestOf(archive);
    if (digest === archiveDigest) return { status: 200, body: { ok: true, restored: false } };
    await mkdir(DATA_DIR, { recursive: true });
    await browserCheckpoint.beforeRestore();
    archiveDigest = undefined;
    const { files, bytes } = await unpackWorkspace(DATA_DIR, archive, ARCHIVE_LIMITS);
    archiveDigest = digest;
    await browserCheckpoint.afterRestore();
    return { status: 200, body: { ok: true, restored: true, files, bytes } };
  } catch (err) {
    return archiveRefusal(err);
  }
}

function archiveRefusal(err) {
  if (err instanceof ArchiveLimitError) return { status: 413, body: { error: err.message, code: err.code } };
  if (err instanceof ArchiveInvalidError) return { status: 400, body: { error: err.message, code: err.code } };
  return { status: 500, body: { error: err.message } };
}

/** GET /archive over HTTP: the gzipped tar itself. */
async function handleArchiveGet(res) {
  if (!ARCHIVE_LIMITS) {
    await browserCheckpoint.snapshot(() => sendArchive(res));
    return undefined;
  }
  const made = await makeBoundedArchive();
  if (made.status !== 200) return made;
  res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": made.archive.length });
  res.end(made.archive);
  return undefined;
}

/** POST /archive over HTTP: a gzipped tar body. */
async function handleArchivePost(req) {
  if (!ARCHIVE_LIMITS) {
    await browserCheckpoint.beforeRestore();
    const result = await receiveArchive(req);
    if (result.status === 200) await browserCheckpoint.afterRestore();
    return result;
  }
  const body = await readBody(req, maxCompressedBytes(ARCHIVE_LIMITS));
  if (!body) return { status: 413, body: { error: "The archive is larger than the bound", code: "archive_limit" } };
  return restoreBoundedArchive(body);
}

/** /archive inside an /invocations envelope: base64 both ways, bounded only. */
async function archiveInEnvelope(method, body) {
  if (!ARCHIVE_LIMITS) {
    return { status: 400, body: { error: "/archive through /invocations needs SANDBOX_ARCHIVE_MAX_BYTES and SANDBOX_ARCHIVE_MAX_FILES" } };
  }
  if (method === "GET") {
    const made = await makeBoundedArchive();
    if (made.status !== 200) return made;
    return { status: 200, body: { archive: made.archive.toString("base64"), files: made.files, bytes: made.bytes } };
  }
  const archive = body?.archive;
  if (archive !== null && (typeof archive !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(archive))) {
    return { status: 400, body: { error: "Missing required field: archive (base64, or null for none)" } };
  }
  return restoreBoundedArchive(archive === null ? null : Buffer.from(archive, "base64"));
}

// =============================================================================
// Bedrock AgentCore Runtime: /ping and /invocations
// =============================================================================

/** Requests being served, so /ping says "HealthyBusy" and AgentCore keeps the session. */
let inFlight = 0;
let lastStatusChange = Math.floor(Date.now() / 1000);

function busy(delta) {
  const was = inFlight > 0;
  inFlight += delta;
  if (was !== inFlight > 0) lastStatusChange = Math.floor(Date.now() / 1000);
}

function handlePing() {
  return { status: 200, body: { status: inFlight > 0 ? "HealthyBusy" : "Healthy", time_of_last_update: lastStatusChange } };
}

function tokenMatches(given) {
  if (!SERVER_TOKEN || typeof given !== "string") return false;
  // Hashed first, so the comparison takes the same time whatever the length.
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(SERVER_TOKEN));
}

/** POST /invocations: {token, path, method, body} → {status, body}, through the same routes. */
async function handleInvocation(req) {
  const raw = await readBody(req, MAX_INVOCATION_BYTES);
  if (!raw) return { status: 413, body: { error: `The request is larger than ${MAX_INVOCATION_BYTES} bytes` } };
  let envelope;
  try {
    envelope = JSON.parse(raw.toString("utf-8"));
  } catch {
    envelope = undefined;
  }
  // Before anything else: without the token, nothing about the request matters.
  if (!envelope || typeof envelope !== "object" || !tokenMatches(envelope.token)) {
    return { status: 401, body: { error: "Missing or wrong token" } };
  }
  const { path, method = "POST", body } = envelope;
  if (typeof path !== "string" || !path.startsWith("/") || (method !== "GET" && method !== "POST")) {
    return { status: 400, body: { error: "The envelope needs path (\"/...\") and method (GET or POST)" } };
  }
  if (path === "/invocations" || path === "/ping") return { status: 400, body: { error: `${path} is not a route to wrap` } };
  const result = path === "/archive" ? await archiveInEnvelope(method, body) : await route(method, path, method === "POST" ? (body ?? {}) : undefined);
  return { status: 200, body: { status: result.status, body: result.body } };
}

// =============================================================================
// HTTP Server
// =============================================================================

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** The whole request body, or undefined (and the rest unread) past `maxBytes`. */
async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      req.resume();
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The JSON routes, shared by direct calls and /invocations envelopes. */
async function route(method, path, body) {
  if (method === "POST" && path === "/exec") return handleExec(body);
  if (method === "POST" && path === "/files/write") return handleFileWrite(body);
  if (method === "POST" && path === "/files/read") return handleFileRead(body);
  if (method === "GET" && path === "/files") return handleFileList();
  if (method === "GET" && path === "/health") return handleHealth();
  if (method === "POST" && path === "/env") return handleEnv(body);
  return { status: 404, body: { error: `Not found: ${method} ${path}` } };
}

const server = createServer(async (req, res) => {
  // Strip query string for route matching
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  let result;
  const counted = path !== "/ping";
  if (counted) busy(1);

  try {
    const refused = refuseCaller(req, method, path);
    if (refused) {
      res.writeHead(refused.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(refused.body));
      return;
    }
    if (method === "GET" && path === "/ping") {
      result = handlePing();
    } else if (method === "POST" && path === "/invocations") {
      result = await handleInvocation(req);
    } else if (SERVER_TOKEN && method === "GET" && path === "/archive") {
      result = await handleArchiveGet(res);
      if (!result) return;
    } else if (SERVER_TOKEN && method === "POST" && path === "/archive") {
      result = await handleArchivePost(req);
    } else {
      result = await route(method, path, method === "POST" ? await parseBody(req) : undefined);
    }
  } catch (err) {
    result = { status: 500, body: { error: err.message } };
  } finally {
    if (counted) busy(-1);
  }

  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(result.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.body));
});

// SANDBOX_PORT=0 takes a free port; with SANDBOX_REPORT_PORT=1 the first line
// on stdout is {"listening":<port>}, so a test reads the port it really got.
server.listen(PORT, "0.0.0.0", () => {
  const { port } = server.address();
  if (process.env.SANDBOX_REPORT_PORT === "1") console.log(JSON.stringify({ listening: port }));
  console.log(`AgentForEach sandbox server listening on port ${port}`);
});

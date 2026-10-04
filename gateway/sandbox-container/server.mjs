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
 *
 * ACA routing: The session pool management endpoint forwards requests to this
 * server. The path after the pool endpoint maps directly to the routes above.
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
import { timingSafeEqual } from "node:crypto";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

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
function refuseCaller(req, method) {
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
    if (SERVER_TOKEN && type === "application/gzip" && new URL(req.url, "http://localhost").pathname === "/archive") return null;
    if (!type.startsWith("application/json")) {
      return { status: 415, body: { error: "Content-Type must be application/json" } };
    }
  }
  return null;
}

// =============================================================================
// Archive (moving /mnt/data to a sandbox on a new image)
// =============================================================================

/**
 * GET /archive streams DATA_DIR as a gzipped tar; POST /archive unpacks one
 * into it. Only with a token: the backend that set it is the only caller,
 * and moves a sandbox's files when its image changes (env vars are in memory
 * and credentials outside the sandbox, so neither travels).
 */
function sendArchive(res) {
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

const server = createServer(async (req, res) => {
  // Strip query string for route matching
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  let result;

  try {
    const refused = refuseCaller(req, method);
    if (refused) {
      res.writeHead(refused.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(refused.body));
      return;
    }
    if (method === "POST" && path === "/exec") {
      const body = await parseBody(req);
      result = await handleExec(body);
    } else if (method === "POST" && path === "/files/write") {
      const body = await parseBody(req);
      result = await handleFileWrite(body);
    } else if (method === "POST" && path === "/files/read") {
      const body = await parseBody(req);
      result = await handleFileRead(body);
    } else if (method === "GET" && path === "/files") {
      result = await handleFileList();
    } else if (method === "GET" && path === "/health") {
      result = handleHealth();
    } else if (method === "POST" && path === "/env") {
      const body = await parseBody(req);
      result = await handleEnv(body);
    } else if (SERVER_TOKEN && method === "GET" && path === "/archive") {
      sendArchive(res);
      return;
    } else if (SERVER_TOKEN && method === "POST" && path === "/archive") {
      result = await receiveArchive(req);
    } else {
      result = { status: 404, body: { error: `Not found: ${method} ${path}` } };
    }
  } catch (err) {
    result = { status: 500, body: { error: err.message } };
  }

  res.writeHead(result.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.body));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AgentForEach sandbox server listening on port ${PORT}`);
});

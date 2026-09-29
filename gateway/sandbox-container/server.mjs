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
 *
 * ACA routing: The session pool management endpoint forwards requests to this
 * server. The path after the pool endpoint maps directly to the routes above.
 *
 * Security: Commands do NOT run with sudo. No interactive TTY.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.SANDBOX_PORT ?? "8080", 10);
const DATA_DIR = "/mnt/data";
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
 * POST /env — Set environment variables in the server process.
 *
 * These persist across all subsequent /exec calls (inherited by child processes).
 * Used for credential injection (API keys, tokens, etc.).
 */
function handleEnv(body) {
  const { vars } = body;

  if (!vars || typeof vars !== "object") {
    return { status: 400, body: { error: "Missing required field: vars (object)" } };
  }

  let count = 0;
  for (const [key, value] of Object.entries(vars)) {
    if (typeof key === "string" && typeof value === "string") {
      process.env[key] = value;
      count++;
    }
  }

  return {
    status: 200,
    body: { success: true, count },
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
      result = handleEnv(body);
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

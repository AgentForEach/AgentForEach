#!/usr/bin/env node
/**
 * afe-browser <action> [base64-json]
 *
 * What the brain runs through the sandbox's exec API for each `browser` tool
 * call. It starts Xvfb and the driver when they aren't running (a fresh or
 * resumed sandbox), sends the action over 127.0.0.1 and prints one line of
 * JSON. The payload is base64 so page text or a URL can never reach the shell.
 *
 * Payload: { args: {...}, actionMs, navMs, maxChars, viewport, idleSec, protectedHosts }
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.AFE_BROWSER_DATA_DIR ?? "/mnt/data";
const RUN_DIR = process.env.AFE_BROWSER_RUN_DIR ?? "/tmp/afe-browser";
const STATE = join(RUN_DIR, "daemon.json");
const LOCK = join(RUN_DIR, "start.lock");
const DISPLAY_NUM = 99;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function print(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function call(daemon, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port: daemon.port,
        method,
        path,
        timeout: timeoutMs,
        headers: {
          "x-afe-token": daemon.token,
          ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`driver replied ${res.statusCode}: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`driver did not answer within ${Math.round(timeoutMs / 1000)} s`)));
    req.on("error", reject);
    req.end(data);
  });
}

/** The running driver, or undefined. */
async function running() {
  if (!existsSync(STATE)) return undefined;
  try {
    const daemon = JSON.parse(readFileSync(STATE, "utf8"));
    const pong = await call(daemon, "GET", "/ping", undefined, 3000);
    return pong.ok ? daemon : undefined;
  } catch {
    return undefined;
  }
}

function alive(pattern) {
  try {
    execFileSync("pgrep", ["-f", pattern], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function ensureDisplay(viewport) {
  const socket = `/tmp/.X11-unix/X${DISPLAY_NUM}`;
  if (existsSync(socket) && alive(`^Xvfb :${DISPLAY_NUM}`)) return;
  // After a suspend the socket file outlives the Xvfb that made it; clear both so we wait for the new one.
  rmSync(`/tmp/.X${DISPLAY_NUM}-lock`, { force: true });
  rmSync(socket, { force: true });
  let failed;
  const xvfb = spawn("Xvfb", [`:${DISPLAY_NUM}`, "-screen", "0", `${viewport}x24`, "-nolisten", "tcp"], {
    detached: true,
    stdio: "ignore",
  });
  xvfb.on("error", (err) => (failed = err));
  xvfb.unref();
  for (let i = 0; i < 50 && !existsSync(socket) && !failed; i++) await sleep(100);
  if (failed) throw new Error(`Xvfb could not start: ${failed.message}`);
  if (!existsSync(socket)) throw new Error("Xvfb did not start");
}

/** Start the driver, one starter at a time (parallel tool calls race here). */
async function start(opts) {
  mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  for (let i = 0; ; i++) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      const age = Date.now() - (statSync(LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 60_000) rmSync(LOCK, { recursive: true, force: true });
      if (i > 600) throw new Error("timed out waiting for another browser start");
      await sleep(100);
    }
  }
  try {
    const already = await running();
    if (already) return already;

    const headless = process.env.AFE_BROWSER_HEADLESS === "1";
    if (!headless) await ensureDisplay(opts.viewport);
    rmSync(STATE, { force: true });
    const log = openSync(join(RUN_DIR, "driver.log"), "w");
    const driver = spawn(process.execPath, [join(HERE, "driver.mjs")], {
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        ...(headless ? {} : { DISPLAY: `:${DISPLAY_NUM}` }),
        AFE_BROWSER_RUN_DIR: RUN_DIR,
        AFE_BROWSER_VIEWPORT: opts.viewport,
        AFE_BROWSER_IDLE_SEC: String(opts.idleSec),
      },
    });
    driver.unref();
    for (let i = 0; i < 300; i++) {
      await sleep(100);
      const daemon = await running();
      if (daemon) return daemon;
      if (driver.exitCode !== null) break;
    }
    const tail = existsSync(join(RUN_DIR, "driver.log"))
      ? readFileSync(join(RUN_DIR, "driver.log"), "utf8").trim().split("\n").slice(-5).join(" | ")
      : "";
    throw new Error(`the browser did not start${tail ? `: ${tail.slice(0, 400)}` : ""}`);
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

const [action, encoded] = process.argv.slice(2);
if (!action) {
  print({ ok: false, error: "usage: afe-browser <action> [base64-json]" });
  process.exit(2);
}

let payload = {};
try {
  payload = encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : {};
} catch {
  print({ ok: false, error: "the payload is not base64 JSON" });
  process.exit(2);
}

const opts = {
  viewport: /^\d{3,4}x\d{3,4}$/.test(payload.viewport ?? "") ? payload.viewport : "1280x800",
  idleSec: Number(payload.idleSec) || 120,
};
const message = {
  action,
  args: payload.args ?? {},
  actionMs: payload.actionMs,
  navMs: payload.navMs,
  maxChars: payload.maxChars,
  protectedHosts: payload.protectedHosts ?? [],
};
// The driver stops any action at max(navMs, actionMs) + 25 s; this leaves room for its answer.
const replyWithin = Math.max(Number(payload.navMs) || 45_000, Number(payload.actionMs) || 30_000) + 35_000;

try {
  let daemon = await running();
  if (!daemon && action === "reset") {
    // Nothing running: clearing the profile is all reset has to do.
    rmSync(join(DATA, ".browser"), { recursive: true, force: true });
    print({ ok: true, action, reset: true });
    process.exit(0);
  }
  daemon ??= await start(opts);
  let result;
  try {
    result = await call(daemon, "POST", "/action", message, replyWithin);
  } catch (err) {
    // Refused means the driver exited (idle, suspend) before it saw the action: safe to start one and send it again.
    // A reset or hang-up means it died mid-action; sending it again could click or submit twice.
    if (!/ECONNREFUSED/.test(err.message)) {
      throw new Error(
        /ECONNRESET|socket hang up/.test(err.message)
          ? "The browser stopped during this action. Take a snapshot to see what happened before trying again."
          : err.message,
      );
    }
    daemon = await start(opts);
    result = await call(daemon, "POST", "/action", message, replyWithin);
  }
  print(result);
} catch (err) {
  print({ ok: false, action, error: err.message });
  process.exit(1);
}

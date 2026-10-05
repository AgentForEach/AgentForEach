/**
 * Test support: run the sandbox server (sandbox-container/server.mjs) as a
 * local process, as the sandbox tests do. Not used at runtime.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** gateway/sandbox-container/server.mjs, found from this file (source or dist). */
export function serverPath(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const candidate = join(dir, "sandbox-container", "server.mjs");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error("sandbox-container/server.mjs not found");
  }
}

/**
 * Start server.mjs with `env` on a port of its own; resolves once it answers.
 * The server takes a free port itself (SANDBOX_PORT=0) and reports it
 * (SANDBOX_REPORT_PORT=1), so no other process can take the port between a
 * probe and the start, and a test never talks to another test's server.
 */
export async function startServer(
  env: Record<string, string>,
  ready: (port: number) => Promise<boolean> = async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).status < 500,
): Promise<{ proc: ChildProcess; port: number }> {
  const proc = spawn(process.execPath, [serverPath()], {
    env: { ...process.env, ...env, SANDBOX_PORT: "0", SANDBOX_REPORT_PORT: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  // Up to 15 s: under a full parallel test run, a node process can take a few seconds to listen.
  const deadline = Date.now() + 15_000;
  let port: number;
  try {
    port = await reportedPort(proc, deadline);
  } catch (err) {
    proc.kill();
    throw err;
  }
  while (Date.now() < deadline) {
    try {
      if (await ready(port)) return { proc, port };
    } catch {
      // not answering yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  proc.kill();
  throw new Error("sandbox server did not start");
}

/** The port in the server's {"listening":<port>} line; the rest of its output is drained. */
function reportedPort(proc: ChildProcess, deadline: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    let found = false;
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      proc.off("exit", onExit);
      fn();
    };
    const onExit = () => settle(() => reject(new Error(`sandbox server exited (${proc.exitCode}) before listening`)));
    const timer = setTimeout(() => settle(() => reject(new Error("sandbox server did not report its port"))), Math.max(0, deadline - Date.now()));
    proc.once("exit", onExit);
    proc.stdout!.on("data", (chunk: Buffer) => {
      if (found) return;
      buffered += chunk.toString("utf8");
      const match = /^\{"listening":(\d+)\}$/m.exec(buffered);
      if (!match) return;
      found = true;
      settle(() => resolve(Number(match[1])));
    });
  });
}

export function stopServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");
  });
}

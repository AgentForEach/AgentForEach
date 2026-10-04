/**
 * Test support: run the sandbox server (sandbox-container/server.mjs) as a
 * local process, as the sandbox tests do. Not used at runtime.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
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

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

/** Start server.mjs with `env` on a free port; resolves once it answers. */
export async function startServer(
  env: Record<string, string>,
  ready: (port: number) => Promise<boolean> = async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).status < 500,
): Promise<{ proc: ChildProcess; port: number }> {
  const port = await freePort();
  const proc = spawn(process.execPath, [serverPath()], {
    env: { ...process.env, ...env, SANDBOX_PORT: String(port) },
    stdio: "ignore",
  });
  // Up to 15 s: under a full parallel test run, a node process can take a few seconds to listen.
  for (let i = 0; i < 300; i++) {
    try {
      if (await ready(port)) return { proc, port };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  proc.kill();
  throw new Error("sandbox server did not start");
}

export function stopServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");
  });
}

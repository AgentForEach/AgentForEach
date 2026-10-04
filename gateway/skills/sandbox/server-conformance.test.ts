/**
 * The sandbox conformance suite against the sandbox server itself
 * (sandbox-container/server.mjs), run as a local process per sandbox: the
 * same server every container backend runs (Dynamic Sessions custom
 * containers, Cloudflare Containers), reached through the shared
 * SandboxServerClient. Sleep stops the process; waking starts it again on
 * the same disk, as a snapshot restore does.
 *
 * This is a test stand-in, not a provider: it runs commands on the host.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import {
  SandboxServerClient,
  SandboxUnsupportedError,
  type EgressCredential,
  type SandboxBackend,
  type SandboxCapabilities,
} from "@agentforeach/platform";
import { runSandboxConformance } from "@agentforeach/platform/sandbox/conformance";
import { startServer, stopServer } from "./server-process.testkit.js";

class LocalServerSandbox implements SandboxBackend {
  readonly capabilities: SandboxCapabilities = { browser: false, egressCredentials: false, persistence: "disk" };
  readonly root = mkdtempSync(join(tmpdir(), "afe-sandbox-"));
  private readonly running = new Map<string, { proc: ChildProcess; port: number }>();
  private readonly server: SandboxServerClient;

  constructor() {
    this.server = new SandboxServerClient({
      defaultTimeoutSec: 60,
      transport: async (identifier, path, init) => {
        const { port } = await this.ensure(identifier);
        return fetch(`http://127.0.0.1:${port}${path}`, {
          method: init.method,
          body: init.body,
          headers: init.body ? { "content-type": "application/json" } : undefined,
        });
      },
    });
  }

  dataDir(identifier: string): string {
    return join(this.root, identifier, "data");
  }

  private async ensure(identifier: string): Promise<{ proc: ChildProcess; port: number }> {
    const current = this.running.get(identifier);
    if (current) return current;
    mkdirSync(this.dataDir(identifier), { recursive: true });
    const entry = await startServer({
      SANDBOX_DATA_DIR: this.dataDir(identifier),
      SANDBOX_ENV_FILE: join(this.root, identifier, "env.json"),
    });
    this.running.set(identifier, entry);
    return entry;
  }

  /** Stop the server process; the next call starts it again on the same disk. */
  async stop(identifier: string): Promise<void> {
    const entry = this.running.get(identifier);
    if (!entry) return;
    this.running.delete(identifier);
    await stopServer(entry.proc);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  exec: SandboxBackend["exec"] = (args, id) => this.server.exec(args, id);
  fileWrite: SandboxBackend["fileWrite"] = (args, id) => this.server.fileWrite(args, id);
  fileRead: SandboxBackend["fileRead"] = (args, id) => this.server.fileRead(args, id);
  fileList: SandboxBackend["fileList"] = (id) => this.server.fileList(id);
  fileReadBinary: SandboxBackend["fileReadBinary"] = (args, id) => this.server.fileReadBinary(args, id);
  setEnv: SandboxBackend["setEnv"] = (vars, id) => this.server.setEnv(vars, id);

  async setEgressCredentials(_credentials: EgressCredential[], _identifier: string): Promise<void> {
    throw new SandboxUnsupportedError("setEgressCredentials", "local sandbox server");
  }

  async deleteUserSandboxes(userId: string): Promise<number> {
    const identifier = this.resolveIdentifier(userId);
    const existed = existsSync(join(this.root, identifier));
    await this.stop(identifier);
    rmSync(join(this.root, identifier), { recursive: true, force: true });
    return existed ? 1 : 0;
  }

  resolveIdentifier(userId: string): string {
    return userId.replace(/[^A-Za-z0-9_-]/g, "_");
  }

  isReady(): boolean {
    return true;
  }
}

const local = new LocalServerSandbox();
after(async () => {
  await local.stopAll();
  rmSync(local.root, { recursive: true, force: true });
});

runSandboxConformance({
  name: "sandbox server (local process)",
  createBackend: () => local,
  sleep: (_backend, identifier) => local.stop(identifier),
  dataDir: (identifier) => realpathSync(local.dataDir(identifier)),
  timeoutMs: 60_000,
});

/**
 * Test support: a stand-in for Bedrock AgentCore Runtime and S3.
 *
 * FakeAgentCore answers InvokeAgentRuntime by starting the real sandbox
 * server (gateway/sandbox-container/server.mjs) as a local process per
 * runtime session, as AgentCore starts a microVM per session, and posting
 * the payload to its /invocations; StopRuntimeSession stops it and deletes
 * its disk. `expire` drops sessions as AgentCore's idle timeout does.
 * FakeS3 keeps objects in memory with S3's conditional-write rules.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

/** gateway/sandbox-container/server.mjs, found from this file. */
function serverPath(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const candidate = join(dir, "gateway", "sandbox-container", "server.mjs");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error("gateway/sandbox-container/server.mjs not found");
  }
}

type Session = { proc: ChildProcess; port: number; root: string };

export class FakeAgentCore {
  readonly root = mkdtempSync(join(tmpdir(), "afe-agentcore-"));
  readonly sessions = new Map<string, Promise<Session>>();
  /** Every command sent, for assertions. */
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  /** Throw this from the next InvokeAgentRuntime instead of answering. */
  failNext?: Error;

  constructor(private readonly env: Record<string, string>) {}

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const name = command.constructor.name;
    this.calls.push({ name, input: command.input });
    const sessionId = String(command.input.runtimeSessionId);
    if (name === "StopRuntimeSessionCommand") {
      if (!this.sessions.has(sessionId)) throw Object.assign(new Error("no such session"), { name: "ResourceNotFoundException" });
      await this.stop(sessionId);
      return {};
    }
    if (name !== "InvokeAgentRuntimeCommand") throw new Error(`unexpected command ${name}`);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = undefined;
      throw err;
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]{32,255}$/.test(sessionId)) throw new Error(`invalid runtimeSessionId ${sessionId}`);
    const session = await this.session(sessionId);
    const response = await fetch(`http://127.0.0.1:${session.port}/invocations`, {
      method: "POST",
      headers: { "content-type": String(command.input.contentType) },
      body: Buffer.from(command.input.payload as Uint8Array).toString("utf8"),
    });
    return { statusCode: response.status, contentType: "application/json", response: Readable.fromWeb(response.body as never) };
  }

  private session(sessionId: string): Promise<Session> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = start(join(this.root, createHash("sha256").update(sessionId).digest("hex").slice(0, 16)), this.env);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /** Stop a session and delete its disk, as AgentCore does when it ends. */
  async stop(sessionId: string): Promise<void> {
    const session = await this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (!session) return;
    await new Promise<void>((resolve) => {
      if (session.proc.exitCode !== null) return resolve();
      session.proc.once("exit", () => resolve());
      session.proc.kill("SIGTERM");
    });
    rmSync(session.root, { recursive: true, force: true });
  }

  /** End every session (idle timeout, a new runtime version...). */
  async expire(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  async close(): Promise<void> {
    await this.expire();
    rmSync(this.root, { recursive: true, force: true });
  }
}

async function start(root: string, env: Record<string, string>): Promise<Session> {
  mkdirSync(join(root, "data"), { recursive: true });
  const proc = spawn(process.execPath, [serverPath()], {
    env: {
      ...process.env,
      ...env,
      SANDBOX_DATA_DIR: join(root, "data"),
      SANDBOX_ENV_FILE: join(root, "env.json"),
      SANDBOX_PORT: "0",
      SANDBOX_REPORT_PORT: "1",
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("sandbox server did not start")), 15_000);
    proc.once("exit", (code) => reject(new Error(`sandbox server exited (${code})`)));
    proc.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const match = /^\{"listening":(\d+)\}$/m.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  return { proc, port, root };
}

type S3Object = { body: string; etag: string };

/** S3 in memory: GetBucketVersioning, GetObject, conditional PutObject. */
export class FakeS3 {
  readonly objects = new Map<string, S3Object>();
  versioning?: "Enabled" | "Suspended";
  /** Throw this from the next PutObject of a body containing `match`. */
  failPut?: { match: string; error: Error };

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const name = command.constructor.name;
    const input = command.input;
    if (name === "GetBucketVersioningCommand") return this.versioning ? { Status: this.versioning } : {};
    const key = String(input.Key);
    const existing = this.objects.get(key);
    if (name === "GetObjectCommand") {
      // Without s3:ListBucket, a missing key is AccessDenied, not NoSuchKey.
      if (!existing) throw Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
      return { ETag: existing.etag, Body: Readable.from([Buffer.from(existing.body)]) };
    }
    if (name !== "PutObjectCommand") throw new Error(`unexpected command ${name}`);
    const body = String(input.Body);
    if (this.failPut && body.includes(this.failPut.match)) {
      const { error } = this.failPut;
      this.failPut = undefined;
      throw error;
    }
    if ((input.IfNoneMatch === "*" && existing) || (input.IfMatch !== undefined && existing?.etag !== input.IfMatch)) {
      throw Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), { name: "PreconditionFailed" });
    }
    const etag = `"${createHash("md5").update(body).update(String(Math.random())).digest("hex")}"`;
    this.objects.set(key, { body, etag });
    return { ETag: etag };
  }

  /** The stored checkpoint of a workspace key, parsed. */
  checkpoint(key: string): Record<string, unknown> | undefined {
    const object = this.objects.get(`workspaces/v1/${key}.json`);
    return object && JSON.parse(object.body);
  }
}

/**
 * A client for the sandbox server (`server.mjs` in the AgentForEach sandbox
 * image, port 8080): exec, files and env over HTTP. Backends that run that
 * image (Cloudflare Containers, a local container, ...) implement the exec
 * and file half of `SandboxBackend` with it, and supply only the transport:
 * how a request reaches one sandbox's server.
 *
 * Server API: POST /exec {command, timeout} -> {stdout, stderr, exitCode,
 * timedOut, truncated}; POST /files/write {filename, content}; POST
 * /files/read {filename, encoding?}; GET /files; POST /env {vars} (replaces
 * the set); GET /health.
 */

import type {
  SandboxExecArgs,
  SandboxExecResult,
  SandboxFileInfo,
  SandboxFileReadArgs,
  SandboxFileReadBinaryResult,
  SandboxFileReadResult,
  SandboxFileWriteArgs,
  SandboxFileWriteResult,
} from "./types.js";
import { readBodyText } from "../http/body.js";
import { truncate } from "./shared.js";

/** Sends one request to the server of the sandbox `identifier`. */
export type SandboxServerTransport = (
  identifier: string,
  path: string,
  init: { method: "GET" | "POST"; body?: string },
) => Promise<Response>;

export interface SandboxServerClientOptions {
  transport: SandboxServerTransport;
  /** Exec timeout when the call gives none, in seconds. Default 120. */
  defaultTimeoutSec?: number;
  /** Longest exec timeout, in seconds. Default 220 (the server's own cap). */
  maxTimeoutSec?: number;
  /** Text returned to the model is cut at this many characters. Default 50000. */
  maxOutputChars?: number;
  /** Largest file read as binary (an export). Default 50 MiB. */
  maxExportBytes?: number;
}

/** A sandbox server request failed; `status` is the HTTP status (404 for a missing file). */
export class SandboxServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SandboxServerError";
  }
}

type ExecWire = { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean; truncated?: boolean };
type FileWire = { content?: string; filename?: string; sizeBytes?: number; success?: boolean; error?: string };
type ListWire = { files?: SandboxFileInfo[]; error?: string };

/** Extra seconds the request waits beyond the exec timeout (server start-up, transfer). */
const EXEC_GRACE_SEC = 30;
/** Largest response read for calls without a limit of their own (exec output is capped by the server). */
const DEFAULT_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
/** Room for the JSON around a file's content. */
const RESPONSE_OVERHEAD_BYTES = 1024 * 1024;

export class SandboxServerClient {
  private readonly transport: SandboxServerTransport;
  private readonly defaultTimeoutSec: number;
  private readonly maxTimeoutSec: number;
  private readonly maxOutputChars: number;
  private readonly maxExportBytes: number;

  constructor(options: SandboxServerClientOptions) {
    this.transport = options.transport;
    this.defaultTimeoutSec = options.defaultTimeoutSec ?? 120;
    this.maxTimeoutSec = options.maxTimeoutSec ?? 220;
    this.maxOutputChars = options.maxOutputChars ?? 50_000;
    this.maxExportBytes = options.maxExportBytes ?? 50 * 1024 * 1024;
  }

  async exec(args: SandboxExecArgs, identifier: string): Promise<SandboxExecResult> {
    const timeout = Math.min(Math.max(1, args.timeout ?? this.defaultTimeoutSec), this.maxTimeoutSec);
    const started = Date.now();
    const wire = await this.call<ExecWire>(identifier, "/exec", { command: args.command, timeout });
    const stdout = truncate(wire.stdout ?? "", this.maxOutputChars);
    const stderr = truncate(wire.stderr ?? "", this.maxOutputChars);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: wire.exitCode ?? -1,
      timedOut: wire.timedOut ?? false,
      truncated: (wire.truncated ?? false) || stdout.truncated || stderr.truncated,
      durationMs: Date.now() - started,
      sessionId: identifier,
    };
  }

  async fileWrite(args: SandboxFileWriteArgs, identifier: string): Promise<SandboxFileWriteResult> {
    const wire = await this.call<FileWire>(identifier, "/files/write", { filename: args.filename, content: args.content });
    if (wire.success === false || wire.error) {
      throw new SandboxServerError(`Failed to write ${args.filename}: ${wire.error ?? "unknown error"}`, 500);
    }
    return {
      success: true,
      filename: wire.filename ?? args.filename,
      sizeBytes: wire.sizeBytes ?? 0,
      sessionId: identifier,
    };
  }

  async fileRead(args: SandboxFileReadArgs, identifier: string): Promise<SandboxFileReadResult> {
    const wire = await this.read(args.filename, identifier, undefined);
    const content = truncate(wire.content ?? "", this.maxOutputChars);
    return {
      content: content.text,
      filename: wire.filename ?? args.filename,
      sizeBytes: wire.sizeBytes ?? 0,
      sessionId: identifier,
      ...(content.truncated ? { truncated: true } : {}),
    };
  }

  async fileReadBinary(args: SandboxFileReadArgs, identifier: string): Promise<SandboxFileReadBinaryResult> {
    const wire = await this.read(args.filename, identifier, "base64");
    const sizeBytes = wire.sizeBytes ?? 0;
    if (sizeBytes > this.maxExportBytes) {
      throw new SandboxServerError(
        `File too large for export (max ${this.maxExportBytes} bytes / ${this.maxExportBytes / 1024 / 1024} MB)`,
        413,
      );
    }
    return { contentBase64: wire.content ?? "", filename: wire.filename ?? args.filename, sizeBytes, sessionId: identifier };
  }

  async fileList(identifier: string): Promise<SandboxFileInfo[]> {
    const wire = await this.call<ListWire>(identifier, "/files");
    return (wire.files ?? []).map((f) => ({ filename: f.filename, size: f.size, lastModified: f.lastModified }));
  }

  /** Replace the env vars every later exec gets (an empty set clears them). */
  async setEnv(vars: Record<string, string>, identifier: string): Promise<void> {
    const safe = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key.replace(/[^A-Za-z0-9_]/g, "_"), value]));
    await this.call(identifier, "/env", { vars: safe });
  }

  /** Whether the sandbox's server answers (starting it if the transport does that). */
  async health(identifier: string): Promise<boolean> {
    try {
      const response = await this.transport(identifier, "/health", { method: "GET" });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  private async read(filename: string, identifier: string, encoding: "base64" | undefined): Promise<FileWire> {
    // The server sends the whole file. Text for the model needs at most 4
    // bytes per character; a binary read is base64 of up to maxExportBytes.
    const limit = encoding
      ? Math.ceil(this.maxExportBytes / 3) * 4 + RESPONSE_OVERHEAD_BYTES
      : this.maxOutputChars * 4 * 2 + RESPONSE_OVERHEAD_BYTES;
    let wire: FileWire;
    try {
      wire = await this.call<FileWire>(identifier, "/files/read", encoding ? { filename, encoding } : { filename }, limit);
    } catch (err) {
      if (err instanceof SandboxServerError && err.status === 413) {
        throw new SandboxServerError(
          encoding
            ? `File too large for export (max ${this.maxExportBytes} bytes / ${this.maxExportBytes / 1024 / 1024} MB)`
            : `${filename} is too large to read whole. Read part of it with sandbox_exec ` +
                `(for example: head -c 100000 "/mnt/data/${filename}").`,
          413,
        );
      }
      throw err;
    }
    if (wire.error) {
      // The server answers 200 with an error for a file it can't read.
      const missing = /ENOENT|no such file/i.test(wire.error);
      throw new SandboxServerError(
        missing ? `File not found: ${filename} (404)` : `Failed to read ${filename}: ${wire.error}`,
        missing ? 404 : 500,
      );
    }
    return wire;
  }

  private async call<T>(identifier: string, path: string, body?: unknown, maxBytes = DEFAULT_RESPONSE_LIMIT_BYTES): Promise<T> {
    const response = await this.transport(identifier, path, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await readBounded(response, maxBytes);
    if (!response.ok) {
      throw new SandboxServerError(`sandbox server ${path}: ${response.status} ${text.slice(0, 500)}`, response.status);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SandboxServerError(`sandbox server ${path}: not JSON: ${text.slice(0, 200)}`, 502);
    }
  }
}

/** How long a transport should wait for an exec of `timeoutSec`. */
export function execRequestTimeoutMs(timeoutSec: number): number {
  return (timeoutSec + EXEC_GRACE_SEC) * 1000;
}

/** The response body as text, refusing (413) one longer than `maxBytes` without reading the rest. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const { text, truncated } = await readBodyText(response, maxBytes);
  if (truncated) throw new SandboxServerError(`sandbox server response is larger than ${maxBytes} bytes`, 413);
  return text;
}

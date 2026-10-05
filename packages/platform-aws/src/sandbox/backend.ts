/**
 * The `aws-agentcore` sandbox backend: each sandbox is an Amazon Bedrock
 * AgentCore Runtime session running the shared sandbox image (server.mjs),
 * reached through the shared SandboxServerClient over InvokeAgentRuntime
 * (./transport.ts). The agent loop stays in the gateway; AgentCore only
 * runs the sandbox.
 *
 * Two storage modes:
 *   - "ephemeral" (persistence "disk"): files live as long as the runtime
 *     session (until its idle timeout or maximum lifetime);
 *   - "s3-checkpoint" (persistence "data", bounded by persistenceLimits):
 *     /mnt/data is restored from and saved to an S3 checkpoint around every
 *     operation (./persistent-workspace.ts), so it survives the session.
 *
 * Runtime session ids are hashes, scoped to the owner (a hash of the user
 * id): no user id reaches AWS. Calls on one owner's sandboxes are run one at
 * a time in this process, and across instances the checkpoint lease does
 * the same. Erasure starts the owner's next generation (new session ids,
 * and older checkpoints are never restored), fences the checkpoints, and
 * stops every session the owner started.
 *
 * Register it from the AWS entry point:
 *
 * ```ts
 * registerSandboxProvider(AWS_AGENTCORE_PROVIDER, (config) =>
 *   new AwsAgentCoreSandbox({ ...agentcoreSandboxOptions(config), storage: getSharedStorage() }));
 * ```
 */

import { createHash } from "node:crypto";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { S3Client } from "@aws-sdk/client-s3";
import {
  SandboxPersistenceLimitError,
  SandboxServerClient,
  SandboxUnsupportedError,
  encodeSandboxIdentifier,
  sandboxIdentifierOwner,
  type EgressCredential,
  type SandboxBackend,
  type SandboxCapabilities,
  type SandboxPersistenceLimits,
} from "@agentforeach/platform";
import type { StorageAdapter } from "@agentforeach/storage";
import { S3WorkspaceCheckpoints, type S3Sender } from "./checkpoints.js";
import { PersistentWorkspaces, type WorkspaceCompute } from "./persistent-workspace.js";
import { AwsSessionStore, ownerHash } from "./session-store.js";
import { AgentCoreTransport, type AgentCoreSender } from "./transport.js";
import { AwsWorkspaceStore } from "./workspace-store.js";

export interface AwsAgentCoreSandboxOptions {
  /** The AgentCore runtime: arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>. */
  runtimeArn: string;
  /** The runtime endpoint (default: DEFAULT). */
  qualifier?: string;
  /** Default: the ARN's region (and it must match). */
  region?: string;
  /** The runtime's SANDBOX_SERVER_TOKEN, sent in every /invocations envelope. */
  serverToken: string;
  /** "ephemeral" (default) or "s3-checkpoint". */
  storageMode?: "ephemeral" | "s3-checkpoint";
  /** s3-checkpoint: the bucket of checkpoints (never versioned). */
  workspaceBucket?: string;
  /** s3-checkpoint: the account that must own it. Default: the runtime ARN's account. */
  expectedBucketOwner?: string;
  /**
   * s3-checkpoint: what a checkpoint keeps. Must equal the runtime's
   * SANDBOX_ARCHIVE_MAX_BYTES / SANDBOX_ARCHIVE_MAX_FILES. Default 32 MiB
   * and 10,000 entries; maxBytes at most 64 MiB (an archive travels whole
   * in one InvokeAgentRuntime payload, 100 MB at most).
   */
  persistenceLimits?: SandboxPersistenceLimits;
  /** One sandbox per user ("userId", default) or per conversation ("sessionId"). */
  identifierStrategy?: "userId" | "sessionId";
  /** The runtime's image was built with the browser (SANDBOX_IMAGE_BROWSER=1). Default false. */
  browser?: boolean;
  defaultTimeoutSec?: number;
  maxTimeoutSec?: number;
  maxOutputChars?: number;
  maxExportBytes?: number;
  /** The database: aws-sandbox-sessions and aws-sandbox-workspaces. */
  storage: StorageAdapter;
  /** s3-checkpoint: how long a call waits while another instance works on the owner's sandbox. Default 30 s. */
  leaseWaitMs?: number;
  /** Clients, for tests. They must not retry (maxAttempts: 1). */
  agentCore?: AgentCoreSender;
  s3?: S3Sender;
  now?: () => number;
}

export const DEFAULT_PERSISTENCE_LIMITS: SandboxPersistenceLimits = { maxBytes: 32 * 1024 * 1024, maxFiles: 10_000 };
const MAX_PERSISTENCE_BYTES = 64 * 1024 * 1024;
const RUNTIME_ARN = /^arn:(aws|aws-us-gov|aws-cn):bedrock-agentcore:([a-z0-9-]+):(\d{12}):runtime\/[A-Za-z0-9_-]+$/;
const QUALIFIER = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

/** A sandbox's owner hash and key (afe-<owner>-<24 hex>), from its identifier. */
export function sandboxKey(identifier: string): { owner: string; key: string } {
  const owner = ownerHash(sandboxIdentifierOwner(identifier));
  return { owner, key: `afe-${owner}-${createHash("sha256").update(identifier).digest("hex").slice(0, 24)}` };
}

/** The largest bounded archive in base64 (server.mjs's: maxBytes plus 1 MiB, compressed). */
function maxArchiveChars(limits: SandboxPersistenceLimits): number {
  return Math.ceil((limits.maxBytes + 1024 * 1024) / 3) * 4;
}

export class AwsAgentCoreSandbox implements SandboxBackend {
  readonly capabilities: SandboxCapabilities;
  readonly erasureNotes: readonly string[];
  private readonly runtimeArn: string;
  private readonly qualifier?: string;
  private readonly identifierStrategy: "userId" | "sessionId";
  private readonly limits: { defaultTimeoutSec: number; maxTimeoutSec: number; maxOutputChars: number; maxExportBytes: number };
  private readonly transport: AgentCoreTransport;
  private readonly sessions: AwsSessionStore;
  private readonly store: AwsWorkspaceStore;
  private readonly workspaces?: PersistentWorkspaces;
  /** s3-checkpoint: each sandbox's env vars, applied again whenever its files are restored onto new compute. */
  private readonly environments = new Map<string, Record<string, string>>();
  /** The tail of each owner's queue of calls. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: AwsAgentCoreSandboxOptions) {
    const arn = RUNTIME_ARN.exec(options.runtimeArn ?? "");
    if (!arn) throw new Error("aws-agentcore needs a runtime ARN (arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>)");
    if (options.qualifier !== undefined && !QUALIFIER.test(options.qualifier)) throw new Error("Invalid AgentCore runtime qualifier");
    const region = options.region || arn[2];
    if (region !== arn[2]) throw new Error("The AWS sandbox region must match the runtime ARN's");
    if (typeof options.serverToken !== "string" || options.serverToken.length < 16) {
      throw new Error("aws-agentcore needs the runtime's SANDBOX_SERVER_TOKEN (16 characters at least)");
    }
    const mode = options.storageMode ?? "ephemeral";
    if (mode !== "ephemeral" && mode !== "s3-checkpoint") throw new Error('storageMode must be "ephemeral" or "s3-checkpoint"');
    this.limits = {
      defaultTimeoutSec: options.defaultTimeoutSec ?? 60,
      maxTimeoutSec: options.maxTimeoutSec ?? 200,
      maxOutputChars: options.maxOutputChars ?? 50_000,
      maxExportBytes: options.maxExportBytes ?? 50 * 1024 * 1024,
    };
    for (const n of [this.limits.defaultTimeoutSec, this.limits.maxTimeoutSec]) {
      if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error("AWS sandbox timeouts must be whole seconds from 1 to 200");
    }
    if (this.limits.defaultTimeoutSec > this.limits.maxTimeoutSec) throw new Error("The AWS sandbox default timeout is over its maximum");
    if (this.limits.maxExportBytes > 50 * 1024 * 1024) throw new Error("maxExportBytes is at most 50 MiB on AWS");

    this.runtimeArn = options.runtimeArn;
    this.identifierStrategy = options.identifierStrategy ?? "userId";
    this.sessions = new AwsSessionStore(options.storage);
    this.store = new AwsWorkspaceStore(options.storage, options.now);
    // Retrying an ambiguous InvokeAgentRuntime could run a command twice.
    const agentCore = options.agentCore ?? new BedrockAgentCoreClient({ region, maxAttempts: 1 });

    let persistenceLimits: SandboxPersistenceLimits | undefined;
    let maxResponseBytes = Math.max(
      Math.ceil(this.limits.maxExportBytes / 3) * 4 + 2 * 1024 * 1024,
      this.limits.maxOutputChars * 8 + 1024 * 1024,
    );
    if (mode === "s3-checkpoint") {
      if (!options.workspaceBucket) throw new Error("s3-checkpoint needs a workspace bucket of its own");
      persistenceLimits = options.persistenceLimits ?? DEFAULT_PERSISTENCE_LIMITS;
      const { maxBytes, maxFiles } = persistenceLimits;
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PERSISTENCE_BYTES || !Number.isInteger(maxFiles) || maxFiles < 1) {
        throw new Error("persistenceLimits: maxBytes from 1 byte to 64 MiB, maxFiles at least 1");
      }
      maxResponseBytes = Math.max(maxResponseBytes, maxArchiveChars(persistenceLimits) + 1024 * 1024);
      const checkpoints = new S3WorkspaceCheckpoints(
        options.workspaceBucket,
        options.s3 ?? new S3Client({ region, maxAttempts: 1 }),
        maxArchiveChars(persistenceLimits),
        options.expectedBucketOwner ?? arn[3],
      );
      this.workspaces = new PersistentWorkspaces(this.store, checkpoints, this.compute(), {
        runtimeArn: options.runtimeArn,
        qualifier: options.qualifier,
        leaseWaitMs: options.leaseWaitMs,
      });
    }
    this.transport = new AgentCoreTransport({
      client: agentCore,
      runtimeArn: options.runtimeArn,
      qualifier: options.qualifier,
      token: options.serverToken,
      maxResponseBytes,
    });
    this.qualifier = options.qualifier;
    this.capabilities = {
      browser: options.browser ?? false,
      egressCredentials: false,
      persistence: persistenceLimits ? "data" : "disk",
      ...(persistenceLimits ? { persistenceLimits } : {}),
    };
    this.erasureNotes = persistenceLimits
      ? [
          "S3 checkpoints are overwritten with deletion markers, not deleted (the workspace bucket keeps one small marker per erased sandbox)",
        ]
      : [];
  }

  exec: SandboxBackend["exec"] = (args, id) => this.run(id, true, (server) => server.exec(args, id));
  fileWrite: SandboxBackend["fileWrite"] = (args, id) => this.run(id, true, (server) => server.fileWrite(args, id));
  fileRead: SandboxBackend["fileRead"] = (args, id) => this.run(id, false, (server) => server.fileRead(args, id));
  fileList: SandboxBackend["fileList"] = (id) => this.run(id, false, (server) => server.fileList(id));
  fileReadBinary: SandboxBackend["fileReadBinary"] = (args, id) => this.run(id, false, (server) => server.fileReadBinary(args, id));

  async setEnv(vars: Record<string, string>, identifier: string): Promise<void> {
    await this.run(identifier, false, (server) => server.setEnv(vars, identifier));
    if (this.workspaces) this.environments.set(sandboxKey(identifier).key, { ...vars });
  }

  async setEgressCredentials(_credentials: EgressCredential[], _identifier: string): Promise<void> {
    throw new SandboxUnsupportedError("setEgressCredentials", "aws-agentcore");
  }

  /**
   * Erase a user's sandboxes: start their next generation (so their next
   * call gets a new, empty sandbox), overwrite their checkpoints, and stop
   * every runtime session they started, each record removed once stopped.
   * A failure leaves the rest to a retry, and throws so erasure reports it.
   */
  async deleteUserSandboxes(userId: string): Promise<number> {
    const owner = ownerHash(userId);
    const workspaces = this.workspaces ? await this.workspaces.erase(owner) : (await this.store.erase(owner), 0);
    for (const key of [...this.environments.keys()]) if (key.startsWith(`afe-${owner}-`)) this.environments.delete(key);
    const records = await this.sessions.list(owner);
    let stopped = 0;
    const failures: string[] = [];
    for (const record of records) {
      // A record never sends the stop to another runtime than the one configured.
      if (record.runtimeArn !== this.runtimeArn) {
        failures.push(`a session on another runtime (${record.runtimeArn.split(":").at(-1)}): erase again with that runtime configured`);
        continue;
      }
      try {
        await this.transport.stop(record.sessionId, record.qualifier);
        await this.sessions.remove(record);
        stopped++;
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (failures.length > 0) {
      throw new Error(`${failures.length} of ${records.length} AgentCore sessions not stopped (${stopped} stopped): ${failures.join("; ")}`);
    }
    await this.store.assertQuiescent(owner);
    return Math.max(stopped, workspaces);
  }

  resolveIdentifier(userId: string, sessionId?: string): string {
    return encodeSandboxIdentifier(userId, this.identifierStrategy === "sessionId" ? sessionId : undefined);
  }

  isReady(): boolean {
    return true;
  }

  /** Run one call on `identifier`'s sandbox, after the owner's earlier calls. */
  private run<T>(identifier: string, mutates: boolean, call: (server: SandboxServerClient) => Promise<T>): Promise<T> {
    const { owner, key } = sandboxKey(identifier);
    return this.serialize(owner, async () => {
      if (!this.workspaces) {
        // Ephemeral: the session for the owner's current generation.
        const sessionId = `${key}-${await this.store.generation(owner)}`;
        await this.track(owner, sessionId);
        return call(this.server(sessionId));
      }
      return this.workspaces.run(key, owner, mutates, async (sessionId, restored) => {
        const server = this.server(sessionId);
        const env = this.environments.get(key);
        if (restored && env) await server.setEnv(env, identifier);
        return call(server);
      });
    });
  }

  private serialize<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(owner) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(owner, tail);
    void tail.then(() => {
      if (this.queues.get(owner) === tail) this.queues.delete(owner);
    });
    return result;
  }

  private server(sessionId: string): SandboxServerClient {
    return new SandboxServerClient({
      ...this.limits,
      transport: (_identifier, path, init) => this.transport.request(sessionId, path, init),
    });
  }

  /** Record a session before its first call, so erasure can stop it. */
  private track(owner: string, sessionId: string): Promise<void> {
    return this.sessions.track({ owner, runtimeArn: this.runtimeArn, qualifier: this.qualifier, sessionId });
  }

  /** The checkpoint mode's view of a session's server: /archive, base64 in the envelope. */
  private compute(): WorkspaceCompute {
    const archive = async (sessionId: string, owner: string, init: { method: "GET" | "POST"; body?: string }) => {
      await this.track(owner, sessionId);
      const response = await this.transport.request(sessionId, "/archive", init);
      const body = (await response.json().catch(() => ({}))) as { error?: string; archive?: string; restored?: boolean };
      if (response.status === 413 && init.method === "GET") {
        throw new SandboxPersistenceLimitError(
          `${body.error ?? "/mnt/data is over its limit"}. This call's changes to /mnt/data were not kept: ` +
            "the sandbox is back to its last saved files. Keep large or temporary files out of /mnt/data.",
        );
      }
      if (response.status === 413) {
        throw new SandboxPersistenceLimitError(
          `The saved files are over the runtime's archive limits (${body.error ?? "413"}): ` +
            "persistenceLimits must match the runtime's SANDBOX_ARCHIVE_MAX_BYTES and SANDBOX_ARCHIVE_MAX_FILES.",
        );
      }
      if (!response.ok) throw new Error(`The sandbox's /mnt/data could not be ${init.method === "GET" ? "saved" : "restored"}: ${response.status} ${body.error ?? ""}`);
      return body;
    };
    return {
      restore: async (sessionId, owner, saved) =>
        (await archive(sessionId, owner, { method: "POST", body: JSON.stringify({ archive: saved }) })).restored === true,
      snapshot: async (sessionId, owner) => {
        const { archive: made } = await archive(sessionId, owner, { method: "GET" });
        if (typeof made !== "string") throw new Error("The sandbox returned no archive");
        return made;
      },
    };
  }
}

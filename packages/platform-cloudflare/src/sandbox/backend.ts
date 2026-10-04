/**
 * The `cloudflare-containers` sandbox backend, used by the gateway inside the
 * Worker: each sandbox is a ContainerSandbox Durable Object (one per sandbox
 * identifier); exec and file calls go to its sandbox server through the
 * shared SandboxServerClient.
 *
 * Register it from the worker entry:
 *
 * ```ts
 * registerSandboxProvider("cloudflare-containers", (config) =>
 *   new CloudflareContainersSandbox(env.SANDBOX, containersSandboxOptions(config)));
 * ```
 *
 * A user's sandboxes are listed in an index object (`idx:<userId>`), so
 * account erasure finds them all, one per conversation included.
 */

import {
  SandboxServerClient,
  encodeSandboxIdentifier,
  sandboxIdentifierOwner,
  type EgressCredential,
  type SandboxBackend,
  type SandboxCapabilities,
} from "@agentforeach/platform";
import type { ContainerSandbox, ContainerSandboxOptions } from "./container-sandbox.js";
import { UNINDEXED_HEADER } from "./protocol.js";
import type { SnapshotDeletionOptions } from "./snapshot-registry.js";

export interface CloudflareContainersSandboxOptions {
  /** Instance type. Default "standard-2" (1 vCPU, 6 GiB, 12 GB disk). */
  instance?: string;
  /** Snapshot and stop a sandbox after this many idle seconds. Default 300. */
  autoSuspendSec?: number;
  /** Hosts the sandbox may reach when networkAccess is "disabled" (exact, or "*.domain"). */
  egressAllowHosts?: string[];
  /** "disabled" (default): deny by default. "enabled": every host allowed. */
  networkAccess?: "disabled" | "enabled";
  /** One sandbox per user ("userId", default) or per conversation ("sessionId"). */
  identifierStrategy?: "userId" | "sessionId";
  /** The image was built with the browser (SANDBOX_IMAGE_BROWSER=1). Default false. */
  browser?: boolean;
  defaultTimeoutSec?: number;
  maxTimeoutSec?: number;
  maxOutputChars?: number;
  maxExportBytes?: number;
  /**
   * Opt-in: delete a sandbox's snapshots from the registry when a user's
   * sandboxes are deleted (account erasure), with an account API token from
   * the Worker's secrets (CLOUDFLARE_IMAGES_API_TOKEN). Snapshots are deltas,
   * so none is deleted while its sandbox lives. Without it, snapshots expire
   * 30 days after their creation or last restore.
   */
  snapshotDeletion?: SnapshotDeletionOptions;
}

/** Durable Object names: a sandbox, and the index of a user's sandboxes. */
const sandboxName = (identifier: string) => `sbx:${identifier}`;
const indexName = (userId: string) => `idx:${userId}`;

export class CloudflareContainersSandbox implements SandboxBackend {
  readonly capabilities: SandboxCapabilities;
  readonly erasureNotes: readonly string[];
  private readonly runtime: ContainerSandboxOptions;
  private readonly server: SandboxServerClient;
  private readonly identifierStrategy: "userId" | "sessionId";
  /** Sent only with erasure (forget), never with every request. */
  private readonly snapshotDeletion?: SnapshotDeletionOptions;

  constructor(
    private readonly namespace: DurableObjectNamespace<ContainerSandbox> | undefined,
    options: CloudflareContainersSandboxOptions = {},
  ) {
    this.capabilities = { browser: options.browser ?? false, egressCredentials: true, persistence: "disk" };
    this.identifierStrategy = options.identifierStrategy ?? "userId";
    this.snapshotDeletion = options.snapshotDeletion;
    this.erasureNotes = options.snapshotDeletion
      ? []
      : [
          "snapshots stay in the Cloudflare container registry until they expire (30 days unused): " +
            "snapshot deletion isn't configured (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_IMAGES_API_TOKEN)",
        ];
    this.runtime = {
      instance: options.instance ?? "standard-2",
      idleMs: (options.autoSuspendSec ?? 300) * 1000,
      allowHosts: options.egressAllowHosts ?? [],
      internet: options.networkAccess === "enabled",
    };
    this.server = new SandboxServerClient({
      defaultTimeoutSec: options.defaultTimeoutSec ?? 120,
      maxTimeoutSec: options.maxTimeoutSec ?? 200,
      maxOutputChars: options.maxOutputChars,
      maxExportBytes: options.maxExportBytes,
      transport: async (identifier, path, init) => {
        const sandbox = this.stub(sandboxName(identifier));
        const response = await sandbox.request({ path, method: init.method, body: init.body }, this.runtime);
        // The sandbox asks after each start, and keeps asking until indexed:
        // an indexing that fails here is retried on the next call.
        if (response.headers.get(UNINDEXED_HEADER)) {
          try {
            await this.index(identifier);
            await sandbox.indexed();
          } catch (err) {
            console.warn(`[sandbox] indexing a sandbox failed; the next call retries: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return response;
      },
    });
  }

  exec: SandboxBackend["exec"] = (args, id) => this.server.exec(args, id);
  fileWrite: SandboxBackend["fileWrite"] = (args, id) => this.server.fileWrite(args, id);
  fileRead: SandboxBackend["fileRead"] = (args, id) => this.server.fileRead(args, id);
  fileList: SandboxBackend["fileList"] = (id) => this.server.fileList(id);
  fileReadBinary: SandboxBackend["fileReadBinary"] = (args, id) => this.server.fileReadBinary(args, id);
  setEnv: SandboxBackend["setEnv"] = (vars, id) => this.server.setEnv(vars, id);

  async setEgressCredentials(credentials: EgressCredential[], identifier: string): Promise<void> {
    await this.index(identifier);
    await this.stub(sandboxName(identifier)).setEgressCredentials(credentials, this.runtime);
  }

  /**
   * Forget each of the user's sandboxes. One that fails (its snapshots
   * couldn't be deleted from the registry) stays in the index, so erasing
   * again retries it; the call then throws, so the erasure reports it.
   */
  async deleteUserSandboxes(userId: string): Promise<number> {
    const index = this.stub(indexName(userId));
    const identifiers = await index.tracked();
    let deleted = 0;
    const failures: string[] = [];
    for (const identifier of identifiers) {
      try {
        if (await this.stub(sandboxName(identifier)).forget(this.snapshotDeletion)) deleted++;
        // One at a time, not the whole index: a sandbox started meanwhile stays listed.
        await index.untrack(identifier);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (failures.length > 0) {
      throw new Error(`${failures.length} of ${identifiers.length} sandboxes not fully deleted (${deleted} deleted): ${failures.join("; ")}`);
    }
    return deleted;
  }

  resolveIdentifier(userId: string, sessionId?: string): string {
    return encodeSandboxIdentifier(userId, this.identifierStrategy === "sessionId" ? sessionId : undefined);
  }

  isReady(): boolean {
    return this.namespace !== undefined;
  }

  /** Put the identifier in its owner's index (idempotent). */
  private async index(identifier: string): Promise<void> {
    await this.stub(indexName(sandboxIdentifierOwner(identifier))).track(identifier);
  }

  private stub(name: string): DurableObjectStub<ContainerSandbox> {
    if (!this.namespace) throw new Error("cloudflare-containers: the SANDBOX Durable Object binding is missing");
    return this.namespace.getByName(name);
  }
}

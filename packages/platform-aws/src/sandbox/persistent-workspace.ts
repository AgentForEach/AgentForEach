/**
 * The aws-agentcore backend's s3-checkpoint mode: AgentCore compute is
 * ephemeral, so every operation on a workspace
 *
 *   1. takes the owner's lease (one operation at a time per owner, across
 *      every gateway instance; a busy lease is waited for, up to a bound),
 *   2. fences the S3 checkpoint, so an older operation can no longer save,
 *   3. restores the checkpoint onto the lease's compute (the server skips
 *      it when the compute already holds it),
 *   4. runs the operation,
 *   5. for an operation that may change files, archives /mnt/data and
 *      commits it to S3 (conditionally),
 *
 * checking the lease between steps. Only then is the compute marked clean
 * and reusable; an operation that fails anywhere leaves it unclean, and the
 * next one restores the last committed files onto new compute. There is no
 * automatic replay: a command may have run even when its call fails.
 *
 * Ported from the AWS reference (aws-persistent-workspace.ts).
 */

import { CheckpointFencedError, type S3WorkspaceCheckpoints } from "./checkpoints.js";
import { AwsWorkspaceStore, WorkspaceBusyError, WorkspaceLeaseLostError, type WorkspaceLease } from "./workspace-store.js";

/** What the workspace needs from a runtime session's sandbox server. */
export interface WorkspaceCompute {
  /** Replace /mnt/data with `archive` (null: empty); true when it changed (new compute, or another archive). */
  restore(sessionId: string, owner: string, archive: string | null): Promise<boolean>;
  /** /mnt/data as a bounded archive (base64); throws SandboxPersistenceLimitError over a bound. */
  snapshot(sessionId: string, owner: string): Promise<string>;
}

export interface PersistentWorkspacesOptions {
  runtimeArn: string;
  qualifier?: string;
  /** How long to wait for another operation's lease. Default 30 s. */
  leaseWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class PersistentWorkspaces {
  private readonly leaseWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly store: AwsWorkspaceStore,
    private readonly checkpoints: S3WorkspaceCheckpoints,
    private readonly compute: WorkspaceCompute,
    private readonly options: PersistentWorkspacesOptions,
  ) {
    this.leaseWaitMs = options.leaseWaitMs ?? 30_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Run `operation` on workspace `key` of `owner`, on the compute the lease
   * names (`sessionId`; `restored` says its files were just replaced).
   * `mutates`: the operation may change files, so they are saved after it.
   */
  async run<T>(
    key: string,
    owner: string,
    mutates: boolean,
    operation: (sessionId: string, restored: boolean) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(key, owner);
    let clean = false;
    try {
      await this.store.assertLease(lease);
      const checkpoint = await this.checkpoints.fence(key, lease.token, lease.generation);
      await this.store.assertLease(lease);
      const restored = await this.compute.restore(lease.physicalId, owner, checkpoint.archive);
      await this.store.assertLease(lease);
      const result = await operation(lease.physicalId, restored);
      if (mutates) {
        await this.store.assertLease(lease);
        const archive = await this.compute.snapshot(lease.physicalId, owner);
        await this.store.assertLease(lease);
        await this.checkpoints.commit(key, checkpoint, archive, lease.token, lease.generation);
      }
      clean = true;
      return result;
    } catch (err) {
      // A fenced checkpoint means the lease went with an erasure or a newer operation.
      throw err instanceof CheckpointFencedError ? new WorkspaceLeaseLostError() : err;
    } finally {
      await this.store.release(lease, clean).catch((err) => {
        console.warn(`[sandbox] releasing a workspace lease failed (it expires on its own): ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /** The lease, waiting (with backoff) while another operation holds it, up to leaseWaitMs. */
  private async acquire(key: string, owner: string): Promise<WorkspaceLease> {
    const deadline = Date.now() + this.leaseWaitMs;
    for (let delay = 250; ; delay = Math.min(delay * 2, 2_000)) {
      try {
        return await this.store.acquire(key, owner, this.options.runtimeArn, this.options.qualifier);
      } catch (err) {
        if (!(err instanceof WorkspaceBusyError) || Date.now() + delay > deadline) throw err;
        await this.sleep(delay);
      }
    }
  }

  /**
   * Start the owner's next generation and overwrite every checkpoint of the
   * erased one with a deletion marker. Returns how many workspaces it had.
   */
  async erase(owner: string): Promise<number> {
    const { generation, keys } = await this.store.erase(owner);
    for (const key of keys) await this.checkpoints.erase(key, generation);
    return keys.length;
  }
}

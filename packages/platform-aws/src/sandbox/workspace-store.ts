/**
 * Per-owner state of the aws-agentcore backend (aws-sandbox-workspaces):
 *
 *   - the owner row: the **generation**, raised by every erasure, so the
 *     owner's next call starts a new, empty sandbox (new AgentCore session
 *     ids, and checkpoints of older generations are never restored), while
 *     the S3 checkpoint's conditional writes fence any writer still on the
 *     old one; and, in s3-checkpoint mode, the **lease** that lets one
 *     operation at a time restore, run and save the owner's workspaces;
 *   - one row per workspace (s3-checkpoint mode): which compute (a physical
 *     AgentCore session) holds it, and whether that compute still matches
 *     the saved checkpoint (`clean`), so it can be reused without a restore.
 *
 * Ported from the AWS reference (aws-workspace-store.ts), with the generation
 * counter in place of its permanent tombstone.
 */

import { randomUUID } from "node:crypto";
import { isConflict, isPreconditionFailed, type Collection, type Doc, type StorageAdapter, type Stored } from "@agentforeach/storage";
import { AWS_SANDBOX_WORKSPACES } from "../collections.js";

/** How long a lease lasts: longer than the longest operation (a 200 s command, a restore and a save). */
export const LEASE_MS = 10 * 60_000;
/** After a lease expires, how long its operation may still be running remotely. */
export const DRAIN_MS = 5 * 60_000;

type OwnerRow = Doc & {
  owner: string;
  kind: "owner";
  generation: number;
  /** The current lease, while an operation holds it. */
  token?: string;
  expires?: number;
  /** Set by an erasure that found a lease: until then, that operation may still be running. */
  drainUntil?: number;
};

type WorkspaceRow = Doc & {
  owner: string;
  kind: "workspace";
  generation: number;
  runtimeArn?: string;
  qualifier?: string;
  /** The AgentCore session that holds this workspace's files. */
  physicalId?: string;
  /** The compute matches the saved checkpoint, so the next operation may reuse it. */
  clean: boolean;
};

type Row = OwnerRow | WorkspaceRow;

export type WorkspaceLease = {
  owner: string;
  key: string;
  token: string;
  generation: number;
  physicalId: string;
};

/** Another operation holds the owner's lease. */
export class WorkspaceBusyError extends Error {
  constructor() {
    super("The sandbox is busy with another operation; try again when it finishes");
    this.name = "WorkspaceBusyError";
  }
}

/** The lease expired, or the owner was erased, while an operation held it. */
export class WorkspaceLeaseLostError extends Error {
  constructor() {
    super("The sandbox operation lost its lease (it took too long, or the account was erased); nothing was saved");
    this.name = "WorkspaceLeaseLostError";
  }
}

const OWNER_ID = "owner";

export class AwsWorkspaceStore {
  private collection?: Promise<Collection<Row>>;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly now: () => number = Date.now,
  ) {}

  private records(): Promise<Collection<Row>> {
    this.collection ??= (async () => {
      await this.storage.initialize();
      return this.storage.collection<Row>(AWS_SANDBOX_WORKSPACES);
    })();
    return this.collection;
  }

  /** The row, created as `initial` if missing (whoever wins a race, both read the winner). */
  private async ensure<T extends Row>(initial: T): Promise<Stored<T>> {
    const c = await this.records();
    const found = await c.read(initial.id, initial.owner);
    if (found) return found as Stored<T>;
    try {
      return (await c.create(initial)) as Stored<T>;
    } catch (err) {
      if (!isConflict(err)) throw err;
      const winner = await c.read(initial.id, initial.owner);
      if (!winner) throw new Error("A sandbox workspace record disappeared while it was created");
      return winner as Stored<T>;
    }
  }

  /** The owner's generation: 0 until their first erasure. One point read, no write. */
  async generation(owner: string): Promise<number> {
    const row = (await (await this.records()).read(OWNER_ID, owner)) as OwnerRow | null;
    return row?.generation ?? 0;
  }

  /**
   * Take the owner's lease for one operation on workspace `key`. Throws
   * WorkspaceBusyError while another operation holds it. The workspace is
   * registered first, so an erasure can fence every key a writer may use.
   * Compute is reused only if the last operation on it saved cleanly, on the
   * same runtime and generation; otherwise the lease names new compute.
   */
  async acquire(key: string, owner: string, runtimeArn: string, qualifier?: string): Promise<WorkspaceLease> {
    const c = await this.records();
    const workspace = await this.ensure<WorkspaceRow>({ id: key, owner, kind: "workspace", generation: 0, clean: false });
    const row = await this.ensure<OwnerRow>({ id: OWNER_ID, owner, kind: "owner", generation: 0 });
    if (row.token && (row.expires ?? 0) > this.now()) throw new WorkspaceBusyError();
    const token = randomUUID();
    const leased = await c
      .replace(OWNER_ID, owner, { ...strip(row), token, expires: this.now() + LEASE_MS }, { ifMatch: row._etag })
      .catch((err) => {
        throw isPreconditionFailed(err) ? new WorkspaceBusyError() : err;
      });
    const generation = (leased as OwnerRow).generation;
    try {
      const reuse =
        workspace.clean &&
        workspace.generation === generation &&
        workspace.runtimeArn === runtimeArn &&
        workspace.qualifier === qualifier &&
        workspace.physicalId;
      const physicalId = reuse ? workspace.physicalId! : `afe-ws-${randomUUID()}`;
      const { qualifier: _previous, ...rest } = strip(workspace);
      await c.replace(
        key,
        owner,
        { ...rest, generation, runtimeArn, ...(qualifier ? { qualifier } : {}), physicalId, clean: false },
        { ifMatch: workspace._etag },
      );
      return { owner, key, token, generation, physicalId };
    } catch (err) {
      await this.release({ owner, key, token, generation, physicalId: "" }, false).catch(() => undefined);
      throw err;
    }
  }

  /** Throws WorkspaceLeaseLostError unless the lease is still held, unexpired, in its generation. */
  async assertLease(lease: WorkspaceLease): Promise<void> {
    const row = (await (await this.records()).read(OWNER_ID, lease.owner)) as OwnerRow | null;
    if (!row || row.token !== lease.token || row.generation !== lease.generation || (row.expires ?? 0) <= this.now()) {
      throw new WorkspaceLeaseLostError();
    }
  }

  /**
   * Give the lease back. `clean`: the compute matches the saved checkpoint,
   * so the next operation may reuse it. A release that never happens (a
   * crash) leaves the compute unclean, and the next operation restores onto
   * new compute.
   */
  async release(lease: WorkspaceLease, clean: boolean): Promise<void> {
    const c = await this.records();
    const row = (await c.read(OWNER_ID, lease.owner)) as Stored<OwnerRow> | null;
    if (!row || row.token !== lease.token) return;
    const workspace = (await c.read(lease.key, lease.owner)) as Stored<WorkspaceRow> | null;
    if (workspace && workspace.physicalId === lease.physicalId && workspace.generation === lease.generation) {
      await c.replace(lease.key, lease.owner, { ...strip(workspace), clean }, { ifMatch: workspace._etag });
    }
    const { token: _token, expires: _expires, ...rest } = strip(row);
    await c.replace(OWNER_ID, lease.owner, rest, { ifMatch: row._etag }).catch((err) => {
      if (!isPreconditionFailed(err)) throw err; // erased meanwhile: the lease is gone anyway
    });
  }

  /**
   * Start the owner's next generation, ending any lease. Returns the
   * generation erased and every workspace key a writer may have used, for
   * the checkpoint store to fence.
   */
  async erase(owner: string): Promise<{ generation: number; keys: string[] }> {
    const c = await this.records();
    for (let attempt = 0; ; attempt++) {
      const row = await this.ensure<OwnerRow>({ id: OWNER_ID, owner, kind: "owner", generation: 0 });
      const leased = row.token !== undefined && (row.expires ?? 0) + DRAIN_MS > this.now();
      const { token: _token, expires: _expires, ...rest } = strip(row);
      const next: OwnerRow = {
        ...rest,
        generation: row.generation + 1,
        ...(leased ? { drainUntil: Math.max(row.drainUntil ?? 0, (row.expires ?? 0) + DRAIN_MS) } : {}),
      };
      try {
        await c.replace(OWNER_ID, owner, next, { ifMatch: row._etag });
      } catch (err) {
        if (attempt < 5 && isPreconditionFailed(err)) continue;
        throw err;
      }
      const rows = await c.find({ partitionKey: owner });
      return { generation: row.generation, keys: rows.filter((r) => r.kind === "workspace").map((r) => r.id) };
    }
  }

  /**
   * Throws while an operation of an erased generation may still be running
   * remotely (its lease, plus DRAIN_MS): erasure reports it, and running it
   * again after that stops any compute that operation started.
   */
  async assertQuiescent(owner: string): Promise<void> {
    const row = (await (await this.records()).read(OWNER_ID, owner)) as OwnerRow | null;
    if (row?.drainUntil && row.drainUntil > this.now()) {
      const seconds = Math.ceil((row.drainUntil - this.now()) / 1000);
      throw new Error(
        `a sandbox operation was running during the erasure; its data is fenced, but erase again in ${seconds} s to stop what it may still start`,
      );
    }
  }
}

/** A stored row without its system fields, to write back. */
function strip<T extends Row>(row: Stored<T> | T): T {
  const { _etag: _e, _ts: _t, ...rest } = row as Stored<T> & { _ts?: unknown };
  return rest as unknown as T;
}

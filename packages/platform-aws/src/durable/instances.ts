/**
 * The pack's instance table: one row per durable instance, in the shared
 * database (`DURABLE_INSTANCES_COLLECTION`). Lambda durable execution names
 * can't be reused, and an execution knows nothing of the port's instance ids,
 * so the row is what an instance *is*: its status (what `status()` returns),
 * its input, and the name of the one execution allowed to act for it now.
 *
 * Every write is a guarded read-modify-write (`mutate`): an execution only
 * changes the row while the row still names it (`current`), so a replaced,
 * terminated or re-dispatched instance's old execution can finish its step
 * and change nothing.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  isConflict,
  isPreconditionFailed,
  mutate,
  oneOf,
  type Collection,
  type Doc,
  type StorageAdapter,
  type Stored,
} from "@agentforeach/storage";
import { isActive, type DurableStatus } from "@agentforeach/platform";
import { DURABLE_INSTANCES_COLLECTION } from "../collections.js";
import { lambdaControl, type DurableControl, type DurableReference } from "./control.js";

export type InstanceType = "job" | "wait" | "alarm";

export interface InstanceRow extends Doc {
  /** sha256 of the instance id: ids are free-form, document ids aren't. */
  id: string;
  instanceId: string;
  /** Owner of user work, for the shared account-erasure query. */
  userId?: string;
  type: InstanceType;
  kind: string;
  status: DurableStatus;
  createdAt: number;
  updatedAt: number;
  /** The execution allowed to act for the instance now (its name). */
  execution: string;
  /** Its ARN, once Lambda acknowledged the invoke. */
  executionArn?: string;
  /** The input as JSON; dropped when the instance finishes. */
  input?: string;
  /** Runs of the current phase's handler (job run, wait start or outcome, one tick); see `DurableContext.attempt`. */
  attempts: number;
  /** Executions the sweep started again after Lambda closed one early (timed out, stopped). */
  redispatches?: number;
  /** Wait: epoch ms of the timeout. */
  timeoutAt?: number;
  /** Wait: its start handler has run. */
  waiting?: boolean;
  /** Wait: decided, and its onEvent or onTimeout runs; signals are refused. */
  outcome?: "event" | "timeout";
  /** Wait: the event, stored by `signal` before any callback is sent (payload as JSON). */
  event?: { name: string; payload: string };
  /** Wait or alarm: the callback its execution is waiting on now. */
  callbackId?: string;
  /** Alarm: a tick is running. */
  ticking?: boolean;
  /** Alarm: `wakeAlarm` asked for the next tick now. */
  wake?: boolean;
  /** When the sweep last looked at it. */
  sweptAt?: number;
}

export type Logger = Pick<Console, "log" | "warn" | "error" | "debug">;

export interface LambdaDurableOptions {
  /** The durable function's numeric published-version ARN (`arn:aws:lambda:…:function:<name>:<n>`). */
  functionArn: string;
  /** Starts every execution name: the stack name. 1–30 of `[A-Za-z0-9_-]`. */
  executionPrefix: string;
  /** The shared database, holding the instance table. */
  storage: () => StorageAdapter;
  /** Lambda's durable executions API. Default: `lambdaControl(functionArn)`. */
  control?: DurableControl;
  /** Where handler logs go. Default: console. */
  logger?: Logger;
  /** How long a finished instance stays readable. Default 1 hour. */
  retentionMs?: number;
  /**
   * The longest one execution waits or ticks before it hands the instance to
   * a fresh one (Lambda caps an execution's lifetime, and its history grows).
   * The durable function's execution timeout must exceed it by the longest
   * handler run. Default 6 hours.
   */
  segmentMs?: number;
  /** An alarm hands over to a fresh execution after this many ticks. Default 100. */
  ticksPerExecution?: number;
  /** Runs of one handler before an instance cut off that often fails. Default 3. */
  maxRuns?: number;
}

/** The options with their defaults, and the table and control built from them. */
export interface Pack {
  readonly table: InstanceTable;
  readonly control: DurableControl;
  readonly logger: Logger;
  readonly retentionMs: number;
  readonly segmentMs: number;
  readonly ticksPerExecution: number;
  readonly maxRuns: number;
  /** A fresh execution name for an instance. */
  executionName(instanceId: string): string;
}

const PREFIX = /^[a-zA-Z0-9_-]{1,30}$/;

export function resolvePack(options: LambdaDurableOptions): Pack {
  if (!PREFIX.test(options.executionPrefix ?? "")) {
    throw new Error("The durable execution prefix must be 1-30 letters, digits, '-' or '_'");
  }
  const prefix = options.executionPrefix;
  return {
    table: new InstanceTable(options.storage),
    control: options.control ?? lambdaControl(options.functionArn),
    logger: options.logger ?? console,
    retentionMs: options.retentionMs ?? 60 * 60 * 1000,
    segmentMs: options.segmentMs ?? 6 * 60 * 60 * 1000,
    ticksPerExecution: options.ticksPerExecution ?? 100,
    maxRuns: options.maxRuns ?? 3,
    // <prefix>-<instance hash>-<random>: at most 64 characters, never reused,
    // and every execution of one instance shares the middle part.
    executionName: (instanceId) => `${prefix}-${rowId(instanceId).slice(0, 16)}-${randomBytes(8).toString("hex")}`,
  };
}

export function rowId(instanceId: string): string {
  return createHash("sha256").update(instanceId).digest("hex");
}

/** The row is active and names this execution. */
export function current(row: InstanceRow | null | undefined, execution: string): row is Stored<InstanceRow> {
  return !!row && row.execution === execution && isActive(row.status);
}

/** What the reference to a row's current execution carries. */
export function referenceTo(row: InstanceRow): DurableReference {
  return { id: row.instanceId, kind: row.kind, execution: row.execution };
}

export class InstanceTable {
  private opened: { storage: StorageAdapter; collection: Promise<Collection<InstanceRow>> } | undefined;

  constructor(private readonly storage: () => StorageAdapter) {}

  private collection(): Promise<Collection<InstanceRow>> {
    const storage = this.storage();
    if (this.opened?.storage !== storage) {
      const collection = (async () => {
        await storage.initialize();
        return storage.collection<InstanceRow>(DURABLE_INSTANCES_COLLECTION);
      })();
      this.opened = { storage, collection };
      // A failed open (the database unreachable) is retried by the next call.
      collection.catch(() => {
        if (this.opened?.collection === collection) this.opened = undefined;
      });
    }
    return this.opened.collection;
  }

  async read(instanceId: string): Promise<Stored<InstanceRow> | null> {
    const id = rowId(instanceId);
    return (await this.collection()).read(id, id);
  }

  /**
   * Read-modify-write the row. `update` returns the next row, or undefined to
   * leave it. Returns the row written, or undefined when nothing was (no
   * row, or `update` declined). Throws when other writers kept winning.
   */
  async update(
    instanceId: string,
    update: (row: Stored<InstanceRow>) => InstanceRow | undefined,
  ): Promise<Stored<InstanceRow> | undefined> {
    const id = rowId(instanceId);
    const result = await mutate(await this.collection(), id, id, (row) => {
      const next = update(row);
      return next && { ...next, updatedAt: next.updatedAt === row.updatedAt ? Date.now() : next.updatedAt };
    }, { maxAttempts: 8 });
    if (result.status === "contention") throw new Error(`Durable instance ${instanceId} is contended; try again`);
    return result.status === "updated" ? result.document : undefined;
  }

  /** Write without touching `updatedAt` (bookkeeping the instance's status doesn't show). */
  async touch(instanceId: string, update: (row: Stored<InstanceRow>) => InstanceRow | undefined): Promise<void> {
    const id = rowId(instanceId);
    await mutate(await this.collection(), id, id, update, { maxAttempts: 2 });
  }

  /**
   * Create the instance's row, or replace a finished one. Returns the new
   * row, or null when an active (or suspended) instance holds the id.
   */
  async claim(
    row: Pick<InstanceRow, "instanceId" | "type" | "kind" | "status" | "execution" | "input" | "attempts" | "timeoutAt" | "userId">,
  ): Promise<Stored<InstanceRow> | null> {
    const collection = await this.collection();
    const id = rowId(row.instanceId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = await collection.read(id, id);
      if (existing && (isActive(existing.status) || existing.status === "suspended")) return null;
      const now = Date.now();
      const next: InstanceRow = { ...row, id, createdAt: now, updatedAt: now };
      try {
        return existing
          ? await collection.replace(id, id, next, { ifMatch: existing._etag })
          : await collection.create(next);
      } catch (err) {
        // Another start won the race; look again.
        if (isConflict(err) || isPreconditionFailed(err)) continue;
        throw err;
      }
    }
    throw new Error(`Durable instance ${row.instanceId} is contended; try again`);
  }

  /** Active rows, the ones the sweep looked at longest ago first. */
  async active(limit: number): Promise<Stored<InstanceRow>[]> {
    return (await this.collection()).find({
      where: oneOf("status", ["pending", "running"]),
      orderBy: { field: "sweptAt", direction: "asc" },
      limit,
    });
  }
}

/**
 * Start the row's current execution and record its ARN. Starting the same
 * name again is safe: Lambda returns the execution it already has.
 */
export async function dispatch(pack: Pack, row: InstanceRow): Promise<void> {
  const arn = await pack.control.start(row.execution, referenceTo(row));
  await pack.table.touch(row.instanceId, (now) =>
    now.execution === row.execution && !now.executionArn ? { ...now, executionArn: arn } : undefined,
  );
}

/** The row of a finished instance: no input or event, kept for `retentionMs`. */
export function finished(pack: Pack, row: InstanceRow, status: "completed" | "failed" | "terminated"): InstanceRow {
  return {
    ...row,
    status,
    input: undefined,
    event: undefined,
    ticking: undefined,
    wake: undefined,
    ttl: Math.max(1, Math.ceil(pack.retentionMs / 1000)),
  };
}

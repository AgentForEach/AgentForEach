/**
 * The Durable port on Lambda durable functions: the operations side.
 *
 * Every operation goes to the instance table first (`./instances.ts`), then
 * to Lambda:
 * - `startJob` / `startWait` / `ensureAlarm` claim the row (an active id
 *   starts nothing; a finished one is replaced) with a fresh execution name,
 *   then invoke the durable function's published version with a reference
 *   to the row. The input stays in the row, never in the payload.
 * - `signal` stores the event in the row, then completes the callback the
 *   wait's execution registered, if it registered one yet; an execution that
 *   registers later finds the event and wakes itself.
 * - `wakeAlarm` sets the row's wake flag the same way.
 * - `terminate` marks the row terminated, so its execution stops at its next
 *   step without running a handler, then wakes and stops that execution.
 * - `status` reads the row.
 *
 * Callbacks that fail to send are logged, not thrown: what they carry is in
 * the row, and the sweep (`./sweep.ts`) sends them again.
 */

import { randomUUID } from "node:crypto";
import { isActive, type Durable, type DurableRegistry, type EnsureResult, type InstanceInfo, type StartResult } from "@agentforeach/platform";
import {
  dispatch,
  finished,
  resolvePack,
  type InstanceRow,
  type InstanceType,
  type LambdaDurableOptions,
  type Pack,
} from "./instances.js";
import { emptyReport, reconcile } from "./sweep.js";

/** An active row unchanged this long has its execution checked when its status is read. */
const STALE_MS = 60_000;

export class LambdaDurable implements Durable {
  private readonly pack: Pack;

  constructor(
    private readonly registry: DurableRegistry,
    options: LambdaDurableOptions,
  ) {
    this.pack = resolvePack(options);
  }

  async startJob<I>(kind: string, input: I, id?: string | null): Promise<StartResult & { id: string }> {
    this.registry.job(kind);
    // `null` too: an id that came through JSON arrives as null, not undefined.
    const instanceId = id ?? randomUUID();
    return { started: await this.start(instanceId, "job", kind, input), id: instanceId };
  }

  async startWait<I>(kind: string, id: string, input: I, timeoutMs: number): Promise<StartResult> {
    this.registry.wait(kind);
    return { started: await this.start(id, "wait", kind, input, Date.now() + Math.max(0, timeoutMs)) };
  }

  async signal(id: string, event: string, payload: unknown): Promise<boolean> {
    let accepted = false;
    const row = await this.pack.table.update(id, (row) => {
      accepted = false;
      if (row.type !== "wait" || !isActive(row.status)) return undefined;
      // Too late: decided, or past its timeout and about to be.
      if (row.outcome || (!row.event && Date.now() >= (row.timeoutAt ?? 0))) return undefined;
      accepted = true;
      if (event !== this.registry.wait(row.kind).event || row.event) return undefined;
      return { ...row, event: { name: event, payload: JSON.stringify(payload ?? null) } };
    });
    if (row?.callbackId) await this.wakeExecution(row);
    return accepted;
  }

  async ensureAlarm<I>(kind: string, id: string, input: I): Promise<EnsureResult> {
    this.registry.alarm(kind);
    const existing = await this.pack.table.read(id);
    if (existing?.status === "suspended") return "suspended";
    if (existing && isActive(existing.status)) return "running";
    return (await this.start(id, "alarm", kind, input)) ? "started" : "running";
  }

  async wakeAlarm(id: string): Promise<boolean> {
    let alive = false;
    const row = await this.pack.table.update(id, (row) => {
      alive = row.type === "alarm" && isActive(row.status);
      return alive && !row.wake ? { ...row, wake: true } : undefined;
    });
    if (row?.callbackId) await this.wakeExecution(row);
    return alive;
  }

  async terminate(id: string, reason: string): Promise<void> {
    const row = await this.pack.table.update(id, (row) =>
      isActive(row.status) || row.status === "suspended" ? finished(this.pack, row, "terminated") : undefined,
    );
    if (!row) return;
    // Its execution checks the row before each step; wake it if it's waiting, and stop it.
    if (row.callbackId) await this.wakeExecution(row);
    if (row.executionArn && this.pack.control.stop) {
      await this.pack.control.stop(row.executionArn, reason).catch((err) => {
        this.pack.logger.warn(`[durable] could not stop the execution of ${id}:`, err);
      });
    }
  }

  async status(id: string): Promise<InstanceInfo | null> {
    let row = await this.pack.table.read(id);
    if (!row) return null;
    // An active row that hasn't moved for a while: check its execution now
    // rather than wait for the sweep (an ended execution fails the row; one
    // Lambda closed early is started again, and stays active).
    if (isActive(row.status) && row.executionArn && Date.now() - row.updatedAt > STALE_MS) {
      try {
        await reconcile(this.pack, row, STALE_MS, emptyReport());
        row = (await this.pack.table.read(id)) ?? row;
      } catch (err) {
        this.pack.logger.warn(`[durable] could not check the execution of ${id}:`, err);
      }
    }
    return { status: row.status, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
  }

  // --------------------------------------------------------------------------

  /** Claim the id and start its execution; false when an instance holds it. */
  private async start(instanceId: string, type: InstanceType, kind: string, input: unknown, timeoutAt?: number): Promise<boolean> {
    const row = await this.pack.table.claim({
      instanceId,
      type,
      kind,
      status: "pending",
      execution: this.pack.executionName(instanceId),
      input: JSON.stringify(input ?? null),
      attempts: 0,
      // Gateway jobs and waits carry their owner here; shared scheduler alarms do not.
      ...(input && typeof input === "object" && "userId" in input && typeof input.userId === "string" ? { userId: input.userId } : {}),
      ...(timeoutAt === undefined ? {} : { timeoutAt }),
    });
    if (!row) return false;
    try {
      await dispatch(this.pack, row);
    } catch (err) {
      // Not started: fail the row, so the id can be started again. Should the
      // invoke have reached Lambda after all, its execution finds the row
      // failed and does nothing.
      await this.pack.table
        .update(instanceId, (now) =>
          now.execution === row.execution && !now.executionArn && isActive(now.status) ? finished(this.pack, now, "failed") : undefined,
        )
        .catch(() => undefined);
      throw err;
    }
    return true;
  }

  private async wakeExecution(row: InstanceRow): Promise<void> {
    await this.pack.control.sendCallback(row.callbackId!).catch((err) => {
      // Completed already, or not reachable now: the row has what it carried.
      this.pack.logger.debug(`[durable] callback for ${row.instanceId} not sent:`, err);
    });
  }
}

/** The Durable the gateway installs on Lambda (`installDurable`). */
export function createLambdaDurable(registry: DurableRegistry, options: LambdaDurableOptions): LambdaDurable {
  return new LambdaDurable(registry, options);
}

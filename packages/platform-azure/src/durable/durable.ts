/**
 * The Durable port on Azure Durable Functions.
 *
 * Each primitive is one generic orchestration; the kind travels in its input:
 *
 * - `DurableJob`: one activity (`DurableJobRun`), never retried.
 * - `DurableWait`: an optional start activity, then a timer racing the
 *   kind's event, then the event or timeout activity.
 * - `DurableAlarm`: a tick activity, then a timer (until the time the tick
 *   returned, capped at Durable's longest timer) racing a "wake" event, then
 *   `continueAsNew`.
 *
 * Instance ids are the caller's, so existing ids keep working. Activities
 * run in an invocation scope with their InvocationContext stashed, and carry
 * a durable client input, so a handler can start or signal other instances.
 *
 * Operations need the durable client of the current invocation: call them
 * from a route or schedule marked `durable`, or from a handler.
 */

import * as df from "durable-functions";
import { randomUUID } from "node:crypto";
import type {
  AlarmDefinition,
  Durable,
  DurableContext,
  DurableRegistry,
  DurableStatus,
  EnsureResult,
  HandlerContext,
  InstanceInfo,
  StartResult,
} from "@agentforeach/platform";
import type { InvocationContext } from "@azure/functions";
import { currentInvocationContext, inScope } from "../host.js";

export const ORCHESTRATIONS = { job: "DurableJob", wait: "DurableWait", alarm: "DurableAlarm" } as const;
const ACTIVITIES = {
  run: "DurableJobRun",
  waitStart: "DurableWaitStart",
  waitEvent: "DurableWaitEvent",
  waitTimeout: "DurableWaitTimeout",
  tick: "DurableAlarmTick",
} as const;
const WAKE_EVENT = "wake";

/** JavaScript Durable Functions timers can't be longer than 6 days. */
export const MAX_TIMER_MS = 6 * 24 * 60 * 60 * 1000;

interface JobInput {
  kind: string;
  input: unknown;
}
interface WaitInput extends JobInput {
  event: string;
  timeoutMs: number;
}
interface ActivityInput extends JobInput {
  instanceId: string;
  payload?: unknown;
}

/** The parts of the Durable Functions client this module uses; replaceable in tests. */
export interface DurableClientLike {
  getStatus(instanceId: string): Promise<{
    name?: string;
    runtimeStatus?: string;
    createdTime?: Date | string;
    lastUpdatedTime?: Date | string;
  } | undefined>;
  startNew(name: string, options?: { instanceId?: string; input?: unknown }): Promise<string>;
  raiseEvent(instanceId: string, eventName: string, eventData: unknown): Promise<void>;
  terminate(instanceId: string, reason: string): Promise<void>;
  purgeInstanceHistory(instanceId: string): Promise<unknown>;
}

/** The subset of `df.app` used to register orchestrations and activities. */
export interface DurableApp {
  orchestration(name: string, handler: df.OrchestrationHandler): void;
  activity(name: string, options: df.ActivityOptions): void;
}

const STATUS: Record<string, DurableStatus> = {
  Pending: "pending",
  Running: "running",
  ContinuedAsNew: "running",
  Suspended: "suspended",
  Completed: "completed",
  Failed: "failed",
  Terminated: "terminated",
  Canceled: "terminated",
};

function toDate(value: Date | string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function alreadyExists(err: unknown): boolean {
  return /already exists/i.test(err instanceof Error ? err.message : String(err));
}

function defaultClient(): DurableClientLike {
  const context = currentInvocationContext();
  if (!context) throw new Error("Durable operations need an Azure Functions invocation (no invocation context)");
  return df.getClient(context) as unknown as DurableClientLike;
}

export interface AzureDurableOptions {
  /**
   * After terminating an older orchestration that holds an alarm's id,
   * how often and how many times to check that it stopped before the alarm
   * takes the id. Termination is queued, not immediate. Default 20 × 500 ms.
   */
  stopCheck?: { attempts: number; delayMs: number };
}

export class AzureDurable implements Durable {
  private readonly stopCheck: { attempts: number; delayMs: number };

  constructor(
    private readonly registry: DurableRegistry,
    private readonly client: () => DurableClientLike = defaultClient,
    options: AzureDurableOptions = {},
  ) {
    this.stopCheck = options.stopCheck ?? { attempts: 20, delayMs: 500 };
  }

  async startJob<I>(kind: string, input: I, id?: string): Promise<StartResult & { id: string }> {
    this.registry.job(kind);
    const payload: JobInput = { kind, input };
    if (id === undefined) {
      const created = await this.client().startNew(ORCHESTRATIONS.job, { instanceId: randomUUID(), input: payload });
      return { started: true, id: created };
    }
    return { ...(await this.start(ORCHESTRATIONS.job, id, payload)), id };
  }

  async startWait<I>(kind: string, id: string, input: I, timeoutMs: number): Promise<StartResult> {
    const definition = this.registry.wait(kind);
    const payload: WaitInput = { kind, input, event: definition.event, timeoutMs };
    return this.start(ORCHESTRATIONS.wait, id, payload);
  }

  async signal(id: string, event: string, payload: unknown): Promise<boolean> {
    const client = this.client();
    const raw = await this.rawStatus(client, id);
    const status = raw ? STATUS[raw.runtimeStatus ?? ""] : undefined;
    if (status !== "pending" && status !== "running") return false;
    await client.raiseEvent(id, event, payload);
    return true;
  }

  async ensureAlarm<I>(kind: string, id: string, input: I): Promise<EnsureResult> {
    this.registry.alarm(kind);
    const client = this.client();
    const raw = await this.rawStatus(client, id);
    const status = raw ? STATUS[raw.runtimeStatus ?? ""] : undefined;
    if (status === "suspended") return "suspended";
    if (status === "pending" || status === "running") {
      if (raw?.name === undefined || raw.name === ORCHESTRATIONS.alarm) return "running";
      // An instance of an older orchestration holds this id (e.g. the
      // pre-platform CronScheduler): replace it with the generic alarm. The
      // termination is queued, so wait for it to land before taking the id;
      // if it hasn't, leave it to the next call.
      await client.terminate(id, `Replaced by ${ORCHESTRATIONS.alarm}`);
      if (!(await this.stopped(client, id))) return "running";
    }
    if (raw) await client.purgeInstanceHistory(id).catch(() => undefined);
    try {
      await client.startNew(ORCHESTRATIONS.alarm, { instanceId: id, input: { kind, input } satisfies JobInput });
    } catch (err) {
      if (alreadyExists(err)) return "running";
      throw err;
    }
    return "started";
  }

  async wakeAlarm(id: string): Promise<boolean> {
    const client = this.client();
    const raw = await this.rawStatus(client, id);
    const status = raw ? STATUS[raw.runtimeStatus ?? ""] : undefined;
    if (status !== "pending" && status !== "running") return false;
    // An older orchestration doesn't listen for "wake"; ensureAlarm replaces it.
    if (raw?.name !== undefined && raw.name !== ORCHESTRATIONS.alarm) return false;
    await client.raiseEvent(id, WAKE_EVENT, {});
    return true;
  }

  async terminate(id: string, reason: string): Promise<void> {
    const client = this.client();
    const raw = await this.rawStatus(client, id);
    const status = raw ? STATUS[raw.runtimeStatus ?? ""] : undefined;
    if (status === "pending" || status === "running" || status === "suspended") await client.terminate(id, reason);
  }

  async status(id: string): Promise<InstanceInfo | null> {
    const raw = await this.rawStatus(this.client(), id);
    const status = raw ? STATUS[raw.runtimeStatus ?? ""] : undefined;
    if (!raw || !status) return null;
    return { status, createdAt: toDate(raw.createdTime), updatedAt: toDate(raw.lastUpdatedTime) };
  }

  // --------------------------------------------------------------------------

  /** Start unless pending or running; a finished instance is replaced. */
  private async start(orchestration: string, id: string, input: unknown): Promise<StartResult> {
    const client = this.client();
    const raw = await this.rawStatus(client, id, { lenient: true });
    const status = raw ? STATUS[raw.runtimeStatus ?? ""] : undefined;
    if (status === "pending" || status === "running" || status === "suspended") return { started: false };
    try {
      await client.startNew(orchestration, { instanceId: id, input });
    } catch (err) {
      // Two identical starts racing: the other one won.
      if (alreadyExists(err)) return { started: false };
      throw err;
    }
    return { started: true };
  }

  /** Wait until the instance is no longer pending or running; false if it still is after the checks. */
  private async stopped(client: DurableClientLike, id: string): Promise<boolean> {
    for (let i = 0; i < this.stopCheck.attempts; i++) {
      const status = STATUS[(await this.rawStatus(client, id))?.runtimeStatus ?? ""];
      if (status !== "pending" && status !== "running") return true;
      await new Promise((r) => setTimeout(r, this.stopCheck.delayMs));
    }
    return false;
  }

  /**
   * The instance's status, or undefined when there is none: the client
   * throws "HTTP 404" for a missing instance. Other errors (throttling, an
   * unavailable task hub) are thrown, except with `lenient`, where any error
   * counts as no instance (starting a job did that before the port).
   */
  private async rawStatus(client: DurableClientLike, id: string, options: { lenient?: boolean } = {}) {
    try {
      return await client.getStatus(id);
    } catch (err) {
      if (options.lenient || /\b404\b|not found/i.test(err instanceof Error ? err.message : String(err))) return undefined;
      throw err;
    }
  }
}

// ============================================================================
// Registration
// ============================================================================

function durableContext(context: HandlerContext, instanceId: string): DurableContext {
  return {
    instanceId,
    invocationId: context.invocationId,
    log: (...a) => context.log(...a),
    warn: (...a) => context.warn(...a),
    error: (...a) => context.error(...a),
    trace: (...a) => context.trace(...a),
  };
}

/** Wrap an activity: its own invocation scope, a durable client input, the kind's handler. */
function activity(
  app: DurableApp,
  name: string,
  handler: (input: ActivityInput, context: DurableContext) => Promise<unknown>,
): void {
  app.activity(name, {
    extraInputs: [df.input.durableClient()],
    handler: (input: unknown, context: InvocationContext) => {
      const a = input as ActivityInput;
      return inScope(context, "job", () => handler(a, durableContext(context, a.instanceId)));
    },
  });
}

/**
 * Register the generic orchestrations and activities that run the
 * registry's kinds, and return the Durable implementation.
 */
export function registerDurable(registry: DurableRegistry, app: DurableApp = df.app): AzureDurable {
  app.orchestration(ORCHESTRATIONS.job, function* (ctx) {
    const input = ctx.df.getInput() as JobInput;
    yield ctx.df.callActivity(ACTIVITIES.run, { ...input, instanceId: ctx.df.instanceId } satisfies ActivityInput);
  });
  activity(app, ACTIVITIES.run, (a, ctx) => registry.job(a.kind).run(a.input, ctx));

  app.orchestration(ORCHESTRATIONS.wait, function* (ctx) {
    const input = ctx.df.getInput() as WaitInput;
    const base = { kind: input.kind, input: input.input, instanceId: ctx.df.instanceId };
    if (registry.wait(input.kind).start) yield ctx.df.callActivity(ACTIVITIES.waitStart, base);
    const deadline = new Date(ctx.df.currentUtcDateTime.getTime() + Math.min(input.timeoutMs, MAX_TIMER_MS));
    const timer = ctx.df.createTimer(deadline);
    const event = ctx.df.waitForExternalEvent(input.event);
    yield ctx.df.Task.any([timer, event]);
    if (event.isCompleted) {
      if (!timer.isCompleted) timer.cancel();
      yield ctx.df.callActivity(ACTIVITIES.waitEvent, { ...base, payload: event.result } satisfies ActivityInput);
    } else {
      yield ctx.df.callActivity(ACTIVITIES.waitTimeout, base);
    }
  });
  activity(app, ACTIVITIES.waitStart, (a, ctx) => registry.wait(a.kind).start!(a.input, ctx));
  activity(app, ACTIVITIES.waitEvent, (a, ctx) => registry.wait(a.kind).onEvent(a.input, a.payload, ctx));
  activity(app, ACTIVITIES.waitTimeout, (a, ctx) => registry.wait(a.kind).onTimeout(a.input, ctx));

  app.orchestration(ORCHESTRATIONS.alarm, function* (ctx) {
    const input = ctx.df.getInput() as JobInput;
    const next: number = yield ctx.df.callActivity(ACTIVITIES.tick, {
      ...input,
      instanceId: ctx.df.instanceId,
    } satisfies ActivityInput);
    const now = ctx.df.currentUtcDateTime.getTime();
    const timer = ctx.df.createTimer(new Date(Math.min(Math.max(next, now), now + MAX_TIMER_MS)));
    const wake = ctx.df.waitForExternalEvent(WAKE_EVENT);
    yield ctx.df.Task.any([timer, wake]);
    // Durable Functions: every pending timer must finish or be cancelled.
    if (!timer.isCompleted) timer.cancel();
    ctx.df.continueAsNew(input);
  });
  activity(app, ACTIVITIES.tick, (a, ctx) =>
    (registry.alarm(a.kind) as AlarmDefinition<unknown>).tick(a.input, ctx),
  );

  return new AzureDurable(registry);
}

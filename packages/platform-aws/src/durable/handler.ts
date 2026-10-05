/**
 * The Durable port on Lambda durable functions: the execution side. One
 * durable function (the `durable` export of the Lambda entry) runs every
 * kind; its payload is a reference to the instance row (`DurableReference`).
 *
 * - A job: run the handler, then finish.
 * - A wait: run `start`, then wait on a durable callback until the event
 *   arrives (`signal` completes the callback) or the timeout passes (the
 *   callback's own timeout), then run `onEvent` or `onTimeout`, then finish.
 * - An alarm: tick, then wait on a callback until the next tick is due
 *   (`wakeAlarm` completes it early), and again.
 *
 * Every handler runs in its own step with at-most-once-per-retry semantics:
 * a handler that throws fails the instance and is never retried (the port's
 * rule); a handler cut off mid-way (the invocation timed out or crashed) is
 * run again, with `attempt` counted in the row, so the handler can tell. An
 * instance whose handler was cut off `maxRuns` times fails.
 *
 * Each execution acts only while the row names it (`current`). A wait or an
 * alarm hands the instance to a fresh execution after `segmentMs` (or an
 * alarm after `ticksPerExecution` ticks), as Durable Functions' continueAsNew
 * does, so no execution outlives Lambda's limits.
 */

import { randomUUID } from "node:crypto";
import {
  CallbackTimeoutError,
  StepSemantics,
  withDurableExecution,
  type DurableContext as ExecutionContext,
  type DurableLambdaHandler,
  type StepConfig,
} from "@aws/durable-execution-sdk-js";
import { openScope, type DurableContext, type DurableRegistry, type InvocationKind } from "@agentforeach/platform";
import type { DurableReference } from "./control.js";
import {
  current,
  dispatch,
  finished,
  resolvePack,
  type InstanceRow,
  type InstanceType,
  type LambdaDurableOptions,
  type Pack,
} from "./instances.js";

/** The Lambda invocation context a durable execution runs in. */
type LambdaContext = ExecutionContext["lambdaContext"];

/** What a handler step returns: null when the instance moved on without it. */
type Ran<T> = { ok: true; value: T } | { ok: false } | null;

/** Time kept back from the invocation's remaining time when a handler's deadline is set. */
const DEADLINE_MARGIN_MS = 10_000;

function isReference(value: unknown): value is DurableReference {
  const r = value as DurableReference;
  return !!r && typeof r === "object" && typeof r.id === "string" && typeof r.kind === "string" && typeof r.execution === "string";
}

/** Retry a handler step only when it was cut off, never when it threw. */
export function handlerStep<T>(maxRuns: number): StepConfig<T> {
  return {
    semantics: StepSemantics.AtMostOncePerRetry,
    retryStrategy: (error, attempt) => ({
      shouldRetry: error?.name === "StepInterruptedError" && attempt <= maxRuns,
      delay: { seconds: 1 },
    }),
  };
}

/** The steps an execution takes, each reading and writing the instance row. */
class ExecutionSteps {
  constructor(
    private readonly registry: DurableRegistry,
    private readonly pack: Pack,
  ) {}

  /** Mark the instance running. Null when the row no longer names this execution. */
  async begin(ref: DurableReference): Promise<{ type: InstanceType; waiting: boolean; startedAt: number } | null> {
    const row = await this.pack.table.read(ref.id);
    if (!current(row, ref.execution)) return null;
    if (row.status === "pending") {
      await this.pack.table.update(ref.id, (now) => (current(now, ref.execution) ? { ...now, status: "running" } : undefined));
    }
    return { type: row.type, waiting: !!row.waiting, startedAt: Date.now() };
  }

  /**
   * Run one handler: count the attempt in the row, then run it in its own
   * invocation scope, awaiting its background work. A tick also clears the
   * alarm's wake flag and callback.
   */
  async handler<T>(
    ref: DurableReference,
    lambda: LambdaContext,
    run: (row: InstanceRow, input: unknown, context: DurableContext) => Promise<T>,
  ): Promise<Ran<T>> {
    const row = await this.pack.table.update(ref.id, (now) => {
      if (!current(now, ref.execution)) return undefined;
      const next = { ...now, attempts: now.attempts + 1 };
      return now.type === "alarm" ? { ...next, ticking: true, wake: false, callbackId: undefined } : next;
    });
    if (!row) return null;
    if (row.attempts > this.pack.maxRuns) {
      this.pack.logger.error(`[durable] ${row.type} ${row.kind} ${row.instanceId} was cut off ${row.attempts - 1} times; failing it`);
      return { ok: false };
    }
    const kind: InvocationKind = row.type === "alarm" ? "alarm" : "job";
    const invocationId = randomUUID();
    const ctx = this.context(row, invocationId, lambda);
    const opened = openScope({ invocationId, kind });
    try {
      const value = await opened.run(() => run(row, JSON.parse(row.input ?? "null"), ctx));
      return { ok: true, value };
    } catch (err) {
      ctx.error(`[durable] ${row.type} ${row.kind} ${row.instanceId} failed:`, err);
      return { ok: false };
    } finally {
      await opened.settle();
    }
  }

  /**
   * Where a wait is: decided (the event is in the row, or the timeout
   * passed: marked so signals are refused from now), or how long to sleep,
   * or time to hand over to a fresh execution.
   */
  async planWait(
    ref: DurableReference,
    startedAt: number,
  ): Promise<{ outcome: "event" | "timeout" } | { sleepMs: number } | { handOver: true } | null> {
    let plan: { outcome: "event" | "timeout" } | { sleepMs: number } | { handOver: true } | null = null;
    await this.pack.table.update(ref.id, (row) => {
      plan = null;
      if (!current(row, ref.execution)) return undefined;
      const waiting = row.waiting ? row : { ...row, waiting: true, attempts: 0 };
      if (row.outcome) {
        plan = { outcome: row.outcome };
        return undefined;
      }
      const now = Date.now();
      const outcome = row.event ? "event" : now >= (row.timeoutAt ?? 0) ? "timeout" : undefined;
      if (outcome) {
        plan = { outcome };
        return { ...waiting, outcome, attempts: 0, callbackId: undefined };
      }
      const left = startedAt + this.pack.segmentMs - now;
      plan = left <= 0 ? { handOver: true } : { sleepMs: Math.min((row.timeoutAt ?? now) - now, left) };
      return row.waiting ? undefined : waiting;
    });
    return plan;
  }

  /**
   * After a tick: how long to sleep (none when woken during the tick), and
   * whether to hand over to a fresh execution once the sleep ends.
   */
  async planSleep(
    ref: DurableReference,
    next: number,
    startedAt: number,
    ticks: number,
  ): Promise<{ sleepMs: number; handOver: boolean } | null> {
    let woken = false;
    const row = await this.pack.table.update(ref.id, (row) => {
      if (!current(row, ref.execution)) return undefined;
      woken = !!row.wake;
      return { ...row, ticking: false, wake: false, attempts: 0 };
    });
    if (!row) return null;
    const now = Date.now();
    const left = Math.max(0, startedAt + this.pack.segmentMs - now);
    const sleepMs = woken ? 0 : Math.max(0, next - now);
    return { sleepMs: Math.min(sleepMs, left), handOver: ticks >= this.pack.ticksPerExecution || sleepMs >= left };
  }

  /**
   * The callback's submitter: record the callback in the row, so `signal`
   * and `wakeAlarm` can complete it. When what it waits for is already in
   * the row (or the instance moved on), complete it now.
   */
  async listen(ref: DurableReference, callbackId: string): Promise<void> {
    let wakeNow = false;
    await this.pack.table.update(ref.id, (row) => {
      wakeNow = true;
      if (!current(row, ref.execution)) return undefined;
      wakeNow = row.type === "wait" ? !!row.event : !!row.wake;
      return { ...row, callbackId };
    });
    if (wakeNow) await this.pack.control.sendCallback(callbackId);
  }

  /** Give the row to a fresh execution. Returns its name, or null when the row moved on. */
  async handOver(ref: DurableReference): Promise<string | null> {
    const execution = this.pack.executionName(ref.id);
    const row = await this.pack.table.update(ref.id, (row) =>
      current(row, ref.execution)
        ? { ...row, execution, executionArn: undefined, callbackId: undefined, ticking: undefined, attempts: 0 }
        : undefined,
    );
    return row ? execution : null;
  }

  /** Start the execution `handOver` named, unless something else replaced it since. */
  async dispatch(ref: DurableReference, execution: string): Promise<void> {
    const row = await this.pack.table.read(ref.id);
    if (current(row, execution) && !row.executionArn) await dispatch(this.pack, row);
  }

  async finish(ref: DurableReference, ok: boolean): Promise<void> {
    await this.pack.table.update(ref.id, (row) =>
      current(row, ref.execution) ? finished(this.pack, row, ok ? "completed" : "failed") : undefined,
    );
  }

  private context(row: InstanceRow, invocationId: string, lambda: LambdaContext): DurableContext & { deadlineAt?: number } {
    const l = this.pack.logger;
    const remaining = lambda.getRemainingTimeInMillis?.();
    return {
      instanceId: row.instanceId,
      invocationId,
      attempt: row.attempts,
      ...(typeof remaining === "number" ? { deadlineAt: Date.now() + Math.max(0, remaining - DEADLINE_MARGIN_MS) } : {}),
      log: (...a) => l.log(...a),
      warn: (...a) => l.warn(...a),
      error: (...a) => l.error(...a),
      trace: (...a) => l.debug(...a),
    };
  }
}

/** Wait on a callback for up to `ms`; true when it was completed, false when it timed out. */
async function sleep(ctx: ExecutionContext, steps: ExecutionSteps, ref: DurableReference, name: string, ms: number): Promise<boolean> {
  try {
    await ctx.waitForCallback(name, (callbackId) => steps.listen(ref, callbackId), {
      timeout: { seconds: Math.max(1, Math.ceil(ms / 1000)) },
    });
    return true;
  } catch (err) {
    if (err instanceof CallbackTimeoutError) return false;
    throw err;
  }
}

/** The durable function's handler: runs the registry's kinds for the instances the pack starts. */
export function createLambdaDurableHandler(registry: DurableRegistry, options: LambdaDurableOptions): DurableLambdaHandler {
  const pack = resolvePack(options);
  const steps = new ExecutionSteps(registry, pack);

  async function handOver(ctx: ExecutionContext, ref: DurableReference): Promise<string> {
    const next = await ctx.step("hand-over", () => steps.handOver(ref));
    if (next) await ctx.step("dispatch", () => steps.dispatch(ref, next));
    return next ? "handed-over" : "superseded";
  }

  async function runJob(ctx: ExecutionContext, ref: DurableReference): Promise<string> {
    const ran = await ctx.step(
      "run",
      () => steps.handler(ref, ctx.lambdaContext, (row, input, c) => registry.job(row.kind).run(input, c)),
      handlerStep(pack.maxRuns),
    );
    if (!ran) return "superseded";
    await ctx.step("finish", () => steps.finish(ref, ran.ok));
    return ran.ok ? "completed" : "failed";
  }

  async function runWait(ctx: ExecutionContext, ref: DurableReference, begun: { waiting: boolean; startedAt: number }): Promise<string> {
    if (!begun.waiting) {
      const started = await ctx.step(
        "start",
        () => steps.handler(ref, ctx.lambdaContext, (row, input, c) => registry.wait(row.kind).start?.(input, c) ?? Promise.resolve()),
        handlerStep(pack.maxRuns),
      );
      if (!started) return "superseded";
      if (!started.ok) {
        await ctx.step("finish", () => steps.finish(ref, false));
        return "failed";
      }
    }
    for (let i = 0; ; i++) {
      const plan = await ctx.step(`plan-${i}`, () => steps.planWait(ref, begun.startedAt));
      if (!plan) return "superseded";
      if ("handOver" in plan) return handOver(ctx, ref);
      if ("sleepMs" in plan) {
        await sleep(ctx, steps, ref, `event-${i}`, plan.sleepMs);
        continue;
      }
      const outcome = plan.outcome;
      const ran = await ctx.step(
        outcome,
        () =>
          steps.handler(ref, ctx.lambdaContext, (row, input, c) => {
            const definition = registry.wait(row.kind);
            return outcome === "event"
              ? definition.onEvent(input, JSON.parse(row.event?.payload ?? "null"), c)
              : definition.onTimeout(input, c);
          }),
        handlerStep(pack.maxRuns),
      );
      if (!ran) return "superseded";
      await ctx.step("finish", () => steps.finish(ref, ran.ok));
      return ran.ok ? "completed" : "failed";
    }
  }

  async function runAlarm(ctx: ExecutionContext, ref: DurableReference, begun: { startedAt: number }): Promise<string> {
    for (let i = 1; ; i++) {
      const ticked = await ctx.step(
        `tick-${i}`,
        () => steps.handler(ref, ctx.lambdaContext, (row, input, c) => registry.alarm(row.kind).tick(input, c)),
        handlerStep(pack.maxRuns),
      );
      if (!ticked) return "superseded";
      if (!ticked.ok) {
        await ctx.step("finish", () => steps.finish(ref, false));
        return "failed";
      }
      const plan = await ctx.step(`plan-${i}`, () => steps.planSleep(ref, Number(ticked.value), begun.startedAt, i));
      if (!plan) return "superseded";
      if (plan.sleepMs > 0) await sleep(ctx, steps, ref, `sleep-${i}`, plan.sleepMs);
      if (plan.handOver) return handOver(ctx, ref);
    }
  }

  return withDurableExecution<unknown, string>(async (reference, ctx) => {
    if (!isReference(reference)) throw new Error("Invalid durable execution reference");
    const ref = reference;
    const begun = await ctx.step("begin", () => steps.begin(ref));
    if (!begun) return "superseded";
    try {
      if (begun.type === "job") return await runJob(ctx, ref);
      if (begun.type === "wait") return await runWait(ctx, ref, begun);
      return await runAlarm(ctx, ref, begun);
    } catch (err) {
      // The pack's own bookkeeping failed past its retries: fail the instance, not just the execution.
      await ctx.step("record-failure", () => steps.finish(ref, false));
      throw err;
    }
  });
}

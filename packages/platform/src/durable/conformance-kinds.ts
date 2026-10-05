/**
 * AgentForEach Platform — Durable conformance kinds
 *
 * The kinds the durable conformance suite runs, as a factory with no test
 * runner or Node imports, so a Worker (or any host the suite drives
 * remotely) can define exactly the same kinds. What the handlers do goes
 * through `ConformanceHooks`: in-process for local backends
 * (`MemoryConformanceRecorder`), or to wherever a remote host keeps it.
 */

import type { DurableRegistry } from "./registry.js";
import type { Durable, DurableContext } from "./types.js";

/** One handler call the suite checks; `attempt` as the host passed it (`DurableContext.attempt`). */
export type ConformanceCall = { kind: string; id: string; input: unknown; payload?: unknown; attempt?: number; at: number };

/** What the conformance kinds' handlers do with the outside world. */
export interface ConformanceHooks {
  /** Record a handler call. */
  record(call: ConformanceCall): void | Promise<void>;
  /** Hold a job running until the suite releases `key`. */
  gate(key: string): Promise<void>;
  /** How far ahead (ms) this alarm's next tick should be. */
  nextTickIn(instanceId: string): number | Promise<number>;
  /** The backend under test, for handlers that start other instances. */
  durable(): Durable;
  /** The suite's time unit, in ms. */
  unitMs: number;
}

/** What the suite reads and sets, wherever the handlers run. */
export interface ConformanceRecorder {
  calls(instanceId: string): Promise<ConformanceCall[]>;
  /** A job is holding on `key`. */
  gateHeld(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
  setNextTickIn(instanceId: string, ms: number): Promise<void>;
}

export const CONFORMANCE_JOB = "conformance-job";
export const CONFORMANCE_WAIT = "conformance-wait";
export const CONFORMANCE_EVENT = "conformance-event";
export const CONFORMANCE_ALARM = "conformance-alarm";

/** Defines the suite's kinds in `registry`. */
export function defineConformanceKinds(registry: DurableRegistry, hooks: ConformanceHooks): DurableRegistry {
  const record = (kind: string, ctx: DurableContext, input: unknown, payload?: unknown) =>
    hooks.record({
      kind,
      id: ctx.instanceId,
      input,
      ...(payload === undefined ? {} : { payload }),
      ...(ctx.attempt === undefined ? {} : { attempt: ctx.attempt }),
      at: Date.now(),
    });
  return registry
    .defineJob<{ value: unknown; hold?: string; fail?: boolean; spawn?: string }>({
      kind: CONFORMANCE_JOB,
      async run(input, ctx) {
        await record("job", ctx, input);
        if (input.hold) await hooks.gate(input.hold);
        if (input.spawn) await hooks.durable().startJob(CONFORMANCE_JOB, { value: "child" }, input.spawn);
        if (input.fail) throw new Error("conformance job failed on purpose");
      },
    })
    .defineWait<{ value: unknown; slowStart?: boolean }, unknown>({
      kind: CONFORMANCE_WAIT,
      event: CONFORMANCE_EVENT,
      async start(input, ctx) {
        await record("wait-start", ctx, input);
        if (input.slowStart) await sleep(hooks.unitMs * 3);
      },
      async onEvent(input, payload, ctx) {
        await record("wait-event", ctx, input, payload);
      },
      async onTimeout(input, ctx) {
        await record("wait-timeout", ctx, input);
      },
    })
    .defineAlarm<{ value: unknown; fail?: boolean }>({
      kind: CONFORMANCE_ALARM,
      async tick(input, ctx) {
        await record("tick", ctx, input);
        if (input.fail) throw new Error("conformance tick failed on purpose");
        return Date.now() + (await hooks.nextTickIn(ctx.instanceId));
      },
    });
}

/**
 * The suite's state in memory: the hooks side for handlers and the recorder
 * side for the suite. Local backends use one in-process; a remote host can
 * keep one where its handlers reach it (a Worker keeps it in a Durable
 * Object) and serve the recorder side to the suite.
 */
export class MemoryConformanceRecorder implements ConformanceRecorder {
  private readonly recorded: ConformanceCall[] = [];
  /** Each key's waiting gates: a handler run again (attempt > 1) can wait on a key its cut-off run holds. */
  private readonly held = new Map<string, Array<() => void>>();
  private readonly released = new Set<string>();
  private readonly ticks = new Map<string, number>();

  record(call: ConformanceCall): void {
    this.recorded.push(call);
  }

  /** Resolves once the suite releases `key`. */
  gate(key: string): Promise<void> {
    if (this.released.has(key)) return Promise.resolve();
    return new Promise((resolve) => this.held.set(key, [...(this.held.get(key) ?? []), resolve]));
  }

  /** Marks `key` held without waiting (for hosts that poll `isReleased`). */
  hold(key: string): void {
    if (!this.held.has(key)) this.held.set(key, []);
  }

  isReleased(key: string): boolean {
    return this.released.has(key);
  }

  nextTickIn(instanceId: string): number {
    return this.ticks.get(instanceId) ?? 60_000;
  }

  async calls(instanceId: string): Promise<ConformanceCall[]> {
    return this.recorded.filter((c) => c.id === instanceId);
  }

  async gateHeld(key: string): Promise<boolean> {
    return this.held.has(key);
  }

  async release(key: string): Promise<void> {
    this.released.add(key);
    for (const resolve of this.held.get(key) ?? []) resolve();
  }

  async setNextTickIn(instanceId: string, ms: number): Promise<void> {
    this.ticks.set(instanceId, ms);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

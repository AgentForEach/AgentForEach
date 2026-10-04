/**
 * An in-process Durable: instances live in this process's memory and end
 * with it. The reference implementation for the conformance suite, and the
 * runtime for tests and local development without a durable backend.
 *
 * Each handler runs in an invocation scope (kind "job" or "alarm") whose
 * background work is awaited before the instance counts as finished, the way
 * a durable step on a short-lived host must.
 */

import { randomUUID } from "node:crypto";
import { openScope } from "../scope.js";
import type { InvocationKind } from "../host.js";
import type { DurableRegistry } from "./registry.js";
import {
  isActive,
  type Durable,
  type DurableContext,
  type DurableStatus,
  type EnsureResult,
  type InstanceInfo,
  type StartResult,
} from "./types.js";

interface Instance {
  kind: string;
  type: "job" | "wait" | "alarm";
  status: DurableStatus;
  createdAt: Date;
  updatedAt: Date;
  /** Wait: the event, once it arrived. */
  event?: { name: string; payload: unknown };
  /** Wait: resolves the wait when the event arrives. */
  deliver?: () => void;
  /** Alarm: the timer for the next tick. */
  timer?: ReturnType<typeof setTimeout>;
  /** Alarm: a tick is running. */
  ticking?: boolean;
  /** Alarm: woken while a tick was running; tick again when it ends. */
  wokenDuringTick?: boolean;
  /** Alarm: run the next tick now. */
  tickNow?: () => void;
}

export interface InMemoryDurableOptions {
  /** Where handler logs go. Default: console. */
  logger?: Pick<Console, "log" | "warn" | "error" | "debug">;
}

export class InMemoryDurable implements Durable {
  private readonly instances = new Map<string, Instance>();
  private readonly logger: Pick<Console, "log" | "warn" | "error" | "debug">;

  constructor(
    private readonly registry: DurableRegistry,
    options: InMemoryDurableOptions = {},
  ) {
    this.logger = options.logger ?? console;
  }

  async startJob<I>(kind: string, input: I, id: string = randomUUID()): Promise<StartResult & { id: string }> {
    const definition = this.registry.job(kind);
    if (!this.claim(id, kind, "job")) return { started: false, id };
    const instance = this.instances.get(id)!;
    void this.runStep(instance, id, "job", (ctx) => definition.run(input, ctx)).then((ok) => this.finish(instance, ok));
    return { started: true, id };
  }

  async startWait<I>(kind: string, id: string, input: I, timeoutMs: number): Promise<StartResult> {
    const definition = this.registry.wait(kind);
    if (!this.claim(id, kind, "wait")) return { started: false };
    const instance = this.instances.get(id)!;
    void (async () => {
      if (definition.start && !(await this.runStep(instance, id, "job", (ctx) => definition.start!(input, ctx)))) {
        return this.finish(instance, false);
      }
      const arrived = new Promise<boolean>((resolve) => {
        if (instance.event) return resolve(true);
        const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        instance.deliver = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
      const gotEvent = await arrived;
      if (!isActive(instance.status)) return;
      const ok = gotEvent
        ? await this.runStep(instance, id, "job", (ctx) => definition.onEvent(input, instance.event!.payload, ctx))
        : await this.runStep(instance, id, "job", (ctx) => definition.onTimeout(input, ctx));
      this.finish(instance, ok);
    })();
    return { started: true };
  }

  async signal(id: string, event: string, payload: unknown): Promise<boolean> {
    const instance = this.instances.get(id);
    if (!instance || instance.type !== "wait" || !isActive(instance.status)) return false;
    if (event !== this.registry.wait(instance.kind).event || instance.event) return true;
    instance.event = { name: event, payload };
    instance.deliver?.();
    return true;
  }

  async ensureAlarm<I>(kind: string, id: string, input: I): Promise<EnsureResult> {
    const definition = this.registry.alarm(kind);
    const existing = this.instances.get(id);
    if (existing?.status === "suspended") return "suspended";
    if (!this.claim(id, kind, "alarm")) return "running";
    const instance = this.instances.get(id)!;
    const tick = async (): Promise<void> => {
      instance.timer = undefined;
      if (!isActive(instance.status)) return;
      instance.ticking = true;
      instance.wokenDuringTick = false;
      let next = Date.now();
      const ok = await this.runStep(instance, id, "alarm", async (ctx) => {
        next = await definition.tick(input, ctx);
      });
      instance.ticking = false;
      if (!isActive(instance.status)) return;
      if (!ok) return this.finish(instance, false);
      const delay = instance.wokenDuringTick ? 0 : Math.max(0, next - Date.now());
      instance.timer = setTimeout(() => void tick(), delay);
    };
    instance.tickNow = () => {
      if (instance.timer) clearTimeout(instance.timer);
      instance.timer = setTimeout(() => void tick(), 0);
    };
    void tick();
    return "started";
  }

  async wakeAlarm(id: string): Promise<boolean> {
    const instance = this.instances.get(id);
    if (!instance || instance.type !== "alarm" || !isActive(instance.status)) return false;
    if (instance.ticking) instance.wokenDuringTick = true;
    else instance.tickNow?.();
    return true;
  }

  async terminate(id: string, _reason: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance || !(isActive(instance.status) || instance.status === "suspended")) return;
    if (instance.timer) clearTimeout(instance.timer);
    instance.deliver = undefined;
    this.setStatus(instance, "terminated");
  }

  async status(id: string): Promise<InstanceInfo | null> {
    const instance = this.instances.get(id);
    if (!instance) return null;
    return { status: instance.status, createdAt: instance.createdAt, updatedAt: instance.updatedAt };
  }

  // --------------------------------------------------------------------------

  /** Create (or replace a finished) instance; false if one is active. */
  private claim(id: string, kind: string, type: Instance["type"]): boolean {
    const existing = this.instances.get(id);
    if (existing && (isActive(existing.status) || existing.status === "suspended")) return false;
    const now = new Date();
    this.instances.set(id, { kind, type, status: "pending", createdAt: now, updatedAt: now });
    return true;
  }

  private setStatus(instance: Instance, status: DurableStatus): void {
    instance.status = status;
    instance.updatedAt = new Date();
  }

  /** Mark this run finished; a run that was terminated or replaced since does nothing. */
  private finish(instance: Instance, ok: boolean): void {
    if (!isActive(instance.status)) return;
    this.setStatus(instance, ok ? "completed" : "failed");
  }


  /** Run one handler step in its own scope; true when it succeeded. */
  private async runStep(
    instance: Instance,
    id: string,
    kind: InvocationKind,
    step: (ctx: DurableContext) => Promise<void>,
  ): Promise<boolean> {
    if (this.instances.get(id) !== instance || !isActive(instance.status)) return false;
    if (instance.status === "pending") this.setStatus(instance, "running");
    const invocationId = randomUUID();
    const ctx = this.context(id, invocationId);
    const opened = openScope({ invocationId, kind });
    try {
      await opened.run(() => step(ctx));
      return true;
    } catch (err) {
      ctx.error(`[durable] ${instance.type} ${instance.kind} ${id} failed:`, err);
      return false;
    } finally {
      await opened.settle();
    }
  }

  private context(instanceId: string, invocationId: string): DurableContext {
    const l = this.logger;
    return {
      instanceId,
      invocationId,
      attempt: 1,
      log: (...a: unknown[]) => l.log(...a),
      warn: (...a: unknown[]) => l.warn(...a),
      error: (...a: unknown[]) => l.error(...a),
      trace: (...a: unknown[]) => l.debug(...a),
    };
  }
}

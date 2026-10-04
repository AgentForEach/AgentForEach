/**
 * The durable kinds an application defines. The gateway fills one registry
 * at startup; the platform pack reads it to run instances of each kind.
 */

import type { AlarmDefinition, JobDefinition, WaitDefinition } from "./types.js";

export class DurableRegistry {
  private readonly jobs = new Map<string, JobDefinition<any>>();
  private readonly waits = new Map<string, WaitDefinition<any, any>>();
  private readonly alarms = new Map<string, AlarmDefinition<any>>();

  defineJob<I>(definition: JobDefinition<I>): this {
    this.claim(definition.kind);
    this.jobs.set(definition.kind, definition);
    return this;
  }

  defineWait<I, E>(definition: WaitDefinition<I, E>): this {
    this.claim(definition.kind);
    this.waits.set(definition.kind, definition);
    return this;
  }

  defineAlarm<I>(definition: AlarmDefinition<I>): this {
    this.claim(definition.kind);
    this.alarms.set(definition.kind, definition);
    return this;
  }

  job(kind: string): JobDefinition<unknown> {
    const d = this.jobs.get(kind);
    if (!d) throw new Error(`Unknown durable job kind "${kind}"`);
    return d;
  }

  wait(kind: string): WaitDefinition<unknown, unknown> {
    const d = this.waits.get(kind);
    if (!d) throw new Error(`Unknown durable wait kind "${kind}"`);
    return d;
  }

  alarm(kind: string): AlarmDefinition<unknown> {
    const d = this.alarms.get(kind);
    if (!d) throw new Error(`Unknown durable alarm kind "${kind}"`);
    return d;
  }

  kinds(): { jobs: string[]; waits: string[]; alarms: string[] } {
    return { jobs: [...this.jobs.keys()], waits: [...this.waits.keys()], alarms: [...this.alarms.keys()] };
  }

  private claim(kind: string): void {
    if (!kind) throw new Error("A durable kind needs a name");
    if (this.jobs.has(kind) || this.waits.has(kind) || this.alarms.has(kind)) {
      throw new Error(`Durable kind "${kind}" is already defined`);
    }
  }
}

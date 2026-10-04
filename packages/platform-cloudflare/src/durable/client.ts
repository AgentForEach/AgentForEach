/**
 * The Durable port on Cloudflare: one Durable Object per instance id (named
 * by the id), running the instance with `DurableInstanceEngine`. Any id
 * works, since Durable Object names are free-form.
 */

import type { Durable, EnsureResult, InstanceInfo, StartResult } from "@agentforeach/platform";

/** The RPC methods of one instance's Durable Object (see `./objects.ts`). */
export interface DurableInstanceRpc {
  start(id: string, type: "job" | "wait" | "alarm", kind: string, input: unknown, timeoutMs?: number): Promise<StartResult>;
  signal(event: string, payload: unknown): Promise<boolean>;
  ensureAlarm(id: string, kind: string, input: unknown): Promise<EnsureResult>;
  wake(): Promise<boolean>;
  terminate(): Promise<void>;
  status(): Promise<InstanceInfo | null>;
}

/** Reaches the Durable Object for an instance id. */
export type InstanceResolver = (id: string) => DurableInstanceRpc;

/** A resolver over a Durable Object namespace binding (`env.DURABLE_INSTANCES`). */
export function namespaceResolver(namespace: () => DurableObjectNamespace): InstanceResolver {
  return (id) => {
    const ns = namespace();
    return ns.get(ns.idFromName(id)) as unknown as DurableInstanceRpc;
  };
}

/** Dates cross RPC as Dates; a plain fake may return strings. */
function revive(info: InstanceInfo | null): InstanceInfo | null {
  if (!info) return null;
  const date = (d: Date | string | undefined) => (d === undefined ? undefined : d instanceof Date ? d : new Date(d));
  return { status: info.status, createdAt: date(info.createdAt), updatedAt: date(info.updatedAt) };
}

export class CloudflareDurable implements Durable {
  constructor(private readonly instance: InstanceResolver) {}

  async startJob<I>(kind: string, input: I, id?: string | null): Promise<StartResult & { id: string }> {
    // `null` too: an id that came through JSON arrives as null, not undefined.
    const instanceId = id ?? crypto.randomUUID();
    return { ...(await this.instance(instanceId).start(instanceId, "job", kind, input)), id: instanceId };
  }

  startWait<I>(kind: string, id: string, input: I, timeoutMs: number): Promise<StartResult> {
    return this.instance(id).start(id, "wait", kind, input, timeoutMs);
  }

  signal(id: string, event: string, payload: unknown): Promise<boolean> {
    return this.instance(id).signal(event, payload);
  }

  ensureAlarm<I>(kind: string, id: string, input: I): Promise<EnsureResult> {
    return this.instance(id).ensureAlarm(id, kind, input);
  }

  wakeAlarm(id: string): Promise<boolean> {
    return this.instance(id).wake();
  }

  terminate(id: string, _reason: string): Promise<void> {
    return this.instance(id).terminate();
  }

  async status(id: string): Promise<InstanceInfo | null> {
    return revive(await this.instance(id).status());
  }
}

/**
 * The Durable Object behind every durable instance. The Worker entry builds
 * the class from the application's registry and exports it under the
 * binding name in wrangler.jsonc:
 *
 * ```ts
 * export const DurableInstance = defineDurableInstance(workflows);
 * ```
 *
 * Workers runtime only (`cloudflare:workers`); exported from
 * "@agentforeach/platform-cloudflare/durable/objects".
 */

import { DurableObject } from "cloudflare:workers";
import type { DurableRegistry, EnsureResult, InstanceInfo, StartResult } from "@agentforeach/platform";
import type { DurableInstanceRpc } from "./client.js";
import { DurableInstanceEngine } from "./engine.js";

/** The class `defineDurableInstance` returns: a Durable Object with the instance RPC methods. */
export type DurableInstanceClass<Env> = new (ctx: DurableObjectState, env: Env) => DurableObject<Env> & DurableInstanceRpc;

export function defineDurableInstance<Env = unknown>(registry: DurableRegistry): DurableInstanceClass<Env> {
  return class DurableInstance extends DurableObject<Env> implements DurableInstanceRpc {
    readonly engine: DurableInstanceEngine;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      this.engine = new DurableInstanceEngine(ctx.storage, registry);
    }

    start(id: string, type: "job" | "wait" | "alarm", kind: string, input: unknown, timeoutMs?: number): Promise<StartResult> {
      return this.engine.start(id, type, kind, input, timeoutMs);
    }

    signal(event: string, payload: unknown): Promise<boolean> {
      return this.engine.signal(event, payload);
    }

    ensureAlarm(id: string, kind: string, input: unknown): Promise<EnsureResult> {
      return this.engine.ensureAlarm(id, kind, input);
    }

    wake(): Promise<boolean> {
      return this.engine.wake();
    }

    terminate(): Promise<void> {
      return this.engine.terminate();
    }

    status(): Promise<InstanceInfo | null> {
      return this.engine.status();
    }

    override async alarm(): Promise<void> {
      await this.engine.alarm();
    }
  };
}

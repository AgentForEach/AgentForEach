/**
 * The durable conformance suite against the deployed durable function
 * ("connect mode"), as the Cloudflare pack runs it against workerd:
 *
 * - The durable function defines the suite's kinds
 *   (`defineDurableConformanceKinds`), which record their calls, hold their
 *   gates and read their alarm intervals in the database
 *   (`DURABLE_CONFORMANCE_COLLECTION`), since every handler runs in its own
 *   invocation.
 * - The `conformance` export of the Lambda entry
 *   (`createDurableConformanceHandler`) is the suite's control API: the
 *   Durable's operations, the recorder's, and `interrupt`, which stops an
 *   instance's execution and runs the sweep so the instance runs again.
 * - The suite runs anywhere with permission to invoke that function:
 *   `node packages/platform-aws/conformance/durable/run.mjs`.
 *
 * Nothing here runs unless invoked; the kinds are prefixed `conformance-`.
 */

import { randomUUID } from "node:crypto";
import { DurableRegistry, type Durable } from "@agentforeach/platform";
import {
  defineConformanceKinds,
  type ConformanceCall,
  type ConformanceRecorder,
} from "@agentforeach/platform/durable/conformance-kinds";
import type { Collection, Doc, StorageAdapter } from "@agentforeach/storage";
import { DURABLE_CONFORMANCE_COLLECTION } from "../collections.js";
import { createLambdaDurable } from "./durable.js";
import { resolvePack, type LambdaDurableOptions } from "./instances.js";
import { durableSweep } from "./sweep.js";

/** The suite's time unit on Lambda: callback timeouts are whole seconds. */
export const CONFORMANCE_UNIT_MS = 1000;

interface RecorderDoc extends Doc {
  key: string;
  at?: number;
  call?: ConformanceCall;
  ms?: number;
}

/** The suite's state in the database, for handlers and suite alike. */
export class StorageConformanceRecorder implements ConformanceRecorder {
  private opened: Promise<Collection<RecorderDoc>> | undefined;

  constructor(private readonly storage: () => StorageAdapter) {}

  private collection(): Promise<Collection<RecorderDoc>> {
    this.opened ??= (async () => {
      const storage = this.storage();
      await storage.initialize();
      return storage.collection<RecorderDoc>(DURABLE_CONFORMANCE_COLLECTION);
    })();
    return this.opened;
  }

  async record(call: ConformanceCall): Promise<void> {
    await (await this.collection()).create({ key: call.id, id: randomUUID(), at: call.at, call });
  }

  async calls(instanceId: string): Promise<ConformanceCall[]> {
    const docs = await (await this.collection()).find({ partitionKey: instanceId, orderBy: { field: "at" } });
    return docs.map((d) => d.call!).filter(Boolean);
  }

  async hold(key: string): Promise<void> {
    await (await this.collection()).upsert({ key: `gate:${key}`, id: "held" });
  }

  async isReleased(key: string): Promise<boolean> {
    return !!(await (await this.collection()).read("released", `gate:${key}`));
  }

  async gateHeld(key: string): Promise<boolean> {
    return !!(await (await this.collection()).read("held", `gate:${key}`));
  }

  async release(key: string): Promise<void> {
    await (await this.collection()).upsert({ key: `gate:${key}`, id: "released" });
  }

  async nextTickIn(instanceId: string): Promise<number> {
    return (await (await this.collection()).read("tick", `tick:${instanceId}`))?.ms ?? 60_000;
  }

  async setNextTickIn(instanceId: string, ms: number): Promise<void> {
    await (await this.collection()).upsert({ key: `tick:${instanceId}`, id: "tick", ms });
  }
}

/**
 * Define the suite's kinds in the durable function's registry, recording to
 * the database. `durable` is the installed Durable (for the kind that starts
 * another instance).
 */
export function defineDurableConformanceKinds(
  registry: DurableRegistry,
  options: { storage: () => StorageAdapter; durable: () => Durable },
): DurableRegistry {
  const recorder = new StorageConformanceRecorder(options.storage);
  return defineConformanceKinds(registry, {
    record: (call) => recorder.record(call),
    // Each handler runs in its own invocation: the gate polls the database.
    gate: async (key) => {
      await recorder.hold(key);
      while (!(await recorder.isReleased(key))) await new Promise((r) => setTimeout(r, CONFORMANCE_UNIT_MS / 4));
    },
    nextTickIn: (instanceId) => recorder.nextTickIn(instanceId),
    durable: options.durable,
    unitMs: CONFORMANCE_UNIT_MS,
  });
}

/** One call from the suite: `{ area: "durable" | "recorder", op, args }`. */
export interface ConformanceRequest {
  area: string;
  op: string;
  args?: unknown[];
}

export type ConformanceResponse = { result: unknown } | { error: string };

const DURABLE_OPS = ["startJob", "startWait", "signal", "ensureAlarm", "wakeAlarm", "terminate", "status"] as const;
const RECORDER_OPS = ["calls", "gateHeld", "release", "setNextTickIn"] as const;

/**
 * The `conformance` handler: the suite's control API. `registry` is the
 * durable function's (with `defineDurableConformanceKinds` applied), and
 * `options` the pack's, as the durable function has them.
 */
export function createDurableConformanceHandler(
  registry: DurableRegistry,
  options: LambdaDurableOptions,
): (request: ConformanceRequest) => Promise<ConformanceResponse> {
  const durable = createLambdaDurable(registry, options);
  const recorder = new StorageConformanceRecorder(options.storage);
  const pack = resolvePack(options);

  /** Stop the instance's execution, as Lambda would on a timeout, and sweep: the instance runs again. */
  async function interrupt(instanceId: string): Promise<unknown> {
    const row = await pack.table.read(instanceId);
    if (!row?.executionArn || !pack.control.stop) throw new Error(`No running execution for ${instanceId}`);
    await pack.control.stop(row.executionArn, "conformance interrupt");
    for (let i = 0; i < 20; i++) {
      if ((await pack.control.status(row.executionArn)) !== "RUNNING") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return durableSweep(options);
  }

  return async (request) => {
    const { area, op } = request ?? {};
    const args = Array.isArray(request?.args) ? request.args : [];
    try {
      if (area === "durable" && op === "interrupt") return { result: await interrupt(String(args[0])) };
      if (area === "durable" && (DURABLE_OPS as readonly string[]).includes(op)) {
        const d = durable as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        return { result: (await d[op](...args)) ?? null };
      }
      if (area === "recorder" && (RECORDER_OPS as readonly string[]).includes(op)) {
        const r = recorder as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        return { result: (await r[op](...args)) ?? null };
      }
      return { error: `Unknown operation ${area}/${op}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
}

/**
 * The suite's side of connect mode: a Durable and a recorder that call the
 * `conformance` handler through `invoke` (Lambda's Invoke, or the handler
 * itself in tests), and `interrupt` for the suite's re-run test.
 */
export function connectDurableConformance(invoke: (request: ConformanceRequest) => Promise<ConformanceResponse>): {
  durable: Durable;
  recorder: ConformanceRecorder;
  interrupt(instanceId: string): Promise<void>;
} {
  const call = async (area: string, op: string, ...args: unknown[]): Promise<any> => {
    // JSON would turn an omitted optional argument (startJob's id) into null.
    while (args.length > 0 && args.at(-1) === undefined) args.pop();
    const response = await invoke({ area, op, args });
    if ("error" in response) throw new Error(`${area}/${op}: ${response.error}`);
    return response.result;
  };
  const date = (d: unknown) => (d === undefined || d === null ? undefined : new Date(d as string));
  return {
    durable: {
      startJob: (kind, input, id) => call("durable", "startJob", kind, input, id),
      startWait: (kind, id, input, timeoutMs) => call("durable", "startWait", kind, id, input, timeoutMs),
      signal: (id, event, payload) => call("durable", "signal", id, event, payload),
      ensureAlarm: (kind, id, input) => call("durable", "ensureAlarm", kind, id, input),
      wakeAlarm: (id) => call("durable", "wakeAlarm", id),
      terminate: (id, reason) => call("durable", "terminate", id, reason),
      status: async (id) => {
        const info = await call("durable", "status", id);
        return info && { status: info.status, createdAt: date(info.createdAt), updatedAt: date(info.updatedAt) };
      },
    },
    recorder: {
      calls: (id) => call("recorder", "calls", id),
      gateHeld: (key) => call("recorder", "gateHeld", key),
      release: (key) => call("recorder", "release", key),
      setNextTickIn: (id, ms) => call("recorder", "setNextTickIn", id, ms),
    },
    interrupt: (instanceId) => call("durable", "interrupt", instanceId),
  };
}

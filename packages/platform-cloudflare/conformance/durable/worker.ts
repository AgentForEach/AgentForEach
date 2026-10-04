/**
 * Test Worker for the durable conformance suite on workerd: the instance
 * Durable Object built from the suite's own kinds (defineConformanceKinds),
 * a Recorder object those kinds report to, and a control API the Node
 * harness drives through (/durable/<operation>, /recorder/<operation>).
 */

import { DurableObject, env as workerEnv } from "cloudflare:workers";
import { DurableRegistry } from "@agentforeach/platform";
import { defineConformanceKinds, MemoryConformanceRecorder, type ConformanceCall } from "@agentforeach/platform/durable/conformance-kinds";
import { CloudflareDurable, namespaceResolver } from "../../dist/durable/client.js";
import { defineDurableInstance } from "../../dist/durable/objects.js";

type Env = { DURABLE_INSTANCES: DurableObjectNamespace; RECORDER: DurableObjectNamespace<Recorder> };
const env = workerEnv as unknown as Env;

/** Must match the harness's unitMs. */
const UNIT_MS = 100;

const recorder = () => env.RECORDER.get(env.RECORDER.idFromName("recorder"));
const durable = () => new CloudflareDurable(namespaceResolver(() => env.DURABLE_INSTANCES));

const registry = defineConformanceKinds(new DurableRegistry(), {
  record: (call) => recorder().record(call),
  // The held job polls: a gate can't be a promise shared across objects.
  gate: async (key) => {
    await recorder().hold(key);
    while (!(await recorder().isReleased(key))) await new Promise((r) => setTimeout(r, UNIT_MS / 4));
  },
  nextTickIn: (instanceId) => recorder().nextTickIn(instanceId),
  durable,
  unitMs: UNIT_MS,
});

export const DurableInstance = defineDurableInstance<Env>(registry);

/** The suite's recorder, in one object every instance reaches. */
export class Recorder extends DurableObject {
  private readonly state = new MemoryConformanceRecorder();
  record(call: ConformanceCall): void {
    this.state.record(call);
  }
  hold(key: string): void {
    this.state.hold(key);
  }
  isReleased(key: string): boolean {
    return this.state.isReleased(key);
  }
  nextTickIn(instanceId: string): number {
    return this.state.nextTickIn(instanceId);
  }
  calls(instanceId: string): Promise<ConformanceCall[]> {
    return this.state.calls(instanceId);
  }
  gateHeld(key: string): Promise<boolean> {
    return this.state.gateHeld(key);
  }
  release(key: string): Promise<void> {
    return this.state.release(key);
  }
  setNextTickIn(instanceId: string, ms: number): Promise<void> {
    return this.state.setNextTickIn(instanceId, ms);
  }
}

const DURABLE_OPS = ["startJob", "startWait", "signal", "ensureAlarm", "wakeAlarm", "terminate", "status"] as const;
const RECORDER_OPS = ["calls", "gateHeld", "release", "setNextTickIn"] as const;

export default {
  async fetch(request: Request): Promise<Response> {
    const [, area, op] = new URL(request.url).pathname.split("/");
    const args = (await request.json().catch(() => [])) as unknown[];
    try {
      if (area === "durable" && (DURABLE_OPS as readonly string[]).includes(op)) {
        const d = durable() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        return Response.json({ result: (await d[op](...args)) ?? null });
      }
      if (area === "recorder" && (RECORDER_OPS as readonly string[]).includes(op)) {
        const r = recorder() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
        return Response.json({ result: (await r[op](...args)) ?? null });
      }
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
    return new Response("not found", { status: 404 });
  },
};

/**
 * AgentForEach Platform — Durable port
 *
 * Jobs, waits and alarms (see `./types.ts`), the registry of kinds an
 * application defines, and the in-memory implementation. The conformance
 * suite is at `@agentforeach/platform/durable/conformance`.
 */

export {
  isActive,
  type Durable,
  type DurableStatus,
  type DurableContext,
  type InstanceInfo,
  type StartResult,
  type EnsureResult,
  type JobDefinition,
  type WaitDefinition,
  type AlarmDefinition,
} from "./types.js";
export { DurableRegistry } from "./registry.js";
export { InMemoryDurable, type InMemoryDurableOptions } from "./memory.js";

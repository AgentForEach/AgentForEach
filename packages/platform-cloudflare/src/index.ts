/**
 * @agentforeach/platform-cloudflare: the Cloudflare platform pack.
 *
 * Each port lives in its own folder, as in platform-azure: src/sandbox
 * (Cloudflare Containers), and the host, durable work, realtime and objects
 * as they arrive. Code here runs in Workers (`cloudflare:workers`); its unit
 * tests run in Node against the parts that don't need the runtime.
 */

/** The name a sandbox backend from this pack registers under (skills.sandbox.provider). */
export const CLOUDFLARE_CONTAINERS_PROVIDER = "cloudflare-containers";

// Host: the gateway's routes and schedules from a Worker's fetch and scheduled handlers.
export { createWorkerHandler, type WaitUntil, type WorkerHostOptions, type WorkerTable } from "./host/worker.js";
export { cronTriggers, toCloudflareCron } from "./host/cron.js";

// Realtime: protocol v1 on Durable Objects. The Durable Object classes are
// in "@agentforeach/platform-cloudflare/realtime/objects" (Workers runtime only).
export * from "./realtime/index.js";

// Durable: one Durable Object per instance. The Durable Object class is in
// "@agentforeach/platform-cloudflare/durable/objects" (Workers runtime only).
export * from "./durable/index.js";

// Sandbox: Cloudflare Containers. The Durable Object and egress classes are
// in "@agentforeach/platform-cloudflare/sandbox/objects" (Workers runtime only).
export { CloudflareContainersSandbox, type CloudflareContainersSandboxOptions } from "./sandbox/backend.js";
export type { ContainerSandboxOptions, SandboxServerRequest } from "./sandbox/container-sandbox.js";
export { allowEntryMatches, egressDecision, hostMatches, type EgressDecision, type SandboxEgressProps } from "./sandbox/egress-policy.js";
export {
  SnapshotRegistry,
  imageRepository,
  snapshotTag,
  type SnapshotDeletionOptions,
  type SnapshotRegistryOptions,
} from "./sandbox/snapshot-registry.js";

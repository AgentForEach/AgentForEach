/**
 * AgentForEach Azure pack — sandbox backends (@agentforeach/platform-azure/sandbox)
 *
 *   - AcaSandboxesClient    — ACA Sandboxes (primary): a suspendable microVM per user
 *   - DynamicSessionsClient — ACA Dynamic Sessions (fallback): pooled, ephemeral
 */

export { AcaSandboxesClient, type AcaSandboxesClientOptions } from "./aca-sandboxes-client.js";
export { DynamicSessionsClient } from "./dynamic-sessions-client.js";
export type { AcaSandboxesConfig, AcaSandboxesClientConfig, DynamicSessionsClientConfig } from "./types.js";

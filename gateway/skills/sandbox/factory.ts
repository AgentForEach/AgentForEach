/**
 * AgentForEach Skills Layer — Sandbox Backend Factory
 *
 * Picks the sandbox backend from config. ACA Sandboxes is the default; ACA
 * Dynamic Sessions is the fallback, used when it is chosen explicitly or when
 * ACA Sandboxes is chosen but not configured and a session pool is.
 */

import { AcaSandboxesClient } from "./aca-sandboxes-client.js";
import { DynamicSessionsClient } from "./client.js";
import type { SandboxBackend, SandboxConfig } from "./types.js";

export function createSandboxBackend(config: SandboxConfig): SandboxBackend | undefined {
  if (!config.enabled) return undefined;

  if (config.provider === "aca-sandboxes") {
    const primary = new AcaSandboxesClient(config);
    if (primary.isReady()) return primary;

    if (config.poolManagementEndpoint) {
      console.warn(
        "[sandbox] ACA Sandboxes not configured (subscription, resource group, sandbox group); " +
          "falling back to ACA Dynamic Sessions",
      );
      return new DynamicSessionsClient({ ...config, provider: "aca-sessions" });
    }
    console.warn("[sandbox] ACA Sandboxes not configured; sandbox tools are disabled");
    return undefined;
  }

  return new DynamicSessionsClient(config);
}

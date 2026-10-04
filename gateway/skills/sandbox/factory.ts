/**
 * AgentForEach Skills Layer — Sandbox Backend Factory
 *
 * Picks the sandbox backend from config, through the provider registry
 * (./registry.ts). A backend that can't be built leaves the sandbox tools
 * off instead of failing turns. The two ACA providers (clients from
 * @agentforeach/platform-azure/sandbox) are registered here:
 *   - "aca-sandboxes" (default): ACA Sandboxes. When it is chosen but not
 *     configured and a Dynamic Sessions pool is, it falls back to that pool.
 *   - "aca-sessions" ("aca"): ACA Dynamic Sessions.
 */

import { AcaSandboxesClient, DynamicSessionsClient } from "@agentforeach/platform-azure/sandbox";
import { getSandboxProviderFactory, registerSandboxProvider } from "./registry.js";
import type { SandboxBackend, SandboxConfig } from "./types.js";

registerSandboxProvider("aca-sandboxes", (config) => {
  const primary = new AcaSandboxesClient(config);
  if (primary.isReady()) return primary;

  if (config.poolManagementEndpoint) {
    console.warn(
      "[sandbox] ACA Sandboxes not configured (subscription, resource group, sandbox group); " +
        "falling back to ACA Dynamic Sessions",
    );
    return new DynamicSessionsClient(config);
  }
  console.warn("[sandbox] ACA Sandboxes not configured; sandbox tools are disabled");
  return undefined;
});

registerSandboxProvider("aca-sessions", (config) => new DynamicSessionsClient(config));

/** Providers whose failure was already logged, so a broken config logs once, not on every turn. */
const reportedFailures = new Set<string>();

/**
 * The configured sandbox backend, or undefined (sandbox tools off) when the
 * sandbox is disabled, its provider isn't configured, or the backend can't be
 * built: an unknown provider, or one that doesn't run on this host (an ACA
 * provider on Cloudflare). A broken backend must not fail every turn, so the
 * error is logged once and the agent runs without a sandbox.
 */
export function createSandboxBackend(config: SandboxConfig): SandboxBackend | undefined {
  if (!config.enabled) return undefined;
  try {
    return getSandboxProviderFactory(config.provider)(config);
  } catch (err) {
    if (!reportedFailures.has(config.provider)) {
      reportedFailures.add(config.provider);
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[sandbox] provider "${config.provider}" could not be created, so sandbox tools are off: ${reason}`);
    }
    return undefined;
  }
}

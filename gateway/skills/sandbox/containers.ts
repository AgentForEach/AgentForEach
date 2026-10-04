/**
 * AgentForEach Skills Layer — Cloudflare Containers settings
 *
 * The options the `cloudflare-containers` backend
 * (@agentforeach/platform-cloudflare, CloudflareContainersSandbox) takes,
 * built from the resolved sandbox config. The Worker entry registers the
 * provider with them:
 *
 * ```ts
 * registerSandboxProvider("cloudflare-containers", (config) =>
 *   new CloudflareContainersSandbox(env.SANDBOX, containersSandboxOptions(config)));
 * ```
 *
 * (The gateway's Node build doesn't import the Workers pack, so the shape is
 * restated here; the pack's options type has the same fields.)
 */

import type { SandboxConfig } from "./types.js";

export interface ContainersSandboxOptions {
  instance: string;
  autoSuspendSec: number;
  egressAllowHosts: string[];
  networkAccess: "disabled" | "enabled";
  identifierStrategy: "userId" | "sessionId";
  browser: boolean;
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
  maxOutputChars: number;
  maxExportBytes: number;
}

export function containersSandboxOptions(config: SandboxConfig): ContainersSandboxOptions {
  if (!config.containers) {
    throw new Error('skills.sandbox.containers is resolved only for provider "cloudflare-containers"');
  }
  const c = config.containers;
  return {
    instance: c.instance,
    autoSuspendSec: c.autoSuspendSec,
    egressAllowHosts: c.egressAllowHosts,
    networkAccess: config.networkAccess,
    identifierStrategy: config.identifierStrategy,
    browser: c.browser,
    defaultTimeoutSec: c.defaultTimeoutSec,
    maxTimeoutSec: c.maxTimeoutSec,
    maxOutputChars: config.maxOutputChars,
    maxExportBytes: config.maxExportBytes,
  };
}

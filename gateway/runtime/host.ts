/**
 * AgentForEach Runtime — Host information
 *
 * Where the gateway is running. A platform's entry point installs its
 * `HostInfo` at startup (`installHost`). Without one, the host is read from
 * the environment: Azure App Service / Functions sets WEBSITE_SITE_NAME and
 * WEBSITE_HOSTNAME; anything else is "local". Values are read on each call,
 * so tests can change the environment between calls.
 */

import type { HostInfo } from "@agentforeach/platform";

const environmentHost: HostInfo = {
  get platform() {
    return process.env.WEBSITE_SITE_NAME ? "azure" : "local";
  },
  get isProductionHost() {
    return !!process.env.WEBSITE_SITE_NAME;
  },
  get publicBaseUrl() {
    const host = process.env.WEBSITE_HOSTNAME;
    if (!host) return undefined;
    return `${host.startsWith("localhost") ? "http" : "https"}://${host}`;
  },
  get label() {
    const site = process.env.WEBSITE_SITE_NAME;
    return site ? `azure:${site}` : "local";
  },
};

let installed: HostInfo | undefined;

/** Called once by a platform's entry point, before serving requests. */
export function installHost(info: HostInfo): void {
  installed = info;
}

/** The current host. */
export function hostInfo(): HostInfo {
  return installed ?? environmentHost;
}

/** For tests: forget an installed host. */
export function resetHostForTests(): void {
  installed = undefined;
}

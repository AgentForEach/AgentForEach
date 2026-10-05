/**
 * AgentForEach Runtime — Host information
 *
 * Where the gateway is running. A platform's entry point installs its
 * `HostInfo` at startup (`installHost`). Without one, the host is read from
 * the environment: Azure App Service / Functions sets WEBSITE_SITE_NAME and
 * WEBSITE_HOSTNAME; Lambda sets AWS_LAMBDA_FUNCTION_NAME; anything else is
 * "local". Lambda is recognised here too so that an AWS entry point that
 * forgot `installHost` still counts as production (checks that must fail
 * closed stay closed). Values are read on each call, so tests can change the
 * environment between calls.
 */

import type { HostInfo } from "@agentforeach/platform";

const environmentHost: HostInfo = {
  get platform() {
    if (process.env.WEBSITE_SITE_NAME) return "azure";
    return process.env.AWS_LAMBDA_FUNCTION_NAME ? "aws" : "local";
  },
  get isProductionHost() {
    return !!(process.env.WEBSITE_SITE_NAME || process.env.AWS_LAMBDA_FUNCTION_NAME);
  },
  get publicBaseUrl() {
    const host = process.env.WEBSITE_HOSTNAME;
    if (!host) return undefined;
    return `${host.startsWith("localhost") ? "http" : "https"}://${host}`;
  },
  get label() {
    const site = process.env.WEBSITE_SITE_NAME;
    if (site) return `azure:${site}`;
    const fn = process.env.AWS_LAMBDA_FUNCTION_NAME;
    return fn ? `aws:${fn}` : "local";
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

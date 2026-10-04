/**
 * Runs before any gateway module: worker.ts imports it first.
 *
 * A Worker has no filesystem, so the config is bundled and installed here.
 * Some gateway modules read config as they load (cron, the channel
 * plugins), so this must come first. `@agentforeach/config` is an alias in
 * wrangler.jsonc: point it at your own agentforeach.json.
 *
 * The host is installed here too: Workers aren't persistent (connections
 * live per invocation) and can't start processes.
 */

import config from "@agentforeach/config";
import { installConfig } from "../../gateway/utils/config.js";
import { installHost } from "../../gateway/runtime/host.js";

installConfig(config as Record<string, unknown>);

installHost({
  platform: "cloudflare",
  isProductionHost: true,
  // Read on each use: vars and secrets are in process.env under nodejs_compat.
  get publicBaseUrl() {
    return process.env.PUBLIC_BASE_URL || undefined;
  },
  get label() {
    return `cloudflare:${process.env.WORKER_NAME || "agentforeach"}`;
  },
  persistent: false,
  subprocesses: false,
});

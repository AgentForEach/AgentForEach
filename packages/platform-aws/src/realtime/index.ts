/**
 * The realtime port on AWS: AppSync Events.
 *
 *   - `appSyncRealtime()`: the provider's registration, which the Lambda
 *     entry hands the gateway, so the gateway never imports this pack:
 *
 *       installRealtimeProvider(appSyncRealtime());   // then WEBSOCKET_PROVIDER=aws-appsync-events
 *
 *   - `createAppSyncAuthorizer()`: the Event API's Lambda authorizer (the
 *     entry's `realtimeAuthorizer` export).
 *
 * Both read the APPSYNC_* variables (./config.ts) when first used, not at
 * import, so one Lambda file can export every handler.
 */

import type { RealtimeCapabilities } from "@agentforeach/platform";
import { appSyncConfigFromEnv, validateAppSyncConfig, type AppSyncEventsConfig } from "./config.js";
import { APPSYNC_CAPABILITIES, APPSYNC_PROVIDER_ID, AppSyncEventsRealtime, type AppSyncEventsRealtimeOptions } from "./provider.js";
import { authorizeAppSyncEvent, type AppSyncAuthorizerEvent, type AppSyncAuthorizerResult } from "./tokens.js";

export { AppSyncEventsRealtime, APPSYNC_CAPABILITIES, APPSYNC_PROVIDER_ID, type AppSyncEventsRealtimeOptions } from "./provider.js";
export {
  appSyncConfigFromEnv,
  validateAppSyncConfig,
  DEFAULT_NAMESPACE,
  DEFAULT_RELAY_NAMESPACE,
  type AppSyncEventsConfig,
} from "./config.js";
export {
  authorizeAppSyncEvent,
  issueClientToken,
  issueRelayToken,
  userChannel,
  groupChannel,
  allChannel,
  relayChannel,
  CLIENT_TOKEN_MAX_MINUTES,
  RELAY_TOKEN_MAX_MINUTES,
  type AppSyncAuthorizerEvent,
  type AppSyncAuthorizerResult,
} from "./tokens.js";

/** What the gateway's `installRealtimeProvider` takes (its `RealtimeProviderRegistration`). */
export type AppSyncRealtimeRegistration = {
  id: typeof APPSYNC_PROVIDER_ID;
  factory: () => AppSyncEventsRealtime;
  traits: {
    capabilities: () => RealtimeCapabilities;
    /** The realtime endpoint's host: the live view's CSP and the sandbox's egress allowlist. */
    relayHost: () => string | undefined;
    /** Client events come through the HTTP API; there are no Web PubSub webhooks. */
    upstreamWebhooks: false;
  };
};

/** The AppSync Events provider, configured from the environment overlaid with `options`. */
export function appSyncRealtime(options: Partial<AppSyncEventsRealtimeOptions> = {}): AppSyncRealtimeRegistration {
  const config = (): AppSyncEventsRealtimeOptions => ({ ...appSyncConfigFromEnv(), ...options });
  return {
    id: APPSYNC_PROVIDER_ID,
    factory: () => new AppSyncEventsRealtime(config()),
    traits: {
      capabilities: () => APPSYNC_CAPABILITIES,
      relayHost: () => {
        try {
          return new URL(config().realtimeEndpoint).host || undefined;
        } catch {
          return undefined;
        }
      },
      upstreamWebhooks: false,
    },
  };
}

/**
 * The Event API's Lambda authorizer. A misconfigured authorizer denies
 * everything (and says why in its log), never allows.
 */
export function createAppSyncAuthorizer(
  options: Partial<AppSyncEventsConfig> = {},
): (event: AppSyncAuthorizerEvent) => Promise<AppSyncAuthorizerResult> {
  let config: AppSyncEventsConfig | undefined;
  return async (event) => {
    try {
      config ??= validateAppSyncConfig({ ...appSyncConfigFromEnv(), ...options });
    } catch (err) {
      console.error(`[appsync] authorizer denies everything: ${err instanceof Error ? err.message : String(err)}`);
      return { isAuthorized: false, ttlOverride: 0 };
    }
    return authorizeAppSyncEvent(config, event);
  };
}

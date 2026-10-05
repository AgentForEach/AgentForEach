/**
 * AgentForEach Platform AWS — AppSync Events configuration
 *
 * One Event API with two channel namespaces:
 *
 *   - `namespace` (default "agentforeach") carries pushes to clients. Its
 *     subscribers authorize with the Lambda authorizer (`afe1.` tokens);
 *     only IAM may publish, so only the gateway does (appsync:EventPublish).
 *   - `relayNamespace` (default "agentforeach-browser") carries the relay:
 *     the browser live view and the sandbox's driver, each publishing to the
 *     other's channel with an `afeb1.` token the authorizer checks.
 *
 * The gateway (publisher and token issuer) and the authorizer read the same
 * settings, from these variables:
 *
 *   APPSYNC_HTTP_ENDPOINT      https://<http domain>/event
 *   APPSYNC_REALTIME_ENDPOINT  wss://<realtime domain>/event/realtime
 *   APPSYNC_API_ID             the Event API's id
 *   APPSYNC_REGION             default: AWS_REGION
 *   APPSYNC_NAMESPACE          default: agentforeach
 *   APPSYNC_RELAY_NAMESPACE    default: agentforeach-browser
 *   APPSYNC_TOKEN_SECRET       at least 32 random bytes, from a secret store; never in source or a client
 */

export type AppSyncEventsConfig = {
  httpEndpoint: string;
  realtimeEndpoint: string;
  apiId: string;
  region: string;
  namespace: string;
  relayNamespace: string;
  /** Signs subscriber and relay tokens; the authorizer checks them with it. */
  tokenSecret: string;
};

/** A namespace or path segment AppSync accepts: letters, digits and dashes, at most 50. */
export const CHANNEL_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;

export const DEFAULT_NAMESPACE = "agentforeach";
export const DEFAULT_RELAY_NAMESPACE = "agentforeach-browser";

/** The configuration from the environment (see the module docs); unset values are empty. */
export function appSyncConfigFromEnv(env: Record<string, string | undefined> = process.env): AppSyncEventsConfig {
  return {
    httpEndpoint: env.APPSYNC_HTTP_ENDPOINT ?? "",
    realtimeEndpoint: env.APPSYNC_REALTIME_ENDPOINT ?? "",
    apiId: env.APPSYNC_API_ID ?? "",
    region: env.APPSYNC_REGION || env.AWS_REGION || "",
    namespace: env.APPSYNC_NAMESPACE || DEFAULT_NAMESPACE,
    relayNamespace: env.APPSYNC_RELAY_NAMESPACE || DEFAULT_RELAY_NAMESPACE,
    tokenSecret: env.APPSYNC_TOKEN_SECRET ?? "",
  };
}

/** `config`, or an error naming what is wrong (never the secret). */
export function validateAppSyncConfig(config: AppSyncEventsConfig): AppSyncEventsConfig {
  const endpoints: Array<[string, string, string, string]> = [
    ["APPSYNC_HTTP_ENDPOINT", config.httpEndpoint, "https:", "/event"],
    ["APPSYNC_REALTIME_ENDPOINT", config.realtimeEndpoint, "wss:", "/event/realtime"],
  ];
  for (const [name, value, protocol, path] of endpoints) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`AppSync Events: ${name} must be a URL`);
    }
    if (url.protocol !== protocol || url.pathname !== path || url.search || url.hash || url.username || url.password) {
      throw new Error(`AppSync Events: ${name} must be ${protocol}//<domain>${path}`);
    }
  }
  if (!config.apiId) throw new Error("AppSync Events: APPSYNC_API_ID is required");
  if (!config.region) throw new Error("AppSync Events: APPSYNC_REGION (or AWS_REGION) is required");
  for (const [name, value] of [
    ["APPSYNC_NAMESPACE", config.namespace],
    ["APPSYNC_RELAY_NAMESPACE", config.relayNamespace],
  ]) {
    if (!CHANNEL_SEGMENT.test(value)) throw new Error(`AppSync Events: ${name} must be letters, digits and dashes`);
  }
  if (config.namespace === config.relayNamespace) {
    throw new Error("AppSync Events: the relay needs its own namespace (clients may publish there)");
  }
  if (new TextEncoder().encode(config.tokenSecret).length < 32) {
    throw new Error("AppSync Events: APPSYNC_TOKEN_SECRET must be at least 32 bytes");
  }
  return config;
}

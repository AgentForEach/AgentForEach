/**
 * AgentForEach WebSocket Provider — Registry
 *
 * Singleton registry for WebSocket provider factories.
 * Follows the same pattern as llms/registry.ts.
 *
 * Providers are registered at module load time (auto-registration), each
 * with what it can do (`capabilities`, `relayHost`), answered from config
 * without loading the provider. The active provider is resolved lazily from
 * agentforeach.json on first use and cached for the lifetime of the process;
 * its SDK is imported only then, so a host never bundles a provider it
 * doesn't use.
 */

import {
  resolveRealtimeCapabilities,
  type RealtimeCapabilities,
  type RealtimeRelay,
  type ResolvedRealtimeCapabilities,
} from "@agentforeach/platform";
import type {
  WebSocketProvider,
  WebSocketProviderConfig,
  WebSocketProviderFactory,
  WebSocketProviderId,
} from "../types.js";
import {
  resolveConnectionString,
  resolveHub,
  resolveProviderId,
  resolveWebPubSubHost,
} from "../config.js";

/** What a provider can do, known from config alone. */
export type WebSocketProviderTraits = {
  capabilities?: () => RealtimeCapabilities;
  /** The relay's host, for egress allowlists and the live view's CSP. */
  relayHost?: () => string | undefined;
  /**
   * The path relay connections use on that host, when the host also serves
   * other things (the Worker itself on Cloudflare). Undefined: the whole host.
   */
  relayPath?: () => string | undefined;
  /**
   * Client events and connection changes reach the gateway as webhooks on
   * its ws/* routes (Azure Web PubSub's upstream). Default true. A provider
   * whose sockets end somewhere that runs the gateway's handler itself (the
   * Cloudflare Durable Objects) says false, and those routes aren't served.
   */
  upstreamWebhooks?: boolean;
};

// ============================================================================
// Registry
// ============================================================================

/**
 * A provider a platform pack registers from its own entry, so the gateway
 * never imports the pack (the AWS pack's AppSync Events, from the Lambda
 * entry): what `registerWebSocketProvider` takes, as one value.
 */
export type RealtimeProviderRegistration = {
  id: WebSocketProviderId;
  factory: WebSocketProviderFactory;
  traits?: WebSocketProviderTraits;
};

/** Internal store: providerId → factory function and traits. */
const factories = new Map<string, { factory: WebSocketProviderFactory; traits: WebSocketProviderTraits }>();

/** Cached provider instances, by id (one active at a time; the relay may load another). */
const instances = new Map<string, Promise<WebSocketProvider>>();

/**
 * Register a WebSocket provider factory.
 *
 * @param id - Unique provider identifier (e.g., "azure-webpubsub", "noop").
 * @param factory - Creates the provider; may import its SDK lazily.
 * @param traits - What the provider can do, without loading it.
 */
export function registerWebSocketProvider(
  id: WebSocketProviderId,
  factory: WebSocketProviderFactory,
  traits: WebSocketProviderTraits = {},
): void {
  factories.set(id, { factory, traits });
  instances.delete(id);
}

/** Registers a pack's provider (see `RealtimeProviderRegistration`). */
export function installRealtimeProvider(registration: RealtimeProviderRegistration): void {
  registerWebSocketProvider(registration.id, registration.factory, registration.traits);
}

function providerFor(id: string): Promise<WebSocketProvider> {
  const cached = instances.get(id);
  if (cached) return cached;
  const entry = factories.get(id);
  if (!entry) {
    throw new Error(
      `No WebSocket provider registered for "${id}". ` +
        `Available: ${[...factories.keys()].join(", ") || "(none)"}`,
    );
  }
  const config: WebSocketProviderConfig = {
    connectionString: resolveConnectionString(),
    hub: resolveHub(),
  };
  const created = Promise.resolve().then(() => entry.factory(config));
  instances.set(id, created);
  created.catch(() => instances.delete(id)); // a failed construction is retried next time
  return created;
}

/**
 * Get the active WebSocket provider.
 *
 * Resolves which provider to use from agentforeach.json ("websocket.provider")
 * and instantiates it on first call. Subsequent calls return the cached
 * instance.
 *
 * @throws If the configured provider has no registered factory, or can't be built.
 */
export async function getActiveProvider(): Promise<WebSocketProvider> {
  return providerFor(resolveProviderId());
}

/** Whether the active provider delivers client events to the ws/* webhook routes. */
export function realtimeUpstreamWebhooks(): boolean {
  return factories.get(resolveProviderId())?.traits.upstreamWebhooks ?? true;
}

/** What the active provider can do, from config, without loading it, with the protocol v1 defaults filled in. */
export function realtimeCapabilities(): ResolvedRealtimeCapabilities {
  const traits = factories.get(resolveProviderId())?.traits;
  return resolveRealtimeCapabilities(traits?.capabilities?.() ?? { push: true, relay: false });
}

/**
 * The relay host, or undefined when there is no relay. The active provider's
 * own relay comes first; with none, a configured Web PubSub serves as the
 * relay, as it always has.
 */
export function relayHost(): string | undefined {
  return factories.get(resolveProviderId())?.traits.relayHost?.() ?? (resolveConnectionString() ? resolveWebPubSubHost() : undefined);
}

/**
 * What a sandbox's egress allowlist needs for the relay: the host, plus the
 * relay's path when the provider has one (`<worker host>/realtime/relay`), so
 * a deny-by-default sandbox reaches the relay and nothing else on that host.
 * Backends whose egress rules are host-only use `relayHost()` instead.
 */
export function relayEgressEntry(): string | undefined {
  const traits = factories.get(resolveProviderId())?.traits;
  const own = traits?.relayHost?.();
  if (own) return own + (traits?.relayPath?.() ?? "");
  return relayHost();
}

/** The relay for two-party handoffs (the browser live view), or undefined. */
export async function getRealtimeRelay(): Promise<RealtimeRelay | undefined> {
  const id = resolveProviderId();
  if (factories.get(id)?.traits.relayHost?.()) return (await providerFor(id)).relay;
  if (resolveConnectionString() && resolveWebPubSubHost()) return (await providerFor("azure-webpubsub")).relay;
  return undefined;
}

/**
 * Check whether a provider factory is registered.
 */
export function hasWebSocketProvider(id: WebSocketProviderId): boolean {
  return factories.has(id);
}

/**
 * List all registered WebSocket provider IDs.
 */
export function listWebSocketProviders(): WebSocketProviderId[] {
  return [...factories.keys()];
}

/**
 * Clear the cached provider instances (useful for testing).
 * Does NOT remove factory registrations.
 */
export function clearWebSocketProviderCache(): void {
  instances.clear();
}

// ============================================================================
// Auto-Registration — built-in providers
// ============================================================================

import { createNoopProvider } from "./noop.js";

registerWebSocketProvider(
  "azure-webpubsub",
  async (config) => {
    const { WebPubSubRealtime } = await import("@agentforeach/platform-azure/realtime");
    return new WebPubSubRealtime(config);
  },
  {
    capabilities: () => ({ push: !!resolveConnectionString(), relay: !!resolveWebPubSubHost() }),
    relayHost: () => resolveWebPubSubHost(),
  },
);
registerWebSocketProvider("noop", createNoopProvider, {
  // With a Web PubSub connection string the runner has always streamed, even
  // with pushes switched off; kept so turning pushes off changes nothing else.
  capabilities: () => ({ push: !!resolveConnectionString(), relay: false }),
});

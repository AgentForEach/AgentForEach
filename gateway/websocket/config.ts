/**
 * AgentForEach WebSocket Layer — Configuration
 *
 * Loads WebSocket / Web PubSub configuration from agentforeach.json ("websocket" section).
 * Follows the same modular config pattern as auth/ and llms/.
 *
 * Env vars still work as overrides — config is the base, env vars win.
 */

import { loadConfigSection, resolveEnvValue } from "../utils/index.js";
import type { WebSocketProviderId } from "./types.js";

// ============================================================================
// WebSocket Config Types
// ============================================================================

/**
 * Token generation settings.
 */
export interface WebSocketTokenConfig {
  /** Default token TTL in minutes. Default: 60. */
  defaultTtlMinutes?: number;
  /** Maximum allowed token TTL in minutes. Default: 1440 (24h). */
  maxTtlMinutes?: number;
}

/**
 * Default group assignment per client role.
 */
export interface WebSocketGroupDefaults {
  /** Groups assigned to all "user" role clients. */
  user?: string[];
  /** Additional groups assigned to "admin" role clients (merged with user groups). */
  admin?: string[];
}

/**
 * Top-level WebSocket configuration ("websocket" section of agentforeach.json).
 */
export interface WebSocketConfig {
  /**
   * Which WebSocket provider to use.
   * Default: "azure-webpubsub". Set to "noop" to disable real-time push.
   */
  provider?: WebSocketProviderId;

  /**
   * Azure Web PubSub connection string.
   * Supports env var references: "$WEBPUBSUB_CONNECTION_STRING".
   */
  connectionString?: string;

  /** Web PubSub hub name. Default: "agentforeach". */
  hub?: string;

  /** Token generation settings. */
  token?: WebSocketTokenConfig;

  /** Default group assignment by role. */
  groupDefaults?: WebSocketGroupDefaults;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_PROVIDER: WebSocketProviderId = "azure-webpubsub";
const DEFAULT_HUB = "agentforeach";
const DEFAULT_TOKEN_TTL_MINUTES = 60;
const MAX_TOKEN_TTL_MINUTES = 1440;

const DEFAULT_USER_GROUPS = ["cron", "chat", "presence"];
const DEFAULT_ADMIN_EXTRA_GROUPS = ["system"];

// ============================================================================
// Config Loader
// ============================================================================

let _wsConfig: WebSocketConfig | undefined;

/**
 * Load the WebSocket config from agentforeach.json.
 *
 * Uses the shared config loader from utils/config.
 * Falls back to sensible defaults if no config found.
 */
export function loadWebSocketConfig(): WebSocketConfig {
  if (_wsConfig) return _wsConfig;

  const section = loadConfigSection<WebSocketConfig>("websocket");
  _wsConfig = section ?? {};
  return _wsConfig;
}

// ============================================================================
// Resolved Accessors
// ============================================================================

/**
 * Resolve which WebSocket provider to use.
 * Env var WEBSOCKET_PROVIDER always wins, then config, then default.
 * Falls back to "noop" when no connection string is available.
 */
export function resolveProviderId(): WebSocketProviderId {
  if (process.env.WEBSOCKET_PROVIDER) {
    return process.env.WEBSOCKET_PROVIDER as WebSocketProviderId;
  }
  const config = loadWebSocketConfig();
  if (config.provider) return config.provider;

  // Auto-fallback: if no connection string is configured, use noop
  const connStr = resolveConnectionString();
  return connStr ? DEFAULT_PROVIDER : "noop";
}

/**
 * Resolve the Web PubSub connection string.
 * Env var WEBPUBSUB_CONNECTION_STRING always wins.
 */
export function resolveConnectionString(): string {
  const config = loadWebSocketConfig();
  return (
    process.env.WEBPUBSUB_CONNECTION_STRING ||
    resolveEnvValue(config.connectionString) ||
    ""
  );
}

/** The Web PubSub service's host, from its connection string ("Endpoint=https://….webpubsub.azure.com;…"). */
export function resolveWebPubSubHost(): string | undefined {
  const endpoint = /(?:^|;)\s*Endpoint=([^;]+)/i.exec(resolveConnectionString())?.[1];
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint.trim()).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Web PubSub hub name.
 * Env var WEBPUBSUB_HUB always wins, then config, then "agentforeach".
 */
export function resolveHub(): string {
  const config = loadWebSocketConfig();
  return process.env.WEBPUBSUB_HUB || config.hub || DEFAULT_HUB;
}

/**
 * Resolve the default token TTL in minutes.
 */
export function resolveDefaultTokenTtl(): number {
  const config = loadWebSocketConfig();
  return config.token?.defaultTtlMinutes ?? DEFAULT_TOKEN_TTL_MINUTES;
}

/**
 * Resolve the maximum token TTL in minutes.
 */
export function resolveMaxTokenTtl(): number {
  const config = loadWebSocketConfig();
  return config.token?.maxTtlMinutes ?? MAX_TOKEN_TTL_MINUTES;
}

/**
 * Resolve the default groups for a given client role.
 */
export function resolveDefaultGroups(role: string): string[] {
  const config = loadWebSocketConfig();
  const defaults = config.groupDefaults;

  const userGroups = defaults?.user ?? DEFAULT_USER_GROUPS;
  const groups = [...userGroups];

  if (role === "admin") {
    const adminExtra = defaults?.admin ?? DEFAULT_ADMIN_EXTRA_GROUPS;
    for (const g of adminExtra) {
      if (!groups.includes(g)) {
        groups.push(g);
      }
    }
  }

  return groups;
}

/**
 * Check whether WebSocket / Web PubSub is configured (connection string available).
 */
export function isWebSocketEnabled(): boolean {
  return resolveConnectionString() !== "";
}

/**
 * Reset the cached config (for testing).
 */
export function resetWebSocketConfig(): void {
  _wsConfig = undefined;
}

/**
 * AgentForEach Channels Module — Plugin Registry
 *
 * Stores and retrieves ChannelPlugin instances. Channels self-register
 * by calling registerChannel() during their module initialization.
 *
 * Follows the same Map-based registry pattern as cron/delivery.ts.
 *
 * @see cron/delivery.ts — DeliveryAdapter registry
 * @see llms/registry.ts — Provider registry
 */

import type { ChannelPlugin } from "./types.js";

// ============================================================================
// Registry
// ============================================================================

const _plugins = new Map<string, ChannelPlugin>();

/**
 * Register a channel plugin.
 *
 * Call this at startup from channel plugin initialization code.
 * After registration, the webhook handler and router can dispatch
 * to this channel by its ID.
 */
export function registerChannel(plugin: ChannelPlugin): void {
  _plugins.set(plugin.id, plugin);
}

/**
 * Get a channel plugin by ID.
 */
export function getChannel(id: string): ChannelPlugin | undefined {
  return _plugins.get(id);
}

/**
 * Get all registered channel plugins as a read-only map.
 */
export function listChannels(): ReadonlyMap<string, ChannelPlugin> {
  return _plugins;
}

/**
 * Get all enabled channel plugin IDs.
 */
export function getEnabledChannelIds(): string[] {
  return [..._plugins.entries()]
    .filter(([, plugin]) => plugin.enabled)
    .map(([id]) => id);
}

/**
 * Check if any channels are registered.
 */
export function hasChannels(): boolean {
  return _plugins.size > 0;
}

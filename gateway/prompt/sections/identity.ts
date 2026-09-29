/**
 * AgentForEach Prompt Layer — Identity Resolution
 *
 * Resolves the final agent identity by merging sources in priority order:
 *   1. IdentityConfig (from app settings) — highest priority
 *   2. IdentityData (from IDENTITY document in Cosmos DB)
 *   3. templates.IDENTITY from agentforeach.json — lowest priority (seed defaults)
 *
 * With structured data, there's no markdown parsing needed — the IDENTITY
 * document already stores typed fields (name, emoji, vibe, etc.).
 */

import type { AgentIdentity, IdentityData, IdentityConfig } from "../types.js";
import { getDefaultTemplate } from "../templates.js";

// ============================================================================
// Identity Resolution
// ============================================================================

/**
 * Resolve the final agent identity by merging sources in priority order.
 *
 * @param docIdentity - Identity data from the IDENTITY Cosmos document.
 * @param config - Identity config from app settings (overrides).
 * @param defaults - Fallback identity values.
 * @returns Merged identity with all available fields populated.
 */
export function resolveIdentity(
  docIdentity: IdentityData,
  config?: IdentityConfig,
  defaults?: Partial<AgentIdentity>,
): AgentIdentity {
  // Base layer: name/emoji fallbacks from templates.IDENTITY (seed defaults).
  // We only pull name+emoji here — role/vibe/soul come from the document
  // (which was seeded from the full template on first run).
  const templateIdentity = getDefaultTemplate("IDENTITY");

  const base: AgentIdentity = {
    name: templateIdentity.name ?? "Assistant",
    emoji: templateIdentity.emoji ?? "🤖",
    ...defaults,
  };

  // Layer 1: Apply document identity (overwrites defaults)
  const merged: AgentIdentity = { ...base };
  for (const [key, value] of Object.entries(docIdentity)) {
    if (value !== undefined && value !== null && value !== "") {
      (merged as Record<string, unknown>)[key] = value;
    }
  }

  // Layer 2: Apply config overrides (highest priority)
  if (config) {
    if (config.name) merged.name = config.name;
    if (config.emoji) merged.emoji = config.emoji;
    if (config.theme) merged.theme = config.theme;
    if (config.avatar) merged.avatar = config.avatar;
  }

  return merged;
}


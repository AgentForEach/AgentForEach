/**
 * AgentForEach Skills Layer — SKILL.md frontmatter
 *
 * Parses YAML frontmatter from SKILL.md files to extract skill metadata.
 * The files themselves come from blob storage (skills/blob-store.ts).
 * Uses a simple regex-based parser for flat key-value pairs (no external
 * YAML dependency needed).
 *
 * Frontmatter format:
 * ```
 * ---
 * id: weather
 * name: Weather
 * description: Get current weather and forecasts
 * category: information
 * ---
 * ```
 */

import type { SkillFrontmatter } from "./types.js";

// ============================================================================
// Frontmatter Parser
// ============================================================================

/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 *
 * Extracts key-value pairs between `---` delimiters. Only supports
 * simple flat string values (no nested objects, arrays, or multi-line).
 *
 * @param content - Raw SKILL.md file content.
 * @returns Parsed frontmatter with id, name, description, category.
 * @throws If frontmatter is missing or required fields are absent.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error("SKILL.md: missing frontmatter (expected --- delimiters)");
  }

  const block = match[1];
  const fields: Record<string, string> = {};

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key && value) {
      fields[key] = value;
    }
  }

  const id = fields.id;
  const name = fields.name;
  const description = fields.description;
  const category = fields.category;

  if (!id || !name || !description || !category) {
    const missing = ["id", "name", "description", "category"].filter(
      (k) => !fields[k],
    );
    throw new Error(
      `SKILL.md: missing required frontmatter fields: ${missing.join(", ")}`,
    );
  }

  return { id, name, description, category };
}

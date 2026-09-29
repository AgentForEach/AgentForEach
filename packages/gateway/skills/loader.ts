/**
 * AgentForEach Skills Layer — SKILL.md Loader
 *
 * Parses YAML frontmatter from SKILL.md files to extract skill metadata.
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

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

// ============================================================================
// File Loader
// ============================================================================

/**
 * Load a SKILL.md file from a skill directory.
 *
 * Uses the same dual-path resolution pattern as utils/config.ts:
 * checks both the compiled output path and the source tree path.
 *
 * @param skillDirName - Name of the skill directory (e.g., "weather").
 * @returns Raw SKILL.md content.
 * @throws If the file cannot be found.
 */
export function loadSkillMd(skillDirName: string): string {
  const loaderDir = dirname(fileURLToPath(import.meta.url));

  // Candidate paths:
  //   1. <loaderDir>/catalog/<skill>/SKILL.md  (compiled output — when .md copied to dist)
  //   2. <loaderDir>/../../../skills/catalog/<skill>/SKILL.md  (source tree fallback)
  //      With rootDir=".." and outDir="dist", compiled loader is at
  //      dist/gateway/skills/loader.js — 3 levels up reaches the package root.
  const candidates = [
    resolve(loaderDir, "catalog", skillDirName, "SKILL.md"),
    resolve(loaderDir, "../../../skills/catalog", skillDirName, "SKILL.md"),
  ];

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `SKILL.md not found for skill "${skillDirName}". Checked: ${candidates.join(", ")}`,
    );
  }

  return readFileSync(found, "utf-8");
}

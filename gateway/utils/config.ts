/**
 * AgentForEach Utilities — Config File Loader
 *
 * Shared helper for loading a section from agentforeach.json.
 * Used by auth, llms, and cron config modules to avoid duplicating
 * the file-resolution, read, parse, and cache logic.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// Types
// ============================================================================

/** The full agentforeach.json structure (keys are section names). */
type ConfigJsonRaw = Record<string, unknown>;

// ============================================================================
// Internal Cache
// ============================================================================

let _cachedRaw: ConfigJsonRaw | null = null;
let _resolvedPath: string | null = null;

/**
 * Resolve the path to agentforeach.json.
 *
 * The candidates list mirrors the pattern used across the codebase:
 *   1. `<callerDir>/../config/agentforeach.json`   (compiled output)
 *   2. `<callerDir>/../../../config/agentforeach.json` (source tree)
 *
 * Since all callers live at the same depth, we derive candidates from
 * a fixed anchor (`utils/` directory → `../config/agentforeach.json`).
 */
function resolvePath(): string | null {
  if (_resolvedPath !== null) return _resolvedPath;

  const utilsDir = dirname(fileURLToPath(import.meta.url));
  const configFileFromEnv = process.env.CONFIG_FILE_JSON;
  if (configFileFromEnv) {
    const envPath = resolve(configFileFromEnv);
    if (existsSync(envPath)) {
      _resolvedPath = envPath;
      return _resolvedPath;
    }
  }

  // chitti.json is the file's name before the AgentForEach rename: a
  // deployment that still has one customised it, so it wins over the stock
  // agentforeach.json until renamed.
  const names = configFileFromEnv ? [configFileFromEnv] : ["chitti.json", "agentforeach.json"];
  const candidates = names.flatMap((name) => [
    resolve(utilsDir, `../config/${name}`),
    resolve(utilsDir, `../../../config/${name}`),
  ]);

  _resolvedPath = candidates.find((p) => existsSync(p)) ?? null;
  if (!_resolvedPath) {
    // Loud: a missing config file silently disables EVERYTHING that reads it
    // (e.g. llms.providers.openai.baseUrl) and produces very confusing 401s
    // because the OpenAI SDK falls back to api.openai.com with the Azure key.
    console.error(
      `[config] ❌ Config file not found. CONFIG_FILE_JSON=${configFileFromEnv ?? "(unset → agentforeach.json)"}, ` +
        `tried: ${candidates.join(", ")}`,
    );
  } else {
    console.log(`[config] loaded ${_resolvedPath}`);
    if (_resolvedPath.endsWith("chitti.json")) {
      console.warn("[config] chitti.json is the pre-rename name: rename it to agentforeach.json (docs/UPGRADING.md)");
    }
  }
  return _resolvedPath;
}

/**
 * Load and cache the raw agentforeach.json contents.
 * Returns null if the file doesn't exist or can't be parsed.
 */
function loadRaw(): ConfigJsonRaw | null {
  if (_cachedRaw !== null) return _cachedRaw;

  const jsonPath = resolvePath();
  if (!jsonPath) return null;

  try {
    _cachedRaw = JSON.parse(readFileSync(jsonPath, "utf-8")) as ConfigJsonRaw;
    return _cachedRaw;
  } catch {
    return null;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Load a named section from agentforeach.json.
 *
 * @typeParam T - Expected shape of the section.
 * @param section - Top-level key in agentforeach.json (e.g. "auth", "llms", "cron").
 * @returns The section value cast to `T`, or `undefined` if not found.
 *
 * @example
 * const authSection = loadConfigSection<AuthConfig>("auth");
 * const llmSection  = loadConfigSection<LlmConfig>("llms");
 * const cronSection = loadConfigSection<CronConfig>("cron");
 */
export function loadConfigSection<T>(section: string): T | undefined {
  const raw = loadRaw();
  if (!raw) return undefined;

  const value = raw[section];
  if (
    !value ||
    (typeof value === "object" && Object.keys(value).length === 0)
  ) {
    return undefined;
  }
  return value as T;
}

/**
 * Reset all cached config state (for testing).
 */
export function resetConfigCache(): void {
  _cachedRaw = null;
  _resolvedPath = null;
}

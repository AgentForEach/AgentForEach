/**
 * AgentForEach Storage SDK — Adapter registry
 *
 * Resolves a provider name from configuration to a `StorageAdapter`:
 *
 *   1. adapters registered in this process (`registerStorageAdapter`);
 *      "memory" is built in;
 *   2. first-party names mapped to their packages ("cosmosdb" ->
 *      @agentforeach/storage-cosmos, "postgres" -> @agentforeach/storage-postgres);
 *   3. anything that looks like a module specifier (a package name with a
 *      scope or slash, or a file path), imported at runtime.
 *
 * A plugin module exports `storageAdapter` (or a default export) of type
 * `StorageAdapterPlugin`:
 *
 * ```ts
 * export const storageAdapter: StorageAdapterPlugin = {
 *   name: "dynamodb",
 *   create: (options) => new DynamoStorage(options),
 * };
 * ```
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InMemoryStorage } from "./memory/adapter.js";
import type { StorageAdapter } from "./types.js";

/** Adapter-specific settings (connection string, database name...). */
export type StorageAdapterOptions = Record<string, unknown>;

export type StorageAdapterFactory = (
  options: StorageAdapterOptions,
) => StorageAdapter | Promise<StorageAdapter>;

export type StorageAdapterPlugin = {
  name: string;
  create: StorageAdapterFactory;
};

const registry = new Map<string, StorageAdapterFactory>();

registry.set("memory", (options) => new InMemoryStorage(options as { now?: () => number }));

/** First-party adapters that ship as their own packages. */
const FIRST_PARTY_PACKAGES: Record<string, string> = {
  cosmosdb: "@agentforeach/storage-cosmos",
  postgres: "@agentforeach/storage-postgres",
};

/** Register (or replace) an adapter factory under `name`. */
export function registerStorageAdapter(name: string, factory: StorageAdapterFactory): void {
  registry.set(name, factory);
}

/** Names registered in this process. */
export function getRegisteredStorageAdapters(): string[] {
  return [...registry.keys()];
}

function isModuleSpecifier(provider: string): boolean {
  return (
    provider.startsWith("@") ||
    provider.startsWith(".") ||
    provider.startsWith("file:") ||
    provider.includes("/") ||
    isAbsolute(provider)
  );
}

/** Split "@scope/name/sub" into the package name and the "./sub" subpath. */
function splitSpecifier(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split("/");
  const size = specifier.startsWith("@") ? 2 : 1;
  const rest = parts.slice(size).join("/");
  return { name: parts.slice(0, size).join("/"), subpath: rest ? `./${rest}` : "." };
}

/** The ESM entry of a package.json `exports` target (import, node, default conditions). */
function exportTarget(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const found = exportTarget(item);
      if (found) return found;
    }
    return undefined;
  }
  if (target && typeof target === "object") {
    for (const [condition, value] of Object.entries(target)) {
      if (["import", "node", "module-sync", "default"].includes(condition)) {
        const found = exportTarget(value);
        if (found) return found;
      }
    }
  }
  return undefined;
}

/**
 * Find a package from the application's directory upwards and return the
 * file Node's ESM loader would import (its `exports` under the import
 * conditions, else `main`, else index.js). Undefined if it isn't installed
 * there. This finds plugins the app depends on even when this SDK lives
 * elsewhere (pnpm, nested node_modules), and picks the ESM build of dual
 * packages, keeping one copy of the SDK in the process.
 */
function resolveFromApp(specifier: string): string | undefined {
  const { name, subpath } = splitSpecifier(specifier);
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const root = join(dir, "node_modules", name);
    const manifest = join(root, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { exports?: unknown; main?: string };
      let target: string | undefined;
      if (pkg.exports !== undefined) {
        const exports = pkg.exports as Record<string, unknown>;
        const isSubpathMap = typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith("."));
        target = exportTarget(isSubpathMap ? exports[subpath] : subpath === "." ? exports : undefined);
      } else {
        target = subpath === "." ? (pkg.main ?? "index.js") : subpath;
      }
      return target ? pathToFileURL(resolve(root, target)).href : undefined;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

function importTarget(specifier: string): string {
  // File paths and file: URLs resolve against the working directory.
  if (specifier.startsWith("file:")) {
    return new URL(specifier, pathToFileURL(join(process.cwd(), "/"))).href;
  }
  if (specifier.startsWith("./") || specifier.startsWith("../") || isAbsolute(specifier)) {
    return pathToFileURL(resolve(specifier)).href;
  }
  // Packages: from the application first, then from this module.
  return resolveFromApp(specifier) ?? specifier;
}

async function loadPlugin(specifier: string, provider: string): Promise<StorageAdapterPlugin> {
  let module: Record<string, unknown>;
  try {
    module = (await import(importTarget(specifier))) as Record<string, unknown>;
  } catch (err) {
    const hint = Object.hasOwn(FIRST_PARTY_PACKAGES, provider) ? ` (install ${specifier})` : "";
    throw new Error(`storage: cannot load adapter "${provider}" from "${specifier}"${hint}`, { cause: err });
  }
  const plugin = (module.storageAdapter ?? module.default) as Partial<StorageAdapterPlugin> | undefined;
  if (!plugin || typeof plugin.create !== "function") {
    throw new Error(
      `storage: "${specifier}" does not export a storage adapter (expected \`storageAdapter\` or a default export with create())`,
    );
  }
  return plugin as StorageAdapterPlugin;
}

/**
 * Create the adapter for `provider` (not yet initialized). Plugins loaded
 * from modules are registered under the provider string afterwards.
 */
export async function createStorageAdapter(
  provider: string,
  options: StorageAdapterOptions = {},
): Promise<StorageAdapter> {
  let factory = registry.get(provider);
  if (!factory) {
    const firstParty = Object.hasOwn(FIRST_PARTY_PACKAGES, provider) ? FIRST_PARTY_PACKAGES[provider] : undefined;
    const specifier = firstParty ?? (isModuleSpecifier(provider) ? provider : undefined);
    if (!specifier) {
      const known = [...new Set([...registry.keys(), ...Object.keys(FIRST_PARTY_PACKAGES)])].join(", ");
      throw new Error(
        `storage: unknown provider "${provider}". Available: ${known}; or give an adapter package name or path.`,
      );
    }
    factory = (await loadPlugin(specifier, provider)).create;
    registry.set(provider, factory);
  }
  return factory(options);
}

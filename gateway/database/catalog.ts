/**
 * AgentForEach Database — container catalog
 *
 * Every container the runtime uses, as the runtime itself defines it:
 * each store is initialised against a recording provider that captures its
 * ContainerOptions. `npm run db:catalog` writes the result to
 * infra/cosmos-containers.json, which Pulumi provisions, and
 * database/catalog.test.ts fails when that file falls behind the code. So the
 * code stays the single source of truth for partition keys, TTLs and
 * indexing/vector policies.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseDocument, ContainerHandle, ContainerOptions, DatabaseProvider } from "./types.js";
import { AbortStore } from "../client/abort-store.js";
import { createCosmosTtlStore } from "../channels/whatsapp/kv-store.js";
import { CronStore } from "../cron/store.js";
import { DigestStore, loadDigestConfig } from "../digests/index.js";
import { EpisodeStore, loadEpisodeConfig } from "../episodes/index.js";
import { HitlStore } from "../hitl/store.js";
import { IdentityStore, loadIdentityConfig } from "../identity/index.js";
import { loadMemoryConfig } from "../memory/config.js";
import { CosmosMemoryStore } from "../memory/providers/cosmosdb.js";
import { PromptDocumentStore } from "../prompt/store.js";
import { SessionStore } from "../sessions/store.js";
import { loadSkillsConfig, UserSkillStore } from "../skills/index.js";
import { UsageStore } from "../usage/store.js";
import { RateLimiter } from "../ratelimit/index.js";

/**
 * infra/cosmos-containers.json, found by walking up from this file
 * (it runs from source under tsx and from dist/ under node).
 */
export function iacCatalogPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "infra", "cosmos-containers.json");
    if (existsSync(join(dir, "infra", "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("infra/ not found above " + fileURLToPath(import.meta.url));
    dir = parent;
  }
}

/** A container as the IaC provisions it. */
export type CatalogContainer = ContainerOptions & { id: string };

class RecordingDatabase implements DatabaseProvider {
  readonly name = "recording";
  readonly containers = new Map<string, CatalogContainer>();

  async initialize(): Promise<void> {}

  async getOrCreateContainer<T extends BaseDocument = BaseDocument>(
    options: ContainerOptions,
  ): Promise<ContainerHandle<T>> {
    this.containers.set(options.id!, JSON.parse(JSON.stringify(options)) as CatalogContainer);
    // Any method resolves to nothing; not thenable, so `await handle` works.
    return new Proxy({}, { get: (_t, prop) => (prop === "then" ? undefined : async () => undefined) }) as ContainerHandle<T>;
  }

  getDatabaseId(): string {
    return "catalog";
  }
}

/** All runtime containers, sorted by id, with the configured ids and TTLs. */
export async function recordContainerCatalog(): Promise<CatalogContainer[]> {
  const db = new RecordingDatabase();
  await Promise.all([
    new CosmosMemoryStore(loadMemoryConfig(), db).initialize(),
    new SessionStore(db).initialize(),
    new PromptDocumentStore(db).initialize(),
    new CronStore(db).initialize(),
    new UsageStore(db).initialize(),
    new HitlStore(db).initialize(),
    new AbortStore(db).initialize(),
    new EpisodeStore(db, loadEpisodeConfig().containerId).initialize(),
    new DigestStore(db, loadDigestConfig().containerId).initialize(),
    new UserSkillStore(db, loadSkillsConfig().containerId).initialize(),
    new IdentityStore(db, loadIdentityConfig()).initialize(),
    new RateLimiter(db).initialize(),
    createCosmosTtlStore("catalog", undefined, db),
  ]);
  return [...db.containers.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * AgentForEach Database — container catalog
 *
 * Every collection the runtime uses, as the runtime itself defines it: each
 * store is initialised against a recording adapter that captures its
 * CollectionSpec. Account erasure walks these specs, and `npm run db:catalog`
 * writes them out for each database:
 *
 *   - infra/cosmos-containers.json: the Cosmos container definitions, which
 *     Pulumi provisions;
 *   - infra/postgres-schema.sql: the PostgreSQL tables and indexes, applied
 *     as a migration when the runtime does not provision them itself.
 *
 * database/catalog.test.ts fails when either file falls behind the code, so
 * the code stays the single source of truth for partition keys, TTLs and
 * indexing/vector policies.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScheduleDef } from "@agentforeach/platform";
import { clone, type Collection, type CollectionSpec, type Doc, type StorageAdapter } from "@agentforeach/storage";
// The definition and schema modules only: the package roots would load the
// Azure Cosmos SDK and the pg driver, and this file is imported at startup
// (account erasure) on every deployment, a Cloudflare Worker's included.
import { toContainerDefinition, type CosmosContainerDefinition } from "@agentforeach/storage-cosmos/definition";
import { schemaSql } from "@agentforeach/storage-postgres/schema";
import { AbortStore } from "../client/abort-store.js";
import { createCosmosTtlStore } from "../channels/whatsapp/kv-store.js";
import { CronStore } from "../cron/store.js";
import { DigestStore, loadDigestConfig } from "../digests/index.js";
import { EpisodeStore, loadEpisodeConfig } from "../episodes/index.js";
import { HitlStore } from "../hitl/store.js";
import { IdentityStore, loadIdentityConfig } from "../identity/index.js";
import { loadMemoryConfig } from "../memory/config.js";
import { StorageMemoryStore } from "../memory/providers/storage.js";
import { PromptDocumentStore } from "../prompt/store.js";
import { SessionStore } from "../sessions/store.js";
import { loadSkillsConfig, UserSkillStore } from "../skills/index.js";
import { UsageStore } from "../usage/store.js";
import { RateLimiter } from "../ratelimit/index.js";
import { getSharedStorage } from "./storage.js";

/**
 * A file in infra/, found by walking up from this file (it runs from source
 * under tsx and from dist/ under node).
 */
function infraPath(file: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "infra", file);
    if (existsSync(join(dir, "infra", "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("infra/ not found above " + fileURLToPath(import.meta.url));
    dir = parent;
  }
}

/** infra/cosmos-containers.json. */
export function iacCatalogPath(): string {
  return infraPath("cosmos-containers.json");
}

/** infra/postgres-schema.sql. */
export function postgresSchemaPath(): string {
  return infraPath("postgres-schema.sql");
}

/** A container as the IaC provisions it. */
export type CatalogContainer = CosmosContainerDefinition;

/** Records each collection a store opens. */
class RecordingStorage implements StorageAdapter {
  readonly name = "recording";
  readonly capabilities = { vectorSearch: true, hybridSearch: true };
  readonly specs = new Map<string, CollectionSpec>();

  async initialize(): Promise<void> {}

  async collection<T extends Doc = Doc>(spec: CollectionSpec): Promise<Collection<T>> {
    this.specs.set(spec.name, clone(spec));
    // Any method resolves to nothing; not thenable, so `await handle` works.
    return new Proxy({}, { get: (_t, prop) => (prop === "then" ? undefined : async () => undefined) }) as Collection<T>;
  }
}

/** Every runtime collection, sorted by name, with the configured names and TTLs. */
export async function recordCollectionSpecs(): Promise<CollectionSpec[]> {
  const storage = new RecordingStorage();
  await Promise.all([
    new StorageMemoryStore(loadMemoryConfig(), storage).initialize(),
    new SessionStore(storage).initialize(),
    new PromptDocumentStore(storage).initialize(),
    new CronStore(storage).initialize(),
    new UsageStore(storage).initialize(),
    new HitlStore(storage).initialize(),
    new AbortStore(storage).initialize(),
    new EpisodeStore(storage, loadEpisodeConfig().containerId).initialize(),
    new DigestStore(storage, loadDigestConfig().containerId).initialize(),
    new UserSkillStore(storage, loadSkillsConfig().containerId).initialize(),
    new IdentityStore(storage, loadIdentityConfig()).initialize(),
    new RateLimiter(storage).initialize(),
    createCosmosTtlStore("catalog", undefined, storage),
  ]);
  return [...storage.specs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every runtime container as the IaC deploys it (Cosmos DB), sorted by id. */
export async function recordContainerCatalog(): Promise<CatalogContainer[]> {
  return (await recordCollectionSpecs()).map(toContainerDefinition);
}

const POSTGRES_SCHEMA_HEADER = `-- AgentForEach PostgreSQL schema (DATABASE_PROVIDER=postgres).
-- Generated from the runtime's collection definitions by
--   npm run db:catalog --workspace @agentforeach/gateway
-- Do not edit by hand. Every statement is idempotent: apply it once, and again
-- after an upgrade, with a role allowed to create extensions and tables:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/postgres-schema.sql
-- then run the runtime with DATABASE_PROVISION=false. Tables are in schema
-- "public"; for DATABASE_SCHEMA=<name>, use schemaSql(spec, { schema }) from
-- @agentforeach/storage-postgres instead.
`;

/** Every runtime table as a PostgreSQL migration (infra/postgres-schema.sql). */
export async function recordPostgresSchema(): Promise<string> {
  const shared = new Set<string>();
  const tables: string[] = [];
  for (const spec of await recordCollectionSpecs()) {
    const statements = schemaSql(spec);
    // The extension and schema statements once, at the top.
    const own = statements.filter((sql) => {
      if (!/^CREATE (EXTENSION|SCHEMA) /.test(sql)) return true;
      shared.add(sql);
      return false;
    });
    tables.push(`-- ${spec.name}\n${own.map((sql) => `${sql};`).join("\n")}`);
  }
  const head = [...shared].sort().map((sql) => `${sql};`).join("\n");
  return `${POSTGRES_SCHEMA_HEADER}\n${head}\n\n${tables.join("\n\n")}\n`;
}

/**
 * Delete expired rows in every collection of the catalog, for hosts that
 * sweep on a schedule (a Cloudflare Worker's cron trigger) because a
 * process-lifetime timer can't run there. Returns how many rows went, or
 * null when the storage has no sweep to run (Cosmos expires rows natively).
 * Persistent hosts don't need to call it: Postgres there sweeps on its own
 * timer.
 */
export async function sweepExpiredRows(storage: StorageAdapter = getSharedStorage()): Promise<number | null> {
  const sweeper = storage as StorageAdapter & { sweepAll?: (specs: readonly CollectionSpec[]) => Promise<number | null> };
  if (typeof sweeper.sweepAll !== "function") return null;
  return sweeper.sweepAll(await recordCollectionSpecs());
}

/**
 * The schedule that runs `sweepExpiredRows`, every 5 minutes, for hosts
 * without a long-lived process (Cloudflare Workers). Persistent hosts don't
 * serve it: Postgres there sweeps on its own timer.
 */
export const databaseSweepSchedule: ScheduleDef = {
  name: "DatabaseSweep",
  schedule: "0 */5 * * * *",
  handler: async (context) => {
    const deleted = await sweepExpiredRows();
    if (deleted) context.log(`[database] swept ${deleted} expired row(s)`);
  },
};

#!/usr/bin/env node
/**
 * Write infra/cosmos-containers.json and infra/postgres-schema.sql from the
 * runtime's own collection definitions (database/catalog.ts). Run after
 * changing a store's collection, a collection id or TTL in agentforeach.json:
 *
 *   npm run db:catalog --workspace @agentforeach/gateway
 */
import { writeFileSync } from "node:fs";

const { iacCatalogPath, postgresSchemaPath, recordContainerCatalog, recordPostgresSchema } = await import(
  "../dist/gateway/database/catalog.js"
);

const catalog = await recordContainerCatalog();
writeFileSync(iacCatalogPath(), JSON.stringify(catalog, null, 2) + "\n");
console.log(`Wrote ${catalog.length} containers to ${iacCatalogPath()}`);

writeFileSync(postgresSchemaPath(), await recordPostgresSchema());
console.log(`Wrote ${catalog.length} tables to ${postgresSchemaPath()}`);

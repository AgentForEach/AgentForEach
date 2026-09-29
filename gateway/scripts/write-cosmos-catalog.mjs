#!/usr/bin/env node
/**
 * Write infra/cosmos-containers.json from the runtime's own
 * container definitions (database/catalog.ts). Run after changing a store's
 * container, a container id or TTL in agentforeach.json:
 *
 *   npm run db:catalog --workspace @agentforeach/gateway
 */
import { writeFileSync } from "node:fs";

const { iacCatalogPath, recordContainerCatalog } = await import("../dist/gateway/database/catalog.js");

const catalog = await recordContainerCatalog();
writeFileSync(iacCatalogPath(), JSON.stringify(catalog, null, 2) + "\n");
console.log(`Wrote ${catalog.length} containers to ${iacCatalogPath()}`);

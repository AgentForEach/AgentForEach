/**
 * The storage conformance suite against a real Cosmos DB account. Skipped
 * unless STORAGE_COSMOS_ENDPOINT is set:
 *
 *   STORAGE_COSMOS_ENDPOINT   account endpoint
 *   STORAGE_COSMOS_KEY        account key; omitted: Entra ID via `az login`
 *                             (needs Cosmos DB Built-in Data Contributor)
 *   STORAGE_COSMOS_DATABASE   default "agentforeach-conformance"
 *
 * The account needs vector search (EnableNoSQLVectorSearch) and, for the
 * hybrid test, full-text search. The suite creates six containers named
 * conformance_<random>_* in that database and deletes them afterwards; the
 * TTL tests wait about 18 s in real time.
 */

import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TokenCredential } from "@azure/core-auth";
import { runStorageConformance } from "@agentforeach/storage/conformance";
import { CosmosStorage } from "./adapter.js";

const endpoint = process.env.STORAGE_COSMOS_ENDPOINT;

/** An Entra ID token from the Azure CLI (local runs after `az login`). */
function azCliCredential(): TokenCredential {
  return {
    async getToken() {
      const { stdout } = await promisify(execFile)(
        "az",
        ["account", "get-access-token", "--resource", "https://cosmos.azure.com", "-o", "json"],
        { timeout: 20_000 },
      );
      const body = JSON.parse(stdout) as { accessToken: string; expires_on?: number };
      return { token: body.accessToken, expiresOnTimestamp: (body.expires_on ?? Date.now() / 1000 + 600) * 1000 };
    },
  };
}

if (!endpoint) {
  test("cosmos conformance (set STORAGE_COSMOS_ENDPOINT to run against a live account)", { skip: true }, () => {});
} else {
  runStorageConformance({
    name: "cosmosdb (live)",
    createAdapter: () =>
      new CosmosStorage({
        endpoint,
        key: process.env.STORAGE_COSMOS_KEY || undefined,
        credential: process.env.STORAGE_COSMOS_KEY ? undefined : azCliCredential(),
        databaseId: process.env.STORAGE_COSMOS_DATABASE ?? "agentforeach-conformance",
        provisionContainers: true,
      }),
    cleanup: async (adapter, names) => {
      const storage = adapter as CosmosStorage;
      const database = storage.getClient().database(storage.getDatabaseId());
      await Promise.all(names.map((name) => database.container(name).delete().catch(() => undefined)));
    },
  });
}

import test from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStorage } from "@agentforeach/storage";
import { createStorage, getSharedStorage, loadDatabaseConfig, resetSharedStorage } from "./index.js";
import { installDatabaseUrlSource } from "./config.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("containers are created locally but only referenced on Azure", () => {
  withEnv({ WEBSITE_SITE_NAME: undefined, COSMOS_PROVISION_CONTAINERS: undefined }, () => {
    assert.equal(loadDatabaseConfig().provisionContainers, true);
  });
  withEnv({ WEBSITE_SITE_NAME: "agentforeach-func", COSMOS_PROVISION_CONTAINERS: undefined }, () => {
    assert.equal(loadDatabaseConfig().provisionContainers, false);
  });
  withEnv({ WEBSITE_SITE_NAME: "agentforeach-func", COSMOS_PROVISION_CONTAINERS: "true" }, () => {
    assert.equal(loadDatabaseConfig().provisionContainers, true);
  });
});

test("provisioning: DATABASE_PROVISION wins over its older name COSMOS_PROVISION_CONTAINERS", () => {
  withEnv({ WEBSITE_SITE_NAME: "agentforeach-func", DATABASE_PROVISION: "true", COSMOS_PROVISION_CONTAINERS: "false" }, () => {
    assert.equal(loadDatabaseConfig().provisionContainers, true);
  });
  withEnv({ WEBSITE_SITE_NAME: undefined, DATABASE_PROVISION: "false", COSMOS_PROVISION_CONTAINERS: undefined }, () => {
    assert.equal(loadDatabaseConfig().provisionContainers, false);
  });
});

test("postgres settings come from DATABASE_URL, DATABASE_SCHEMA and DATABASE_POOL_SIZE", () => {
  withEnv(
    { DATABASE_PROVIDER: "postgres", DATABASE_URL: "postgres://u:p@db:5432/app", DATABASE_SCHEMA: "agents", DATABASE_POOL_SIZE: "4" },
    () => {
      const config = loadDatabaseConfig();
      assert.equal(config.provider, "postgres");
      assert.equal(config.connectionString, "postgres://u:p@db:5432/app");
      assert.equal(config.schema, "agents");
      assert.equal(config.poolSize, 4);
      assert.equal(config.serverTimeouts, true);
    },
  );
  withEnv({ DATABASE_URL: undefined, DATABASE_SCHEMA: undefined, DATABASE_POOL_SIZE: undefined }, () => {
    const config = loadDatabaseConfig();
    assert.equal(config.connectionString, undefined);
    assert.equal(config.poolSize, undefined);
  });
  withEnv({ DATABASE_SERVER_TIMEOUTS: "false" }, () => assert.equal(loadDatabaseConfig().serverTimeouts, false));
  withEnv({ DATABASE_PROVIDER: "postgres", DATABASE_POOL_SIZE: "0" }, () =>
    assert.throws(() => loadDatabaseConfig(), /poolSize must be a positive integer/),
  );
  withEnv({ DATABASE_PROVIDER: undefined, DATABASE_POOL_SIZE: "lots" }, () => {
    assert.equal(loadDatabaseConfig().provider, "cosmosdb", "ignored on Cosmos");
  });
  // Empty values (local.settings.json placeholders) count as unset.
  withEnv({ DATABASE_PROVIDER: "", DATABASE_URL: "", DATABASE_POOL_SIZE: "" }, () => {
    const config = loadDatabaseConfig();
    assert.equal(config.provider, "cosmosdb");
    assert.equal(config.connectionString, undefined);
  });
});

test("postgres needs a connection string and loads its adapter on first use", async () => {
  const base = { endpoint: "", key: "", databaseId: "agentforeach" };
  assert.throws(() => createStorage({ ...base, provider: "postgres" }), /requires a connection string/);
  // Nothing listens on port 1: the adapter loads, then initialize fails to connect.
  const storage = createStorage({ ...base, provider: "postgres", connectionString: "postgres://u:p@127.0.0.1:1/db" });
  assert.equal(storage.name, "postgres");
  assert.deepEqual(storage.capabilities, { vectorSearch: false, hybridSearch: false }, "unknown until loaded");
  await assert.rejects(storage.initialize(), /ECONNREFUSED|connect/);
  await storage.close?.();
});

test("the process shares one storage adapter", () => {
  withEnv({ DATABASE_PROVIDER: "memory" }, () => {
    resetSharedStorage();
    assert.equal(getSharedStorage(), getSharedStorage());
    assert.ok(getSharedStorage() instanceof InMemoryStorage);
    resetSharedStorage();
  });
});

test("the provider is configuration: cosmosdb needs an endpoint, other names load as adapters", async () => {
  const base = { endpoint: "", key: "", databaseId: "agentforeach" };
  assert.throws(() => createStorage({ ...base, provider: "cosmosdb" }), /requires an endpoint/);
  assert.equal(createStorage({ ...base, provider: "cosmosdb", endpoint: "https://a.documents.azure.com:443/" }).name, "cosmosdb");
  const plugin = createStorage({ ...base, provider: "@acme/not-installed" });
  assert.equal(plugin.name, "@acme/not-installed");
  await assert.rejects(plugin.initialize(), /cannot load adapter/);
});

test("a plugin adapter is initialized before first use, once, and a failed load is retried", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storage-plugin-"));
  const sdk = new URL(import.meta.resolve("@agentforeach/storage")).href;
  const file = join(dir, "flaky.mjs");
  await writeFile(
    file,
    `import { InMemoryStorage } from ${JSON.stringify(sdk)};
     globalThis.__pluginLog = [];
     let attempts = 0;
     export const storageAdapter = {
       name: "flaky",
       create: () => {
         attempts += 1;
         if (attempts === 1) throw new Error("first load fails");
         const adapter = new InMemoryStorage();
         const initialize = adapter.initialize.bind(adapter);
         adapter.initialize = async () => { globalThis.__pluginLog.push("initialize"); return initialize(); };
         const collection = adapter.collection.bind(adapter);
         adapter.collection = async (spec) => { globalThis.__pluginLog.push("collection"); return collection(spec); };
         return adapter;
       },
     };`,
  );
  const storage = createStorage({ provider: file, endpoint: "", key: "", databaseId: "x" });
  await assert.rejects(storage.collection({ name: "docs", partitionKey: "pk" }), /first load fails/);
  await Promise.all([storage.collection({ name: "docs", partitionKey: "pk" }), storage.initialize()]);
  await storage.collection({ name: "other", partitionKey: "pk" });
  const log = (globalThis as unknown as { __pluginLog: string[] }).__pluginLog;
  assert.equal(log[0], "initialize", "initialized before any collection");
  assert.equal(log.filter((l) => l === "initialize").length, 1, "once");
  assert.deepEqual(storage.capabilities, { vectorSearch: true, hybridSearch: true });
});

test("a host can supply the database URL from a binding; DATABASE_URL still wins", () => {
  let reads = 0;
  installDatabaseUrlSource(() => (reads++, "postgres://u:p@hyperdrive.local:5432/app"));
  try {
    withEnv({ DATABASE_URL: undefined }, () => {
      assert.equal(reads, 0, "nothing is read when the source is installed");
      assert.equal(loadDatabaseConfig().connectionString, "postgres://u:p@hyperdrive.local:5432/app");
      assert.equal(reads, 1, "read when the config loads");
    });
    withEnv({ DATABASE_URL: "postgres://u:p@explicit:5432/app" }, () => {
      assert.equal(loadDatabaseConfig().connectionString, "postgres://u:p@explicit:5432/app");
    });
  } finally {
    installDatabaseUrlSource(undefined);
  }
  withEnv({ DATABASE_URL: undefined }, () => assert.equal(loadDatabaseConfig().connectionString, undefined));
});

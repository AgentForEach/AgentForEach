/**
 * The storage factory: which adapter a configuration gets, and how Postgres
 * connections are held on persistent and non-persistent hosts. Offline: the
 * connection string points at a closed port, so every query fails fast with
 * ECONNREFUSED, which is enough to see where the pool came from.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { background, openScope } from "@agentforeach/platform";
import { installHost, resetHostForTests } from "../runtime/host.js";
import { createStorage, scopedPoolSource } from "./storage.js";
import type { ResolvedDatabaseConfig } from "./config.js";

const closedPort = "postgres://u:p@127.0.0.1:1/db";

function postgres(overrides: Partial<ResolvedDatabaseConfig> = {}): ResolvedDatabaseConfig {
  return {
    provider: "postgres",
    connectionString: closedPort,
    databaseId: "agentforeach",
    provisionContainers: false,
    serverTimeouts: true,
    ...overrides,
  } as ResolvedDatabaseConfig;
}

const workers = { platform: "cloudflare", isProductionHost: false, publicBaseUrl: undefined, label: "test", persistent: false };

afterEach(() => resetHostForTests());

test("cosmosdb loads on first use, and a missing endpoint still fails at once", () => {
  assert.throws(() => createStorage({ provider: "cosmosdb", databaseId: "x" } as ResolvedDatabaseConfig), /requires an endpoint/);
  const storage = createStorage({
    provider: "cosmosdb",
    endpoint: "https://example.documents.azure.com:443/",
    key: "a2V5",
    databaseId: "x",
  } as ResolvedDatabaseConfig);
  assert.equal(storage.name, "cosmosdb");
  assert.deepEqual(storage.capabilities, { vectorSearch: false, hybridSearch: false }, "nothing is loaded until it's used");
});

test("on a persistent host (Azure, Node), postgres keeps one pool for the process, as before", async () => {
  const storage = createStorage(postgres());
  await assert.rejects(storage.initialize(), /ECONNREFUSED|connect/);
  // Outside any invocation, the process-wide pool is used (and refuses here only because the port is closed).
  const err = await storage.initialize().catch((e: Error) => e);
  assert.doesNotMatch(String(err), /only exists inside an invocation/);
});

test("on a host that isn't persistent, a connection outside an invocation is refused at once", async () => {
  installHost(workers);
  const storage = createStorage(postgres());
  await assert.rejects(storage.initialize(), /only exists inside an invocation/);
});

test("the scoped pool source: one pool per invocation, shared within it, ended after its background work", async () => {
  const made: Array<{ id: number; options: unknown; ended: boolean; end(): Promise<void> }> = [];
  const create = ((options: unknown) => {
    const pool = { id: made.length + 1, options, ended: false, end: async () => void (pool.ended = true) };
    made.push(pool);
    return pool;
  }) as unknown as Parameters<typeof scopedPoolSource>[0];
  const source = scopedPoolSource(create, { connectionString: closedPort, serverTimeouts: false });

  assert.throws(() => source(), /only exists inside an invocation/);
  for (const id of ["one", "two"]) {
    const opened = openScope({ invocationId: id, kind: "http" });
    await opened.run(async () => {
      assert.equal(source(), source(), "the same pool throughout the invocation");
      background(new Promise((r) => setTimeout(r, 10)).then(() => source())); // still usable from background work
    });
    assert.equal(made.at(-1)!.ended, false, "not ended while background work runs");
    await opened.settle();
    assert.equal(made.at(-1)!.ended, true, `invocation ${id}'s pool is ended with it`);
  }
  assert.equal(made.length, 2, "a new pool per invocation");
  const { onError, ...settings } = made[0].options as Record<string, unknown>;
  assert.deepEqual(
    settings,
    { connectionString: closedPort, serverTimeouts: false, poolSize: 2, idleTimeoutMs: 0 },
    "two connections by default, kept until the invocation ends (on workerd an idle close is reported as an error)",
  );
  assert.equal(typeof onError, "function", "with the pool's own error filter");
});

test("the scoped pool reports connection errors, except the ones its own ending causes", async () => {
  let pool: { fire(err: Error): void; ended: boolean } | undefined;
  const create = ((options: { onError?: (err: unknown) => void }) => {
    pool = {
      ended: false,
      fire: (err: Error) => options.onError?.(err),
      end: async function (this: { ended: boolean }) {
        // workerd reports each socket the pool closes as an error.
        options.onError?.(new Error("This socket has been closed."));
        this.ended = true;
      },
    } as unknown as typeof pool;
    return pool;
  }) as unknown as Parameters<typeof scopedPoolSource>[0];
  const reported: string[] = [];
  const source = scopedPoolSource(create, { connectionString: closedPort, onError: (err) => void reported.push(String(err)) });
  const opened = openScope({ invocationId: "x", kind: "schedule" });
  await opened.run(async () => {
    source();
    pool!.fire(new Error("server dropped an idle connection"));
  });
  await opened.settle();
  assert.deepEqual(reported, ["Error: server dropped an idle connection"], "only the error from before the pool ended");
});

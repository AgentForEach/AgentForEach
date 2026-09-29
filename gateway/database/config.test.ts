import test from "node:test";
import assert from "node:assert/strict";

import { getSharedDatabase, loadDatabaseConfig, resetSharedDatabase } from "./index.js";

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

test("the process shares one database provider", () => {
  withEnv({ DATABASE_PROVIDER: "noop" }, () => {
    resetSharedDatabase();
    assert.equal(getSharedDatabase(), getSharedDatabase());
    resetSharedDatabase();
  });
});

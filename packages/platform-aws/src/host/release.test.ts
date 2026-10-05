import test from "node:test";
import assert from "node:assert/strict";
import { createReleaseLoader, validateReleaseManifest } from "./release.js";

const arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:database-abc";
const manifest = {
  version: 1,
  config: { database: { provider: "postgres" } },
  environment: { DATABASE_PROVIDER: "postgres", AWS_SANDBOX_WORKSPACE_BUCKET: "test-workspaces" },
  secrets: { DATABASE_URL: { arn } },
};
const location = () => ({ AGENTFOREACH_RELEASE_BUCKET: "artifacts", AGENTFOREACH_RELEASE_KEY: "releases/r1/http.json" }) as Record<string, string | undefined>;

test("the release loads once per process: settings and secrets into the environment, the config installed, secrets kept out of it", async () => {
  const env = location();
  let reads = 0;
  const installed: unknown[] = [];
  const load = createReleaseLoader({
    env,
    readManifest: async (bucket, key) => {
      reads++;
      assert.deepEqual([bucket, key], ["artifacts", "releases/r1/http.json"]);
      return JSON.stringify(manifest);
    },
    readSecret: async (ref) => (ref.arn === arn ? "postgres://private" : ""),
    installConfig: (config) => void installed.push(config),
  });
  await Promise.all([load(), load(), load()]);
  assert.equal(reads, 1);
  assert.equal(env.DATABASE_URL, "postgres://private");
  assert.equal(env.DATABASE_PROVIDER, "postgres");
  assert.equal(env.AWS_SANDBOX_WORKSPACE_BUCKET, "test-workspaces");
  assert.deepEqual(installed, [{ database: { provider: "postgres" } }]);
  assert.ok(!JSON.stringify(installed).includes("private"));
});

test("a secret that can't be read leaves the environment and config untouched, and the next call tries again", async () => {
  const env = location();
  let fail = true;
  const installed: unknown[] = [];
  const load = createReleaseLoader({
    env,
    readManifest: async () => JSON.stringify(manifest),
    readSecret: async () => {
      if (fail) throw new Error("unavailable");
      return "db";
    },
    installConfig: (config) => void installed.push(config),
  });
  await assert.rejects(load(), /unavailable/);
  assert.equal(env.DATABASE_PROVIDER, undefined);
  assert.deepEqual(installed, []);
  fail = false;
  await load();
  assert.equal(env.DATABASE_URL, "db");
  assert.equal(installed.length, 1);
});

test("an empty secret, or a function without a manifest location, fails closed", async () => {
  const empty = createReleaseLoader({
    env: location(),
    readManifest: async () => JSON.stringify(manifest),
    readSecret: async () => "",
    installConfig: () => {},
  });
  await assert.rejects(empty(), /The secret for DATABASE_URL is empty/);
  const nowhere = createReleaseLoader({ env: {}, readManifest: async () => "{}", readSecret: async () => "", installConfig: () => {} });
  await assert.rejects(nowhere(), /AGENTFOREACH_RELEASE_BUCKET and AGENTFOREACH_RELEASE_KEY/);
});

test("a manifest can't replace the function's credentials, handler, Node options, config path or its own location", () => {
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_REGION", "LAMBDA_TASK_ROOT", "NODE_OPTIONS", "_HANDLER", "_X_AMZN_TRACE_ID", "CONFIG_FILE_JSON", "AGENTFOREACH_RELEASE_KEY", "lower"]) {
    assert.throws(() => validateReleaseManifest({ ...manifest, environment: { [name]: "x" } }), /may not set/, name);
    assert.throws(() => validateReleaseManifest({ ...manifest, environment: {}, secrets: { [name]: { arn } } }), /may not set/, name);
  }
  assert.throws(() => validateReleaseManifest({ ...manifest, secrets: { DATABASE_PROVIDER: { arn } } }), /both a setting and a secret/);
  assert.throws(() => validateReleaseManifest({ ...manifest, secrets: { DATABASE_URL: { arn: "arn:aws:s3:::bucket" } } }), /Secrets Manager ARN/);
  assert.throws(() => validateReleaseManifest({ ...manifest, environment: { PORT: 8080 } }), /must be a string/);
  assert.throws(() => validateReleaseManifest({ ...manifest, version: 2 }), /Invalid release manifest/);
  assert.throws(() => validateReleaseManifest({ ...manifest, config: [] }), /Invalid release manifest/);
});

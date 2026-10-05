#!/usr/bin/env node
/**
 * Runs the durable conformance suite against a deployed AWS stack ("connect
 * mode"): builds the pack, then runs the suite, which drives the Lambda
 * entry's `conformance` export through Lambda's Invoke. Needs AWS
 * credentials allowed to invoke that function, and the durable function's
 * registry to include the suite's kinds (defineDurableConformanceKinds).
 *
 *   DURABLE_CONFORMANCE_FUNCTION=<name or qualified ARN of the conformance function> \
 *     node packages/platform-aws/conformance/durable/run.mjs
 *
 * It starts and stops durable instances (prefixed conf-) on that stack; it
 * creates no AWS resources.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DURABLE_CONFORMANCE_FUNCTION) {
  console.error("Set DURABLE_CONFORMANCE_FUNCTION to the conformance function's name or ARN.");
  process.exit(2);
}

const build = spawnSync("npm", ["run", "build"], { cwd: resolve(here, "../.."), stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const suite = spawnSync(process.execPath, ["--test", "--test-reporter=spec", resolve(here, "conformance.test.mjs")], {
  stdio: "inherit",
});
process.exit(suite.status ?? 1);

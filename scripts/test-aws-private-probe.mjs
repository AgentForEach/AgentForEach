#!/usr/bin/env node

/**
 * Checks a deployed AWS stack from inside its VPC, through the two functions
 * that have no route (docs/AWS.md#check-a-deployment):
 *
 *   migrate      applies the schema again (idempotent) and reports pgvector
 *   conformance  the durable conformance suite against the deployed durable function
 *
 * The migration is invoked on its published version; the conformance suite runs
 * through the pack's runner and its published control function, with the caller's AWS
 * credentials (lambda:InvokeFunction on them). Nothing is created; the suite
 * cleans up its own instances. Never run by CI.
 *
 * Usage:
 *   pulumi -C deploy/aws/infra stack output --json --stack <name> > /tmp/afe-application.json
 *   AWS_APPLICATION_LIVE=1 node scripts/test-aws-private-probe.mjs /tmp/afe-application.json [migrate|conformance|all]
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

if (process.env.AWS_APPLICATION_LIVE !== "1") {
  console.error("Set AWS_APPLICATION_LIVE=1 to run against a deployed stack.");
  process.exit(2);
}
const [outputsPath, which = "all"] = process.argv.slice(2);
if (!outputsPath || !["migrate", "conformance", "all"].includes(which)) {
  console.error("usage: test-aws-private-probe.mjs <application-outputs.json> [migrate|conformance|all]");
  process.exit(2);
}
const outputs = JSON.parse(await readFile(outputsPath, "utf8"));
const region = process.env.AWS_REGION ?? outputs.apiUrl?.match(/execute-api\.([a-z0-9-]+)\./)?.[1];
const run = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), "afe-probe-"));

async function invoke(functionArn, input) {
  const resultPath = join(dir, "result.json");
  const { stdout } = await run(
    "aws",
    ["lambda", "invoke", "--function-name", functionArn, "--cli-binary-format", "raw-in-base64-out", "--payload", input,
      "--cli-read-timeout", "960", ...(region ? ["--region", region] : []), "--output", "json", resultPath],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const response = JSON.parse(stdout);
  const body = await readFile(resultPath, "utf8");
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    result = body;
  }
  return { failed: !!response.FunctionError || !!result?.error || result?.ok === false, result };
}

const report = { checkedAt: new Date().toISOString(), checks: [] };
try {
  const targets = [
    ["migrate", outputs.migrateFunctionArn, "{}"],
    ["conformance", outputs.conformanceFunctionArn, undefined],
  ].filter(([name]) => which === "all" || which === name);
  for (const [name, arn, input] of targets) {
    if (!arn) {
      report.checks.push({ name, status: "failed", error: `the outputs have no ${name} function (is the stack in its application phase?)` });
      continue;
    }
    let failed, result;
    if (name === "conformance") {
      try {
        const { stdout } = await run(process.execPath, [fileURLToPath(new URL("../packages/platform-aws/conformance/durable/run.mjs", import.meta.url))], {
          env: { ...process.env, ...(region ? { AWS_REGION: region } : {}), DURABLE_CONFORMANCE_FUNCTION: arn },
          maxBuffer: 8 * 1024 * 1024,
        });
        failed = false;
        result = stdout;
      } catch (error) {
        failed = true;
        result = error.stdout || error.message;
      }
    } else {
      ({ failed, result } = await invoke(arn, input));
    }
    report.checks.push({ name, status: failed ? "failed" : "passed", result });
    console.log(failed ? "FAIL" : "PASS", name);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
if (report.checks.some((check) => check.status !== "passed")) process.exitCode = 1;

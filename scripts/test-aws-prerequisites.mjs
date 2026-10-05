#!/usr/bin/env node

/**
 * Read-only AWS readiness check before deploying AgentForEach (docs/AWS.md).
 * Reads the account's Lambda concurrency and, with --bedrock, the Bedrock
 * quotas a Bedrock-backed deployment needs. Changes nothing, prints no
 * credentials, and exits non-zero when it finds a blocker.
 *
 * Usage:
 *   AWS_REGION=us-west-2 node scripts/test-aws-prerequisites.mjs [--bedrock]
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const region = process.env.AWS_REGION ?? "us-west-2";
const aws = async (...args) =>
  JSON.parse((await run("aws", [...args, "--region", region, "--output", "json"], { maxBuffer: 8 * 1024 * 1024 })).stdout);

/** Bedrock quotas a Bedrock-backed evaluation needed (Nova Lite chat, Titan V2 embeddings). */
const BEDROCK_QUOTAS = [
  ["nova-lite-daily-tokens", "L-45E0AD92"],
  ["titan-v2-requests-per-minute", "L-26C560CE"],
  ["titan-v2-tokens-per-minute", "L-DE641971"],
];

const report = { checkedAt: new Date().toISOString(), region, checks: [], blockers: [] };
try {
  await aws("sts", "get-caller-identity");
  report.checks.push({ name: "credentials", value: "ok" });
  const concurrency = (await aws("lambda", "get-account-settings")).AccountLimit.ConcurrentExecutions;
  report.checks.push({
    name: "lambda-concurrency",
    value: concurrency,
    note:
      concurrency < 100
        ? "Low: keep reservedConcurrency at -1 (unreserved); reserving per function would not fit."
        : "Enough to reserve concurrency per function if you want to.",
  });
  if (process.argv.includes("--bedrock")) {
    for (const [name, code] of BEDROCK_QUOTAS) {
      const quota = (await aws("service-quotas", "get-service-quota", "--service-code", "bedrock", "--quota-code", code)).Quota;
      report.checks.push({ name, quotaCode: code, value: quota.Value, adjustable: quota.Adjustable });
      if (quota.Value === 0) report.blockers.push(`${name}: the quota is zero, so Bedrock calls will be throttled`);
    }
  }
} catch (error) {
  report.blockers.push(`AWS readiness check failed: ${String(error.message).slice(0, 300)}`);
}
console.log(JSON.stringify(report, null, 2));
if (report.blockers.length) process.exitCode = 1;

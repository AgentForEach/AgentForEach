#!/usr/bin/env node
/**
 * The Lambda bundle guard (npm run check:bundle, after the Worker's).
 *
 * 1. Bundles deploy/aws/lambda.ts exactly as the build does
 *    (lambda-bundle.mjs), and fails if the bundle contains Azure code
 *    (@azure/*, durable-functions, the Azure pack, the Cosmos adapter) or
 *    Cloudflare code (cloudflare:* modules, the Cloudflare pack). For each
 *    hit it prints the chain of imports from the entry, marking lazy ones
 *    (lib/bundle-guard.mjs, shared with the Worker guard).
 *
 *    The gateway reaches Azure-only code only through `await import()` (or
 *    on paths a configuration selects), and the bundle aliases each such
 *    module to deploy/aws/azure-only.ts (which throws if used), so none of
 *    it is bundled. A new path to such code fails here until it is lazy and
 *    aliased.
 *
 * 2. Checks that every schedule the Lambda serves (the gateway's table plus
 *    the database sweep) runs on whole minutes, as the every-minute
 *    EventBridge Scheduler tick needs.
 *
 * Needs the workspace packages built (npm run build:platform, and the
 * gateway's build for step 2).
 */

import { build } from "esbuild";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { checkForbidden } from "./lib/bundle-guard.mjs";
import { LAMBDA_ENTRY, lambdaBuildOptions, root } from "./lambda-bundle.mjs";

/** Inputs that must never be in the Lambda bundle. */
const FORBIDDEN_INPUTS = [
  [/node_modules\/@azure\//, "an Azure SDK"],
  [/node_modules\/durable-functions\//, "Durable Functions"],
  [/packages\/platform-azure\//, "the Azure platform pack"],
  [/packages\/storage-cosmos\/(?!(src|dist)\/definition\.)/, "the Cosmos adapter"],
  [/packages\/platform-cloudflare\//, "the Cloudflare platform pack"],
  [/node_modules\/@cloudflare\//, "Cloudflare's runtime packages"],
];
/** Imports left external that must never be reached. */
const FORBIDDEN_EXTERNALS = [
  [/^@azure\//, "an Azure SDK"],
  [/^durable-functions$/, "Durable Functions"],
  [/^@agentforeach\/platform-azure(\/|$)/, "the Azure platform pack"],
  [/^@agentforeach\/storage-cosmos(\/adapter)?$/, "the Cosmos adapter"],
  [/^cloudflare:/, "a Workers runtime module"],
  [/^@agentforeach\/platform-cloudflare(\/|$)/, "the Cloudflare platform pack"],
  [/^@cloudflare\//, "Cloudflare's runtime packages"],
];

/**
 * Left external, so the check never depends on bundling them and a path to
 * one is reported with its chain. Aliases are resolved first, so an aliased
 * module still goes to the stub.
 */
const CLOUD_ONLY_EXTERNALS = [
  "@azure/*",
  "durable-functions",
  "@agentforeach/platform-azure",
  "@agentforeach/platform-azure/*",
  "@agentforeach/storage-cosmos",
  "@agentforeach/storage-cosmos/adapter",
  "cloudflare:*",
  "@agentforeach/platform-cloudflare",
  "@agentforeach/platform-cloudflare/*",
  "@cloudflare/*",
];

async function checkBundle() {
  const { metafile } = await build(lambdaBuildOptions({ write: false, metafile: true, outdir: "out", external: CLOUD_ONLY_EXTERNALS }));
  return checkForbidden(metafile, {
    entry: relative(root, join(root, LAMBDA_ENTRY)),
    forbiddenInputs: FORBIDDEN_INPUTS,
    forbiddenExternals: FORBIDDEN_EXTERNALS,
    bundleName: "the Lambda bundle",
    fix: "Reach Azure-only code only through `await import()`, and alias that module to deploy/aws/azure-only.ts in scripts/lambda-bundle.mjs; never import Cloudflare code from the gateway's shared modules.",
  });
}

async function checkSchedules() {
  const imp = (path) => import(pathToFileURL(join(root, path)).href);
  const [{ buildRouteTable }, { databaseSweepSchedule }, { cronMatcher }] = await Promise.all([
    imp("gateway/dist/gateway/routes.js"),
    imp("gateway/dist/gateway/database/catalog.js"),
    imp("packages/platform/dist/index.js"),
  ]);
  const schedules = [...buildRouteTable().schedules, databaseSweepSchedule];
  const refused = [];
  for (const s of schedules) {
    try {
      cronMatcher(s.schedule, "EventBridge Scheduler ticks");
    } catch (err) {
      refused.push(`${s.name}: ${err.message}`);
    }
  }
  if (refused.length) {
    console.error(`\n✖ the Lambda can't run these schedules on its every-minute tick:\n  ${refused.join("\n  ")}`);
    return false;
  }
  console.log(`schedules: ${schedules.map((s) => `${s.name} (${s.schedule})`).join(", ")} run on whole minutes`);
  return true;
}

const bundleOk = await checkBundle();
const schedulesOk = await checkSchedules();
if (!bundleOk || !schedulesOk) process.exit(1);
console.log("✔ the Lambda bundle is free of Azure and Cloudflare code");

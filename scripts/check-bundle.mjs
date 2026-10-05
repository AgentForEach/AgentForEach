#!/usr/bin/env node
/**
 * The Cloudflare Worker bundle guard (npm run check:bundle).
 *
 * 1. Bundles deploy/cloudflare/worker.ts as Wrangler does (its `main` and
 *    `alias` from wrangler.jsonc, Workers resolution conditions, Node
 *    built-ins left to nodejs_compat), and fails if the bundle contains
 *    Azure-only code (@azure/*, durable-functions, undici, the Azure pack,
 *    the Cosmos adapter), AWS-only code (@aws-sdk/*, @smithy/*, the Lambda
 *    durable execution SDK), or an import of child_process. For each hit it
 *    prints the chain of imports from the entry, marking lazy ones
 *    (lib/bundle-guard.mjs, shared with the Lambda guard).
 *
 *    The gateway reaches Azure- and AWS-only code only through `await
 *    import()`, and wrangler.jsonc aliases each such module to
 *    deploy/cloudflare/azure-only.ts or aws-only.ts (which throw if used), so
 *    none of it is bundled. A new path to such code, static or lazy, fails
 *    here until it is lazy and aliased.
 *
 * 2. Checks wrangler.jsonc's cron triggers against the schedules the Worker
 *    serves (the gateway's table plus the database sweep): one trigger per
 *    distinct schedule, nothing missing, nothing extra.
 *
 * Needs the workspace packages built (npm run build:platform, and the
 * gateway's build for step 2). `npm run check:bundle` runs the Lambda guard
 * (check-lambda-bundle.mjs) after it.
 */

import { build } from "esbuild";
import { readJsonc } from "./cloudflare-config.mjs";
import { checkForbidden } from "./lib/bundle-guard.mjs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deployDir = join(root, "deploy/cloudflare");
const configPath = join(deployDir, "wrangler.jsonc");

/** Inputs that must never be in the Worker bundle. */
const FORBIDDEN_INPUTS = [
  [/node_modules\/@azure\//, "an Azure SDK"],
  [/node_modules\/durable-functions\//, "Durable Functions"],
  [/node_modules\/undici\//, "undici (use safeFetch's fetch transport)"],
  [/packages\/platform-azure\//, "the Azure platform pack"],
  [/packages\/storage-cosmos\/(?!(src|dist)\/definition\.)/, "the Cosmos adapter"],
  [/node_modules\/@aws-sdk\//, "an AWS SDK"],
  [/node_modules\/@smithy\//, "the AWS SDK's Smithy runtime"],
  [/node_modules\/@aws\/durable-execution-sdk-js/, "the Lambda durable execution SDK"],
];
/**
 * Imports left external that must never be reached. `thirdPartyLazy`: also
 * allowed when the path to it runs through a lazy import a dependency makes
 * itself (the Anthropic SDK loads Node-only helpers that way): the module
 * exists under nodejs_compat, and it's the dependency's choice to call it.
 * Our own code reaching it, statically or lazily, still fails.
 */
const FORBIDDEN_EXTERNALS = [
  [/^(node:)?child_process$/, "child processes, which Workers can't start", { thirdPartyLazy: true }],
  [/^@azure\//, "an Azure SDK"],
  [/^durable-functions$/, "Durable Functions"],
  [/^undici$/, "undici (use safeFetch's fetch transport)"],
  [/^@agentforeach\/platform-azure(\/|$)/, "the Azure platform pack"],
  [/^@agentforeach\/storage-cosmos(\/adapter)?$/, "the Cosmos adapter"],
  [/^@aws-sdk\//, "an AWS SDK"],
  [/^@smithy\//, "the AWS SDK's Smithy runtime"],
  [/^@aws\/durable-execution-sdk-js/, "the Lambda durable execution SDK"],
];

/**
 * Left external, so the check never depends on bundling them (some don't
 * bundle for Workers at all) and a path to one is reported with its chain.
 * Aliases are resolved first, so an aliased module still goes to the stub.
 */
const CLOUD_ONLY_EXTERNALS = [
  "@azure/*",
  "durable-functions",
  "undici",
  "@agentforeach/platform-azure",
  "@agentforeach/platform-azure/*",
  "@agentforeach/storage-cosmos",
  "@agentforeach/storage-cosmos/adapter",
  "@aws-sdk/*",
  "@smithy/*",
  "@aws/durable-execution-sdk-js*",
];

/** wrangler.jsonc, comments and trailing commas removed (shared with cloudflare-config.mjs). */
function readWranglerConfig() {
  return readJsonc(configPath);
}

function aliasesOf(config) {
  return Object.fromEntries(
    Object.entries(config.alias ?? {}).map(([name, target]) => [name, target.startsWith(".") ? resolve(deployDir, target) : target]),
  );
}

async function bundleReport(config) {
  const builtins = builtinModules.flatMap((m) => [m, `${m}/*`]);
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(deployDir, config.main)],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    alias: aliasesOf(config),
    external: ["node:*", "cloudflare:*", ...builtins, ...CLOUD_ONLY_EXTERNALS],
    loader: { ".json": "json" },
    logLevel: "silent",
  });
  return result.metafile;
}

async function checkBundle(config) {
  const metafile = await bundleReport(config);
  return checkForbidden(metafile, {
    entry: relative(root, join(deployDir, config.main)),
    forbiddenInputs: FORBIDDEN_INPUTS,
    forbiddenExternals: FORBIDDEN_EXTERNALS,
    bundleName: "the Worker bundle",
    fix: "Reach Azure- or AWS-only code only through `await import()`, and alias that module to ./azure-only.ts or ./aws-only.ts in deploy/cloudflare/wrangler.jsonc.",
  });
}

async function checkTriggers(config) {
  const imp = (path) => import(pathToFileURL(join(root, path)).href);
  const [{ buildRouteTable }, { databaseSweepSchedule }, { cronTriggers }] = await Promise.all([
    imp("gateway/dist/gateway/routes.js"),
    imp("gateway/dist/gateway/database/catalog.js"),
    imp("packages/platform-cloudflare/dist/index.js"),
  ]);
  const wanted = cronTriggers([...buildRouteTable().schedules, databaseSweepSchedule]);
  const declared = config.triggers?.crons ?? [];
  const missing = wanted.filter((c) => !declared.includes(c));
  const extra = declared.filter((c) => !wanted.includes(c));
  if (missing.length || extra.length) {
    console.error(
      `\n✖ wrangler.jsonc triggers.crons should be ${JSON.stringify(wanted)}` +
        (missing.length ? `; missing ${JSON.stringify(missing)}` : "") +
        (extra.length ? `; nothing runs on ${JSON.stringify(extra)}` : ""),
    );
    return false;
  }
  console.log(`triggers: ${JSON.stringify(declared)} match the Worker's schedules`);
  return true;
}

const config = readWranglerConfig();
const bundleOk = await checkBundle(config);
const triggersOk = await checkTriggers(config);
if (!bundleOk || !triggersOk) process.exit(1);
console.log("✔ the Worker bundle is free of Azure- and AWS-only code");

/**
 * How the Lambda package is bundled: one ESM file from deploy/aws/lambda.ts,
 * for Node. Shared by the build (build-lambda.mjs) and the guard
 * (check-lambda-bundle.mjs), so the guard checks exactly what ships.
 *
 * The gateway reaches Azure-only modules only through `await import()` (or
 * on paths a configuration selects); each is aliased to
 * deploy/aws/azure-only.ts, which throws if used, so no Azure code is
 * bundled. The AWS SDKs, undici and child processes are fine here: Lambda
 * is Node.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LAMBDA_ENTRY = "deploy/aws/lambda.ts";
/** The function handler is `dist/deploy/aws/lambda.<export>` (Lambda finds the .mjs). */
export const LAMBDA_OUTFILE = "dist/deploy/aws/lambda.mjs";

const AZURE_ONLY = join(root, "deploy/aws/azure-only.ts");
export const LAMBDA_ALIASES = {
  "@agentforeach/storage-cosmos/adapter": AZURE_ONLY,
  "@agentforeach/platform-azure/identity": AZURE_ONLY,
  "@agentforeach/platform-azure/objects": AZURE_ONLY,
  "@agentforeach/platform-azure/realtime": AZURE_ONLY,
  "@agentforeach/platform-azure/sandbox": AZURE_ONLY,
};

/** Optional native add-ons that dependencies load only if installed (pg's pg-native). */
const OPTIONAL_NATIVE = ["pg-native"];

/** esbuild options for the Lambda bundle; `extra` adds to them (the guard leaves cloud-only code external). */
export function lambdaBuildOptions(extra = {}) {
  return {
    absWorkingDir: root,
    entryPoints: [join(root, LAMBDA_ENTRY)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    mainFields: ["module", "main"],
    alias: LAMBDA_ALIASES,
    // CommonJS dependencies still `require` Node's built-ins from inside an ES module.
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    loader: { ".json": "json" },
    logLevel: "silent",
    ...extra,
    external: [...OPTIONAL_NATIVE, ...(extra.external ?? [])],
  };
}

#!/usr/bin/env node
/**
 * Builds the Lambda package's entry (npm run build:aws): deploy/aws/lambda.ts
 * bundled into dist/deploy/aws/lambda.mjs, with its source map. Every
 * function of the AWS stack runs a named export of it
 * (`dist/deploy/aws/lambda.<export>`).
 *
 * Needs the workspace packages built (npm run build:storage, npm run
 * build:platform).
 */

import { build } from "esbuild";
import { join } from "node:path";
import { LAMBDA_OUTFILE, lambdaBuildOptions, root } from "./lambda-bundle.mjs";

const result = await build(lambdaBuildOptions({ outfile: join(root, LAMBDA_OUTFILE), sourcemap: true, metafile: true, logLevel: "warning" }));
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`✔ ${LAMBDA_OUTFILE}: ${Object.keys(result.metafile.inputs).length} modules, ${(bytes / 1e6).toFixed(1)} MB with its source map`);

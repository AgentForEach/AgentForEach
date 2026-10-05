#!/usr/bin/env node
/**
 * Rewrites the checked-in copies of the portable realtime client
 * (packages/platform/src/realtime/client/index.ts) where nothing is built or
 * bundled:
 *
 *   - examples/web-chat/realtime-client.js: an ES module the static page imports;
 *   - gateway/sandbox-container/browser/realtime-client.mjs: the browser
 *     driver's, shipped in the sandbox image with the driver's other files;
 *   - gateway/skills/browser/realtime-client-script.ts: the classic script the
 *     live view inlines, as a string, so no bundler can change what its CSP
 *     hash covers.
 *
 * Tests fail while a copy is stale. Needs the platform package built:
 *
 *   npm run build --workspace @agentforeach/platform && node scripts/sync-realtime-client.mjs
 */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realtimeClientModule, realtimeClientScript } from "@agentforeach/platform";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The live view's copy: the script as a TypeScript string constant. */
function viewerScriptModule() {
  return (
    "// The portable realtime client as the classic script the live view inlines (viewer.ts),\n" +
    "// generated from packages/platform/src/realtime/client/index.ts. Don't edit it: change the\n" +
    "// source, then run `node scripts/sync-realtime-client.mjs`.\n" +
    `export const REALTIME_CLIENT_SCRIPT = ${JSON.stringify(realtimeClientScript())};\n`
  );
}

const copies = {
  "examples/web-chat/realtime-client.js": realtimeClientModule(),
  "gateway/sandbox-container/browser/realtime-client.mjs": realtimeClientModule(),
  "gateway/skills/browser/realtime-client-script.ts": viewerScriptModule(),
};

for (const [path, text] of Object.entries(copies)) {
  writeFileSync(join(root, path), text);
  console.log(`wrote ${path}`);
}

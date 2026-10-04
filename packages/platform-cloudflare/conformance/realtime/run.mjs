#!/usr/bin/env node
/**
 * Runs the realtime conformance suite on workerd, locally: builds the pack,
 * starts the test Worker with `wrangler dev` on a free port (no Cloudflare
 * account or resources involved), runs the suite, and stops the Worker.
 *
 *   node packages/platform-cloudflare/conformance/realtime/run.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const freePort = () =>
  new Promise((ok) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });

const build = spawnSync("npm", ["run", "build"], { cwd: resolve(here, "../.."), stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const [port, inspector] = [await freePort(), await freePort()];
const wrangler = spawn(
  "npx",
  ["-y", "wrangler@4", "dev", "--config", resolve(here, "wrangler.jsonc"), "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--show-interactive-dev-session=false"],
  { cwd: here, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "inherit"] },
);
await new Promise((ok, fail) => {
  wrangler.stdout.on("data", (chunk) => String(chunk).includes("Ready on") && ok());
  wrangler.on("exit", (code) => fail(new Error(`wrangler dev exited with ${code}`)));
});

const suite = spawnSync(process.execPath, ["--test", "--test-reporter=spec", resolve(here, "conformance.test.mjs")], {
  stdio: "inherit",
  env: { ...process.env, REALTIME_WORKER_URL: `http://127.0.0.1:${port}` },
});
wrangler.kill("SIGTERM");
process.exit(suite.status ?? 1);

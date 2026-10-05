// The web chat's copy of the portable realtime client is the current one, and the page uses it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { realtimeClientModule } from "@agentforeach/platform";

test("realtime-client.js is the portable client, as generated (node scripts/sync-realtime-client.mjs)", () => {
  assert.equal(readFileSync(new URL("realtime-client.js", import.meta.url), "utf8"), realtimeClientModule());
});

test("the page connects through it, with the gateway's descriptor when there is one", async () => {
  const html = readFileSync(new URL("index.html", import.meta.url), "utf8");
  assert.match(html, /await import\("\.\/realtime-client\.js"\)/);
  assert.match(html, /body\.descriptor \?\? \{ protocol: "v1", url: body\.url \}/);
  const { keepConnected } = await import("./realtime-client.js");
  assert.equal(typeof keepConnected, "function");
});

/**
 * Dynamic Sessions client: responses are read only up to a cap, and a file
 * too large to read or export fails with a clear message.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { DynamicSessionsClient } from "./client.js";
import type { SandboxConfig } from "./types.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(overrides: Partial<SandboxConfig> = {}) {
  return new DynamicSessionsClient(
    {
      enabled: true,
      provider: "aca-dynamic-sessions",
      poolManagementEndpoint: "https://pool.example",
      containerType: "CustomContainer",
      identifierStrategy: "userId",
      defaultTimeoutSec: 60,
      maxTimeoutSec: 220,
      cooldownSec: 600,
      networkAccess: "disabled",
      maxOutputChars: 10,
      exportsContainerName: "user-exports",
      exportExpiryHours: 24,
      maxExportBytes: 64,
      ...overrides,
    } as SandboxConfig,
    { getToken: async () => "token" },
  );
}

function respondWith(body: string) {
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
}

test("a text read is cut to maxOutputChars and marked truncated", async () => {
  respondWith(JSON.stringify({ content: "x".repeat(100), filename: "a.txt", sizeBytes: 100 }));
  const read = await client().fileRead({ filename: "a.txt" }, "id");
  assert.equal(read.content, "x".repeat(10));
  assert.equal(read.truncated, true);
});

test("a file too large to read whole fails with a way to read part of it", async () => {
  respondWith(JSON.stringify({ content: "x".repeat(9 * 1024 * 1024), filename: "big.log", sizeBytes: 9 * 1024 * 1024 }));
  await assert.rejects(client().fileRead({ filename: "big.log" }, "id"), /too large to read whole.*head -c/);
});

test("an export over maxExportBytes is refused", async () => {
  respondWith(JSON.stringify({ stdout: Buffer.alloc(10_000).toString("base64"), stderr: "", exitCode: 0 }));
  await assert.rejects(client().fileReadBinary({ filename: "big.bin" }, "id"), /too large for export/);
});

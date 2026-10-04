import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { hostInfo, installHost, resetHostForTests } from "./host.js";
import { isCloudRuntime } from "../utils/env.js";

const KEYS = ["WEBSITE_SITE_NAME", "WEBSITE_HOSTNAME"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  resetHostForTests();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("without an installed host, Azure App Service variables identify a production Azure host", () => {
  process.env.WEBSITE_SITE_NAME = "afe-func";
  process.env.WEBSITE_HOSTNAME = "afe-func.azurewebsites.net";
  const h = hostInfo();
  assert.equal(h.platform, "azure");
  assert.equal(h.isProductionHost, true);
  assert.equal(h.publicBaseUrl, "https://afe-func.azurewebsites.net");
  assert.equal(h.label, "azure:afe-func");
  assert.equal(isCloudRuntime(), true);
});

test("without an installed host or Azure variables, the host is local", () => {
  for (const k of KEYS) delete process.env[k];
  const h = hostInfo();
  assert.equal(h.platform, "local");
  assert.equal(h.isProductionHost, false);
  assert.equal(h.publicBaseUrl, undefined);
  assert.equal(h.label, "local");
  assert.equal(isCloudRuntime(), false);
});

test("a localhost WEBSITE_HOSTNAME (Core Tools) is served over http", () => {
  process.env.WEBSITE_HOSTNAME = "localhost:7071";
  assert.equal(hostInfo().publicBaseUrl, "http://localhost:7071");
});

test("an installed host wins over the environment", () => {
  process.env.WEBSITE_SITE_NAME = "afe-func";
  installHost({ platform: "cloudflare", isProductionHost: true, publicBaseUrl: "https://afe.example", label: "cloudflare:afe" });
  assert.equal(hostInfo().platform, "cloudflare");
  assert.equal(hostInfo().publicBaseUrl, "https://afe.example");
  assert.equal(isCloudRuntime(), true);
});

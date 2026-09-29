/**
 * Sandbox backend selection and the config that feeds it.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcaSandboxesClient } from "./aca-sandboxes-client.js";
import { DynamicSessionsClient } from "./client.js";
import { createSandboxBackend } from "./factory.js";
import { loadSkillsConfig, resetSkillsConfig } from "../config.js";
import { resetConfigCache } from "../../utils/index.js";
import type { SandboxConfig } from "./types.js";

const ENV_KEYS = [
  "CONFIG_FILE_JSON",
  "SANDBOX_PROVIDER",
  "ACA_SANDBOX_SUBSCRIPTION_ID",
  "ACA_SANDBOX_RESOURCE_GROUP",
  "ACA_SANDBOX_GROUP",
  "ACA_SANDBOX_REGION",
  "ACA_POOL_MANAGEMENT_ENDPOINT",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetSkillsConfig();
  resetConfigCache();
});

function base(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    enabled: true,
    provider: "aca-sandboxes",
    poolManagementEndpoint: "",
    containerType: "PythonLTS",
    identifierStrategy: "userId",
    defaultTimeoutSec: 60,
    maxTimeoutSec: 220,
    cooldownSec: 600,
    networkAccess: "disabled",
    maxOutputChars: 50_000,
    exportsContainerName: "user-exports",
    exportExpiryHours: 24,
    maxExportBytes: 1,
    sandboxes: {
      subscriptionId: "sub",
      resourceGroup: "rg",
      sandboxGroup: "grp",
      endpoint: "https://management.westus2.azuredevcompute.io",
      diskImage: "ubuntu",
      cpu: "1000m",
      memory: "2048Mi",
      autoSuspendSec: 300,
      suspendMode: "Disk",
      autoDeleteDays: 30,
      egressAllowHosts: [],
      defaultTimeoutSec: 120,
      maxTimeoutSec: 200,
    },
    ...overrides,
  };
}

test("factory prefers ACA Sandboxes when configured", () => {
  assert.ok(createSandboxBackend(base()) instanceof AcaSandboxesClient);
});

test("factory falls back to Dynamic Sessions when Sandboxes are not configured", () => {
  const unconfigured = base({
    poolManagementEndpoint: "https://pool.example",
    sandboxes: { ...base().sandboxes!, subscriptionId: "" },
  });
  assert.ok(createSandboxBackend(unconfigured) instanceof DynamicSessionsClient);

  const neither = base({ sandboxes: { ...base().sandboxes!, sandboxGroup: "" } });
  assert.equal(createSandboxBackend(neither), undefined);
});

test("factory honours an explicit Dynamic Sessions choice", () => {
  const backend = createSandboxBackend(
    base({ provider: "aca-sessions", poolManagementEndpoint: "https://pool.example" }),
  );
  assert.ok(backend instanceof DynamicSessionsClient);
});

function withConfigFile(skills: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), "agentforeach-cfg-"));
  const file = join(dir, "test.json");
  writeFileSync(file, JSON.stringify({ skills }));
  process.env.CONFIG_FILE_JSON = file;
  resetConfigCache();
  resetSkillsConfig();
}

const SKILLS = {
  enabled: true,
  sandbox: {
    enabled: true,
    provider: "aca-sandboxes",
    sandboxes: {
      subscriptionId: "$ACA_SANDBOX_SUBSCRIPTION_ID",
      resourceGroup: "$ACA_SANDBOX_RESOURCE_GROUP",
      sandboxGroup: "$ACA_SANDBOX_GROUP",
      region: "$ACA_SANDBOX_REGION",
    },
    aca: {
      poolManagementEndpoint: "$ACA_POOL_MANAGEMENT_ENDPOINT",
      defaultTimeoutSec: 60,
      maxTimeoutSec: 220,
    },
  },
};

test("config: $ENV values resolve and the region becomes the regional endpoint", () => {
  process.env.ACA_SANDBOX_SUBSCRIPTION_ID = "sub-9";
  process.env.ACA_SANDBOX_RESOURCE_GROUP = "rg-9";
  process.env.ACA_SANDBOX_GROUP = "grp-9";
  process.env.ACA_SANDBOX_REGION = "Central India";
  withConfigFile(SKILLS);
  const cfg = loadSkillsConfig().sandbox!;
  assert.equal(cfg.provider, "aca-sandboxes");
  assert.equal(cfg.sandboxes?.subscriptionId, "sub-9");
  assert.equal(cfg.sandboxes?.endpoint, "https://management.centralindia.azuredevcompute.io");
  assert.equal(cfg.sandboxes?.maxTimeoutSec, 200);
});

test("config: the Dynamic Sessions fallback keeps its own 220 s timeouts", () => {
  process.env.ACA_POOL_MANAGEMENT_ENDPOINT = "https://pool.example";
  withConfigFile(SKILLS);
  const cfg = loadSkillsConfig().sandbox!;
  assert.equal(cfg.poolManagementEndpoint, "https://pool.example");
  assert.equal(cfg.defaultTimeoutSec, 60);
  assert.equal(cfg.maxTimeoutSec, 220);
  assert.ok(createSandboxBackend(cfg) instanceof DynamicSessionsClient);
});

test("config: SANDBOX_PROVIDER from the IaC overrides agentforeach.json", () => {
  process.env.SANDBOX_PROVIDER = "aca-sessions";
  withConfigFile(SKILLS);
  assert.equal(loadSkillsConfig().sandbox?.provider, "aca-sessions");
});

test("config: the legacy provider name 'aca' means Dynamic Sessions", () => {
  withConfigFile({ ...SKILLS, sandbox: { ...SKILLS.sandbox, provider: "aca" } });
  assert.equal(loadSkillsConfig().sandbox?.provider, "aca-sessions");
});

/**
 * Sandbox backend selection and the config that feeds it.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcaSandboxesClient, DynamicSessionsClient } from "@agentforeach/platform-azure/sandbox";
import { createSandboxBackend } from "./factory.js";
import { getSandboxProviders, registerSandboxProvider } from "./registry.js";
import { containersSandboxOptions } from "./containers.js";
import { agentcoreSandboxOptions } from "./agentcore.js";
import type { AwsAgentCoreSandboxOptions } from "@agentforeach/platform-aws/sandbox";
import { InMemoryStorage } from "@agentforeach/storage";
import { clearWebSocketProviderCache, registerWebSocketProvider } from "../../websocket/providers/index.js";
import { resetWebSocketConfig } from "../../websocket/config.js";
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
  "AWS_SANDBOX_RUNTIME_ARN",
  "AWS_SANDBOX_SERVER_TOKEN",
  "AWS_SANDBOX_STORAGE_MODE",
  "AWS_SANDBOX_WORKSPACE_BUCKET",
  "AWS_SANDBOX_ARCHIVE_MAX_BYTES",
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

test("providers come from the registry: a pack registers its own, unknown names fail", () => {
  assert.deepEqual(getSandboxProviders().filter((p) => p.startsWith("aca")).sort(), ["aca-sandboxes", "aca-sessions"]);
  const custom = new DynamicSessionsClient(base({ provider: "aca-sessions" }));
  registerSandboxProvider("test-pack", () => custom);
  assert.equal(createSandboxBackend(base({ provider: "test-pack" })), custom);
  assert.equal(createSandboxBackend(base({ provider: "nobody", enabled: false })), undefined, "a disabled sandbox never looks");
});

test("the legacy name \"aca\" means Dynamic Sessions, in config and in the registry", () => {
  process.env.SANDBOX_PROVIDER = "aca";
  const dir = mkdtempSync(join(tmpdir(), "sandbox-provider-"));
  writeFileSync(join(dir, "c.json"), JSON.stringify({ skills: { sandbox: { enabled: true } } }));
  process.env.CONFIG_FILE_JSON = join(dir, "c.json");
  resetConfigCache();
  resetSkillsConfig();
  assert.equal(loadSkillsConfig().sandbox?.provider, "aca-sessions");
  assert.ok(createSandboxBackend(base({ provider: "aca" })) instanceof DynamicSessionsClient);
});

test("backends declare what they can do", () => {
  const tokenProvider = { getToken: async () => "t" };
  assert.deepEqual(new AcaSandboxesClient(base(), { tokenProvider }).capabilities, {
    browser: true,
    egressCredentials: true,
    persistence: "disk",
  });
  const memory = base();
  memory.sandboxes = { ...memory.sandboxes!, suspendMode: "Memory" };
  assert.equal(new AcaSandboxesClient(memory, { tokenProvider }).capabilities.persistence, "memory");
  assert.deepEqual(new DynamicSessionsClient(base({ provider: "aca-sessions" })).capabilities, {
    browser: false,
    egressCredentials: false,
    persistence: "none",
  });
});

test("Dynamic Sessions refuses proxy credentials and has nothing per user to delete", async () => {
  const sessions = new DynamicSessionsClient(base({ provider: "aca-sessions" }));
  await assert.rejects(sessions.setEgressCredentials([], "u1"), { name: "SandboxUnsupportedError" });
  assert.equal(await sessions.deleteUserSandboxes("u1"), 0);
});

test("cloudflare-containers: its settings resolve with defaults and map to the backend's options", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-containers-"));
  writeFileSync(
    join(dir, "c.json"),
    JSON.stringify({
      skills: {
        sandbox: {
          enabled: true,
          provider: "cloudflare-containers",
          networkAccess: "disabled",
          containers: { egressAllowHosts: ["pypi.org"], browser: true },
        },
      },
    }),
  );
  process.env.CONFIG_FILE_JSON = join(dir, "c.json");
  delete process.env.SANDBOX_PROVIDER;
  resetConfigCache();
  resetSkillsConfig();
  const sandbox = loadSkillsConfig().sandbox!;
  assert.equal(sandbox.provider, "cloudflare-containers");
  assert.equal(sandbox.sandboxes, undefined);
  assert.deepEqual(containersSandboxOptions(sandbox), {
    instance: "standard-2",
    autoSuspendSec: 300,
    egressAllowHosts: ["pypi.org"],
    networkAccess: "disabled",
    identifierStrategy: "userId",
    browser: true,
    defaultTimeoutSec: 120,
    maxTimeoutSec: 200,
    maxOutputChars: sandbox.maxOutputChars,
    maxExportBytes: sandbox.maxExportBytes,
  });
  assert.throws(() => containersSandboxOptions(base()), /only for provider "cloudflare-containers"/);
});

test("aws-agentcore: its settings resolve from the IaC's env vars and map to the backend's options", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-agentcore-"));
  writeFileSync(
    join(dir, "c.json"),
    JSON.stringify({
      skills: {
        sandbox: { enabled: true, provider: "aws-agentcore", identifierStrategy: "sessionId", aws: { serverToken: "$AFE_TEST_TOKEN", browser: true } },
      },
    }),
  );
  process.env.CONFIG_FILE_JSON = join(dir, "c.json");
  delete process.env.SANDBOX_PROVIDER;
  process.env.AWS_SANDBOX_RUNTIME_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/afe_sandbox-abc123";
  process.env.AWS_SANDBOX_STORAGE_MODE = "s3-checkpoint";
  process.env.AWS_SANDBOX_WORKSPACE_BUCKET = "afe-workspaces";
  process.env.AWS_SANDBOX_ARCHIVE_MAX_BYTES = "1048576";
  process.env.AFE_TEST_TOKEN = "token-from-a-secret-0123456789";
  resetConfigCache();
  resetSkillsConfig();
  try {
    const sandbox = loadSkillsConfig().sandbox!;
    assert.equal(sandbox.provider, "aws-agentcore");
    assert.equal(sandbox.sandboxes, undefined, "no ACA settings resolved for AWS");
    const options = agentcoreSandboxOptions(sandbox);
    assert.deepEqual(options, {
      runtimeArn: process.env.AWS_SANDBOX_RUNTIME_ARN,
      serverToken: "token-from-a-secret-0123456789",
      storageMode: "s3-checkpoint",
      workspaceBucket: "afe-workspaces",
      persistenceLimits: { maxBytes: 1048576, maxFiles: 10_000 },
      browser: true,
      defaultTimeoutSec: 60,
      maxTimeoutSec: 200,
      identifierStrategy: "sessionId",
      maxOutputChars: sandbox.maxOutputChars,
      maxExportBytes: sandbox.maxExportBytes,
    });
    // The pack takes these options as they are, plus the database (checked at compile time).
    const forPack: AwsAgentCoreSandboxOptions = { ...options, storage: new InMemoryStorage() };
    assert.ok(forPack);
    assert.throws(() => agentcoreSandboxOptions(base()), /only for provider "aws-agentcore"/);
  } finally {
    delete process.env.AFE_TEST_TOKEN;
  }
});

test("a backend that can't be built turns the sandbox off, with one error, instead of failing", () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    registerSandboxProvider("broken-pack", () => {
      throw new Error("no token provider on this host");
    });
    assert.equal(createSandboxBackend(base({ provider: "broken-pack" })), undefined);
    assert.equal(createSandboxBackend(base({ provider: "broken-pack" })), undefined);
    assert.equal(errors.length, 1, "logged once, not on every turn");
    assert.match(errors[0], /provider "broken-pack" could not be created, so sandbox tools are off: no token provider on this host/);

    assert.equal(createSandboxBackend(base({ provider: "nobody" })), undefined);
    assert.match(errors[1], /provider "nobody" could not be created.*Unknown sandbox provider "nobody" \(registered: .*aca-sandboxes/);
  } finally {
    console.error = original;
  }
});

test("the handoff relay: the containers backend allows only its path, ACA the relay host (review S-L3)", () => {
  // A realtime provider whose relay lives on the gateway's own host, as on Cloudflare.
  registerWebSocketProvider("test-own-relay", () => ({ id: "test-own-relay" }) as never, {
    capabilities: () => ({ push: true, relay: true }),
    relayHost: () => "gw.example.workers.dev",
    relayPath: () => "/realtime/relay",
  });
  const savedProvider = process.env.WEBSOCKET_PROVIDER;
  const savedWps = process.env.WEBPUBSUB_CONNECTION_STRING;
  process.env.WEBSOCKET_PROVIDER = "test-own-relay";
  delete process.env.WEBPUBSUB_CONNECTION_STRING;
  delete process.env.SANDBOX_PROVIDER;
  resetWebSocketConfig();
  clearWebSocketProviderCache();
  const load = (sandbox: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-relay-"));
    const handoff = { enabled: true, handoff: { enabled: true } };
    writeFileSync(join(dir, "c.json"), JSON.stringify({ skills: { sandbox: { enabled: true, browser: handoff, ...sandbox } } }));
    process.env.CONFIG_FILE_JSON = join(dir, "c.json");
    resetConfigCache();
    resetSkillsConfig();
    return loadSkillsConfig().sandbox!;
  };
  try {
    const containers = load({ provider: "cloudflare-containers", containers: { egressAllowHosts: ["pypi.org"] } });
    assert.deepEqual(containers.containers?.egressAllowHosts, ["pypi.org", "gw.example.workers.dev/realtime/relay"]);
    const aca = load({ provider: "aca-sandboxes", sandboxes: { subscriptionId: "s", resourceGroup: "r", sandboxGroup: "g", region: "westus2" } });
    assert.deepEqual(aca.sandboxes?.egressAllowHosts, ["gw.example.workers.dev"], "ACA's rules match hosts only");
  } finally {
    if (savedProvider === undefined) delete process.env.WEBSOCKET_PROVIDER;
    else process.env.WEBSOCKET_PROVIDER = savedProvider;
    if (savedWps !== undefined) process.env.WEBPUBSUB_CONNECTION_STRING = savedWps;
    resetWebSocketConfig();
    clearWebSocketProviderCache();
  }
});

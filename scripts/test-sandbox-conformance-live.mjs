#!/usr/bin/env node
/**
 * The sandbox conformance suite (@agentforeach/platform/sandbox/conformance)
 * against a real backend. CI runs it only against the sandbox server on the
 * local machine, which has no egress proxy and no sleep; this is the live run.
 *
 *   node scripts/test-sandbox-conformance-live.mjs <backend>
 *
 * Needs the packages built: `npm run build --workspace @agentforeach/gateway`.
 * Every backend creates real sandboxes for a throwaway user and deletes them
 * at the end (the suite's last check, then its cleanup).
 *
 * aca-sandboxes: ACA Sandboxes, with sleep (POST /stop) and egress checks.
 *   ACA_SANDBOX_SUBSCRIPTION_ID, ACA_SANDBOX_RESOURCE_GROUP, ACA_SANDBOX_GROUP,
 *   ACA_SANDBOX_REGION (or ACA_SANDBOX_ENDPOINT); optional ACA_SANDBOX_DISK_IMAGE_ID.
 *   Signed in with `az login` (or AZURE_SANDBOX_TOKEN), with the "Container
 *   Apps SandboxGroup Data Owner" role on the group. One 1 vCPU / 2 GiB sandbox.
 *
 * aca-sessions: ACA Dynamic Sessions (keeps nothing, no egress proxy: those
 *   checks skip). ACA_POOL_MANAGEMENT_ENDPOINT; optional
 *   ACA_POOL_CONTAINER_TYPE (CustomContainer, the default, or PythonLTS).
 *
 * cloudflare-containers: the real backend inside a test Worker
 *   (scripts/test-fixtures/cloudflare-sandbox-worker, see its README).
 *   CF_SANDBOX_TEST_URL (the Worker's URL), CF_SANDBOX_TEST_TOKEN (its API_TOKEN secret).
 *
 * aws-agentcore: a Bedrock AgentCore Runtime running the sandbox image
 *   (docs/AWS-Sandbox.md), through the AWS credential chain (it needs
 *   bedrock-agentcore:InvokeAgentRuntime and StopRuntimeSession, and in
 *   s3-checkpoint mode the workspace bucket's s3:GetBucketVersioning,
 *   GetObject and PutObject). AWS_SANDBOX_RUNTIME_ARN, AWS_SANDBOX_SERVER_TOKEN;
 *   optional AWS_SANDBOX_QUALIFIER, AWS_SANDBOX_STORAGE_MODE (ephemeral, the
 *   default, or s3-checkpoint with AWS_SANDBOX_WORKSPACE_BUCKET and
 *   AWS_SANDBOX_ARCHIVE_MAX_BYTES / _FILES equal to the runtime's). Session
 *   records are kept in memory. In s3-checkpoint mode, sleep stops the
 *   sessions, so the next call restores from S3; no egress proxy, so those
 *   checks skip. Billable: run it only when you mean to.
 *
 * Common: SANDBOX_ECHO_HOST (default postman-echo.com; must echo
 * /headers and be unreachable until a credential names it),
 * SANDBOX_BLOCKED_URL (default https://example.com), SANDBOX_TIMEOUT_MS.
 */

import { fileURLToPath } from "node:url";

import { encodeSandboxIdentifier } from "../packages/platform/dist/index.js";
import { runSandboxConformance } from "../packages/platform/dist/sandbox/conformance.js";

const backendName = process.argv[2];
const env = (key) => {
  const value = process.env[key];
  if (!value) {
    console.error(`Missing ${key} (see the header of ${fileURLToPath(import.meta.url)})`);
    process.exit(2);
  }
  return value;
};
const egress = {
  echoHost: process.env.SANDBOX_ECHO_HOST ?? "postman-echo.com",
  blockedUrl: process.env.SANDBOX_BLOCKED_URL ?? "https://example.com",
};
const timeoutMs = Number(process.env.SANDBOX_TIMEOUT_MS ?? 300_000);
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The resolved sandbox config the gateway would build (the fields the clients read). */
function sandboxConfig(extra) {
  return {
    enabled: true,
    identifierStrategy: "userId",
    networkAccess: "disabled",
    maxOutputChars: 50_000,
    maxExportBytes: 50 * 1024 * 1024,
    defaultTimeoutSec: 60,
    maxTimeoutSec: 200,
    ...extra,
  };
}

async function acaSandboxes() {
  const { AcaSandboxesClient, ACA_SANDBOXES_API_VERSION, labelHash } = await import(
    "../packages/platform-azure/dist/sandbox/aca-sandboxes-client.js"
  );
  const { createDefaultTokenProvider } = await import("../packages/platform-azure/dist/identity.js");
  const region = process.env.ACA_SANDBOX_REGION?.toLowerCase().replace(/\s+/g, "");
  const endpoint = process.env.ACA_SANDBOX_ENDPOINT ?? `https://management.${region ?? env("ACA_SANDBOX_REGION")}.azuredevcompute.io`;
  const sandboxes = {
    subscriptionId: env("ACA_SANDBOX_SUBSCRIPTION_ID"),
    resourceGroup: env("ACA_SANDBOX_RESOURCE_GROUP"),
    sandboxGroup: env("ACA_SANDBOX_GROUP"),
    endpoint,
    diskImage: process.env.ACA_SANDBOX_DISK_IMAGE ?? "ubuntu",
    diskImageId: process.env.ACA_SANDBOX_DISK_IMAGE_ID,
    cpu: "1000m",
    memory: "2048Mi",
    autoSuspendSec: 300,
    suspendMode: "Disk",
    autoDeleteDays: 1,
    // Not the echo host: the egress check needs it closed until a credential opens it.
    egressAllowHosts: [],
    defaultTimeoutSec: 120,
    maxTimeoutSec: 200,
  };
  const tokens = createDefaultTokenProvider();
  const base = `${endpoint}/subscriptions/${sandboxes.subscriptionId}/resourceGroups/${sandboxes.resourceGroup}/sandboxGroups/${sandboxes.sandboxGroup}`;
  const call = async (method, path) => {
    const url = new URL(`${base}${path}`);
    url.searchParams.set("api-version", ACA_SANDBOXES_API_VERSION);
    const response = await fetch(url, { method, headers: { authorization: `Bearer ${await tokens.getToken()}` } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : undefined;
  };
  return {
    createBackend: () => new AcaSandboxesClient(sandboxConfig({ sandboxes }), { tokenProvider: tokens }),
    // Stop the identifier's sandbox (found by its owner label) and wait until it is stopped.
    sleep: async (_backend, identifier) => {
      const listed = await call("GET", `/sandboxes?labels=${encodeURIComponent(`agentforeach-owner=${labelHash(identifier)}`)}`);
      // The data plane answers with a bare array (the client's listByLabel takes either).
      const sandbox = (Array.isArray(listed) ? listed : listed?.value)?.[0];
      if (!sandbox) throw new Error("no sandbox to stop");
      await call("POST", `/sandboxes/${sandbox.id}/stop`);
      for (const deadline = Date.now() + 180_000; Date.now() < deadline; await sleepMs(2000)) {
        if (/^(stopped|suspended)/i.test((await call("GET", `/sandboxes/${sandbox.id}`))?.state ?? "")) return;
      }
      throw new Error("the sandbox never stopped");
    },
    egress,
  };
}

async function acaSessions() {
  const { DynamicSessionsClient } = await import("../packages/platform-azure/dist/sandbox/dynamic-sessions-client.js");
  const config = sandboxConfig({
    poolManagementEndpoint: env("ACA_POOL_MANAGEMENT_ENDPOINT"),
    containerType: process.env.ACA_POOL_CONTAINER_TYPE ?? "CustomContainer",
  });
  return { createBackend: () => new DynamicSessionsClient(config), egress };
}

async function cloudflareContainers() {
  const url = env("CF_SANDBOX_TEST_URL").replace(/\/$/, "");
  // The bearer token runs any command in the Worker's sandboxes: never send it in clear.
  const target = new URL(url);
  if (target.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
    console.error(`CF_SANDBOX_TEST_URL must be https:// (got ${target.protocol}//${target.host}); only localhost may use http`);
    process.exit(2);
  }
  const token = env("CF_SANDBOX_TEST_TOKEN");
  const rpc = async (method, ...args) => {
    const response = await fetch(`${url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method, args }),
    });
    if (!response.ok) throw new Error(`test Worker: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    const body = await response.json();
    if (!body.ok) {
      const err = new Error(body.error);
      err.name = body.name;
      throw err;
    }
    return body.result;
  };
  const capabilities = await rpc("capabilities");
  const backend = {
    capabilities,
    exec: (args, id) => rpc("exec", args, id),
    fileWrite: (args, id) => rpc("fileWrite", args, id),
    fileRead: (args, id) => rpc("fileRead", args, id),
    fileList: (id) => rpc("fileList", id),
    fileReadBinary: (args, id) => rpc("fileReadBinary", args, id),
    setEnv: (vars, id) => rpc("setEnv", vars, id),
    setEgressCredentials: (credentials, id) => rpc("setEgressCredentials", credentials, id),
    deleteUserSandboxes: (userId) => rpc("deleteUserSandboxes", userId),
    // The test Worker uses the default strategy, one sandbox per user.
    resolveIdentifier: (userId) => encodeSandboxIdentifier(userId),
    isReady: () => true,
  };
  return {
    createBackend: () => backend,
    sleep: async (_backend, identifier) => {
      await rpc("suspend", identifier);
    },
    egress,
  };
}

async function awsAgentCore() {
  const { InMemoryStorage } = await import("../packages/storage/dist/index.js");
  const { BedrockAgentCoreClient } = await import("@aws-sdk/client-bedrock-agentcore");
  const { AgentCoreTransport, AwsAgentCoreSandbox, AwsSessionStore, sandboxKey } = await import(
    "../packages/platform-aws/dist/sandbox/index.js"
  );
  const runtimeArn = env("AWS_SANDBOX_RUNTIME_ARN");
  const serverToken = env("AWS_SANDBOX_SERVER_TOKEN");
  const qualifier = process.env.AWS_SANDBOX_QUALIFIER || undefined;
  const storageMode = process.env.AWS_SANDBOX_STORAGE_MODE || "ephemeral";
  const checkpoint = storageMode === "s3-checkpoint";
  const storage = new InMemoryStorage();
  // No SDK retries: an ambiguous failure must not run a command twice.
  const agentCore = new BedrockAgentCoreClient({ region: runtimeArn.split(":")[3], maxAttempts: 1 });
  const backend = new AwsAgentCoreSandbox({
    runtimeArn,
    qualifier,
    serverToken,
    storageMode,
    storage,
    agentCore,
    ...(checkpoint
      ? {
          workspaceBucket: env("AWS_SANDBOX_WORKSPACE_BUCKET"),
          persistenceLimits: {
            maxBytes: Number(env("AWS_SANDBOX_ARCHIVE_MAX_BYTES")),
            maxFiles: Number(env("AWS_SANDBOX_ARCHIVE_MAX_FILES")),
          },
        }
      : {}),
  });
  const sessions = new AwsSessionStore(storage);
  const stopper = new AgentCoreTransport({ client: agentCore, runtimeArn, qualifier, token: serverToken, maxResponseBytes: 1 });
  return {
    createBackend: () => backend,
    // Checkpoint mode: end the runtime sessions, as an idle timeout does; the next call restores from S3.
    ...(checkpoint
      ? {
          sleep: async (_backend, identifier) => {
            for (const record of await sessions.list(sandboxKey(identifier).owner)) await stopper.stop(record.sessionId, record.qualifier);
          },
        }
      : {}),
    egress,
  };
}

const backends = {
  "aca-sandboxes": acaSandboxes,
  "aca-sessions": acaSessions,
  "cloudflare-containers": cloudflareContainers,
  "aws-agentcore": awsAgentCore,
};
if (!backends[backendName]) {
  console.error(`Usage: node scripts/test-sandbox-conformance-live.mjs <${Object.keys(backends).join("|")}>`);
  process.exit(2);
}
const options = await backends[backendName]();
runSandboxConformance({ name: `${backendName} (live)`, timeoutMs, ...options });

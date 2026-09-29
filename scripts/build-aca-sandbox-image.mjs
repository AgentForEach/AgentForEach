#!/usr/bin/env node
/**
 * Build AgentForEach's ACA Sandboxes disk image, with no container registry.
 *
 * Starts a build sandbox from the public "ubuntu" image with egress open,
 * runs packages/gateway/sandbox-container/provision-aca.sh in it, commits
 * the sandbox to a private disk image in the group, waits until the image is
 * Ready, checks it by booting a sandbox from it, and cleans up.
 *
 * The verification boot uses the same size as production, so an image too big
 * for AgentForEach's default sandboxes fails here rather than in production.
 *
 * Prints the disk image id: set it as `skills.sandbox.sandboxes.diskImageId`
 * (or the ACA_SANDBOX_DISK_IMAGE_ID app setting / Pulumi sandboxDiskImageId).
 *
 * Usage (same env as scripts/test-aca-sandboxes-live.mjs):
 *   ACA_SANDBOX_SUBSCRIPTION_ID=... ACA_SANDBOX_RESOURCE_GROUP=... \
 *   ACA_SANDBOX_GROUP=... ACA_SANDBOX_REGION=... \
 *   [SANDBOX_IMAGE_FULL=1] node scripts/build-aca-sandbox-image.mjs
 */

import { readFileSync } from "node:fs";
import {
  AcaSandboxesClient,
  ACA_SANDBOXES_API_VERSION,
  labelHash,
} from "../packages/gateway/dist/gateway/skills/sandbox/aca-sandboxes-client.js";
import { createDefaultTokenProvider } from "../packages/gateway/dist/gateway/utils/azure-token.js";

const env = (k) => {
  if (!process.env[k]) {
    console.error(`Missing ${k}`);
    process.exit(2);
  }
  return process.env[k];
};
const region = env("ACA_SANDBOX_REGION").toLowerCase().replace(/\s+/g, "");
const endpoint = `https://management.${region}.azuredevcompute.io`;
const group = {
  subscriptionId: env("ACA_SANDBOX_SUBSCRIPTION_ID"),
  resourceGroup: env("ACA_SANDBOX_RESOURCE_GROUP"),
  sandboxGroup: env("ACA_SANDBOX_GROUP"),
};
const base = `${endpoint}/subscriptions/${group.subscriptionId}/resourceGroups/${group.resourceGroup}/sandboxGroups/${group.sandboxGroup}`;
const tokens = createDefaultTokenProvider();

// The image inherits the build sandbox's disk size, and sandboxes can't use
// an image larger than their own disk. Build on the production size (1 vCPU,
// 2 GiB, 20 GiB disk) so the image fits AgentForEach's default sandboxes.
const CPU = process.env.ACA_SANDBOX_CPU ?? "1000m";
const MEMORY = process.env.ACA_SANDBOX_MEMORY ?? "2048Mi";
const DISK = process.env.ACA_SANDBOX_DISK;

function clientFor({ networkAccess, diskImageId }) {
  return new AcaSandboxesClient(
    {
      enabled: true,
      provider: "aca-sandboxes",
      identifierStrategy: "userId",
      networkAccess,
      maxOutputChars: 200_000,
      poolManagementEndpoint: "",
      containerType: "PythonLTS",
      defaultTimeoutSec: 60,
      maxTimeoutSec: 220,
      cooldownSec: 600,
      exportsContainerName: "",
      exportExpiryHours: 1,
      maxExportBytes: 1,
      sandboxes: {
        ...group,
        endpoint,
        diskImage: "ubuntu",
        diskImageId,
        cpu: CPU,
        memory: MEMORY,
        disk: DISK,
        autoSuspendSec: 600,
        suspendMode: "Disk",
        autoDeleteDays: 1,
        egressAllowHosts: [],
        defaultTimeoutSec: 200,
        maxTimeoutSec: 200,
      },
    },
    { tokenProvider: tokens },
  );
}

async function call(method, path, body) {
  const url = new URL(`${base}${path}`);
  url.searchParams.set("api-version", ACA_SANDBOXES_API_VERSION);
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await tokens.getToken()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${method} ${path}: ${resp.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const name = `agentforeach-sandbox-${new Date().toISOString().slice(0, 10)}`;
const builderId = `image-builder-${Date.now()}`;
const builder = clientFor({ networkAccess: "enabled" });
const ident = builder.resolveIdentifier(builderId);
let imageId;

try {
  console.log("Provisioning build sandbox…");
  const script = readFileSync(new URL("../packages/gateway/sandbox-container/provision-aca.sh", import.meta.url), "utf8");
  await builder.fileWrite({ filename: "provision-aca.sh", content: script }, ident);
  const full = process.env.SANDBOX_IMAGE_FULL === "1" ? "SANDBOX_IMAGE_FULL=1 " : "";
  // apt can take a while; run in the background and poll so no single call nears the HTTP limit.
  await builder.exec({ command: `${full}nohup bash provision-aca.sh > provision.log 2>&1; echo $? > provision.exit &` }, ident);
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    const done = await builder.exec({ command: "cat provision.exit 2>/dev/null || echo running" }, ident);
    const status = done.stdout.trim();
    if (status === "running") {
      process.stdout.write(".");
      continue;
    }
    const log = await builder.exec({ command: "tail -20 provision.log" }, ident);
    console.log(`\n${log.stdout}`);
    if (status !== "0") throw new Error(`provisioning failed (exit ${status})`);
    break;
  }
  await builder.exec({ command: "rm -f /mnt/data/provision-aca.sh /mnt/data/provision.log /mnt/data/provision.exit" }, ident);

  const owned = await call("GET", `/sandboxes?labels=${encodeURIComponent(`agentforeach-user=${labelHash(builderId)}`)}`);
  const builderSandbox = (Array.isArray(owned) ? owned : owned.value)[0];
  if (!builderSandbox?.id) throw new Error("could not find the build sandbox");

  console.log(`Committing ${builderSandbox.id} as disk image "${name}"…`);
  const committed = await call("POST", `/sandboxes/${builderSandbox.id}/commit`, { labels: { name } });
  const image = committed.diskImage ?? committed;
  imageId = image.id ?? image.diskImageId;
  if (!imageId) throw new Error(`commit returned no image id: ${JSON.stringify(committed).slice(0, 300)}`);

  const started = Date.now();
  for (;;) {
    const img = await call("GET", `/diskimages/${imageId}`);
    const state = img.status?.state;
    if (state === "Ready" || state === "Succeeded") break;
    if (state === "Failed") throw new Error(`image build failed: ${img.status?.errorMessage}`);
    if (Date.now() - started > 20 * 60_000) throw new Error(`image not ready after 20 min (${state})`);
    process.stdout.write(`[${state}]`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`\nImage ready in ${Math.round((Date.now() - started) / 1000)} s`);
} finally {
  await builder.deleteUserSandboxes(builderId).catch((e) => console.warn(`cleanup: ${e.message}`));
}

console.log("Verifying: boot a sandbox from the image with the default deny egress…");
const verifyUser = `image-verify-${Date.now()}`;
const verifier = clientFor({ networkAccess: "disabled", diskImageId: imageId });
try {
  const r = await verifier.exec(
    { command: "for b in python3 pip3 node npm git jq unzip gcc; do printf '%s=' $b; command -v $b >/dev/null && echo ok || echo MISSING; done" },
    verifier.resolveIdentifier(verifyUser),
  );
  console.log(r.stdout);
  if (r.stdout.includes("MISSING")) throw new Error("image is missing tools");
} finally {
  await verifier.deleteUserSandboxes(verifyUser).catch(() => {});
}

console.log(`\nDisk image id: ${imageId}`);
console.log(`Set skills.sandbox.sandboxes.diskImageId (or ACA_SANDBOX_DISK_IMAGE_ID) to it.`);

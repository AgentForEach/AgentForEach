#!/usr/bin/env node
/**
 * Live test of the ACA Sandboxes backend against a real sandbox group.
 *
 * Exercises the real client (create, exec, files, env, timeouts, egress,
 * suspend/resume, delete) and prints the raw wire responses the client
 * depends on, so contract drift in the preview API is easy to spot.
 *
 * Prerequisites:
 *   - a sandbox group, and the "Container Apps SandboxGroup Data Owner" role
 *     for the signed-in identity on it
 *   - `az login` (or AZURE_SANDBOX_TOKEN)
 *   - `npm run build --workspace @agentforeach/gateway`
 *
 * Usage:
 *   ACA_SANDBOX_SUBSCRIPTION_ID=... ACA_SANDBOX_RESOURCE_GROUP=... \
 *   ACA_SANDBOX_GROUP=... ACA_SANDBOX_REGION=centralindia \
 *   node scripts/test-aca-sandboxes-live.mjs
 *
 * Creates one sandbox (1 vCPU / 2 GiB) and deletes it at the end.
 */

import { AcaSandboxesClient, ACA_SANDBOXES_API_VERSION, labelHash } from "../packages/platform-azure/dist/sandbox/aca-sandboxes-client.js";
import { createDefaultTokenProvider } from "../packages/platform-azure/dist/identity.js";

const env = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing ${k}`);
    process.exit(2);
  }
  return v;
};

const region = env("ACA_SANDBOX_REGION").toLowerCase().replace(/\s+/g, "");
const endpoint = `https://management.${region}.azuredevcompute.io`;
const sandboxes = {
  subscriptionId: env("ACA_SANDBOX_SUBSCRIPTION_ID"),
  resourceGroup: env("ACA_SANDBOX_RESOURCE_GROUP"),
  sandboxGroup: env("ACA_SANDBOX_GROUP"),
  endpoint,
  diskImage: process.env.ACA_SANDBOX_DISK_IMAGE ?? "ubuntu",
  diskImageId: process.env.ACA_SANDBOX_DISK_IMAGE_ID,
  cpu: "1000m",
  memory: "2048Mi",
  disk: process.env.ACA_SANDBOX_DISK,
  // Short so the auto-suspend step finishes quickly; production default is 300.
  autoSuspendSec: Number(process.env.ACA_SANDBOX_AUTOSUSPEND_SEC ?? 60),
  suspendMode: process.env.ACA_SANDBOX_SUSPEND_MODE ?? "Disk",
  autoDeleteDays: 1,
  egressAllowHosts: [],
  defaultTimeoutSec: 60,
  maxTimeoutSec: 200,
};
const config = {
  enabled: true,
  provider: "aca-sandboxes",
  sandboxes,
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
};

const tokens = createDefaultTokenProvider();
const base = `${endpoint}/subscriptions/${sandboxes.subscriptionId}/resourceGroups/${sandboxes.resourceGroup}/sandboxGroups/${sandboxes.sandboxGroup}`;

/** Raw data-plane call, for inspecting wire shapes. */
async function raw(method, path, body) {
  const url = new URL(`${base}${path}`);
  if (!url.searchParams.has("api-version")) url.searchParams.set("api-version", ACA_SANDBOXES_API_VERSION);
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await tokens.getToken()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: resp.status, json };
}

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ name, ok: true, ms });
    console.log(`\n✔ ${name} (${ms} ms)`);
    if (detail !== undefined) console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  } catch (err) {
    const ms = Date.now() - started;
    results.push({ name, ok: false, ms, error: err.message });
    console.log(`\n✖ ${name} (${ms} ms)\n  ${err.message}`);
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const userId = `live-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const client = new AcaSandboxesClient(config, { tokenProvider: tokens });
const identifier = client.resolveIdentifier(userId);
let sandboxId;

try {
  await step("create on first exec + inspect image", async () => {
    const r = await client.exec(
      {
        command:
          'echo hello; id -u; echo "HOME=$HOME"; head -2 /etc/os-release; ' +
          "for b in bash timeout base64 unzip python3 pip3 node curl; do printf '%s=' $b; command -v $b || echo MISSING; done",
      },
      identifier,
    );
    expect(r.exitCode === 0, `exit ${r.exitCode}: ${r.stderr}`);
    expect(r.stdout.startsWith("hello"), "unexpected stdout");
    return r.stdout;
  });

  await step("list by owner label: labels and createdAt present", async () => {
    const r = await raw("GET", `/sandboxes?labels=${encodeURIComponent(`agentforeach-owner=${labelHash(identifier)}`)}`);
    expect(r.status === 200, `status ${r.status}`);
    const items = Array.isArray(r.json) ? r.json : r.json.value;
    expect(items?.length === 1, `expected 1 sandbox, got ${items?.length}`);
    sandboxId = items[0].id;
    expect(items[0].labels?.["agentforeach-owner"] === labelHash(identifier), "owner label missing in list");
    return { shape: Array.isArray(r.json) ? "array" : Object.keys(r.json), item: items[0] };
  });

  await step("label filter excludes other owners", async () => {
    const r = await raw("GET", `/sandboxes?labels=${encodeURIComponent("agentforeach-owner=does-not-exist")}`);
    const items = Array.isArray(r.json) ? r.json : r.json.value;
    expect(items.length === 0, `filter ignored: got ${items.length} sandboxes`);
  });

  await step("GET sandbox: labels, both lifecycle policies, egress", async () => {
    const r = await raw("GET", `/sandboxes/${sandboxId}`);
    expect(r.status === 200, `status ${r.status}`);
    const { state, stateDetails, labels, lifecycle, egressPolicy } = r.json;
    expect(labels?.["agentforeach-owner"], "labels missing on GET");
    expect(lifecycle?.autoSuspendPolicy?.enabled, "autoSuspendPolicy missing: sandbox would never suspend");
    expect(lifecycle?.autoDeletePolicy?.enabled, "autoDeletePolicy missing");
    return { state, stateDetails, lifecycle, egressPolicy };
  });

  await step("exec: exitCode on failure and success", async () => {
    const fail = await client.exec({ command: "exit 3" }, identifier);
    expect(fail.exitCode === 3, `expected 3, got ${fail.exitCode}`);
    const raw0 = await raw("POST", `/sandboxes/${sandboxId}/executeShellCommand`, { command: "true" });
    return { failExit: fail.exitCode, rawSuccessBody: raw0.json };
  });

  await step("exec: in-sandbox timeout reports timedOut", async () => {
    const r = await client.exec({ command: "sleep 30", timeout: 3 }, identifier);
    expect(r.timedOut, `not timed out: exit ${r.exitCode}`);
    return { exitCode: r.exitCode, durationMs: r.durationMs };
  });

  await step("exec: quoting survives the wrapper", async () => {
    // Single-quoted in the user's command, so nothing may be expanded.
    const tricky = `printf '%s|' "a'b" 'c"d' '$HOME' '\`x\`' 'back\\slash'`;
    const r = await client.exec({ command: tricky }, identifier);
    expect(r.stdout === `a'b|c"d|$HOME|\`x\`|back\\slash|`, `got ${JSON.stringify(r.stdout)}`);
  });

  await step("files: write, list, read, binary read, missing file", async () => {
    await client.fileWrite({ filename: "notes.txt", content: "héllo sandbox" }, identifier);
    await client.fileWrite({ filename: "sub/dir/deep.txt", content: "deep" }, identifier);
    const list = await client.fileList(identifier);
    expect(list.some((f) => f.filename === "notes.txt"), `list: ${JSON.stringify(list)}`);
    expect(!list.some((f) => f.filename === "sub"), "directories must not be listed as files");
    expect(list.every((f) => f.lastModified), "lastModified missing");
    const read = await client.fileRead({ filename: "notes.txt" }, identifier);
    expect(read.content === "héllo sandbox", `read: ${read.content}`);
    const bin = await client.fileReadBinary({ filename: "notes.txt" }, identifier);
    expect(Buffer.from(bin.contentBase64, "base64").toString() === "héllo sandbox", "binary mismatch");
    const shell = await client.exec({ command: "cat notes.txt sub/dir/deep.txt" }, identifier);
    expect(shell.stdout === "héllo sandboxdeep", `exec sees: ${shell.stdout}`);
    let missing;
    try {
      await client.fileRead({ filename: "nope.txt" }, identifier);
    } catch (e) {
      missing = e.message;
    }
    expect(missing && /404/.test(missing), `missing file: ${missing}`);
    return { list, missing };
  });

  await step("setEnv: values reach commands; empty env clears them", async () => {
    await client.setEnv({ API_KEY: "s3cr'et value" }, identifier);
    const r = await client.exec({ command: 'printf %s "$API_KEY"' }, identifier);
    expect(r.stdout === "s3cr'et value", `got ${r.stdout}`);
    await client.setEnv({}, identifier);
    const r2 = await client.exec({ command: 'printf %s "${API_KEY:-unset}"' }, identifier);
    expect(r2.stdout === "unset", `still set: ${r2.stdout}`);
    await client.setEnv({ API_KEY: "persisted" }, identifier);
  });

  await step("egress: HTTPS and raw TCP blocked (deny + Full inspection)", async () => {
    const r = await client.exec(
      {
        command:
          "(command -v curl >/dev/null && curl -sS -m 8 -o /dev/null -w 'http=%{http_code}' https://example.com || echo http=blocked); " +
          "echo; (timeout 6 bash -c 'echo > /dev/tcp/1.1.1.1/53' && echo tcp=open || echo tcp=blocked)",
      },
      identifier,
    );
    return `${r.stdout}\n${r.stderr}`.trim();
  });

  await step("credential injection: secret added by the egress proxy, never in the sandbox", async () => {
    // An echo service shows the headers the upstream actually received.
    const echoHost = process.env.ACA_SANDBOX_ECHO_HOST ?? "postman-echo.com";
    await client.setEgressCredentials(
      [{ key: "ECHO_TOKEN", hosts: [echoHost], header: "Authorization", value: "Bearer live-secret-42" }],
      identifier,
    );
    // Keep API_KEY: a later step checks it survives suspend/resume.
    await client.setEnv({ ECHO_TOKEN: "injected-by-egress-proxy", API_KEY: "persisted" }, identifier);
    const r = await client.exec(
      {
        command:
          `echo "env=$ECHO_TOKEN"; ` +
          `curl -sS -m 15 -H "Authorization: Bearer $ECHO_TOKEN" https://${echoHost}/headers; echo; ` +
          `grep -rsl "live-secret-42" /root /home /tmp /mnt /etc /var/tmp 2>/dev/null | head -1 || true`,
      },
      identifier,
    );
    expect(r.stdout.includes("env=injected-by-egress-proxy"), `env: ${r.stdout}`);
    expect(r.stdout.includes('"authorization":"Bearer live-secret-42"'), `upstream did not get the secret: ${r.stdout}`);
    const lines = r.stdout.trim().split("\n");
    expect(!lines.at(-1)?.startsWith("/"), `secret found on disk at ${lines.at(-1)}`);
    // Clearing the credentials removes the rule again.
    await client.setEgressCredentials([], identifier);
    const after = await client.exec(
      { command: `curl -sS -m 8 -o /dev/null -w '%{http_code}' https://${echoHost}/headers` },
      identifier,
    );
    expect(after.stdout === "403", `host still reachable after clearing: ${after.stdout}`);
    return "upstream received the secret; env held only the placeholder; cleared rule blocks the host again";
  });

  await step("suspend via /stop, observe states", async () => {
    const stop = await raw("POST", `/sandboxes/${sandboxId}/stop`);
    const seen = [];
    const deadline = Date.now() + 120_000;
    for (;;) {
      const g = await raw("GET", `/sandboxes/${sandboxId}`);
      const s = `${g.json?.state}${g.json?.stateDetails?.stoppedReason ? `/${g.json.stateDetails.stoppedReason}` : ""}`;
      if (seen.at(-1) !== s) seen.push(s);
      if (/^(stopped|suspended)/i.test(g.json?.state ?? "")) break;
      if (Date.now() > deadline) throw new Error(`never stopped: ${seen.join(" → ")}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { stopStatus: stop.status, states: seen.join(" → ") };
  });

  await step("raw exec against a stopped sandbox (auto-resume or error?)", async () => {
    const r = await raw("POST", `/sandboxes/${sandboxId}/executeShellCommand`, { command: "echo alive" });
    const g = await raw("GET", `/sandboxes/${sandboxId}`);
    return { execStatus: r.status, execBody: r.json, stateAfter: g.json?.state };
  });

  await step("resume through a fresh client: files and env survived", async () => {
    // Make sure it is stopped again before measuring resume.
    let g = await raw("GET", `/sandboxes/${sandboxId}`);
    if (!/^(stopped|suspended)/i.test(g.json?.state ?? "")) {
      await raw("POST", `/sandboxes/${sandboxId}/stop`);
      for (let i = 0; i < 120; i++) {
        g = await raw("GET", `/sandboxes/${sandboxId}`);
        if (/^(stopped|suspended)/i.test(g.json?.state ?? "")) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const fresh = new AcaSandboxesClient(config, { tokenProvider: tokens });
    const t = Date.now();
    const r = await fresh.exec({ command: 'cat notes.txt; echo; printf %s "$API_KEY"' }, identifier);
    const resumeMs = Date.now() - t;
    expect(r.stdout === "héllo sandbox\npersisted", `after resume: ${JSON.stringify(r.stdout)}`);
    return { resumeAndExecMs: resumeMs, suspendMode: sandboxes.suspendMode };
  });

  await step("auto-suspend fires after the idle interval; resume keeps files", async () => {
    await client.exec({ command: "nohup sleep 3600 >/dev/null 2>&1 & echo $! > pid" }, identifier);
    const t0 = Date.now();
    let state;
    for (;;) {
      const g = await raw("GET", `/sandboxes/${sandboxId}`);
      state = `${g.json?.state}/${g.json?.stateDetails?.stoppedReason ?? ""}`;
      if (/^(stopped|suspended)/i.test(g.json?.state ?? "")) break;
      if (Date.now() - t0 > (sandboxes.autoSuspendSec + 120) * 1000) {
        throw new Error(`still ${state} after ${Math.round((Date.now() - t0) / 1000)} s`);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    const suspendedAfterSec = Math.round((Date.now() - t0) / 1000);
    const fresh = new AcaSandboxesClient(config, { tokenProvider: tokens });
    const t = Date.now();
    const r = await fresh.exec(
      { command: 'cat notes.txt; echo; kill -0 "$(cat pid)" 2>/dev/null && echo process=alive || echo process=gone' },
      identifier,
    );
    expect(r.stdout.startsWith("héllo sandbox"), `files lost: ${r.stdout}`);
    return {
      state,
      suspendedAfterSec,
      resumeAndExecMs: Date.now() - t,
      suspendMode: sandboxes.suspendMode,
      backgroundProcess: r.stdout.trim().split("\n").at(-1),
    };
  });

  await step("same client after an out-of-band stop", async () => {
    await raw("POST", `/sandboxes/${sandboxId}/stop`);
    for (let i = 0; i < 120; i++) {
      const g = await raw("GET", `/sandboxes/${sandboxId}`);
      if (/^(stopped|suspended)/i.test(g.json?.state ?? "")) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // This client believes the sandbox is running (used seconds ago).
    const r = await client.exec({ command: "echo back" }, identifier);
    expect(r.stdout.trim() === "back", `got ${r.stdout}`);
  });
} finally {
  await step("deleteUserSandboxes, then GET is 404", async () => {
    const n = await client.deleteUserSandboxes(userId);
    let status;
    for (let i = 0; i < 60; i++) {
      status = (await raw("GET", `/sandboxes/${sandboxId}`)).status;
      if (status === 404) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(status === 404, `still there: ${status}`);
    return { deleted: n };
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  for (const f of failed) console.log(`  ✖ ${f.name}: ${f.error}`);
  process.exitCode = failed.length ? 1 : 0;
}

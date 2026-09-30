#!/usr/bin/env node
/**
 * Live test of the `browser` tool against a real sandbox group.
 *
 * Drives the same path the agent uses (BrowserToolHandler → SandboxToolHandler
 * → AcaSandboxesClient → afe-browser in the sandbox): open and read pages,
 * search, screenshot, refuse local addresses, keep cookies across a suspend,
 * and clear them on reset.
 *
 * Prerequisites: those of scripts/test-aca-sandboxes-live.mjs, plus a disk
 * image built with SANDBOX_IMAGE_BROWSER=1.
 *
 * With WEBPUBSUB_CONNECTION_STRING set, it also hands the browser to a
 * user: the driver streams out through the sandbox's egress to Web PubSub,
 * and this script, playing the user, types into the page and presses Done.
 *
 * Usage:
 *   ACA_SANDBOX_SUBSCRIPTION_ID=... ACA_SANDBOX_RESOURCE_GROUP=... \
 *   ACA_SANDBOX_GROUP=... ACA_SANDBOX_REGION=... ACA_SANDBOX_DISK_IMAGE_ID=... \
 *   [WEBPUBSUB_CONNECTION_STRING=...] node scripts/test-browser-live.mjs
 *
 * Creates one sandbox at the default size (1 vCPU / 2 GiB) with open egress and deletes it at the end.
 */

import {
  AcaSandboxesClient,
  ACA_SANDBOXES_API_VERSION,
  labelHash,
} from "../gateway/dist/gateway/skills/sandbox/aca-sandboxes-client.js";
import { SandboxToolHandler } from "../gateway/dist/gateway/skills/sandbox/handler.js";
import { BrowserToolHandler, handoffDriverUserId } from "../gateway/dist/gateway/skills/browser/handler.js";
import { WebPubSubServiceClient } from "@azure/web-pubsub";
import { createDefaultTokenProvider } from "../gateway/dist/gateway/utils/azure-token.js";

const env = (k) => {
  if (!process.env[k]) {
    console.error(`Missing ${k}`);
    process.exit(2);
  }
  return process.env[k];
};

const region = env("ACA_SANDBOX_REGION").toLowerCase().replace(/\s+/g, "");
const endpoint = `https://management.${region}.azuredevcompute.io`;
const sandboxes = {
  subscriptionId: env("ACA_SANDBOX_SUBSCRIPTION_ID"),
  resourceGroup: env("ACA_SANDBOX_RESOURCE_GROUP"),
  sandboxGroup: env("ACA_SANDBOX_GROUP"),
  endpoint,
  diskImage: "ubuntu",
  diskImageId: env("ACA_SANDBOX_DISK_IMAGE_ID"),
  cpu: "1000m",
  memory: "2048Mi",
  // Short, so the suspend step finishes quickly; production default is 300.
  autoSuspendSec: 60,
  suspendMode: "Disk",
  autoDeleteDays: 1,
  egressAllowHosts: [],
  defaultTimeoutSec: 120,
  maxTimeoutSec: 200,
};
const browserConfig = {
  enabled: true,
  actionTimeoutSec: 30,
  navigationTimeoutSec: 45,
  maxSnapshotChars: 8_000,
  viewport: { width: 1280, height: 800 },
  idleShutdownSec: 120,
  maxActionsPerTurn: 30,
  maxActionsPerScheduledRun: 10,
  showScreenshots: true,
  handoff: { enabled: true, maxMinutes: 10, viewerBaseUrl: "https://viewer.invalid" },
};
const config = {
  enabled: true,
  provider: "aca-sandboxes",
  sandboxes,
  browser: browserConfig,
  poolManagementEndpoint: "",
  containerType: "PythonLTS",
  identifierStrategy: "userId",
  defaultTimeoutSec: 60,
  maxTimeoutSec: 220,
  cooldownSec: 600,
  networkAccess: "enabled",
  maxOutputChars: 50_000,
  exportsContainerName: "user-exports",
  exportExpiryHours: 24,
  maxExportBytes: 1,
};

const tokens = createDefaultTokenProvider();
const base = `${endpoint}/subscriptions/${sandboxes.subscriptionId}/resourceGroups/${sandboxes.resourceGroup}/sandboxGroups/${sandboxes.sandboxGroup}`;
async function raw(method, path) {
  const url = new URL(`${base}${path}`);
  url.searchParams.set("api-version", ACA_SANDBOXES_API_VERSION);
  const resp = await fetch(url, { method, headers: { Authorization: `Bearer ${await tokens.getToken()}` } });
  const text = await resp.text();
  return text ? JSON.parse(text) : undefined;
}

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`\n✔ ${name} (${Date.now() - started} ms)`);
    if (detail !== undefined) console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`\n✖ ${name} (${Date.now() - started} ms)\n  ${err.message}`);
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const userId = `browser-live-${Date.now()}`;
const client = new AcaSandboxesClient(config, { tokenProvider: tokens });
const identifier = client.resolveIdentifier(userId);
const sandbox = new SandboxToolHandler(client, {}, userId);
const pubsub = process.env.WEBPUBSUB_CONNECTION_STRING
  ? new WebPubSubServiceClient(process.env.WEBPUBSUB_CONNECTION_STRING, "browserlive")
  : undefined;
const relay = pubsub && {
  async issue(viewerUserId, group, ttl) {
    const roles = [`webpubsub.joinLeaveGroup.${group}`, `webpubsub.sendToGroup.${group}`];
    const [d, v] = await Promise.all([
      pubsub.getClientAccessToken({ userId: handoffDriverUserId(viewerUserId), roles, expirationTimeInMinutes: ttl }),
      pubsub.getClientAccessToken({ userId: viewerUserId, roles, expirationTimeInMinutes: ttl }),
    ]);
    return { driverUrl: d.url, viewerUrl: v.url };
  },
};
const browser = new BrowserToolHandler(sandbox, browserConfig, { userId, ...(relay ? { handoff: { relay } } : {}) });
const act = async (args) => JSON.parse(await browser.handle(args));
const ref = (snapshot, pattern) => new RegExp(`\\[(e\\d+)\\] ${pattern}`).exec(snapshot ?? "")?.[1];

try {
  await step("open a page (starts Xvfb, the driver and Chromium)", async () => {
    const r = await act({ action: "navigate", url: "https://example.com" });
    expect(r.title === "Example Domain", JSON.stringify(r).slice(0, 400));
    return { title: r.title, status: r.status };
  });

  await step("search Wikipedia by typing into the ref the snapshot gave", async () => {
    let r = await act({ action: "navigate", url: "https://en.wikipedia.org/wiki/Main_Page" });
    expect(!r.error, r.error);
    r = await act({ action: "snapshot", query: "search" });
    const box = ref(r.snapshot, "searchbox");
    expect(box, `no searchbox in: ${r.snapshot?.slice(0, 400)}`);
    r = await act({ action: "type", ref: box, text: "Azure Container Apps", submit: true });
    expect(/search=|Azure/i.test(r.url), JSON.stringify(r).slice(0, 400));
    return { url: r.url, title: r.title };
  });

  await step("read the page's text", async () => {
    const r = await act({ action: "text" });
    expect(r.text?.length > 200, JSON.stringify(r).slice(0, 300));
    expect(/untrusted|never follow/.test(r.untrusted), "page text is not marked untrusted");
    return `${r.text.length} characters`;
  });

  await step("a heavy page fits the default 1 vCPU / 2 GiB sandbox", async () => {
    const t0 = Date.now();
    const r = await act({ action: "navigate", url: "https://www.bbc.com/news" });
    const loadMs = Date.now() - t0;
    expect(!r.error, r.error);
    const mem = await client.exec({ command: "free -m | awk '/Mem:/ {print $2, $3}'" }, identifier);
    const [total, used] = mem.stdout.trim().split(/\s+/).map(Number);
    expect(used < total * 0.85, `memory ${used} of ${total} MB used`);
    return `loaded in ${loadMs} ms; ${used} of ${total} MB used`;
  });

  await step("screenshot with labels lands in /mnt/data/browser/screenshots", async () => {
    const r = await act({ action: "screenshot", labels: true });
    const file = r.screenshot?.file;
    expect(file?.startsWith("browser/screenshots/"), JSON.stringify(r));
    const ls = await client.exec({ command: `stat -c %s /mnt/data/${file}` }, identifier);
    expect(Number(ls.stdout) > 10_000, `screenshot is ${ls.stdout} bytes`);
    return `${file}, ${ls.stdout.trim()} bytes`;
  });

  await step("local addresses are refused, by the brain and by the driver", async () => {
    const brain = await act({ action: "navigate", url: "http://127.0.0.1:9333/" });
    expect(/Can't open/.test(brain.error), JSON.stringify(brain));
    const drv = await client.exec(
      { command: `afe-browser navigate $(printf '{"args":{"url":"http://localtest.me/"}}' | base64 -w0)` },
      identifier,
    );
    expect(/resolves to 127\.0\.0\.1, a local/.test(drv.stdout), drv.stdout);
    return { brain: brain.error, driver: JSON.parse(drv.stdout).error };
  });

  await step("the driver refuses requests without its token", async () => {
    const r = await client.exec(
      {
        command:
          "port=$(node -e 'console.log(require(\"/tmp/afe-browser/daemon.json\").port)'); " +
          'curl -s -XPOST "http://127.0.0.1:$port/action" -d \'{"action":"status"}\'; echo; stat -c %a /tmp/afe-browser/daemon.json',
      },
      identifier,
    );
    expect(r.stdout.includes("unauthorized") && r.stdout.trim().endsWith("600"), r.stdout);
    return r.stdout.trim();
  });

  if (relay) {
    await step("hand the browser to the user: frames out through the egress proxy, their typing in", async () => {
      let r = await act({ action: "navigate", url: "https://httpbin.org/forms/post" });
      if (r.error) {
        // An outside site that drops a connection now and then; one more try before blaming the browser.
        await new Promise((x) => setTimeout(x, 5000));
        r = await act({ action: "navigate", url: "https://httpbin.org/forms/post" });
      }
      const field = ref(r.snapshot, 'textbox "Customer name');
      expect(field, `no name field: ${r.error ?? r.snapshot?.slice(0, 300)}`);
      await act({ action: "click", ref: field }); // the agent puts the cursor there first
      const handed = await browser.run({ action: "handoff", reason: "Type your name, then press Done.", kind: "other" });
      const form = handed.inputRequest;
      expect(form?.formType === "browser_handoff", handed.output);
      const q = new URLSearchParams(String(form.proposedArgs.viewerUrl).split("#")[1]);
      const ws = new WebSocket(q.get("r"), "json.webpubsub.azure.v1");
      const group = q.get("g");
      let frames = 0;
      let firstFrameMs;
      const t0 = Date.now();
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.data?.kind === "frame") {
          frames++;
          firstFrameMs ??= Date.now() - t0;
        }
      };
      await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error("viewer could not connect")); });
      const say = (data) => ws.send(JSON.stringify({ type: "sendToGroup", group, dataType: "json", noEcho: true, data }));
      ws.send(JSON.stringify({ type: "joinGroup", group, ackId: 1 }));
      await new Promise((x) => setTimeout(x, 800));
      say({ kind: "hello" });
      await new Promise((x) => setTimeout(x, 2500));
      say({ kind: "text", text: "Ann Live" });
      await new Promise((x) => setTimeout(x, 2500));
      say({ kind: "done" });
      await new Promise((x) => setTimeout(x, 1500));
      ws.close();
      expect(frames > 0, "no frames reached the user");
      const after = await act({ action: "snapshot", query: "customer name" });
      expect(/value="Ann Live"/.test(after.snapshot), `typing didn't arrive: ${after.snapshot}`);
      return `first frame after ${firstFrameMs} ms, ${frames} frames; the user's typing reached the page`;
    });
  }

  await step("set a cookie", async () => {
    const nav = await act({ action: "navigate", url: "https://postman-echo.com/cookies/set?afe_live=1" });
    const r = await act({ action: "text" });
    expect(/afe_live/.test(r.text), `${r.text?.slice(0, 200)} | navigate: ${JSON.stringify(nav).slice(0, 300)}`);
  });

  await step("the browser comes back after a suspend, cookies intact", async () => {
    const started = Date.now();
    for (;;) {
      const owned = await raw("GET", `/sandboxes?labels=${encodeURIComponent(`agentforeach-user=${labelHash(userId)}`)}`);
      const sb = (Array.isArray(owned) ? owned : owned.value)[0];
      if (/stopped|suspended/i.test(sb?.state ?? "")) break;
      if (Date.now() - started > 240_000) throw new Error(`still ${sb?.state} after 4 minutes`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
    const suspendedAfter = Math.round((Date.now() - started) / 1000);
    const t0 = Date.now();
    const r = await act({ action: "navigate", url: "https://postman-echo.com/cookies" });
    const text = (await act({ action: "text" })).text ?? "";
    expect(/afe_live/.test(text), `cookie lost: ${text.slice(0, 200)} ${JSON.stringify(r).slice(0, 200)}`);
    return `suspended after ${suspendedAfter} s; first page after resume in ${Date.now() - t0} ms`;
  });

  await step("reset clears cookies", async () => {
    await act({ action: "reset" });
    await act({ action: "navigate", url: "https://postman-echo.com/cookies" });
    const text = (await act({ action: "text" })).text ?? "";
    expect(!/afe_live/.test(text), `cookie survived reset: ${text.slice(0, 200)}`);
  });
} finally {
  const n = await client.deleteUserSandboxes(userId).catch((e) => console.warn(`cleanup: ${e.message}`));
  console.log(`\nDeleted ${n ?? 0} sandbox(es).`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

/**
 * The browser tool: argument checks, the command it runs in the sandbox, how
 * driver results reach the model, registration and config.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BrowserToolHandler,
  checkBrowserArgs,
  handoffDriverUserId,
  handoffOutcome,
  isBrowserEnabled,
  isBrowserHandoffCall,
  parseDriverOutput,
  type BrowserGuards,
  type HandoffRelay,
} from "./handler.js";
import { viewerBaseUrl, viewerHeaders, viewerHtml, viewerLink } from "./viewer.js";
import { createHash } from "node:crypto";
import type { BrowserConfig } from "./types.js";
import { SandboxToolHandler } from "../sandbox/handler.js";
import { AcaSandboxesClient } from "../sandbox/aca-sandboxes-client.js";
import type { ExportBlobStore } from "../sandbox/export-store.js";
import type { EgressCredential, SandboxBackend, SandboxConfig, SandboxExecResult } from "../sandbox/types.js";
import type { CredentialBinding } from "../types.js";
import { isScheduledRun } from "../../client/runner.js";
import { getSkillToolDefinitions, isSkillTool } from "../handler.js";
import { loadSkillsConfig, resetSkillsConfig } from "../config.js";
import { resetConfigCache } from "../../utils/index.js";

const CONFIG: BrowserConfig = {
  enabled: true,
  actionTimeoutSec: 30,
  navigationTimeoutSec: 45,
  maxSnapshotChars: 8_000,
  viewport: { width: 1280, height: 800 },
  idleShutdownSec: 120,
  maxActionsPerTurn: 30,
  maxActionsPerScheduledRun: 10,
  showScreenshots: true,
  handoff: { enabled: true, maxMinutes: 10, hub: "agentforeach-browser", viewerBaseUrl: "https://gw.example" },
};

/** A sandbox that records what it was asked to run and answers with canned driver output. */
class FakeSandbox implements SandboxBackend {
  commands: Array<{ command: string; timeout?: number }> = [];
  egressCalls = 0;
  reply: Partial<SandboxExecResult> = { stdout: '{"ok":true,"handled":true,"action":"snapshot"}' };
  files: Record<string, string> = {};
  async exec(args: { command: string; timeout?: number }): Promise<SandboxExecResult> {
    this.commands.push(args);
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false, durationMs: 1, sessionId: "s", ...this.reply };
  }
  async fileWrite(args: { filename: string; content: string }) {
    this.files[args.filename] = args.content;
    return { success: true, filename: args.filename, sizeBytes: args.content.length, sessionId: "s" };
  }
  async fileRead() { return { content: "", filename: "", sizeBytes: 0, sessionId: "s" }; }
  async fileList() { return []; }
  async fileReadBinary(args: { filename: string }) {
    const content = this.files[args.filename] ?? "";
    return { contentBase64: Buffer.from(content).toString("base64"), filename: args.filename, sizeBytes: content.length, sessionId: "s" };
  }
  async setEnv() {}
  async setEgressCredentials(_c: EgressCredential[]) { this.egressCalls++; }
  resolveIdentifier(userId: string) { return userId; }
  isReady() { return true; }
}

function payloadOf(command: string, files: Record<string, string> = {}): { args: Record<string, unknown>; [k: string]: unknown } {
  const [, , arg] = command.split(" ");
  const b64 = arg.startsWith("@/mnt/data/") ? files[arg.slice("@/mnt/data/".length)] : arg;
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function setup(
  exportStore?: ExportBlobStore,
  guards?: BrowserGuards,
  config: BrowserConfig = CONFIG,
  credentials: { values: Record<string, string>; bindings: Record<string, CredentialBinding> } = { values: {}, bindings: {} },
) {
  const backend = new FakeSandbox();
  const sandbox = new SandboxToolHandler(
    backend, credentials.values, "u1", undefined, undefined, exportStore, credentials.bindings,
  );
  return { backend, sandbox, browser: new BrowserToolHandler(sandbox, config, guards) };
}

// ============================================================================
// Argument checks
// ============================================================================

test("checkBrowserArgs: navigate takes public http(s) URLs only", () => {
  assert.deepEqual(checkBrowserArgs("navigate", { url: "https://example.com/a" }), { args: { url: "https://example.com/a" } });
  for (const url of ["file:///etc/passwd", "http://localhost:9333/", "http://127.0.0.1/", "http://169.254.169.254/", "javascript:alert(1)", ""]) {
    assert.ok("error" in checkBrowserArgs("navigate", { url }), url);
  }
});

test("checkBrowserArgs: refs, tabs and keys must look like refs, tabs and keys", () => {
  assert.deepEqual(checkBrowserArgs("click", { ref: "e12" }), { args: { ref: "e12" } });
  assert.ok("error" in checkBrowserArgs("click", { ref: "#submit" }));
  assert.ok("error" in checkBrowserArgs("click", {}));
  assert.deepEqual(checkBrowserArgs("tab_focus", { tab: "t2" }), { args: { tab: "t2" } });
  assert.ok("error" in checkBrowserArgs("tab_close", { tab: "2" }));
  assert.deepEqual(checkBrowserArgs("press", { key: "Control+A" }), { args: { key: "Control+A" } });
  assert.ok("error" in checkBrowserArgs("press", { key: "Enter; rm -rf /" }));
});

test("checkBrowserArgs: type needs a ref and text, and keeps submit strictly boolean", () => {
  assert.deepEqual(checkBrowserArgs("type", { ref: "e3", text: "hello", submit: "yes" }), {
    args: { ref: "e3", text: "hello", submit: false },
  });
  assert.ok("error" in checkBrowserArgs("type", { ref: "e3" }));
  assert.ok("error" in checkBrowserArgs("type", { ref: "e3", text: "x".repeat(5001) }));
});

test("checkBrowserArgs: a bare domain means https, as in an address bar", () => {
  assert.deepEqual(checkBrowserArgs("navigate", { url: "example.com" }), { args: { url: "https://example.com/" } });
  assert.deepEqual(checkBrowserArgs("navigate", { url: "news.ycombinator.com/item?id=1" }), {
    args: { url: "https://news.ycombinator.com/item?id=1" },
  });
  assert.ok("error" in checkBrowserArgs("navigate", { url: "localhost:9333" }), "still refused");
  assert.ok("error" in checkBrowserArgs("navigate", { url: "just words" }));
});

test("checkBrowserArgs: hover, upload, text paging and accept_dialogs", () => {
  assert.deepEqual(checkBrowserArgs("hover", { ref: "e4" }), { args: { ref: "e4" } });
  assert.deepEqual(checkBrowserArgs("upload", { ref: "e9", path: "/mnt/data/out/cv.pdf" }), { args: { ref: "e9", path: "out/cv.pdf" } });
  for (const path of ["../etc/passwd", "/etc/passwd", "out/../../x", ""]) {
    assert.ok("error" in checkBrowserArgs("upload", { ref: "e9", path }), path);
  }
  assert.deepEqual(checkBrowserArgs("text", { offset: 8000.7, selector: " main " }), { args: { offset: 8000, selector: "main" } });
  assert.deepEqual(checkBrowserArgs("text", { offset: -5 }), { args: {} });
  assert.deepEqual(checkBrowserArgs("click", { ref: "e2", accept_dialogs: true }), { args: { ref: "e2", acceptDialogs: true } });
  assert.deepEqual(checkBrowserArgs("click", { ref: "e2", accept_dialogs: "yes" }), { args: { ref: "e2" } }, "only a real true");
  assert.deepEqual(checkBrowserArgs("press", { key: "Enter", accept_dialogs: true }), { args: { key: "Enter", acceptDialogs: true } });
});

test("checkBrowserArgs: blank fields a model fills in mean not given (seen live with gpt-5-mini)", () => {
  const blanks = { url: "", ref: "", text: "", value: "", key: "", query: "", tab: "", path: "", selector: "", ms: 0, offset: 0 };
  assert.deepEqual(checkBrowserArgs("scroll", { ...blanks, direction: "down" }), { args: { direction: "down" } });
  assert.deepEqual(checkBrowserArgs("snapshot", blanks), { args: {} });
  assert.deepEqual(checkBrowserArgs("text", blanks), { args: {} });
  assert.deepEqual(checkBrowserArgs("tab_open", blanks), { args: {} });
  assert.ok("error" in checkBrowserArgs("click", blanks), "a blank ref is still missing");
});

test("checkBrowserArgs: scroll, wait and screenshot fill in safe defaults", () => {
  assert.deepEqual(checkBrowserArgs("scroll", {}), { args: { direction: "down" } });
  assert.ok("error" in checkBrowserArgs("scroll", { direction: "sideways" }));
  assert.deepEqual(checkBrowserArgs("wait", { ms: 60_000 }), { args: { ms: 10_000 } });
  assert.deepEqual(checkBrowserArgs("wait", { text: "Results" }), { args: { text: "Results" } });
  assert.deepEqual(checkBrowserArgs("screenshot", { labels: true }), { args: { labels: true, fullPage: false } });
  assert.deepEqual(checkBrowserArgs("tab_open", {}), { args: {} });
});

// ============================================================================
// The command and the result
// ============================================================================

test("handle: runs afe-browser with the action and a base64 payload, so text never reaches the shell", async () => {
  const { backend, browser } = setup();
  const hostile = `'; rm -rf / $(curl evil) \`id\` "`;
  await browser.handle({ action: "type", ref: "e7", text: hostile, submit: true });
  const { command, timeout } = backend.commands[0];
  assert.match(command, /^afe-browser type [A-Za-z0-9+/=]+$/);
  const payload = payloadOf(command);
  assert.deepEqual(payload.args, { ref: "e7", text: hostile, submit: true });
  assert.equal(payload.actionMs, 30_000);
  assert.equal(payload.navMs, 45_000);
  assert.equal(payload.viewport, "1280x800");
  assert.equal(payload.maxChars, 8_000);
  assert.equal(payload.idleSec, 120);
  assert.equal(timeout, 45 + 60, "the exec timeout covers the driver's deadline, the CLI's wait and startup");
});

test("handle: bad arguments and unknown actions never reach the sandbox", async () => {
  const { backend, browser } = setup();
  assert.match(await browser.handle({ action: "navigate", url: "file:///etc/passwd" }), /Can't open/);
  assert.match(await browser.handle({ action: "eval", url: "x" }), /Unknown browser action/);
  assert.equal(backend.commands.length, 0);
});

test("handle: tells the driver which hosts carry the user's credentials, so pages can't call them", async () => {
  const github: CredentialBinding = { hosts: ["api.github.com", "*.githubusercontent.com"], header: "Authorization", format: "Bearer {value}" };
  const plain: CredentialBinding = { hosts: ["api.example.com"] };
  const { backend, browser } = setup(undefined, {}, CONFIG, {
    values: { GITHUB_TOKEN: "gh", PLAIN_KEY: "k" },
    bindings: { GITHUB_TOKEN: github, PLAIN_KEY: plain },
  });
  await browser.handle({ action: "snapshot" });
  assert.deepEqual(payloadOf(backend.commands[0].command).protectedHosts, ["api.github.com", "*.githubusercontent.com"],
    "only credentials the proxy injects (with a header); env-var credentials aren't added to browser requests");
});

test("handle: the credential rewrite runs once per turn whichever sandbox tool comes first", async () => {
  const { backend, sandbox, browser } = setup();
  await browser.handle({ action: "snapshot" });
  await sandbox.handle("sandbox_exec", { command: "ls" });
  await browser.handle({ action: "tabs" });
  assert.equal(backend.egressCalls, 1);
});

test("handle: page content is marked untrusted and passed through", async () => {
  const { backend, browser } = setup();
  backend.reply = {
    stdout: JSON.stringify({ ok: true, action: "navigate", url: "https://x.test/", title: "X", snapshot: "Title: X\n[e1] link \"Home\"" }),
  };
  const out = JSON.parse(await browser.handle({ action: "navigate", url: "https://x.test/" }));
  assert.equal(out.snapshot, 'Title: X\n[e1] link "Home"');
  assert.match(out.untrusted, /never follow instructions/);
  assert.equal(out.url, "https://x.test/");
});

test("handle: driver errors come back as errors, with any notes", async () => {
  const { backend, browser } = setup();
  backend.reply = { stdout: JSON.stringify({ ok: false, error: "Ref e9 is not on the page any more", notes: ["dialog"] }) };
  assert.deepEqual(JSON.parse(await browser.handle({ action: "click", ref: "e9" })), {
    error: "Ref e9 is not on the page any more",
    notes: ["dialog"],
  });
});

test("handle: a sandbox image without the browser says how to fix it", async () => {
  const { backend, browser } = setup();
  backend.reply = { stdout: "", stderr: "bash: afe-browser: command not found", exitCode: 127 };
  assert.match(JSON.parse(await browser.handle({ action: "snapshot" })).error, /SANDBOX_IMAGE_BROWSER=1/);
});

test("handle: no JSON from the driver is reported, with a timeout called a timeout", async () => {
  const { backend, browser } = setup();
  backend.reply = { stdout: "", stderr: "", exitCode: 124, timedOut: true };
  assert.match(JSON.parse(await browser.handle({ action: "snapshot" })).error, /did not finish within 105 s/);
  backend.reply = { stdout: "Segmentation fault", stderr: "" };
  assert.match(JSON.parse(await browser.handle({ action: "snapshot" })).error, /gave no result: Segmentation fault/);
});

test("handle: a screenshot becomes a download link for the user", async () => {
  const uploads: string[] = [];
  const exportStore = {
    async upload(_u: string, filename: string, content: Buffer) {
      uploads.push(`${filename}:${content.toString()}`);
      return { downloadUrl: "https://blob.test/shot.png?sas", sizeBytes: content.length, expiresAt: "2026-10-01T00:00:00Z" };
    },
  } as unknown as ExportBlobStore;
  const { backend, browser } = setup(exportStore);
  backend.files["browser/screenshots/a.png"] = "PNG";
  backend.reply = { stdout: JSON.stringify({ ok: true, action: "screenshot", screenshot: "browser/screenshots/a.png" }) };
  const out = JSON.parse(await browser.handle({ action: "screenshot" }));
  assert.deepEqual(uploads, ["browser/screenshots/a.png:PNG"]);
  assert.equal(out.screenshot.downloadUrl, "https://blob.test/shot.png?sas");
  assert.match(out.screenshotHint, /blob\.test/);
});

test("screenshot: the model gets the window-sized JPEG as an image, the user a link", async () => {
  const { backend, browser } = setup();
  backend.files["browser/screenshots/a.png"] = "PNG";
  backend.files["browser/screenshots/a.view.jpg"] = "JPEG-BYTES";
  backend.reply = {
    stdout: JSON.stringify({ ok: true, handled: true, action: "screenshot", screenshot: "browser/screenshots/a.png", view: "browser/screenshots/a.view.jpg" }),
  };
  const { output, images } = await browser.run({ action: "screenshot", labels: true });
  assert.equal(payloadOf(backend.commands[0].command).args.forModel, true, "the driver is asked for a model copy");
  assert.deepEqual(images, [{ mediaType: "image/jpeg", data: Buffer.from("JPEG-BYTES").toString("base64") }]);
  const out = JSON.parse(output);
  assert.match(out.seen, /attached/);
  assert.equal(out.view, undefined, "the model copy's path isn't shown");
});

test("screenshot: with showScreenshots off, no image and no model copy", async () => {
  const { backend, browser } = setup(undefined, {}, { ...CONFIG, showScreenshots: false });
  backend.reply = { stdout: JSON.stringify({ ok: true, handled: true, screenshot: "browser/screenshots/a.png" }) };
  const { images } = await browser.run({ action: "screenshot" });
  assert.equal(payloadOf(backend.commands[0].command).args.forModel, undefined);
  assert.equal(images, undefined);
});

test("screenshot: if the model copy can't be read, the result says to use the snapshot", async () => {
  const { backend, browser } = setup();
  backend.reply = { stdout: JSON.stringify({ ok: true, handled: true, screenshot: "s.png", view: "missing.view.jpg" }) };
  const { output, images } = await browser.run({ action: "screenshot" });
  assert.equal(images, undefined);
  assert.match(JSON.parse(output).seen, /could not be shown/);
});

test("handle: without an export store the screenshot stays in the sandbox and says why", async () => {
  const { backend, browser } = setup();
  backend.reply = { stdout: JSON.stringify({ ok: true, screenshot: "browser/screenshots/a.png" }) };
  const out = JSON.parse(await browser.handle({ action: "screenshot" }));
  assert.equal(out.screenshot.file, "browser/screenshots/a.png");
  assert.match(out.screenshot.error, /export not configured/i);
});

test("handle: downloads come with a hint to export them", async () => {
  const { backend, browser } = setup();
  backend.reply = { stdout: JSON.stringify({ ok: true, downloads: ["browser/downloads/1-report.pdf"] }) };
  const out = JSON.parse(await browser.handle({ action: "click", ref: "e4" }));
  assert.deepEqual(out.downloads, ["browser/downloads/1-report.pdf"]);
  assert.match(out.downloadsHint, /sandbox_file_export/);
});

test("parseDriverOutput takes the last JSON line and ignores noise", () => {
  assert.deepEqual(parseDriverOutput('warning: something\n{"ok":true,"url":"u"}\n'), { ok: true, url: "u" });
  assert.equal(parseDriverOutput("not json"), undefined);
  assert.equal(parseDriverOutput('{"no":"ok field"}'), undefined);
});

// ============================================================================
// Guardrails
// ============================================================================

test("guard: a turn stops after maxActionsPerTurn actions, and says to answer instead", async () => {
  const { backend, browser } = setup(undefined, {}, { ...CONFIG, maxActionsPerTurn: 3 });
  for (let i = 0; i < 3; i++) assert.ok(!JSON.parse(await browser.handle({ action: "snapshot" })).error);
  const out = JSON.parse(await browser.handle({ action: "snapshot" }));
  assert.match(out.error, /limit for this turn is reached \(3 actions\)/);
  assert.match(out.error, /answer with what you have/);
  assert.equal(backend.commands.length, 3, "the refused action never reached the sandbox");
});

test("guard: a scheduled run gets the lower per-run cap", async () => {
  const { backend, browser } = setup(undefined, { scheduled: true }, { ...CONFIG, maxActionsPerScheduledRun: 2 });
  await browser.handle({ action: "snapshot" });
  await browser.handle({ action: "snapshot" });
  assert.match(JSON.parse(await browser.handle({ action: "snapshot" })).error, /scheduled run is reached \(2 actions\)/);
  assert.equal(backend.commands.length, 2);
});

test("guard: invalid calls don't use up the cap", async () => {
  const { browser } = setup(undefined, {}, { ...CONFIG, maxActionsPerTurn: 1 });
  await browser.handle({ action: "click", ref: "nope" });
  await browser.handle({ action: "teleport" });
  assert.ok(!JSON.parse(await browser.handle({ action: "snapshot" })).error);
});

test("guard: every action counts against the user's browser limit, and a refusal stops it", async () => {
  const checked: string[] = [];
  let allow = true;
  const limiter = {
    async check(userId: string) {
      checked.push(userId);
      return allow
        ? ({ allowed: true } as const)
        : ({ allowed: false, window: "day", retryAfterSeconds: 3600 } as const);
    },
  };
  const { backend, browser } = setup(undefined, { userId: "u1", limiter });
  await browser.handle({ action: "snapshot" });
  allow = false;
  const out = JSON.parse(await browser.handle({ action: "snapshot" }));
  assert.match(out.error, /Today's browser limit/);
  assert.deepEqual(checked, ["u1", "u1"]);
  assert.equal(backend.commands.length, 1);
});

test("guard: the per-minute limit says how long to wait", async () => {
  const limiter = { check: async () => ({ allowed: false, window: "minute", retryAfterSeconds: 12 }) as const };
  const { browser } = setup(undefined, { userId: "u1", limiter });
  assert.match(JSON.parse(await browser.handle({ action: "tabs" })).error, /Wait 12 s/);
});

test("the tool tells the model not to act irreversibly when nobody can confirm", () => {
  const def = getSkillToolDefinitions({ sandboxEnabled: true, browserEnabled: true }).find((t) => t.name === "browser")!;
  assert.match(def.description, /if you can't ask \(a scheduled run\), don't do it/);
});

// ============================================================================
// Registration and config
// ============================================================================

function sandboxConfig(browserEnabled: boolean): SandboxConfig {
  return {
    enabled: true,
    provider: "aca-sandboxes",
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
    browser: { ...CONFIG, enabled: browserEnabled },
    sandboxes: {
      subscriptionId: "sub",
      resourceGroup: "rg",
      sandboxGroup: "grp",
      endpoint: "https://management.centralindia.azuredevcompute.io",
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
  };
}

test("isBrowserEnabled needs the setting and a real ACA Sandboxes backend", () => {
  const tokenProvider = { getToken: async () => "t" };
  const on = sandboxConfig(true);
  const aca = new AcaSandboxesClient(on, { tokenProvider });
  assert.equal(isBrowserEnabled(on, aca, "u1"), true);
  assert.equal(isBrowserEnabled(sandboxConfig(false), aca, "u1"), false);
  assert.equal(isBrowserEnabled({ ...on, enabled: false }, aca, "u1"), false);
  assert.equal(isBrowserEnabled(on, new FakeSandbox(), "u1"), false, "a Dynamic Sessions fallback has no browser");
  assert.equal(isBrowserEnabled(on, undefined, "u1"), false);
});

test("isBrowserEnabled offers the browser only to listed users when there is a list", () => {
  const tokenProvider = { getToken: async () => "t" };
  const pilot = { ...sandboxConfig(true), browser: { ...CONFIG, users: ["alice", "bob"] } };
  const aca = new AcaSandboxesClient(pilot, { tokenProvider });
  assert.equal(isBrowserEnabled(pilot, aca, "alice"), true);
  assert.equal(isBrowserEnabled(pilot, aca, "carol"), false);
  assert.equal(isBrowserEnabled(pilot, aca, undefined), false);
  const nobody = { ...sandboxConfig(true), browser: { ...CONFIG, users: [] } };
  assert.equal(isBrowserEnabled(nobody, aca, "alice"), false, "an empty list offers it to nobody");
});

test("meter: each action that reaches the sandbox counts one browserAction", async () => {
  const units: Record<string, number> = {};
  const { browser } = setup(undefined, { units }, { ...CONFIG, maxActionsPerTurn: 2 });
  await browser.handle({ action: "snapshot" });
  await browser.handle({ action: "click", ref: "bad" }); // invalid: not sent, not counted
  await browser.handle({ action: "tabs" });
  await browser.handle({ action: "tabs" }); // over the cap: refused, not counted
  assert.deepEqual(units, { browserAction: 2 });
});

test("meter: calls the browser never carried out aren't billed", async () => {
  const units: Record<string, number> = {};
  const { backend, browser } = setup(undefined, { units });
  backend.reply = { stdout: "", stderr: "bash: afe-browser: command not found", exitCode: 127 };
  await browser.handle({ action: "snapshot" });
  backend.reply = { stdout: JSON.stringify({ ok: false, action: "snapshot", error: "the browser did not start" }), exitCode: 1 };
  await browser.handle({ action: "snapshot" });
  backend.exec = async () => {
    throw new Error("sandbox unavailable");
  };
  await browser.handle({ action: "snapshot" });
  assert.deepEqual(units, {});
});

test("meter: an action the driver carried out is billed even when it failed on the page", async () => {
  const units: Record<string, number> = {};
  const { backend, browser } = setup(undefined, { units });
  backend.reply = { stdout: JSON.stringify({ ok: false, handled: true, action: "click", error: "Ref e9 is no longer on the page" }) };
  await browser.handle({ action: "click", ref: "e9" });
  assert.deepEqual(units, { browserAction: 1 });
});

test("guard: a refusal by the user's limit doesn't use up the turn's cap", async () => {
  let allow = false;
  const limiter = {
    check: async () =>
      (allow ? { allowed: true } : { allowed: false, window: "minute", retryAfterSeconds: 5 }) as
        | { allowed: true }
        | { allowed: false; window: "minute"; retryAfterSeconds: number },
  };
  const { backend, browser } = setup(undefined, { userId: "u1", limiter }, { ...CONFIG, maxActionsPerTurn: 1 });
  await browser.handle({ action: "snapshot" });
  await browser.handle({ action: "snapshot" });
  allow = true;
  assert.ok(!JSON.parse(await browser.handle({ action: "snapshot" })).error);
  assert.equal(backend.commands.length, 1);
});

test("isScheduledRun: cron sessions and delivered jobs are, a resumed confirmation isn't", () => {
  assert.equal(isScheduledRun({}, "cron"), true);
  assert.equal(isScheduledRun({ scheduled: true }, "interactive"), true, "a main-session job or heartbeat");
  assert.equal(isScheduledRun({ scheduled: true, metadata: { _hitlContinuation: "true" } }, "interactive"), false);
  assert.equal(isScheduledRun({}, "interactive"), false);
});

test("meter: an action the user's limit refuses is not counted", async () => {
  const units: Record<string, number> = {};
  const limiter = { check: async () => ({ allowed: false, window: "day", retryAfterSeconds: 1 }) as const };
  const { browser } = setup(undefined, { userId: "u1", limiter, units });
  await browser.handle({ action: "snapshot" });
  assert.deepEqual(units, {});
});

test("getSkillToolDefinitions offers the browser only alongside the sandbox tools", () => {
  const names = (opts: { sandboxEnabled?: boolean; browserEnabled?: boolean }) =>
    getSkillToolDefinitions(opts).map((t) => t.name);
  assert.ok(names({ sandboxEnabled: true, browserEnabled: true }).includes("browser"));
  assert.ok(!names({ sandboxEnabled: true, browserEnabled: false }).includes("browser"));
  assert.ok(!names({ sandboxEnabled: false, browserEnabled: true }).includes("browser"));
  assert.equal(isSkillTool("browser"), true);
});

const ENV_KEYS = ["CONFIG_FILE_JSON", "SANDBOX_BROWSER_ENABLED", "SANDBOX_PROVIDER"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetSkillsConfig();
  resetConfigCache();
});

function withConfigFile(sandbox: Record<string, unknown>): void {
  const dir = mkdtempSync(join(tmpdir(), "agentforeach-browser-cfg-"));
  const file = join(dir, "test.json");
  writeFileSync(file, JSON.stringify({ skills: { enabled: true, sandbox: { enabled: true, provider: "aca-sandboxes", ...sandbox } } }));
  process.env.CONFIG_FILE_JSON = file;
  resetConfigCache();
  resetSkillsConfig();
}

test("config: the browser is off by default, with small, cheap defaults", () => {
  withConfigFile({});
  const b = loadSkillsConfig().sandbox!.browser!;
  assert.equal(b.enabled, false);
  assert.equal(b.maxSnapshotChars, 8_000);
  assert.equal(b.idleShutdownSec, 120, "shorter than the sandbox's 300 s auto-suspend, so it takes effect");
  assert.equal(b.maxActionsPerTurn, 30);
  assert.equal(b.maxActionsPerScheduledRun, 10);
});

test("config: turning the browser on doesn't change the sandbox size", () => {
  withConfigFile({ browser: { enabled: true, navigationTimeoutSec: 60, maxActionsPerTurn: 50 } });
  let cfg = loadSkillsConfig().sandbox!;
  assert.equal(cfg.browser?.enabled, true);
  assert.equal(cfg.browser?.navigationTimeoutSec, 60);
  assert.equal(cfg.browser?.maxActionsPerTurn, 50);
  assert.equal(cfg.sandboxes?.cpu, "1000m");
  assert.equal(cfg.sandboxes?.memory, "2048Mi");

  withConfigFile({ browser: { enabled: true }, sandboxes: { cpu: "2000m", memory: "4096Mi" } });
  cfg = loadSkillsConfig().sandbox!;
  assert.equal(cfg.sandboxes?.cpu, "2000m", "operators can still choose a bigger size");
});

test("config: users limits the browser to a list; without it everyone gets it", () => {
  withConfigFile({ browser: { enabled: true, users: ["alice"] } });
  assert.deepEqual(loadSkillsConfig().sandbox?.browser?.users, ["alice"]);
  withConfigFile({ browser: { enabled: true } });
  assert.equal(loadSkillsConfig().sandbox?.browser?.users, undefined);
});

test("config: snapshots are capped below the sandbox's output limit", () => {
  withConfigFile({ browser: { maxSnapshotChars: 100_000 } });
  assert.equal(loadSkillsConfig().sandbox?.browser?.maxSnapshotChars, 40_000);
});

test("config: SANDBOX_BROWSER_ENABLED from the IaC overrides agentforeach.json", () => {
  process.env.SANDBOX_BROWSER_ENABLED = "true";
  withConfigFile({});
  assert.equal(loadSkillsConfig().sandbox?.browser?.enabled, true);

  process.env.SANDBOX_BROWSER_ENABLED = "1";
  withConfigFile({});
  assert.equal(loadSkillsConfig().sandbox?.browser?.enabled, true, "1 means on too");

  process.env.SANDBOX_BROWSER_ENABLED = "false";
  withConfigFile({ browser: { enabled: true } });
  assert.equal(loadSkillsConfig().sandbox?.browser?.enabled, false);
});

// ============================================================================
// Handoff to the user
// ============================================================================

const relay = (calls: Array<{ user: string; group: string; ttl: number }> = []): HandoffRelay => ({
  async issue(user, group, ttl) {
    calls.push({ user, group, ttl });
    return { driverUrl: `wss://wps.example/client/hubs/h?access_token=DRIVER-${group}`, viewerUrl: `wss://wps.example/client/hubs/h?access_token=VIEWER-${group}` };
  },
});

test("checkBrowserArgs: handoff needs a reason; the kind defaults to other", () => {
  assert.deepEqual(checkBrowserArgs("handoff", { reason: " Log in, then press Done. ", kind: "login" }), {
    args: { reason: "Log in, then press Done.", kind: "login" },
  });
  assert.deepEqual(checkBrowserArgs("handoff", { reason: "Pay", kind: "steal" }), { args: { reason: "Pay", kind: "other" } });
  assert.ok("error" in checkBrowserArgs("handoff", { kind: "login" }));
});

test("handoff: starts the live view, then asks the runner to pause on a form that shows it", async () => {
  const issued: Array<{ user: string; group: string; ttl: number }> = [];
  const units: Record<string, number> = {};
  const { backend, browser } = setup(undefined, { userId: "u1", units, handoff: { relay: relay(issued) } });
  backend.reply = { stdout: JSON.stringify({ ok: true, handled: true, action: "handoff_start", handoff: "started" }) };
  const before = Date.now();
  const result = await browser.run({ action: "handoff", reason: "Log in to Amazon, then press Done.", kind: "login" });

  const { command } = backend.commands[0];
  assert.match(command, /^afe-browser handoff_start @\/mnt\/data\/\.browser\/in-[0-9a-f]{24}\.b64$/, "the token goes up as a file, not on the command line");
  assert.doesNotMatch(command, /access_token/);
  const sent = payloadOf(command, backend.files).args as Record<string, unknown>;
  assert.equal(sent.kind, "login", "the driver knows the kind (payment handoffs stop screenshots of the site)");
  assert.match(String(sent.group), /^bh-[0-9a-f]{32}$/, "a fresh unguessable group");
  assert.equal(sent.relayUrl, `wss://wps.example/client/hubs/h?access_token=DRIVER-${sent.group}`, "the driver gets the driver's token");
  assert.equal(sent.viewerUserId, "u1", "only the user's own input is accepted");
  assert.ok(Number(sent.expiresAt) >= before + 10 * 60_000 - 1000 && Number(sent.expiresAt) <= Date.now() + 10 * 60_000);
  assert.deepEqual(issued, [{ user: "u1", group: sent.group, ttl: 11 }]);

  const form = result.inputRequest!;
  assert.equal(form.formType, "browser_handoff");
  assert.equal(form.formName, "Log in");
  assert.equal(form.intent, "Log in to Amazon, then press Done.");
  assert.equal(form.timeoutSeconds, 600);
  const link = String(form.proposedArgs.viewerUrl);
  const [page, fragment] = link.split("#");
  assert.equal(page, "https://gw.example/api/browser/view", "no secret in the part a server sees");
  const q = new URLSearchParams(fragment);
  assert.equal(q.get("r"), `wss://wps.example/client/hubs/h?access_token=VIEWER-${sent.group}`, "the viewer gets its own token");
  assert.equal(q.get("g"), sent.group);
  assert.equal(q.get("d"), handoffDriverUserId("u1"), "the viewer only believes the driver");
  assert.equal(q.get("embed"), "1");
  assert.equal(JSON.parse(result.output).handoff, "waiting");
  assert.doesNotMatch(result.output, /access_token/, "no token reaches the model");
  assert.deepEqual(units, { browserAction: 1, browserHandoff: 1 });
});

test("handoff: refused where it can't happen, without using the browser or a cap", async () => {
  const cases: Array<[string, BrowserGuards, BrowserConfig]> = [
    ["turned off", { userId: "u1", handoff: { relay: relay() } }, { ...CONFIG, handoff: { ...CONFIG.handoff, enabled: false } }],
    ["scheduled run", { userId: "u1", scheduled: true, handoff: { relay: relay() } }, CONFIG],
    ["no form surface (a message channel)", { userId: "u1" }, CONFIG],
    ["no viewer address", { userId: "u1", handoff: { relay: relay() } }, { ...CONFIG, handoff: { enabled: true, maxMinutes: 10, hub: "h" } }],
  ];
  const saved = process.env.WEBSITE_HOSTNAME;
  delete process.env.WEBSITE_HOSTNAME;
  try {
    for (const [label, guards, config] of cases) {
      const units: Record<string, number> = {};
      const { backend, browser } = setup(undefined, { ...guards, units }, { ...config, maxActionsPerTurn: 1 });
      const result = await browser.run({ action: "handoff", reason: "Log in", kind: "login" });
      assert.ok(JSON.parse(result.output).error, label);
      assert.equal(result.inputRequest, undefined, label);
      assert.equal(backend.commands.length, 0, label);
      assert.deepEqual(units, {}, label);
      assert.ok(!JSON.parse((await browser.run({ action: "tabs" })).output).error, `${label}: the refusal used no cap`);
    }
  } finally {
    if (saved !== undefined) process.env.WEBSITE_HOSTNAME = saved;
  }
});

test("handoff: a live view that can't connect is an error, not a form", async () => {
  const { backend, browser } = setup(undefined, { userId: "u1", handoff: { relay: relay() } });
  backend.reply = { stdout: JSON.stringify({ ok: false, handled: true, error: "The live view could not connect." }) };
  const result = await browser.run({ action: "handoff", reason: "Log in", kind: "login" });
  assert.match(JSON.parse(result.output).error, /could not connect/);
  assert.equal(result.inputRequest, undefined);

  const failing: HandoffRelay = { issue: async () => { throw new Error("no Web PubSub"); } };
  const second = setup(undefined, { userId: "u1", handoff: { relay: failing } });
  const r2 = await second.browser.run({ action: "handoff", reason: "Log in", kind: "login" });
  assert.match(JSON.parse(r2.output).error, /could not be set up: no Web PubSub/);
  assert.equal(second.backend.commands.length, 0);
});

test("handoffOutcome: done, cancelled, or late, with the user's note", () => {
  const now = 1_000_000;
  const done = JSON.parse(handoffOutcome({ data: { done: true, note: "logged in" } }, now + 60_000, now));
  assert.equal(done.handoff, "done");
  assert.equal(done.userNote, "logged in");
  assert.match(done.message, /never re-enter passwords or payment details/);
  assert.equal(JSON.parse(handoffOutcome({ cancelled: true }, now + 60_000, now)).handoff, "cancelled");
  assert.equal(JSON.parse(handoffOutcome({ data: { done: true } }, now - 120_000, now)).handoff, "expired");
});

test("isBrowserHandoffCall and the driver's relay identity", () => {
  assert.equal(isBrowserHandoffCall({ name: "browser", arguments: { action: "handoff" } }), true);
  assert.equal(isBrowserHandoffCall({ name: "browser", arguments: { action: "click" } }), false);
  assert.equal(isBrowserHandoffCall({ name: "request_user_input", arguments: { action: "handoff" } }), false);
  const id = handoffDriverUserId("alice@example.com");
  assert.match(id, /^browser-driver:[0-9a-f]{24}$/);
  assert.doesNotMatch(id, /alice/, "no user id in the relay");
});

test("viewer: the page runs only its own script, connects only to our relay and carries no secret", () => {
  const html = viewerHtml("afe-wps.webpubsub.azure.com");
  const headers = viewerHeaders("afe-wps.webpubsub.azure.com");
  assert.match(headers["Content-Security-Policy"], /connect-src wss:\/\/afe-wps\.webpubsub\.azure\.com(;|$)/, "pinned to this deployment's relay");
  assert.match(html, /<meta name="afe-relay-host" content="afe-wps.webpubsub.azure.com">/);
  assert.match(html, /new URL\(relayUrl\)\.host !== relayHost/, "the script refuses a link to another relay");
  assert.match(html, /msg\.fromUserId !== driverId/, "and believes only the driver");
  assert.equal(viewerHtml('evil"><script>').includes('evil"><script>'), false, "the host can't break out of the attribute");
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const hash = createHash("sha256").update(script).digest("base64");
  assert.match(headers["Content-Security-Policy"], new RegExp(`script-src 'sha256-${hash.replace(/[+/]/g, "\\$&")}'`));
  assert.match(headers["Content-Security-Policy"], /default-src 'none'/);
  assert.equal(headers["Cache-Control"], "no-store");
  assert.doesNotMatch(html, /access_token|wss:\/\/[a-z]/, "the page itself holds no token or relay URL");
  assert.match(html, /history\.replaceState/, "the token is cleared from the address bar");
});

test("viewer: links carry everything in the fragment; the base comes from config or the Function App", () => {
  const link = viewerLink("https://gw.example", { relayUrl: "wss://x/?access_token=T", group: "bh-1", expiresAt: 5, reason: "Pay", driverUserId: "browser-driver:ab" });
  assert.equal(link.split("#")[0], "https://gw.example/api/browser/view");
  assert.equal(new URLSearchParams(link.split("#")[1]).get("r"), "wss://x/?access_token=T");
  const saved = process.env.WEBSITE_HOSTNAME;
  process.env.WEBSITE_HOSTNAME = "afe-func.azurewebsites.net";
  try {
    assert.equal(viewerBaseUrl(undefined), "https://afe-func.azurewebsites.net");
    assert.equal(viewerBaseUrl("https://chat.example.com/"), "https://chat.example.com");
  } finally {
    if (saved === undefined) delete process.env.WEBSITE_HOSTNAME;
    else process.env.WEBSITE_HOSTNAME = saved;
  }
});

test("config: handoff defaults, a clamped time limit, and the relay host let through deny-mode egress", () => {
  withConfigFile({ browser: { enabled: true, handoff: { maxMinutes: 90 } } });
  let cfg = loadSkillsConfig().sandbox!;
  assert.equal(cfg.browser?.handoff.enabled, true);
  assert.equal(cfg.browser?.handoff.maxMinutes, 30);
  assert.equal(cfg.browser?.handoff.hub, "agentforeach_browser", "its own hub, apart from chat's (letters, digits, underscores)");
  withConfigFile({ browser: { enabled: true, handoff: { maxMinutes: "ten" } } });
  assert.equal(loadSkillsConfig().sandbox!.browser?.handoff.maxMinutes, 10, "a non-number falls back to the default");

  const saved = process.env.WEBPUBSUB_CONNECTION_STRING;
  process.env.WEBPUBSUB_CONNECTION_STRING = "Endpoint=https://afe-wps.webpubsub.azure.com;AccessKey=abc;Version=1.0;";
  try {
    withConfigFile({ browser: { enabled: true }, sandboxes: { egressAllowHosts: ["pypi.org"] } });
    cfg = loadSkillsConfig().sandbox!;
    assert.deepEqual(cfg.sandboxes?.egressAllowHosts, ["pypi.org", "afe-wps.webpubsub.azure.com"]);
    withConfigFile({ browser: { enabled: false } });
    assert.deepEqual(loadSkillsConfig().sandbox!.sandboxes?.egressAllowHosts, [], "only when the browser can hand off");
  } finally {
    if (saved === undefined) delete process.env.WEBPUBSUB_CONNECTION_STRING;
    else process.env.WEBPUBSUB_CONNECTION_STRING = saved;
  }
});

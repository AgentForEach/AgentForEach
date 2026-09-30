/**
 * AgentForEach browser driver: one long-lived process per sandbox that holds
 * a headed Chromium (on Xvfb) with a persistent profile, and serves actions
 * from the `afe-browser` CLI over 127.0.0.1 with a random token.
 *
 * Started on demand by cli.mjs. It exits when Chromium closes, after
 * AFE_BROWSER_IDLE_SEC without a request, or on `reset`; a sandbox suspend
 * also ends it, and the next call starts it again with the same profile, so
 * cookies and logins survive.
 */

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  checkUrl,
  checkUrlResolved,
  explainError,
  hostMatches,
  isTransientNetError,
  looksBlocked,
  truncate,
} from "./guard.mjs";
import { labelsInPage, snapshotInPage, textInPage } from "./snapshot.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const DATA = process.env.AFE_BROWSER_DATA_DIR ?? "/mnt/data";
const RUN_DIR = process.env.AFE_BROWSER_RUN_DIR ?? "/tmp/afe-browser";
const PROFILE = join(DATA, ".browser", "profile");
const OUTPUT = "browser"; // under DATA, so sandbox_file_export can hand files to the user
const PROXY_CA = "/etc/ssl/certs/adc-egress-proxy-ca.crt";
const [VIEW_W, VIEW_H] = (process.env.AFE_BROWSER_VIEWPORT ?? "1280x800").split("x").map(Number);
const IDLE_MS = Number(process.env.AFE_BROWSER_IDLE_SEC ?? 120) * 1000;
const HEADLESS = process.env.AFE_BROWSER_HEADLESS === "1" || !process.env.DISPLAY;
/** Elements listed per snapshot; every element is tagged and searchable with query. */
const MAX_LIST = 200;
/** Longest wait for a click or key press; Playwright retries until then when something covers the target. */
const CLICK_TIMEOUT_MS = 15_000;
/** Longest wait for downloads an action started before answering. */
const DOWNLOAD_WAIT_MS = 15_000;

// ============================================================================
// Launch
// ============================================================================

/**
 * The sandbox's egress proxy re-signs TLS with its own CA, which the platform
 * writes at boot (so it can rotate). Chromium on Linux trusts its NSS store,
 * not the system bundle, so import the CA on every start.
 */
function trustEgressProxyCa() {
  if (!existsSync(PROXY_CA)) return;
  const dir = join(homedir(), ".pki", "nssdb");
  const db = `sql:${dir}`;
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "cert9.db"))) execFileSync("certutil", ["-d", db, "-N", "--empty-password"]);
  const pems = readFileSync(PROXY_CA, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  pems.forEach((pem, i) => {
    const nick = `adc-egress-proxy-${i}`;
    const file = join(RUN_DIR, `${nick}.pem`);
    writeFileSync(file, `${pem}\n`);
    try {
      execFileSync("certutil", ["-d", db, "-D", "-n", nick], { stdio: "ignore" });
    } catch {
      // not there yet
    }
    execFileSync("certutil", ["-d", db, "-A", "-t", "C,,", "-n", nick, "-i", file]);
  });
}

/** Save PDFs and other files instead of opening them in Chromium's viewer (headed Chromium opens PDFs). */
function preferDownloads() {
  const file = join(PROFILE, "Default", "Preferences");
  let prefs = {};
  try {
    prefs = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // a new profile
  }
  prefs.plugins = { ...prefs.plugins, always_open_pdf_externally: true };
  prefs.download = { ...prefs.download, prompt_for_download: false };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(prefs));
}

/** Chromium from the image (PLAYWRIGHT_BROWSERS_PATH), or Playwright's own lookup elsewhere. */
function chromePath() {
  if (process.env.AFE_BROWSER_CHROME) return process.env.AFE_BROWSER_CHROME;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/ms-playwright";
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  const exe = dir && join(root, dir, "chrome-linux64", "chrome");
  return exe && existsSync(exe) ? exe : undefined;
}

mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
mkdirSync(PROFILE, { recursive: true });
for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
  rmSync(join(PROFILE, lock), { force: true }); // left behind when a suspend killed the last browser
}
trustEgressProxyCa();
preferDownloads();

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: HEADLESS,
  executablePath: chromePath(),
  viewport: { width: VIEW_W, height: VIEW_H },
  acceptDownloads: true,
  args: [
    "--disable-dev-shm-usage",
    "--renderer-process-limit=2",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    // Keep every request on the TCP egress proxy; under Partial inspection UDP isn't inspected.
    "--disable-quic",
  ],
});
let resetting = false;
context.on("close", () => {
  if (!resetting) process.exit(0);
});

// ============================================================================
// Credential hosts
// ============================================================================

/*
 * The egress proxy adds the user's skill credentials to every request to the
 * hosts they are bound to, whoever sends it. A page's own script could call
 * such a host and read the answer with the user's token attached. So requests
 * to those hosts are blocked unless the agent itself opened the page there.
 */
let protectedHosts = [];
let agentOpening; // host of the page the agent is opening right now
const warnedHosts = new Set();

async function guardCredentialRequest(route) {
  const request = route.request();
  let host = "";
  try {
    host = new URL(request.url()).hostname;
    const mainFrame = request.frame().page().mainFrame();
    if (request.isNavigationRequest() && request.frame() === mainFrame && agentOpening === host) {
      return route.continue();
    }
  } catch {
    // service-worker requests have no frame: block them too
  }
  if (host && !warnedHosts.has(host)) {
    warnedHosts.add(host);
    pendingNotes.push(
      `Blocked a request the page made to ${host}: the user's credentials are attached to requests to that host, so only you can open it (navigate there directly).`,
    );
  }
  return route.abort("blockedbyclient");
}

const matchesProtected = (url) => protectedHosts.some((pattern) => hostMatches(url.hostname, pattern));

/** Apply the brain's list of credential hosts; routing costs a little, so only while there are some. */
async function setProtectedHosts(hosts) {
  const next = [...new Set((Array.isArray(hosts) ? hosts : []).map(String))].sort();
  if (next.join("\n") === protectedHosts.join("\n")) return;
  const had = protectedHosts.length > 0;
  protectedHosts = next;
  if (next.length && !had) await context.route(matchesProtected, guardCredentialRequest);
  if (!next.length && had) await context.unroute(matchesProtected, guardCredentialRequest);
}

// ============================================================================
// Tabs, downloads, dialogs
// ============================================================================

const tabIds = new WeakMap();
let nextTab = 1;
let current;
let openedDuringAction;
const pendingDownloads = [];
const pendingNotes = [];
let downloadsInFlight = 0;
/** Accept confirm/prompt dialogs during this action (the agent asked, after the user approved). */
let acceptDialogs = false;
/** HTTP status of each tab's last main-frame navigation. */
const statusOf = new WeakMap();

function track(page) {
  if (tabIds.has(page)) return;
  tabIds.set(page, `t${nextTab++}`);
  openedDuringAction = page;
  page.on("response", (response) => {
    try {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        statusOf.set(page, response.status());
      }
    } catch {
      // the frame went away
    }
  });
  page.on("download", async (download) => {
    downloadsInFlight++;
    const name = basename(download.suggestedFilename()).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "download";
    const rel = `${OUTPUT}/downloads/${Date.now()}-${name}`;
    try {
      mkdirSync(join(DATA, OUTPUT, "downloads"), { recursive: true });
      await download.saveAs(join(DATA, rel));
      pendingDownloads.push(rel);
    } catch (err) {
      pendingNotes.push(`A download failed: ${String(err.message).split("\n")[0]}`);
    } finally {
      downloadsInFlight--;
    }
  });
  page.on("dialog", async (dialog) => {
    const type = dialog.type();
    // Alerts would freeze the page. Confirms and prompts are declined unless the agent said to accept them.
    const accept = acceptDialogs || type === "alert" || type === "beforeunload";
    pendingNotes.push(
      `The page showed ${type === "alert" ? "an alert" : `a ${type} dialog`}: "${dialog.message().slice(0, 200)}" (${accept ? "accepted" : "dismissed"}).`,
    );
    await (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
  });
  page.on("close", () => {
    if (current === page) current = context.pages().at(-1);
  });
}

for (const page of context.pages()) track(page);
context.on("page", track);
current = context.pages()[0] ?? (await context.newPage());
openedDuringAction = undefined;

async function page() {
  if (!current || current.isClosed()) current = context.pages().at(-1) ?? (await context.newPage());
  return current;
}

// ============================================================================
// Actions
// ============================================================================

class ActionError extends Error {}

async function goto(p, url, navMs) {
  const checked = await checkUrlResolved(url);
  if (!checked.ok) throw new ActionError(`Refused to open ${url}: ${checked.reason}`);
  const started = Date.now();
  agentOpening = checked.url.hostname;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const timeout = Math.max(navMs - (Date.now() - started), 5000);
        const response = await p.goto(checked.url.href, { waitUntil: "domcontentloaded", timeout });
        if (response) statusOf.set(p, response.status());
        await p.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
        return;
      } catch (err) {
        // The URL is a file: the download handler saves it, and settle() waits for it.
        if (/Download is starting/.test(err.message)) return;
        // One quiet retry for a dropped connection, if there's time left for it.
        if (attempt === 1 && isTransientNetError(err.message) && Date.now() - started < navMs / 2) {
          await p.waitForTimeout(1000);
          continue;
        }
        throw new ActionError(explainError(err.message));
      }
    }
  } finally {
    agentOpening = undefined;
  }
}

/** Wait for whatever the last action started (a navigation, a new tab, a download) to settle. */
async function settle(p) {
  await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(400);
  // Catches a navigation the page starts shortly after the action; pages that never go quiet cost 1.2 s.
  await p.waitForLoadState("networkidle", { timeout: 1200 }).catch(() => {});
  const until = Date.now() + DOWNLOAD_WAIT_MS;
  while (downloadsInFlight > 0 && Date.now() < until) await p.waitForTimeout(100);
  if (downloadsInFlight > 0) pendingNotes.push("A download is still running; its file will be listed in a later result.");
  if (openedDuringAction && !openedDuringAction.isClosed() && openedDuringAction !== p) {
    current = openedDuringAction;
    pendingNotes.push(`The action opened a new tab (${tabIds.get(current)}); it is now the current tab.`);
    await current.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  }
  // A link or redirect the page chose can still point somewhere local, by name or by DNS.
  const at = (await page()).url();
  if (at.startsWith("http")) {
    const checked = await checkUrlResolved(at);
    if (!checked.ok) {
      await (await page()).goto("about:blank").catch(() => {});
      throw new ActionError(`The page went to ${at.slice(0, 200)}, which is a local address; it was blocked.`);
    }
  }
}

function locate(p, ref) {
  if (!/^e\d{1,5}$/.test(ref ?? "")) throw new ActionError(`"${ref}" is not a ref like e12. Take a snapshot to get refs.`);
  return p.locator(`[data-afe-ref="${ref}"]`);
}

async function withRef(p, ref, fn) {
  const target = locate(p, ref);
  if ((await target.count()) === 0) {
    throw new ActionError(`Ref ${ref} is no longer on the page (it changed or went away). Take a new snapshot and use a ref from it.`);
  }
  try {
    await fn(target.first());
  } catch (err) {
    throw err instanceof ActionError ? err : new ActionError(explainError(err.message));
  }
}

async function describe(p, { query, maxChars } = {}) {
  let snap;
  for (let attempt = 1; ; attempt++) {
    try {
      snap = await p.evaluate(snapshotInPage, { maxList: MAX_LIST, query: query ?? "" });
      break;
    } catch (err) {
      // The page navigated mid-snapshot; give it a moment once.
      if (attempt > 1) throw new ActionError(`Could not read the page: ${String(err.message).split("\n")[0]}`);
      await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    }
  }
  const lines = [`Title: ${snap.title}`, `URL: ${snap.url}`, `Scrolled: ${snap.scroll}% of a ${snap.pageHeight}px page`];
  if (snap.headings.length && !query) lines.push("Headings:", ...snap.headings);
  if (snap.messages.length) lines.push("Messages:", ...snap.messages.map((m) => `- ${m}`));
  const unlisted = snap.matched - snap.elements.length;
  lines.push(
    query
      ? `Elements matching "${query}" (${snap.matched} of ${snap.total}${unlisted > 0 ? `, ${unlisted} not listed` : ""}):`
      : `Elements (${snap.total}, in view first${unlisted > 0 ? `; ${unlisted} not listed: scroll, or use snapshot with query` : ""}):`,
    ...snap.elements,
  );
  if (snap.total < 5 && snap.lead) lines.push(`Page text: ${snap.lead}`);
  if (snap.frames) {
    lines.push(
      `Note: ${snap.frames} frame(s) on this page (for example a cookie banner or a payment form) aren't listed, and their buttons can't be used yet.`,
    );
  }
  const blocked = looksBlocked({ status: statusOf.get(p), title: snap.title, text: snap.lead });
  return {
    snapshot: truncate(lines.join("\n"), maxChars, "use snapshot with query to find what you need").text,
    ...(blocked ? { blocked: true } : {}),
  };
}

async function state(p, opts = {}) {
  const out = { tab: tabIds.get(p), url: p.url().slice(0, 500), title: (await p.title().catch(() => "")).slice(0, 200) };
  if (statusOf.get(p) !== undefined) out.status = statusOf.get(p);
  if (opts.snapshot !== false) Object.assign(out, await describe(p, opts));
  if (out.blocked) {
    out.note =
      "This site is showing a bot check or blocked the request. Don't retry or try to get around it; tell the user they can open the page themselves.";
  }
  return out;
}

/** Keep the newest screenshots only, so a long browsing habit doesn't fill the sandbox disk. */
function pruneScreenshots(keep = 60) {
  const dir = join(DATA, OUTPUT, "screenshots");
  try {
    const files = readdirSync(dir).sort(); // ISO timestamps sort by time
    for (const f of files.slice(0, Math.max(files.length - keep, 0))) rmSync(join(dir, f), { force: true });
  } catch {
    // nothing to prune
  }
}

/** A file under /mnt/data the agent wants to upload, or an error. */
function dataFile(path) {
  const abs = resolve(DATA, String(path).replace(/^\/mnt\/data\/?/, ""));
  if (abs !== DATA && !abs.startsWith(DATA + sep)) throw new ActionError("The file must be under /mnt/data.");
  if (!existsSync(abs)) throw new ActionError(`There is no file at ${path}. Use sandbox_file_list to see the files.`);
  return abs;
}

async function run(action, args, t) {
  const p = await page();
  const clickMs = Math.min(t.actionMs, CLICK_TIMEOUT_MS);
  switch (action) {
    case "status":
      return { version: context.browser()?.version() ?? "unknown", tabs: context.pages().length, headless: HEADLESS };
    case "navigate":
      await goto(p, args.url, t.navMs);
      await settle(p);
      return state(await page(), t);
    case "snapshot":
      return state(p, { ...t, query: args.query });
    case "click":
      await withRef(p, args.ref, (el) => el.click({ timeout: clickMs }));
      await settle(p);
      return state(await page(), t);
    case "hover":
      await withRef(p, args.ref, (el) => el.hover({ timeout: clickMs }));
      await p.waitForTimeout(300);
      return state(p, t);
    case "type":
      await withRef(p, args.ref, async (el) => {
        await el.fill(String(args.text), { timeout: t.actionMs });
        if (args.submit) await el.press("Enter", { timeout: clickMs });
      });
      await settle(p);
      return state(await page(), t);
    case "select":
      await withRef(p, args.ref, async (el) => {
        const value = String(args.value);
        const options = await el.evaluate((s) =>
          s.tagName === "SELECT" ? [...s.options].map((o) => [(o.label || o.textContent || "").trim(), o.value]) : null,
        );
        if (!options) {
          throw new ActionError("That element isn't a <select>. For a custom dropdown, click it, then click the option.");
        }
        const hit =
          options.find(([label, v]) => label === value || v === value) ??
          options.find(([label]) => label.toLowerCase() === value.toLowerCase());
        if (!hit) {
          throw new ActionError(`There is no option "${value}". Options: ${options.slice(0, 30).map(([l]) => l).join(" | ")}`);
        }
        await el.selectOption({ value: hit[1] }, { timeout: t.actionMs });
      });
      await settle(p);
      return state(await page(), t);
    case "upload":
      await withRef(p, args.ref, (el) => el.setInputFiles(dataFile(args.path), { timeout: t.actionMs }));
      await settle(p);
      return state(await page(), t);
    case "press":
      await p.keyboard.press(String(args.key));
      await settle(p);
      return state(await page(), t);
    case "scroll":
      if (args.ref) {
        await withRef(p, args.ref, (el) => el.scrollIntoViewIfNeeded({ timeout: t.actionMs }));
      } else {
        await p.evaluate((dir) => {
          if (dir === "top") scrollTo(0, 0);
          else if (dir === "bottom") scrollTo(0, document.documentElement.scrollHeight);
          else scrollBy(0, (dir === "up" ? -0.8 : 0.8) * innerHeight);
        }, args.direction ?? "down");
      }
      await p.waitForTimeout(300);
      return state(p, t);
    case "back": {
      const before = p.url();
      // goBack() resolves to null for pages restored from the back-forward cache, so compare URLs.
      await p.goBack({ waitUntil: "domcontentloaded", timeout: t.navMs });
      if (p.url() === before) throw new ActionError("There is no earlier page in this tab.");
      await settle(p);
      return state(await page(), t);
    }
    case "wait":
      if (args.text) {
        await p.getByText(String(args.text)).first().waitFor({ timeout: t.actionMs }).catch(() => {
          throw new ActionError(`"${args.text}" did not appear within ${t.actionMs / 1000} s.`);
        });
      } else {
        await p.waitForTimeout(Math.min(Number(args.ms) || 1000, 10_000));
      }
      return state(p, t);
    case "text": {
      let full;
      try {
        full = await p.evaluate(textInPage, args.selector ?? null);
      } catch (err) {
        throw new ActionError(`Could not read the text: ${explainError(err.message)}`);
      }
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const chunk = full.slice(offset, offset + t.maxChars);
      const more = full.length - offset - chunk.length;
      const text = more > 0 ? `${chunk}\n… [${more} more characters: use text with offset ${offset + chunk.length}]` : chunk;
      return { ...(await state(p, { snapshot: false })), text, length: full.length };
    }
    case "tabs":
      return {
        current: tabIds.get(p),
        tabs: await Promise.all(
          context.pages().map(async (tab) => ({
            tab: tabIds.get(tab),
            url: tab.url().slice(0, 500),
            title: (await tab.title().catch(() => "")).slice(0, 200),
          })),
        ),
      };
    case "tab_open": {
      const tab = await context.newPage();
      current = tab;
      openedDuringAction = undefined;
      if (args.url) {
        await goto(tab, args.url, t.navMs);
        await settle(tab);
      }
      return state(await page(), t);
    }
    case "tab_focus":
    case "tab_close": {
      const tab = context.pages().find((x) => tabIds.get(x) === args.tab);
      if (!tab) throw new ActionError(`No tab ${args.tab}. Use the tabs action to list them.`);
      if (action === "tab_close") {
        await tab.close();
        return state(await page(), t);
      }
      current = tab;
      await tab.bringToFront();
      return state(tab, t);
    }
    case "screenshot": {
      if (args.labels) {
        await p.evaluate(snapshotInPage, { maxList: 0 }).catch(() => {});
        await p.evaluate(labelsInPage, true).catch(() => {});
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rel = `${OUTPUT}/screenshots/${stamp}.png`;
      // For the model: the window only (a full page can be too tall to read once scaled), as a smaller JPEG.
      const view = args.forModel ? `${OUTPUT}/screenshots/${stamp}.view.jpg` : undefined;
      mkdirSync(join(DATA, OUTPUT, "screenshots"), { recursive: true });
      try {
        await p.screenshot({ path: join(DATA, rel), fullPage: Boolean(args.fullPage), timeout: t.actionMs });
        if (view) await p.screenshot({ path: join(DATA, view), type: "jpeg", quality: 70, timeout: t.actionMs });
      } finally {
        if (args.labels) await p.evaluate(labelsInPage, false).catch(() => {});
      }
      pruneScreenshots();
      return { ...(await state(p, { snapshot: false })), screenshot: rel, ...(view ? { view } : {}) };
    }
    case "reset":
      // Delete the profile before answering, and take no more calls: the next one starts a fresh driver.
      resetting = true;
      server.close();
      await context.close().catch(() => {});
      rmSync(join(DATA, ".browser"), { recursive: true, force: true });
      rmSync(join(RUN_DIR, "daemon.json"), { force: true });
      setTimeout(() => process.exit(0), 100);
      return { reset: true };
    default:
      throw new ActionError(`Unknown action ${action}`);
  }
}

/** Stop an action that runs past its budget, so the queue never backs up behind it. */
function withDeadline(work, ms) {
  let timer;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new ActionError(`The action took longer than ${Math.round(ms / 1000)} s and was stopped. Take a snapshot to see the page.`)),
        ms,
      );
    }),
  ]);
}

// ============================================================================
// Server
// ============================================================================

const token = randomBytes(24).toString("hex");
let idleTimer;
let busy = 0;
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (busy) return touch();
    context.close().catch(() => process.exit(0));
  }, IDLE_MS);
}

function authorized(req) {
  const given = Buffer.from(String(req.headers["x-afe-token"] ?? ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

// One action at a time: the model can issue several browser calls at once.
let queue = Promise.resolve();

const server = createServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!authorized(req)) return reply(401, { ok: false, error: "unauthorized" });
  if (req.method === "GET" && req.url === "/ping") return reply(200, { ok: true, pid: process.pid });
  if (req.method !== "POST" || req.url !== "/action") return reply(404, { ok: false, error: "not found" });
  let body = "";
  let gone = false;
  res.on("close", () => {
    if (!res.writableFinished) gone = true;
  });
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    queue = queue.then(async () => {
      // The caller gave up while this waited in the queue: don't act on a stale request.
      if (gone) return;
      busy++;
      touch();
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        busy--;
        return reply(400, { ok: false, error: "bad JSON" });
      }
      const t = {
        actionMs: Number(msg.actionMs) || 30_000,
        navMs: Number(msg.navMs) || 45_000,
        maxChars: Number(msg.maxChars) || 8_000,
      };
      acceptDialogs = msg.args?.acceptDialogs === true;
      try {
        await setProtectedHosts(msg.protectedHosts);
        const result = await withDeadline(run(String(msg.action), msg.args ?? {}, t), Math.max(t.navMs, t.actionMs) + 25_000);
        const extra = {};
        if (pendingDownloads.length) extra.downloads = pendingDownloads.splice(0);
        if (pendingNotes.length) extra.notes = pendingNotes.splice(0);
        // handled: the driver carried the action out (the gateway bills only these).
        reply(200, { ok: true, handled: true, action: msg.action, ...result, ...extra });
      } catch (err) {
        const message = err instanceof ActionError ? err.message : explainError(err.message ?? err);
        reply(200, { ok: false, handled: true, action: msg.action, error: message, notes: pendingNotes.splice(0) });
      } finally {
        openedDuringAction = undefined;
        acceptDialogs = false;
        busy--;
        touch();
      }
    });
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync(join(RUN_DIR, "daemon.json"), JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  touch();
  console.log(`ready port=${port} pid=${process.pid} headless=${HEADLESS}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    context.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  challengeFrame,
  checkUrl,
  checkUrlResolved,
  explainError,
  hostMatches,
  isTransientNetError,
  maskCardNumbers,
  pageRequestBlocked,
  guardPageSockets,
  parseViewerInput,
  truncate,
  wallKind,
} from "./guard.mjs";
import { cardFieldFilledInPage, labelsInPage, snapshotInPage, textInPage } from "./snapshot.mjs";
import { trustEgressCa } from "./egress-ca.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const DATA = process.env.AFE_BROWSER_DATA_DIR ?? "/mnt/data";
const RUN_DIR = process.env.AFE_BROWSER_RUN_DIR ?? "/tmp/afe-browser";
const PROFILE = join(DATA, ".browser", "profile");
const OUTPUT = "browser"; // under DATA, so sandbox_file_export can hand files to the user
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
// The egress proxy's CA, wherever the backend says it is (SANDBOX_EGRESS_CA).
trustEgressCa({ workDir: RUN_DIR });
preferDownloads();

/** URLs on hosts that may be local or private (loopback, private ranges, local names). */
const LOCAL_HOST_URL =
  /^(https?|wss?):\/\/(\[[^\]]*\]|localhost|[^/:]*\.(localhost|local|internal|localdomain)|metadata|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|0\.0\.0\.0)(:\d+)?([/?#]|$)/i;

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
// A page may not reach the sandbox's own servers on 127.0.0.1 (the sandbox
// server, this driver) or any private address: refuse its requests there.
// The pattern is matched in the browser (normalised URLs), so other requests
// aren't held up; pageRequestBlocked makes the exact call.
await context.route(LOCAL_HOST_URL, (route) =>
  pageRequestBlocked(route.request().url()) ? route.abort("blockedbyclient") : route.fallback(),
);

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

// WebSockets bypass context.route, so the local-host and credential-host
// blocks above don't see them: close a page's socket to either. This covers
// sockets a page (or its frames) opens, not those from a Web Worker it starts:
// Playwright's WebSocket route isn't injected into workers. On Cloudflare the
// egress handler never adds credentials to a WebSocket, so that gap is closed
// there; on ACA Sandboxes it isn't (docs/Browser.md, Security).
await guardPageSockets(context, {
  protectedHosts: () => protectedHosts,
  onBlocked: (raw) => {
    let host = "";
    try {
      host = new URL(raw).hostname;
    } catch {
      return;
    }
    if (warnedHosts.has(host) || !protectedHosts.some((pattern) => hostMatches(host, pattern))) return;
    warnedHosts.add(host);
    pendingNotes.push(
      `Blocked a WebSocket the page opened to ${host}: the user's credentials are attached to requests to that host, so pages may not connect to it.`,
    );
  },
});

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
/** HTTP status of each tab's last main-frame navigation, and its Cloudflare `cf-mitigated` header. */
const statusOf = new WeakMap();
const cfMitigatedOf = new WeakMap();
/** The live view while the user has the browser (see Handoff below), and how the last one ended. */
let handoff;
let lastHandoff;
/** The site a payment handoff was for: no screenshots of it reach the model while the page is there. */
let paymentOrigin;

function track(page) {
  if (tabIds.has(page)) return;
  tabIds.set(page, `t${nextTab++}`);
  openedDuringAction = page;
  // The user opened a tab in the live view: show them that tab.
  if (handoff) {
    current = page;
    streamPage(page).catch(() => {});
  }
  page.on("framenavigated", (frame) => {
    if (handoff?.page === page && frame === page.mainFrame()) sendStatus();
  });
  page.on("response", (response) => {
    try {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        statusOf.set(page, response.status());
        cfMitigatedOf.set(page, response.headers()["cf-mitigated"]);
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
    if (handoff) return askViewer(dialog);
    // Alerts would freeze the page. Confirms and prompts are declined unless the agent said to accept them.
    const accept = acceptDialogs || type === "alert" || type === "beforeunload";
    pendingNotes.push(
      `The page showed ${type === "alert" ? "an alert" : `a ${type} dialog`}: "${dialog.message().slice(0, 200)}" (${accept ? "accepted" : "dismissed"}).`,
    );
    await (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
  });
  // A file chooser can't be shown in the live view: tell the user, not the page.
  page.on("filechooser", () => {
    if (handoff) {
      relaySend({ kind: "notice", text: "This page asked for a file. Uploading from the live view isn't possible yet: tell the agent, it can upload a file you've shared in the chat." });
    }
  });
  page.on("close", () => {
    if (current === page) current = context.pages().at(-1);
    if (handoff?.page === page && current) streamPage(current).catch(() => {});
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
        if (response) {
          statusOf.set(p, response.status());
          cfMitigatedOf.set(p, response.headers()["cf-mitigated"]);
        }
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

/** A ref is `e12` on the page itself, or `f2e5` inside frame f2 (see readFrames). */
function locate(p, ref) {
  const m = /^(f\d{1,4})?(e\d{1,5})$/.exec(ref ?? "");
  if (!m) throw new ActionError(`"${ref}" is not a ref like e12 or f2e5. Take a snapshot to get refs.`);
  const frame = m[1] ? p.frames().find((f) => frameIds.get(f) === m[1]) : p.mainFrame();
  if (!frame || frame.isDetached()) {
    throw new ActionError(`Ref ${ref} is no longer on the page (its frame went away). Take a new snapshot and use a ref from it.`);
  }
  return frame.locator(`[data-afe-ref="${m[2]}"]`);
}

async function withRef(p, ref, fn) {
  const target = locate(p, ref);
  if ((await target.count()) === 0) {
    throw new ActionError(`Ref ${ref} is no longer on the page (it changed or went away). Take a new snapshot and use a ref from it.`);
  }
  // A click at the centre of an element holding a CAPTCHA would land on its checkbox (snapshots leave
  // these out, but a ref can predate the widget).
  const frames = await target.first().evaluate((el) => [...el.querySelectorAll("iframe")].map((f) => f.src)).catch(() => []);
  if (frames.some((src) => challengeFrame(src))) {
    throw new ActionError("That element holds a human check (a CAPTCHA). Don't try to solve it: use handoff so the user can.");
  }
  try {
    await fn(target.first());
  } catch (err) {
    throw err instanceof ActionError ? err : new ActionError(explainError(err.message));
  }
}

/** Frames read per snapshot besides the page itself; a page full of ad frames shouldn't slow every action. */
const MAX_FRAMES = 12;
/** Frame ids (`f1`, `f2`, …), kept for a frame's life so its refs stay stable like the page's. */
const frameIds = new WeakMap();
let nextFrame = 1;

/** Where a frame sits on the page, or null when it can't be seen (hidden, or a tracking pixel). */
async function frameBox(frame) {
  const el = await frame.frameElement().catch(() => null);
  if (!el) return null;
  try {
    if (!(await el.isVisible())) return null;
    const box = await el.boundingBox();
    if (!box || box.width < 8 || box.height < 8) return null;
    return { inView: box.x < VIEW_W && box.y < VIEW_H && box.x + box.width > 0 && box.y + box.height > 0 };
  } finally {
    await el.dispose().catch(() => {});
  }
}

/** Whether a human-check frame is asking for a person now: a puzzle on screen, or an unticked checkbox. */
async function asksForPerson(frame, check) {
  if (check === "puzzle") return true;
  if (check !== "checkbox") return false;
  // reCAPTCHA's and hCaptcha's checkbox; an invisible reCAPTCHA's badge has none.
  const ticked = await frame
    .evaluate(() => document.querySelector("#recaptcha-anchor, #checkbox")?.getAttribute("aria-checked") ?? null)
    .catch(() => null);
  return ticked === "false";
}

/**
 * Snapshot the page and every frame on it a person can see (cookie banners,
 * payment forms and other embeds, cross-origin ones included), each frame's
 * refs prefixed with its id. Human-check widgets (reCAPTCHA and the like) are
 * never read, so the agent can't click them; a visible one that is waiting
 * for a person is returned as `challenge`, for the user to do in a handoff.
 */
async function readFrames(p, { query = "", maxList = MAX_LIST } = {}) {
  let main;
  for (let attempt = 1; ; attempt++) {
    try {
      main = await p.evaluate(snapshotInPage, { maxList, query });
      break;
    } catch (err) {
      // The page navigated mid-snapshot; give it a moment once.
      if (attempt > 1) throw new ActionError(`Could not read the page: ${String(err.message).split("\n")[0]}`);
      await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    }
  }
  const frames = [];
  const unread = new Set(); // frames left out; their own frames are left out with them
  let unreadable = 0;
  let skipped = 0;
  let challenge;
  // Parents before their children, so a frame left out takes its own frames with it.
  const order = [];
  const walk = (f) => f.childFrames().forEach((c) => (order.push(c), walk(c)));
  walk(p.mainFrame());
  for (const frame of order) {
    const parent = frame.parentFrame();
    if (frame.isDetached() || (parent && unread.has(parent))) {
      unread.add(frame);
      continue;
    }
    const widget = challengeFrame(frame.url());
    const box = await frameBox(frame);
    if (widget || !box) {
      unread.add(frame);
      if (widget && box?.inView && !challenge && (await asksForPerson(frame, widget.check))) {
        challenge = { provider: widget.provider };
      }
      continue;
    }
    if (frames.length >= MAX_FRAMES) {
      unread.add(frame);
      skipped++;
      continue;
    }
    let id = frameIds.get(frame);
    if (!id) {
      id = `f${nextFrame++}`;
      frameIds.set(frame, id);
    }
    try {
      const snap = await frame.evaluate(snapshotInPage, { maxList, query, prefix: id, frameSeen: box.inView });
      frames.push({ id, frame, snap });
    } catch {
      // Navigating, or gone. Its refs, if any, fail with "no longer on the page".
      unread.add(frame);
      unreadable++;
    }
  }
  return { main, frames, unreadable, skipped, challenge };
}

async function describe(p, { query, maxChars } = {}) {
  const { main, frames, unreadable, skipped, challenge } = await readFrames(p, { query: query ?? "" });
  const parts = [main, ...frames.map((f) => f.snap)];
  // In view first across the page and its frames, then the rest.
  const elements = [
    ...parts.flatMap((s) => s.elements.slice(0, s.inView)),
    ...parts.flatMap((s) => s.elements.slice(s.inView)),
  ].slice(0, MAX_LIST);
  const total = parts.reduce((n, s) => n + s.total, 0);
  const matched = parts.reduce((n, s) => n + s.matched, 0);
  const messages = parts.flatMap((s) => s.messages).slice(0, 5);

  const lines = [`Title: ${main.title}`, `URL: ${main.url}`, `Scrolled: ${main.scroll}% of a ${main.pageHeight}px page`];
  if (main.headings.length && !query) lines.push("Headings:", ...main.headings);
  if (messages.length) lines.push("Messages:", ...messages.map((m) => `- ${m}`));
  const unlisted = matched - elements.length;
  lines.push(
    query
      ? `Elements matching "${query}" (${matched} of ${total}${unlisted > 0 ? `, ${unlisted} not listed` : ""}):`
      : `Elements (${total}, in view first${unlisted > 0 ? `; ${unlisted} not listed: scroll, or use snapshot with query` : ""}):`,
    ...elements,
  );
  if (total < 5 && main.lead) lines.push(`Page text: ${main.lead}`);
  const withElements = frames.filter((f) => f.snap.total > 0);
  if (withElements.length) {
    const where = withElements.map(({ id, frame }) => {
      try {
        return `${id} ${new URL(frame.url()).host || "(embedded)"}`;
      } catch {
        return `${id} (embedded)`;
      }
    });
    lines.push(`Frames: ${where.join(", ")}. A ref inside a frame starts with its id, like ${withElements[0].id}e1.`);
  }
  if (unreadable) lines.push(`Note: ${unreadable} frame(s) on this page couldn't be read (still loading?); a new snapshot may list them.`);
  if (skipped) lines.push(`Note: only the first ${MAX_FRAMES} frames on this page are listed; ${skipped} more aren't.`);
  const wall = challenge
    ? "challenge"
    : wallKind({ status: statusOf.get(p), title: main.title, text: main.lead, cfMitigated: cfMitigatedOf.get(p) });
  return {
    // A card number the user typed (in any field or editable element) never reaches the model.
    snapshot: truncate(maskCardNumbers(lines.join("\n")), maxChars, "use snapshot with query to find what you need").text,
    ...(wall === "blocked" ? { blocked: true } : {}),
    ...(wall === "challenge" ? { challenge: challenge ?? {} } : {}),
  };
}

async function state(p, opts = {}) {
  const out = { tab: tabIds.get(p), url: p.url().slice(0, 500), title: (await p.title().catch(() => "")).slice(0, 200) };
  if (statusOf.get(p) !== undefined) out.status = statusOf.get(p);
  if (opts.snapshot !== false) Object.assign(out, await describe(p, opts));
  if (out.challenge) {
    // The gateway adds how to involve the user (a handoff, where one is possible).
    out.note =
      `This page is asking for a human check${out.challenge.provider ? ` (${out.challenge.provider})` : ""}. ` +
      "Don't try to solve, click or get around it yourself.";
  } else if (out.blocked) {
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
      const chunk = maskCardNumbers(full.slice(offset, offset + t.maxChars));
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
        // Tag the page and its frames as a snapshot would, then label each in its own frame.
        const { frames } = await readFrames(p, { maxList: 0 }).catch(() => ({ frames: [] }));
        await p.evaluate(labelsInPage, { show: true }).catch(() => {});
        for (const { id, frame } of frames) await frame.evaluate(labelsInPage, { show: true, prefix: id }).catch(() => {});
      }
      // Card details the user typed must never reach the model or the sandbox's disk: no screenshot at all
      // while a card field holds a value, or of the site a payment handoff was for.
      let origin = "";
      try {
        origin = new URL(p.url()).origin;
      } catch {
        // about:blank
      }
      if (await cardFieldFilled(p)) {
        return { ...(await state(p, { snapshot: false })), withheld: "A payment card field on this page holds a value, so no screenshot was taken. Work from the snapshot." };
      }
      if (paymentOrigin && origin === paymentOrigin) {
        return { ...(await state(p, { snapshot: false })), withheld: "This is the site the user paid on, so no screenshot was taken. Work from the snapshot." };
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
        if (args.labels) {
          for (const frame of p.frames()) await frame.evaluate(labelsInPage, { show: false }).catch(() => {});
        }
      }
      pruneScreenshots();
      return { ...(await state(p, { snapshot: false })), screenshot: rel, ...(view ? { view } : {}) };
    }
    case "handoff_start":
      return startHandoff(args);
    case "handoff_stop": {
      const had = Boolean(handoff);
      await stopHandoff("stopped");
      return { handoff: had ? "stopped" : "none", last: lastHandoff };
    }
    case "handoff_status":
      return { handoff: handoff ? "active" : "none", ...(handoff ? { expiresAt: handoff.expiresAt } : {}), last: lastHandoff };
    case "reset":
      paymentOrigin = undefined;
      await stopHandoff("reset");
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
// Handoff: the user drives the browser through a live view
// ============================================================================

/*
 * For a login, a CAPTCHA, a second factor or a payment, the agent hands the
 * browser to the user. The driver connects OUT to Web PubSub (the sandbox
 * takes no inbound connections), joins the handoff's group, streams the page
 * as JPEG frames (CDP screencast, sent only when the screen changes) and
 * applies the user's mouse and keyboard input. Only messages Web PubSub
 * stamps with the user's own id are accepted.
 */
async function cardFieldFilled(p) {
  for (const frame of p.frames()) {
    try {
      if (await frame.evaluate(cardFieldFilledInPage)) return true;
    } catch {
      // a frame that went away, or one we can't read
    }
  }
  return false;
}

/** Input waiting to be applied, oldest first; moves coalesce so a burst can't delay a click. */
const pendingInput = [];
let draining = false;
const MAX_PENDING_INPUT = 200;
/** Frames are only sent while a viewer has spoken recently, and no faster than this. */
const VIEWER_QUIET_MS = 30_000;
const FRAME_INTERVAL_MS = 150;

function relaySend(data, h = handoff) {
  if (h?.ws.readyState === 1) {
    h.ws.send(JSON.stringify({ type: "sendToGroup", group: h.group, dataType: "json", noEcho: true, data }));
  }
}

function sendStatus() {
  const h = handoff;
  if (!h?.page) return;
  h.page
    .title()
    .catch(() => "")
    .then((title) =>
      relaySend({
        kind: "status",
        url: h.page.url().slice(0, 300),
        title: String(title).slice(0, 200),
        tab: tabIds.get(h.page),
        tabs: context.pages().length,
        expiresAt: h.expiresAt,
        reason: h.reason,
      }, h),
    );
}

/** A frame now, for a viewer that just joined (the screencast only sends when the screen changes). */
async function sendFullFrame() {
  const h = handoff;
  if (!h?.cdp) return;
  const shot = await h.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }).catch(() => undefined);
  if (shot) relaySend({ kind: "frame", seq: h.seq++, w: VIEW_W, h: VIEW_H, jpeg: shot.data }, h);
}

async function streamPage(p) {
  const h = handoff;
  if (!h || h.page === p) return;
  if (h.cdp) {
    await h.cdp.send("Page.stopScreencast").catch(() => {});
    await h.cdp.detach().catch(() => {});
  }
  h.page = p;
  const cdp = await context.newCDPSession(p);
  h.cdp = cdp;
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    // Acking late paces the screencast: at most one frame per FRAME_INTERVAL_MS, however busy the page.
    setTimeout(() => cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}), FRAME_INTERVAL_MS);
    if (handoff !== h || h.cdp !== cdp) return;
    // Nobody is watching (the tab was closed): send nothing until a viewer says hello again.
    if (Date.now() - h.viewerSeen > VIEWER_QUIET_MS) return;
    // A viewer on a slow link falls behind: drop this frame, the next one replaces it.
    if (h.ws.bufferedAmount > 2_000_000) return;
    relaySend({ kind: "frame", seq: h.seq++, w: Math.round(metadata.deviceWidth), h: Math.round(metadata.deviceHeight), jpeg: data }, h);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: VIEW_W, maxHeight: VIEW_H, everyNthFrame: 1 });
  sendStatus();
  await sendFullFrame();
}

/** A confirm or prompt during a handoff: the user answers it in the live view (two minutes, then it's declined). */
function askViewer(dialog) {
  const h = handoff;
  const type = dialog.type();
  if (type === "alert") {
    relaySend({ kind: "notice", text: `The page said: ${dialog.message().slice(0, 200)}` }, h);
    dialog.accept().catch(() => {});
    return;
  }
  const timer = setTimeout(() => {
    if (h.dialog?.dialog === dialog) h.dialog = undefined;
    dialog.dismiss().catch(() => {});
  }, 120_000);
  h.dialog = { dialog, timer };
  relaySend({ kind: "dialog", type, message: dialog.message().slice(0, 500), defaultValue: dialog.defaultValue?.() ?? "" }, h);
}

async function applyInput(input) {
  const h = handoff;
  if (!h) return;
  const p = h.page;
  switch (input.kind) {
    case "hello":
      sendStatus();
      await sendFullFrame();
      break;
    case "ping":
      break;
    case "dialog": {
      const pending = h.dialog;
      if (!pending) break;
      h.dialog = undefined;
      clearTimeout(pending.timer);
      await (input.accept ? pending.dialog.accept(input.text || undefined) : pending.dialog.dismiss()).catch(() => {});
      break;
    }
    case "done":
    case "cancel":
      await stopHandoff(input.kind === "done" ? "done" : "cancelled");
      break;
    case "mouse":
      await p.mouse.move(input.x, input.y);
      if (input.type === "down") {
        await p.mouse.down({ button: input.button });
        h.buttons.add(input.button);
      } else if (input.type === "up") {
        await p.mouse.up({ button: input.button });
        h.buttons.delete(input.button);
      } else if (input.type === "wheel") await p.mouse.wheel(input.deltaX, input.deltaY);
      break;
    case "key":
      if (input.type === "down") {
        await p.keyboard.down(input.key);
        h.keys.add(input.key);
      } else {
        await p.keyboard.up(input.key);
        h.keys.delete(input.key);
      }
      break;
    case "text":
      await p.keyboard.insertText(input.text);
      break;
  }
}

function onRelayMessage(raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  const input = parseViewerInput(message, handoff?.viewerUserId);
  if (!input) return;
  touch();
  handoff.viewerSeen = Date.now();
  // Answers to a dialog, and Done or Cancel, can't wait in line: the click that opened a
  // dialog doesn't finish until the dialog is answered.
  if (input.kind === "dialog" || input.kind === "done" || input.kind === "cancel") {
    applyInput(input).catch(() => {});
    return;
  }
  // A burst of moves collapses to the latest; a flood can't push a click out of reach.
  const last = pendingInput.at(-1);
  if (input.kind === "mouse" && input.type === "move" && last?.kind === "mouse" && last.type === "move") {
    pendingInput[pendingInput.length - 1] = input;
  } else if (pendingInput.length < MAX_PENDING_INPUT) {
    pendingInput.push(input);
  }
  drainInput();
}

/** Apply queued input in order: a key down lands before its key up. */
async function drainInput() {
  if (draining) return;
  draining = true;
  try {
    while (pendingInput.length) {
      await applyInput(pendingInput.shift()).catch(() => {});
    }
  } finally {
    draining = false;
  }
}

async function startHandoff({ relayUrl, group, viewerUserId, expiresAt, reason, kind }) {
  await stopHandoff("replaced");
  if (typeof relayUrl !== "string" || !relayUrl.startsWith("wss://") || !group || !viewerUserId) {
    throw new ActionError("The handoff is missing its live-view connection.");
  }
  const until = Number(expiresAt) || Date.now() + 10 * 60_000;
  if (until <= Date.now() + 5_000) throw new ActionError("The handoff's deadline has already passed.");
  const ws = await openRelay(relayUrl);
  handoff = {
    ws,
    relayUrl,
    group,
    viewerUserId,
    expiresAt: until,
    reason: String(reason ?? "").slice(0, 200),
    seq: 0,
    viewerSeen: Date.now(),
    keys: new Set(),
    buttons: new Set(),
  };
  const h = handoff;
  if (kind === "payment") {
    try {
      paymentOrigin = new URL((await page()).url()).origin;
    } catch {
      // not on a web page yet
    }
  }
  attachRelay(h, ws);
  h.timer = setTimeout(() => stopHandoff("expired").catch(() => {}), Math.max(until - Date.now(), 1000));
  // A heartbeat, so the viewer can tell the browser is still there.
  h.heartbeat = setInterval(sendStatus, 10_000);
  await streamPage(await page());
  return { handoff: "started", expiresAt: until };
}

/** Open the relay socket (the live view's connection), or fail with a message for the agent. */
async function openRelay(relayUrl) {
  const ws = new WebSocket(relayUrl, "json.webpubsub.azure.v1");
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new ActionError("The live view could not connect (timed out).")), 15_000);
    ws.onopen = () => {
      clearTimeout(timer);
      ok();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      fail(new ActionError("The live view could not connect. If sandbox egress is restricted, allow the Web PubSub host."));
    };
  });
  return ws;
}

/** Join the handoff's group on `ws` and handle its messages; a socket that drops is opened again. */
function attachRelay(h, ws) {
  h.ws = ws;
  ws.send(JSON.stringify({ type: "joinGroup", group: h.group, ackId: 1 }));
  ws.onmessage = (m) => onRelayMessage(m.data);
  ws.onclose = () => {
    if (handoff === h && h.ws === ws) reconnectRelay(h).catch(() => {});
  };
}

/** Relay reconnects in a row before the handoff ends as disconnected. */
const RELAY_RECONNECTS = 5;

/**
 * The relay socket dropped mid-handoff (a network blip, or a platform that
 * ends long outbound connections): open it again while the handoff lasts,
 * with a short backoff, so the user's live view carries on. The backoff
 * totals about 12 s, inside the 30 s a relay URL may reconnect after its
 * connection closed (RELAY_RESUME_MS on self-hosted realtime providers).
 */
async function reconnectRelay(h) {
  for (let attempt = 1; attempt <= RELAY_RECONNECTS && handoff === h && Date.now() < h.expiresAt - 2_000; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 5_000)));
    if (handoff !== h) return;
    try {
      const ws = await openRelay(h.relayUrl);
      if (handoff !== h) {
        ws.close();
        return;
      }
      attachRelay(h, ws);
      h.reconnects = (h.reconnects ?? 0) + 1;
      console.error(`[driver] relay reconnected (attempt ${attempt}, ${h.reconnects} so far)`);
      // The screencast carries on into the new socket; send a whole frame now.
      sendStatus();
      await sendFullFrame().catch(() => {});
      return;
    } catch {
      // try again
    }
  }
  if (handoff === h) await stopHandoff("disconnected");
}

async function stopHandoff(reason) {
  const h = handoff;
  if (!h) return;
  handoff = undefined;
  clearTimeout(h.timer);
  clearInterval(h.heartbeat);
  pendingInput.length = 0;
  if (h.dialog) {
    clearTimeout(h.dialog.timer);
    await h.dialog.dialog.dismiss().catch(() => {});
  }
  // Let go of anything the user held down, or the agent's next key would come with a stuck Shift.
  for (const key of h.keys) await h.page?.keyboard.up(key).catch(() => {});
  for (const button of h.buttons) await h.page?.mouse.up({ button }).catch(() => {});
  relaySend({ kind: "ended", reason }, h);
  await h.cdp?.send("Page.stopScreencast").catch(() => {});
  await h.cdp?.detach().catch(() => {});
  try {
    h.ws.close();
  } catch {
    // already closed
  }
  lastHandoff = { outcome: reason, at: new Date().toISOString() };
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
    if (busy || handoff) return touch();
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
        // The agent is acting again, so the user's turn with the browser is over.
        if (handoff && !String(msg.action).startsWith("handoff_") && msg.action !== "reset") {
          await stopHandoff("agent_resumed");
          pendingNotes.push("The live view was closed: you have the browser again.");
        }
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

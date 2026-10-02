/**
 * Pure checks for the browser driver: which URLs it may open, and whether a
 * page is a bot wall. No Playwright here, so guard.test.mjs runs anywhere.
 *
 * The sandbox's egress already blocks private, link-local and Azure-internal
 * addresses (measured live), so the one internal target left is the driver
 * itself on 127.0.0.1. These checks keep the agent from opening it, or any
 * other local or private address, on purpose or by a redirect it chose.
 */

import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain"];

/** Why an address may not be opened, or null when it may. */
export function blockedAddress(ip) {
  const family = isIP(ip);
  if (family === 0) return null;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) is checked as the IPv4 it maps to.
  const mapped = family === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blockedAddress(mapped[1]);
  return BLOCKED.check(ip, family === 4 ? "ipv4" : "ipv6")
    ? `${ip} is a local or private address`
    : null;
}

/** Parse and check a URL without touching the network. */
export function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `${url.protocol} URLs are not allowed; use http or https` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials in the URL are not allowed" };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return { ok: false, reason: "the URL has no host" };
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: `${host} is a local host` };
  }
  const literal = blockedAddress(host);
  if (literal) return { ok: false, reason: literal };
  return { ok: true, url, host };
}

/** checkUrl plus a DNS lookup, so a public name that points at a private address is refused too. */
export async function checkUrlResolved(raw, resolve = (h) => lookup(h, { all: true })) {
  const checked = checkUrl(raw);
  if (!checked.ok || isIP(checked.host)) return checked;
  let addresses;
  try {
    addresses = await resolve(checked.host);
  } catch {
    // Let the browser report the DNS failure the way a person would see it.
    return checked;
  }
  for (const { address } of addresses) {
    if (blockedAddress(address)) {
      return { ok: false, reason: `${checked.host} resolves to ${address}, a local or private address` };
    }
  }
  return checked;
}

/** Walls a person can get past: a check to pass (Cloudflare's interstitial, PerimeterX, DuckDuckGo, Amazon). */
const CHALLENGE_TITLES = [/^just a moment/i, /are you a robot/i, /^verify you are human/i, /^human verification/i];
const CHALLENGE_TEXT = [
  /verify (that )?you are (a )?human/i,
  /confirm (that )?you are (a )?human/i,
  /are you a robot/i,
  /bots use duckduckgo too/i,
  /checking (if the site connection is secure|your browser)/i,
  /press (&|and) hold/i,
  /enter the characters you see/i,
];

/** Walls with nothing to pass: the site refused (Akamai, Reddit, Google, Apache). */
const BLOCK_TITLES = [/^attention required/i, /^access denied/i, /^security check/i, /^403 forbidden/i, /^request blocked/i];
const BLOCK_TEXT = [
  /blocked by network security/i,
  /unusual traffic from your (computer )?network/i,
  /you don't have permission to access .* on this server/i,
  /please enable (javascript and )?cookies to continue/i,
];

/**
 * Whether a page is a bot wall (Cloudflare, Akamai and friends challenge
 * datacenter IPs), and which kind: "challenge" when it asks for a check a
 * person can do (the user, through a handoff), "blocked" when the site just
 * refused, or null for an ordinary page. Never something for the agent to
 * retry or get around. `text` is the start of the page's visible text (walls
 * often answer 200); `cfMitigated` is Cloudflare's `cf-mitigated` header.
 */
export function wallKind({ status, title, text, cfMitigated }) {
  const t = (title ?? "").trim();
  const lead = (text ?? "").slice(0, 600);
  if (String(cfMitigated ?? "").trim().toLowerCase() === "challenge") return "challenge";
  if (CHALLENGE_TITLES.some((re) => re.test(t)) || CHALLENGE_TEXT.some((re) => re.test(lead))) return "challenge";
  if (status === 429) return "blocked";
  if (BLOCK_TITLES.some((re) => re.test(t))) return "blocked";
  // A 403 with a real page (a login form, an error page with links) isn't necessarily a wall; one with little text is.
  if (status === 403 && (text ?? "").length < 400) return "blocked";
  return BLOCK_TEXT.some((re) => re.test(lead)) ? "blocked" : null;
}

/** Whether a page is a bot wall of either kind (see wallKind). */
export function looksBlocked(page) {
  return wallKind(page) !== null;
}

/**
 * The human-check widget a frame belongs to, by the frame's address, or null.
 *
 * The driver never lists anything inside these frames, so the agent can't
 * click "I'm not a robot" itself, and reports a visible one as a check for
 * the user. `check` is the part that asks a person for something: the
 * "checkbox" (a check only while it is unticked: an invisible reCAPTCHA's
 * badge has none), the "puzzle" that pops up (hidden off-page until then), or
 * "none". Turnstile is "none": it usually passes on its own, and its
 * full-page interstitial is caught by its title or header (wallKind).
 */
export function challengeFrame(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const under = (domain) => host === domain || host.endsWith(`.${domain}`);
  if ((under("google.com") || under("recaptcha.net")) && url.pathname.startsWith("/recaptcha/")) {
    const part = url.pathname.endsWith("/bframe") ? "puzzle" : url.pathname.endsWith("/anchor") ? "checkbox" : "none";
    return { provider: "reCAPTCHA", check: part };
  }
  if (under("hcaptcha.com")) {
    const frame = new URLSearchParams(url.hash.slice(1)).get("frame");
    return { provider: "hCaptcha", check: frame === "challenge" ? "puzzle" : frame === "checkbox" ? "checkbox" : "none" };
  }
  if (host === "challenges.cloudflare.com") return { provider: "Cloudflare Turnstile", check: "none" };
  if (under("arkoselabs.com") || under("funcaptcha.com")) return { provider: "Arkose Labs", check: "puzzle" };
  if (under("captcha-delivery.com")) return { provider: "DataDome", check: "puzzle" };
  return null;
}

/** Network errors worth one quiet retry (the egress proxy drops a connection now and then). */
export function isTransientNetError(message) {
  return /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_TIMED_OUT/.test(message ?? "");
}

/** Cut text to `max` characters at a line break when there is one, saying so and how to see more. */
export function truncate(text, max, hint) {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", max);
  const end = cut > max * 0.8 ? cut : max;
  const more = `${text.length - end} more characters`;
  return { text: `${text.slice(0, end)}\n… [truncated, ${hint ? `${more}: ${hint}` : more}]`, truncated: true };
}

/**
 * Whether `host` matches a credential host pattern: an exact name, or
 * "*.example.com" for any subdomain (not example.com itself), as skills
 * declare them for the egress proxy.
 */
export function hostMatches(host, pattern) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  const p = String(pattern).toLowerCase().replace(/\.$/, "");
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

/**
 * Turn a Playwright error into one line an agent can act on: what failed and,
 * when Playwright knows, why (an overlay in the way, a detached element, …).
 */
export function explainError(message) {
  const text = String(message ?? "");
  const first = text.split("\n")[0].replace(/^(page|locator|frame|elementHandle)\.\w+: /, "");
  if (/intercepts pointer events/.test(text)) {
    return `${first} Something on the page covers this element (often a cookie banner, a dialog or a menu): take a snapshot and close it first.`;
  }
  if (/element is not (visible|enabled|editable)/.test(text)) {
    const why = /not (visible|enabled|editable)/.exec(text)[1];
    return `${first} The element is not ${why}; take a snapshot, it may need scrolling, another step first, or it may be disabled.`;
  }
  if (/Malformed value/.test(text)) {
    return `${first} The field wants a specific format (a time field wants HH:MM, a date field YYYY-MM-DD).`;
  }
  if (/Timeout \d+ms exceeded/.test(first)) {
    return `${first} Take a snapshot to see what the page shows now.`;
  }
  return first;
}

// ============================================================================
// Handoff: input from the user's live view
// ============================================================================

/** Named keys the live view may press (Playwright names, as KeyboardEvent.key gives them). */
const NAMED_KEYS = new Set([
  "Enter", "Tab", "Backspace", "Delete", "Escape", "Space", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Shift", "Control", "Alt", "Meta", "Insert",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);
const MOUSE_TYPES = new Set(["move", "down", "up", "wheel"]);
const BUTTONS = new Set(["left", "right", "middle"]);
const finite = (n, lo, hi) => typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;

/**
 * A Web PubSub group message from the live view, checked and narrowed, or
 * null. Only the user the handoff was issued to may drive the browser:
 * `fromUserId` is set by Web PubSub from the sender's token, not by the sender.
 */
export function parseViewerInput(message, viewerUserId) {
  if (!message || message.type !== "message" || message.from !== "group") return null;
  if (!viewerUserId || message.fromUserId !== viewerUserId) return null;
  const d = message.data;
  if (!d || typeof d !== "object") return null;
  switch (d.kind) {
    case "hello":
    case "ping":
    case "done":
    case "cancel":
      return { kind: d.kind };
    case "dialog":
      // The user's answer to a confirm or prompt the page showed.
      if (typeof d.accept !== "boolean") return null;
      return { kind: "dialog", accept: d.accept, text: typeof d.text === "string" ? d.text.slice(0, 500) : "" };
    case "mouse": {
      if (!MOUSE_TYPES.has(d.type) || !finite(d.x, 0, 10000) || !finite(d.y, 0, 10000)) return null;
      const out = { kind: "mouse", type: d.type, x: d.x, y: d.y, button: BUTTONS.has(d.button) ? d.button : "left" };
      if (d.type === "wheel") {
        out.deltaX = finite(d.deltaX, -5000, 5000) ? d.deltaX : 0;
        out.deltaY = finite(d.deltaY, -5000, 5000) ? d.deltaY : 0;
      }
      return out;
    }
    case "key": {
      if (d.type !== "down" && d.type !== "up") return null;
      const key = typeof d.key === "string" ? d.key : "";
      // One printable character, or a named key: never a chord string the page didn't send.
      if (!(NAMED_KEYS.has(key) || [...key].length === 1)) return null;
      return { kind: "key", type: d.type, key: key === " " ? "Space" : key };
    }
    case "text": {
      if (typeof d.text !== "string" || !d.text || d.text.length > 2000) return null;
      return { kind: "text", text: d.text };
    }
    default:
      return null;
  }
}

// ============================================================================
// Card numbers
// ============================================================================

/** The Luhn check every payment card number passes. */
export function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Whether a value is a payment card number: 13–19 digits (spaces or dashes allowed) that pass Luhn. */
export function isCardNumber(value) {
  const digits = String(value ?? "").replace(/[\s-]/g, "");
  return /^\d{13,19}$/.test(digits) && luhn(digits);
}

/**
 * Hide anything in text that is a card number, so page text, labels and
 * field values the model reads never carry one (the user may have typed it).
 */
export function maskCardNumbers(text) {
  return String(text).replace(/\d(?:[ -]?\d){12,18}/g, (run) => (isCardNumber(run) ? "••••" : run));
}

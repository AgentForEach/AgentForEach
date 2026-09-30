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

const WALL_TITLES = [
  /^just a moment/i,
  /^attention required/i,
  /^access denied/i,
  /^security check/i,
  /are you a robot/i,
  /^verify you are human/i,
  /^403 forbidden/i,
  /^request blocked/i,
];

/** What bot walls say on the page (Reddit, DuckDuckGo, Cloudflare, Akamai, PerimeterX, Google). */
const WALL_TEXT = [
  /blocked by network security/i,
  /verify (that )?you are (a )?human/i,
  /are you a robot/i,
  /unusual traffic from your (computer )?network/i,
  /bots use duckduckgo too/i,
  /checking (if the site connection is secure|your browser)/i,
  /press (&|and) hold/i,
  /you don't have permission to access .* on this server/i,
  /please enable (javascript and )?cookies to continue/i,
];

/**
 * Whether a page looks like a bot wall (Cloudflare, Akamai and friends
 * challenge datacenter IPs). The agent should tell the user, not retry.
 * `text` is the start of the page's visible text; walls often answer 200.
 */
export function looksBlocked({ status, title, text }) {
  if (status === 429) return true;
  const t = (title ?? "").trim();
  if (WALL_TITLES.some((re) => re.test(t))) return true;
  // A 403 with a real page (a login form, an error page with links) isn't necessarily a wall; one with little text is.
  if (status === 403 && (text ?? "").length < 400) return true;
  return WALL_TEXT.some((re) => re.test((text ?? "").slice(0, 600)));
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

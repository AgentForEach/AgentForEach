/**
 * The egress rules a sandbox's outbound HTTP and HTTPS go through, outside
 * the sandbox (in the Worker): deny by default, allow listed hosts, and add
 * credential headers for the hosts a credential names, so a secret never
 * enters the sandbox. Pure, so it is tested without the Workers runtime.
 */

import type { EgressCredential } from "@agentforeach/platform";

/** What the outbound handler of one sandbox knows (its entrypoint props). */
export interface SandboxEgressProps {
  /**
   * Where the sandbox may go: "host" (exact), "*.example.com" (its
   * subdomains), or "host/path" to allow only paths under /path on that host
   * (the browser relay on the gateway's own host). Ports 80 and 443 only.
   */
  allowHosts: string[];
  /** Open egress (networkAccess "enabled"): every host is allowed. */
  internet: boolean;
  /** Headers to set on requests to the hosts each credential names. */
  credentials: EgressCredential[];
}

export type EgressDecision =
  | { allowed: true; headers: Array<[name: string, value: string]> }
  | { allowed: false; reason: string };

/** Whether `host` matches `pattern` (exact, or "*.domain" for any subdomain of domain). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase().trim().replace(/\.$/, "");
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

/** Whether `url` matches an allow entry: a host pattern, optionally with a path prefix. */
export function allowEntryMatches(url: URL, entry: string): boolean {
  const slash = entry.indexOf("/");
  if (slash === -1) return hostMatches(url.hostname, entry);
  const prefix = entry.slice(slash).replace(/\/+$/, "");
  if (!hostMatches(url.hostname, entry.slice(0, slash))) return false;
  return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`) || url.pathname.startsWith(`${prefix}?`);
}

/**
 * Why a host must never be reached from a sandbox, whatever the allowlist
 * says, or null: a local name, or a loopback, private, link-local,
 * carrier-grade NAT, metadata, multicast or unspecified IP literal. Names
 * are resolved by the Worker's own fetch, on Cloudflare's network.
 */
export function localTarget(rawHost: string): string | null {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (["localhost", "metadata", "metadata.google.internal"].includes(host)) return "a local name";
  if ([".localhost", ".local", ".internal", ".localdomain"].some((suffix) => host.endsWith(suffix))) return "a local name";
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return privateIPv4(v4.slice(1).map(Number)) ? "a local or private address" : null;
  if (!host.includes(":")) return null;
  const words = expandIPv6(host);
  if (!words) return null;
  // IPv4-mapped (::ffff:a.b.c.d, which URL parsing writes as hex words).
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    return privateIPv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]) ? "a local or private address" : null;
  }
  const unspecifiedOrLoopback = words.slice(0, 7).every((w) => w === 0) && words[7] <= 1;
  const uniqueLocal = (words[0] & 0xfe00) === 0xfc00;
  const linkLocal = (words[0] & 0xffc0) === 0xfe80;
  const multicast = (words[0] & 0xff00) === 0xff00;
  return unspecifiedOrLoopback || uniqueLocal || linkLocal || multicast ? "a local or private address" : null;
}

function privateIPv4([a, b]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** Eight 16-bit words of an IPv6 address (with a possible dotted IPv4 tail), or null. */
function expandIPv6(address: string): number[] | null {
  let text = address;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1].split(".").map(Number);
    text = `${text.slice(0, -tail[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

/** The port a URL goes to (the scheme's default when none is given). */
function portOf(url: URL): string {
  return url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
}

/**
 * Decide one outbound request: allow (with the headers to set) or deny.
 * A WebSocket upgrade (`websocket`) never gets credentials, and a credential
 * doesn't open its host to one: a page in the sandbox's browser can open
 * WebSockets the browser can't intercept, and would borrow them.
 */
export function egressDecision(url: URL, props: SandboxEgressProps, { websocket = false } = {}): EgressDecision {
  const host = url.hostname;
  const local = localTarget(host);
  if (local) return { allowed: false, reason: `blocked by the AgentForEach egress policy: ${host} is ${local}` };
  const port = portOf(url);
  // Credentials only ever go out encrypted, to the standard HTTPS port, and never on a WebSocket.
  const secure = (url.protocol === "https:" || url.protocol === "wss:") && port === "443" && !websocket;
  const headers: Array<[string, string]> = [];
  let credentialed = false;
  if (secure) {
    for (const credential of props.credentials) {
      if (credential.hosts.some((pattern) => hostMatches(host, pattern))) {
        headers.push([credential.header, credential.value]);
        credentialed = true;
      }
    }
  }
  if (props.internet) return { allowed: true, headers };
  if (port !== "80" && port !== "443") {
    return { allowed: false, reason: `blocked by the AgentForEach egress policy: port ${port} is not allowed` };
  }
  // A host a credential names is reachable, as with ACA Sandboxes, whose
  // credential rules also open the host.
  if (credentialed || props.allowHosts.some((entry) => allowEntryMatches(url, entry))) {
    return { allowed: true, headers };
  }
  return { allowed: false, reason: `blocked by the AgentForEach egress policy: ${host}${url.pathname} is not allowed` };
}

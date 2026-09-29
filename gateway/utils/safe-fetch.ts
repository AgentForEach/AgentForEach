/**
 * AgentForEach Utils — SSRF-safe outbound fetch
 *
 * Every fetch of a URL that a user, the LLM or a skill controls goes through
 * safeFetch (web_fetch, link understanding, http_fetch, cron webhooks).
 *
 *   - Only http(s), no credentials in the URL, no internal hostnames.
 *   - Every address a hostname resolves to is checked at CONNECT time, by
 *     the lookup the socket actually uses, so DNS rebinding (resolve public,
 *     then private) can't slip past a pre-flight check.
 *   - Redirects are followed by hand, up to maxRedirects, and each hop is
 *     re-validated; when a hop changes origin only the accept,
 *     accept-language, content-type and user-agent headers are kept.
 *   - Address classification uses net.BlockList, which also matches
 *     IPv4-mapped IPv6 (e.g. [::ffff:169.254.169.254]) against IPv4 rules.
 */

import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Response } from "undici";

// ============================================================================
// Address classification
// ============================================================================

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (IMDS)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 3], // multicast + reserved + broadcast
  ["168.63.129.16", 32], // Azure platform (WireServer / DNS / health)
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible (::a.b.c.d)
  ["64:ff9b::", 96], // NAT64 (reaches IPv4 space)
  ["64:ff9b:1::", 48], // local-use NAT64
  ["2001::", 32], // Teredo (embeds an IPv4 address)
  ["2002::", 16], // 6to4 (embeds an IPv4 address)
  ["::ffff:0:0:0", 96], // SIIT-translated IPv4 (::ffff:0:a.b.c.d); not ::ffff:0:0/96, which is all IPv4-mapped space
  ["100::", 64], // discard-only
  ["fec0::", 10], // deprecated site-local
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

const METADATA = new BlockList();
METADATA.addSubnet("169.254.0.0", 16, "ipv4");

/** Why an IP address may not be fetched, or null when it may. */
export function blockedAddressReason(ip: string): string | null {
  const family = isIP(ip);
  if (family === 0) return "not an IP address";
  const type = family === 4 ? "ipv4" : "ipv6";
  if (METADATA.check(ip, type)) return `cloud metadata / link-local address ${ip}`;
  return BLOCKED.check(ip, type)
    ? `private IP ${ip} (private, loopback, CGNAT or reserved range)`
    : null;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.internal",
]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain"];

/** Parse and check a URL before any network activity. */
export function checkUrl(
  raw: string | URL,
  isBlocked: (ip: string) => string | null = blockedAddressReason,
): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme ${url.protocol} not allowed` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials in the URL are not allowed" };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return { ok: false, reason: "missing host" };
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: `host ${host} is internal` };
  }
  // WHATWG URL already normalised numeric forms (2130706433, 0x7f.1) to dotted IPv4.
  // IP literals skip DNS, so the connect-time lookup never sees them.
  if (isIP(host)) {
    const reason = isBlocked(host);
    if (reason) return { ok: false, reason };
  }
  return { ok: true, url };
}

// ============================================================================
// Connect-time DNS guard
// ============================================================================

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))),
  );

export class SsrfBlockedError extends Error {
  override name = "SsrfBlockedError";
}

/** Whether a fetch failed because of an SSRF block (undici wraps it in `cause`). */
export function isSsrfBlocked(err: unknown): err is Error {
  return (
    err instanceof SsrfBlockedError ||
    (err instanceof Error && err.cause instanceof SsrfBlockedError)
  );
}

/**
 * Headers safe to keep when a redirect changes origin. Everything else
 * (Authorization, API keys in custom headers, cookies) is dropped.
 */
const CROSS_ORIGIN_SAFE_HEADERS = new Set(["accept", "accept-language", "content-type", "user-agent"]);

function keepCrossOriginSafeHeaders(headers: SafeFetchInit["headers"]): Record<string, string> | undefined {
  if (!headers) return undefined;
  const entries: Array<[string, string]> =
    headers instanceof Headers || (typeof headers === "object" && "forEach" in headers && !Array.isArray(headers))
      ? [...(headers as Headers).entries()]
      : Array.isArray(headers)
        ? (headers as Array<[string, string]>)
        : Object.entries(headers as Record<string, string>);
  return Object.fromEntries(entries.filter(([k]) => CROSS_ORIGIN_SAFE_HEADERS.has(k.toLowerCase())));
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for net/tls sockets that resolves every address and refuses the
 * connection if any is blocked (a mix of public and private answers is how
 * rebinding hides).
 */
function guardedLookup(resolver: Resolver, isBlocked: (ip: string) => string | null) {
  return (hostname: string, options: { all?: boolean } | number, callback: LookupCallback) => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          return callback(Object.assign(new Error(`no addresses for ${hostname}`), { code: "ENOTFOUND" }), []);
        }
        for (const a of addresses) {
          const reason = isBlocked(a.address);
          if (reason) return callback(new SsrfBlockedError(`SSRF blocked: ${hostname} → ${reason}`), []);
        }
        if (typeof options === "object" && options.all) return callback(null, addresses);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, []),
    );
  };
}

// ============================================================================
// safeFetch
// ============================================================================

export type SafeFetchInit = Omit<UndiciRequestInit, "redirect" | "dispatcher"> & {
  /** Redirect hops to follow, each re-validated (default 5). */
  maxRedirects?: number;
  /** Abort after this long, across all hops (default 30 s). */
  timeoutMs?: number;
  /** DNS resolver (tests). */
  resolver?: Resolver;
  /** Address check (tests only: lets a loopback test server through). */
  isBlockedAddress?: (ip: string) => string | null;
};

let defaultAgent: Agent | undefined;

/**
 * Test hook: replaces the network call (URL checks and redirect handling
 * still run). Never set outside tests.
 */
export const safeFetchTestHooks: { fetch?: typeof undiciFetch } = {};

/**
 * fetch() for untrusted URLs. Throws SsrfBlockedError when the URL or any
 * hop resolves to an internal address; otherwise behaves like fetch with
 * redirects followed.
 */
export async function safeFetch(input: string | URL, init: SafeFetchInit = {}): Promise<Response> {
  const {
    maxRedirects = 5,
    timeoutMs = 30_000,
    resolver,
    isBlockedAddress,
    signal,
    ...requestInit
  } = init;

  const isBlocked = isBlockedAddress ?? blockedAddressReason;
  const dispatcher =
    resolver || isBlockedAddress
      ? new Agent({ connect: { lookup: guardedLookup(resolver ?? systemResolver, isBlocked) } })
      : (defaultAgent ??= new Agent({ connect: { lookup: guardedLookup(systemResolver, isBlocked) } }));

  const timeout = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal as AbortSignal, timeout]) : timeout;

  let current = checkedUrl(input, isBlocked);
  let method = (requestInit.method ?? "GET").toUpperCase();
  let body = requestInit.body;
  let headers = requestInit.headers;

  for (let hop = 0; ; hop++) {
    const response = await (safeFetchTestHooks.fetch ?? undiciFetch)(current, {
      ...requestInit,
      method,
      body,
      headers,
      redirect: "manual",
      dispatcher,
      signal: combinedSignal,
    });

    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
    await response.body?.cancel().catch(() => {});
    if (hop >= maxRedirects) throw new Error(`Too many redirects (>${maxRedirects})`);

    const next = checkedUrl(new URL(location, current), isBlocked);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
    if (next.origin !== current.origin) {
      // No secrets across origins: the body may carry substituted credentials
      // (a 307/308 would re-send it), and so may most headers.
      if (body !== undefined) throw new SsrfBlockedError("Refusing to re-send a request body to another origin");
      headers = keepCrossOriginSafeHeaders(headers);
    }
    current = next;
  }
}

function checkedUrl(input: string | URL, isBlocked: (ip: string) => string | null): URL {
  const result = checkUrl(input, isBlocked);
  if (!result.ok) throw new SsrfBlockedError(`SSRF blocked: ${result.reason}`);
  return result.url;
}

/** A fetch Response from undici or Node's global fetch; only the body is used. */
export interface ResponseWithBody {
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
      releaseLock(): void;
    };
  } | null;
}

/**
 * Read at most `maxBytes` of a response body, then cancel the rest.
 * Reading with arrayBuffer() first would buffer a huge (or decompressed
 * gzip-bomb) body in memory before any truncation.
 */
export async function readBodyBytes(
  response: ResponseWithBody,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) return { bytes: Buffer.concat(chunks, total), truncated: false };
      const room = maxBytes - total;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        await reader.cancel().catch(() => {});
        return { bytes: Buffer.concat(chunks, maxBytes), truncated: true };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Read at most `maxBytes` of a response body as UTF-8 text (see readBodyBytes). */
export async function readBodyText(
  response: ResponseWithBody,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await readBodyBytes(response, maxBytes);
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), truncated };
}

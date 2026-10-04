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
 *
 * How a request goes out is the host's transport (`installSafeFetchTransport`);
 * every check above runs the same whichever it is:
 *   - Node (Azure): `safe-fetch-node.ts`, undici with the guarded lookup on
 *     the socket, so the address checked is the address connected to. The
 *     Node entry point installs it.
 *   - fetch-only runtimes (Cloudflare Workers): `fetchTransport`, the
 *     default. It resolves and checks every address before each hop, then
 *     calls the platform's fetch. That fetch resolves the name again, so an
 *     answer that changes in between (DNS rebinding) isn't caught; on
 *     Workers the window is harmless, because private and metadata addresses
 *     aren't reachable from Cloudflare's network.
 */

import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";

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

/** An IPv6 address as its eight 16-bit words, in any spelling, or undefined when it isn't one. */
function ipv6Words(ip: string): number[] | undefined {
  const address = ip.split("%")[0]!.toLowerCase();
  if (isIP(address) !== 6) return undefined;
  let text = address;
  let tail: number[] = [];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    tail = dotted[2]!.split(".").map(Number);
    text = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const parse = (part: string) => (part ? part.split(":") : []);
  const width = 8 - (dotted ? 2 : 0);
  const halves = text.split("::");
  const groups =
    halves.length === 2
      ? [...parse(halves[0]!), ...Array(width - parse(halves[0]!).length - parse(halves[1]!).length).fill("0"), ...parse(halves[1]!)]
      : parse(text);
  const words = groups.map((g) => parseInt(g, 16));
  if (dotted) words.push((tail[0]! << 8) | tail[1]!, (tail[2]! << 8) | tail[3]!);
  return words.length === 8 ? words : undefined;
}

const zeros = (words: number[], from: number, to: number) => words.slice(from, to).every((w) => w === 0);
const ipv4Of = (words: number[]) => [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff].join(".");

/**
 * The IPv4 address an IPv4-mapped IPv6 address (::ffff:a.b.c.d) stands for,
 * in any spelling (compressed or not, hex or dotted, any case), or undefined
 * for any other address. Node's BlockList checks mapped addresses against the
 * IPv4 rules itself; workerd's lets the expanded forms through, so they are
 * normalised here, on every host.
 */
export function mappedIPv4(ip: string): string | undefined {
  const words = ipv6Words(ip);
  return words && zeros(words, 0, 5) && words[5] === 0xffff ? ipv4Of(words) : undefined;
}

/** A SIIT-translated IPv4 address (::ffff:0:a.b.c.d), in any spelling: always refused. */
function isSiit(ip: string): boolean {
  const words = ipv6Words(ip);
  return !!words && zeros(words, 0, 4) && words[4] === 0xffff && words[5] === 0;
}

type AddressLists = { metadata: Pick<BlockList, "check">; blocked: Pick<BlockList, "check"> };
const ADDRESS_LISTS: AddressLists = { metadata: METADATA, blocked: BLOCKED };

/**
 * Why an IP address may not be fetched, or null when it may. Never throws:
 * an address the lists can't check is refused (workerd's BlockList throws on
 * some IPv6 spellings), so callers always see an SSRF refusal.
 */
export function blockedAddressReason(ip: string, lists: AddressLists = ADDRESS_LISTS): string | null {
  const family = isIP(ip);
  if (family === 0) return "not an IP address";
  // workerd's BlockList reads any ::ffff: prefix as IPv4-mapped and throws on this one.
  if (family === 6 && isSiit(ip)) return `SIIT-translated IPv4 address ${ip}`;
  // An IPv4-mapped address is the IPv4 address it maps, whatever its spelling.
  const checked = (family === 6 && mappedIPv4(ip)) || ip;
  const type = isIP(checked) === 4 ? "ipv4" : "ipv6";
  try {
    if (lists.metadata.check(checked, type)) return `cloud metadata / link-local address ${ip}`;
    return lists.blocked.check(checked, type)
      ? `private IP ${ip} (private, loopback, CGNAT or reserved range)`
      : null;
  } catch (err) {
    return `address ${ip} couldn't be checked (${err instanceof Error ? err.message : String(err)})`;
  }
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

export const systemResolver: Resolver = (hostname) =>
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
 * Why a hostname's answers may not be connected to, or null when they may:
 * no answer at all, or any blocked address among them (a mix of public and
 * private answers is how rebinding hides).
 */
function refusal(hostname: string, addresses: LookupAddress[], isBlocked: (ip: string) => string | null): Error | null {
  if (addresses.length === 0) {
    return Object.assign(new Error(`no addresses for ${hostname}`), { code: "ENOTFOUND" });
  }
  for (const a of addresses) {
    const reason = isBlocked(a.address);
    if (reason) return new SsrfBlockedError(`SSRF blocked: ${hostname} → ${reason}`);
  }
  return null;
}

/**
 * A `lookup` for net/tls sockets that resolves every address and refuses the
 * connection if any is blocked.
 */
export function guardedLookup(resolver: Resolver, isBlocked: (ip: string) => string | null) {
  return (hostname: string, options: { all?: boolean } | number, callback: LookupCallback) => {
    resolver(hostname).then(
      (addresses) => {
        const refused = refusal(hostname, addresses, isBlocked);
        if (refused) return callback(refused, []);
        if (typeof options === "object" && options.all) return callback(null, addresses);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, []),
    );
  };
}

// ============================================================================
// Transports
// ============================================================================

/** The address checks a hop must obey: the resolver and the address test. */
export interface AddressGuard {
  resolver: Resolver;
  isBlocked: (ip: string) => string | null;
  /** True when a caller (a test) replaced the system resolver or address test. */
  custom: boolean;
}

/** One request, as safeFetch sends it: redirects are never followed by the transport. */
export type HopInit = Omit<RequestInit, "redirect" | "signal"> & { redirect: "manual"; signal: AbortSignal };

/**
 * How one hop goes out. A transport must make `guard` apply to the
 * addresses it connects to; safeFetch has already checked the URL.
 */
export interface SafeFetchTransport {
  readonly name: string;
  send(url: URL, init: HopInit, guard: AddressGuard): Promise<Response>;
}

/**
 * For runtimes with only fetch (Cloudflare Workers): resolve the host and
 * check every address before the hop, then fetch. See the module docs for
 * the rebinding window this leaves, and why it's acceptable there.
 */
export const fetchTransport: SafeFetchTransport = {
  name: "fetch",
  async send(url, init, guard) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!isIP(host)) {
      const refused = refusal(host, await guard.resolver(host), guard.isBlocked);
      if (refused) throw refused;
    }
    return fetch(url, init);
  },
};

/**
 * Node itself: not workerd, which defines process.versions.node under
 * nodejs_compat but says who it is, and not Bun or Deno, whose undici
 * compatibility may not route connections through the guarded lookup (they
 * get the fetch transport, which checks before every hop).
 */
function onNode(): boolean {
  if (typeof process === "undefined" || typeof process.versions?.node !== "string") return false;
  const versions = process.versions as Record<string, string | undefined>;
  if (versions.bun || versions.deno) return false;
  return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent !== "Cloudflare-Workers";
}

let nodeTransport: Promise<SafeFetchTransport> | undefined;

/**
 * On Node, `safe-fetch-node.ts`'s transport, loaded on first use: any Node
 * caller gets it (an embedder's createAgentClient, a script, a test), not
 * only the entry points that import it. The specifier isn't a literal, so a
 * bundler doesn't follow it: a Worker bundle never reaches undici. Where it
 * can't be loaded (an embedder bundled the gateway into one file), the fetch
 * transport is used instead, with a warning once.
 */
const lazyNodeTransport: SafeFetchTransport = {
  name: "node",
  async send(url, init, guard) {
    nodeTransport ??= loadNodeTransport();
    return (await nodeTransport).send(url, init, guard);
  },
};

/** Load the Node transport, or fall back to fetch (exported for tests, with a specifier that may not exist). */
export async function loadNodeTransport(specifier = "./safe-fetch-node.js"): Promise<SafeFetchTransport> {
  try {
    return ((await import(specifier)) as { nodeTransport: SafeFetchTransport }).nodeTransport;
  } catch (err) {
    console.warn(
      `[safe-fetch] the Node transport (${specifier}) couldn't be loaded, so requests use the fetch transport, ` +
        `which checks addresses before each hop but not at connect time. Import utils/safe-fetch-node.js ` +
        `from your entry point to use it. (${err instanceof Error ? err.message : String(err)})`,
    );
    return fetchTransport;
  }
}

let transport: SafeFetchTransport = onNode() ? lazyNodeTransport : fetchTransport;

/** Set by a host's entry point (Node installs `safe-fetch-node.ts`'s transport). */
export function installSafeFetchTransport(next: SafeFetchTransport): void {
  transport = next;
}

/** The transport in use, e.g. for a host's startup log. */
export function safeFetchTransport(): SafeFetchTransport {
  return transport;
}

// ============================================================================
// safeFetch
// ============================================================================

export type SafeFetchInit = Omit<RequestInit, "redirect"> & {
  /** Redirect hops to follow, each re-validated (default 5). */
  maxRedirects?: number;
  /** Abort after this long, across all hops (default 30 s). */
  timeoutMs?: number;
  /** DNS resolver (tests). */
  resolver?: Resolver;
  /** Address check (tests only: lets a loopback test server through). */
  isBlockedAddress?: (ip: string) => string | null;
};

/**
 * Test hook: replaces the network call, transport included (URL checks and
 * redirect handling still run). Never set outside tests.
 */
export const safeFetchTestHooks: { fetch?: (url: URL, init: HopInit) => Promise<Response> } = {};

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
  const guard: AddressGuard = {
    resolver: resolver ?? systemResolver,
    isBlocked,
    custom: Boolean(resolver || isBlockedAddress),
  };

  const timeout = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal as AbortSignal, timeout]) : timeout;

  let current = checkedUrl(input, isBlocked);
  let method = (requestInit.method ?? "GET").toUpperCase();
  let body = requestInit.body;
  let headers = requestInit.headers;

  for (let hop = 0; ; hop++) {
    const request: HopInit = { ...requestInit, method, body, headers, redirect: "manual", signal: combinedSignal };
    const response = await (safeFetchTestHooks.fetch
      ? safeFetchTestHooks.fetch(current, request)
      : transport.send(current, request, guard));

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

/** Bounded body reads, shared with the platform packs. */
export { readBodyBytes, readBodyText, type ResponseWithBody } from "@agentforeach/platform";

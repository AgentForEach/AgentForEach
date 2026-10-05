/**
 * The Lambda HTTP host: serves the gateway's routes behind an API Gateway
 * HTTP API (payload format 2.0).
 *
 * It only translates: the event becomes a Fetch `Request` and the shared
 * Fetch host (`createFetchHost` in @agentforeach/platform) routes it, exactly
 * as on a Cloudflare Worker; the `Response` becomes the result API Gateway
 * expects. On the way:
 * - Payload 1.0 (REST API) events are refused with a 400, as are paths that
 *   could change the URL's origin and GET or HEAD requests with a body.
 * - The body arrives as text or base64 (`isBase64Encoded`); the bytes are
 *   kept exactly, so webhook signatures still verify.
 * - API Gateway sends cookies apart from the headers, and takes `Set-Cookie`
 *   back in `cookies`; both are moved where each side expects them.
 * - A deployed base path (a stage such as /prod) is stripped when given.
 * - A text response goes back as text; anything else base64-encoded.
 * - The origin handlers see is the configured one, or the API's own domain
 *   name: never a request header.
 *
 * Every request gets a deadline (`HandlerContext.deadlineAt`): 25 s by
 * default, under API Gateway's 30 s, and never later than the function's
 * remaining time allows. Lambda freezes the process once the handler
 * returns, so the request's background work is awaited before returning,
 * until that deadline (`backgroundAfterResponse: false`).
 */

import { createFetchHost, type CorsPolicy, type RouteDef } from "@agentforeach/platform";
import { lambdaDeadline, settleBeforeReturn, type LambdaContext } from "./lambda.js";

/** An API Gateway HTTP API event, payload format 2.0: the fields the host reads. */
export interface HttpApiV2Event {
  version: "2.0";
  rawPath: string;
  rawQueryString: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: {
    requestId: string;
    domainName: string;
    http: { method: string; path?: string; sourceIp?: string; protocol?: string };
  };
}

/** What the handler returns to API Gateway. */
export interface HttpApiV2Result {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: boolean;
}

export interface LambdaHttpOptions {
  /** The routes, built once on first use. */
  routes: () => readonly RouteDef[];
  /** The gateway's public origin, e.g. "https://api.example.com". Default: https:// and the API's domain name. */
  origin?: string;
  /** A base path the API is deployed under (a stage, e.g. "/prod"), stripped before routing. Requests outside it get a 404. */
  basePath?: string;
  /** Each request's budget in ms, at most 29 000 (under API Gateway's 30 s). Default 25 000. */
  requestTimeoutMs?: number;
  /** CORS for routes that don't handle it themselves. Default: CORS_ALLOWED_ORIGINS. */
  cors?: () => CorsPolicy;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const MAX_REQUEST_TIMEOUT_MS = 29_000;
/** Content types sent back as text; everything else is base64. */
const TEXT_TYPES = /^text\/|json|javascript|xml|x-www-form-urlencoded/i;

/** Thrown for an event the host refuses: its status, and a message safe to send. */
class EventError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function result(status: number, error?: string): HttpApiV2Result {
  return error === undefined
    ? { statusCode: status, headers: {}, body: "", isBase64Encoded: false }
    : { statusCode: status, headers: { "content-type": "application/json" }, body: JSON.stringify({ error }), isBase64Encoded: false };
}

/** The origin requests are addressed to, checked once: scheme and host only. */
function checkedOrigin(origin: string): string {
  const url = new URL(origin);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`origin must be a scheme and host only, e.g. "https://api.example.com": got "${origin}"`);
  }
  return url.origin;
}

/** The Fetch request for an event. */
function toRequest(event: HttpApiV2Event, origin: string | undefined, basePath: string): Request {
  if (event?.version !== "2.0" || typeof event.rawPath !== "string" || !event.requestContext?.http?.method) {
    throw new EventError(400, "Expected an API Gateway HTTP API event, payload format 2.0");
  }
  let path = event.rawPath;
  // Nothing in the path may change what the URL points at.
  if (!path.startsWith("/") || path.startsWith("//") || /[?#\\]/.test(path)) throw new EventError(400, "Invalid path");
  if (basePath) {
    if (path !== basePath && !path.startsWith(`${basePath}/`)) throw new EventError(404, "");
    path = path.slice(basePath.length) || "/";
  }
  const domain = event.requestContext.domainName;
  if (!origin && (!domain || /[/?#@\\]/.test(domain))) throw new EventError(400, "Invalid domain name");
  const url = new URL(path, origin ?? `https://${domain}`);
  url.search = event.rawQueryString ?? "";

  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) if (value !== undefined) headers.set(name, value);
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
  const method = event.requestContext.http.method.toUpperCase();
  const body = event.body === undefined ? undefined : Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
  if (method === "GET" || method === "HEAD") {
    if (body?.length) throw new EventError(400, "A GET or HEAD request can't have a body");
    return new Request(url, { method, headers });
  }
  return new Request(url, { method, headers, body });
}

/** API Gateway's result for a response. */
async function toResult(response: Response, method: string): Promise<HttpApiV2Result> {
  const cookies = response.headers.getSetCookie();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const bytes = method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
  const text = bytes.length === 0 || TEXT_TYPES.test(headers["content-type"] ?? "");
  return {
    statusCode: response.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: bytes.toString(text ? "utf8" : "base64"),
    isBase64Encoded: !text,
  };
}

/** The `http` handler of a Lambda entry point. */
export function createLambdaHttpHandler(options: LambdaHttpOptions) {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!(timeoutMs > 0 && timeoutMs <= MAX_REQUEST_TIMEOUT_MS)) {
    throw new Error(`requestTimeoutMs must be between 1 and ${MAX_REQUEST_TIMEOUT_MS}: got ${timeoutMs}`);
  }
  const basePath = options.basePath?.replace(/\/+$/, "") ?? "";
  if (basePath && !/^\/[^?#\\]*$/.test(basePath)) throw new Error(`basePath must start with "/": got "${options.basePath}"`);
  const origin = options.origin ? checkedOrigin(options.origin) : undefined;

  let routes: readonly RouteDef[] | undefined;
  const http = createFetchHost({ routes: () => (routes ??= options.routes()), cors: options.cors });

  return async (event: HttpApiV2Event, context: LambdaContext): Promise<HttpApiV2Result> => {
    const deadlineAt = lambdaDeadline(context, timeoutMs);
    let request: Request;
    try {
      request = toRequest(event, origin, basePath);
    } catch (err) {
      if (err instanceof EventError) return result(err.status, err.message || undefined);
      return result(400, "Invalid HTTP event");
    }
    try {
      const response = await http.dispatch(request, {
        invocationId: context.awsRequestId,
        deadlineAt,
        settle: (opened, route) => settleBeforeReturn(opened, deadlineAt, route.name),
      });
      return await toResult(response, request.method);
    } catch (err) {
      console.error(`[host] request ${context.awsRequestId} failed:`, err);
      return result(500);
    }
  };
}

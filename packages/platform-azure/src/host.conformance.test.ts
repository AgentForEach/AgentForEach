/**
 * The host conformance suite on the Azure registration, in process.
 *
 * What runs is registerFunctions' handlers, with the request and context as
 * Azure's own classes (@azure/functions HttpRequest, InvocationContext), so
 * handlers written against HttpRequestLike are checked against what Azure
 * really hands them, and every invocation runs in its scope. The Functions
 * host itself (routing, a handler error's 500, CORS preflights from the
 * host's CORS settings) doesn't run in a test: routing here is matchRoute,
 * which reproduces the host's rules, and the two host-only behaviours are
 * skipped (a deployed Function App does them from its host settings).
 */

import functions, { type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { matchRoute, type HttpMethod } from "@agentforeach/platform";
import { hostConformanceTable, runHostConformance } from "@agentforeach/platform/host/conformance";
import { registerFunctions, type FunctionsApp } from "./host.js";

type Registered = {
  name: string;
  route: string;
  methods: HttpMethod[];
  handler: (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;
};

const registered: Registered[] = [];
const app: FunctionsApp = {
  http: (name, options) => void registered.push({ name, ...(options as unknown as Omit<Registered, "name">) }),
  timer: () => {},
};
registerFunctions(hostConformanceTable(), app);

// A CommonJS package whose classes Node can't see as named exports.
const { HttpRequest: AzureHttpRequest, InvocationContext: AzureInvocationContext } = functions;

/** Stands in for the Functions host: routes the request and builds Azure's HttpRequest for it. */
async function functionsHost(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const match = matchRoute(registered, request.method, url.pathname);
  if (!match) return new Response(null, { status: 404 });
  const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  const azureRequest = new AzureHttpRequest({
    method: request.method,
    url: request.url, // the query comes from the URL, repeated values included
    headers: Object.fromEntries(request.headers),
    params: match.params,
    ...(text ? { body: { string: text } } : {}),
  });
  const context = new AzureInvocationContext({ invocationId: crypto.randomUUID(), functionName: match.route.name });
  const result = await match.route.handler(azureRequest, context);
  const status = result.status ?? 200;
  const body = status === 204 || status === 304 ? null : ((result.body as string | undefined) ?? null);
  return new Response(body, { status, headers: result.headers as Record<string, string> | undefined });
}

runHostConformance({
  name: "Azure registration (in process, Azure's request classes)",
  fetch: functionsHost,
  // Both are the Functions host's own work, not the registration's.
  answersPreflights: false,
  handlesErrors: false,
});

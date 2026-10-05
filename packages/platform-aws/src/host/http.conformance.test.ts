/**
 * The host conformance suite on the Lambda HTTP host, in process: each
 * request becomes the payload 2.0 event API Gateway would send, and the
 * result the Response API Gateway would return.
 */
import { hostConformanceTable, runHostConformance } from "@agentforeach/platform/host/conformance";
import { createLambdaHttpHandler, type HttpApiV2Event, type HttpApiV2Result } from "./http.js";

const handler = createLambdaHttpHandler({ routes: () => hostConformanceTable().routes });
let requests = 0;

/** Stands in for API Gateway: the event for a request, and the response for a result. */
async function apiGateway(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (name !== "cookie") headers[name] = value;
  });
  const bytes = Buffer.from(await request.arrayBuffer());
  const event: HttpApiV2Event = {
    version: "2.0",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    cookies: request.headers.get("cookie")?.split("; "),
    ...(bytes.length ? { body: bytes.toString("base64"), isBase64Encoded: true } : {}),
    requestContext: { requestId: `api-${++requests}`, domainName: url.host, http: { method: request.method } },
  };
  const result: HttpApiV2Result = await handler(event, { awsRequestId: `lambda-${requests}`, getRemainingTimeInMillis: () => 60_000 });
  const responseHeaders = new Headers(result.headers);
  for (const cookie of result.cookies ?? []) responseHeaders.append("set-cookie", cookie);
  const body = [101, 204, 205, 304].includes(result.statusCode) ? null : Buffer.from(result.body, result.isBase64Encoded ? "base64" : "utf8");
  return new Response(body, { status: result.statusCode, headers: responseHeaders });
}

runHostConformance({ name: "Lambda HTTP host (in process, payload 2.0)", fetch: apiGateway, backgroundAfterResponse: false });

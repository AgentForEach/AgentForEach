/**
 * SandboxEgress: the outbound handler every sandbox's HTTP and HTTPS is
 * intercepted to (ContainerSandbox registers it with its rules as props).
 * Export it from the worker entry; no binding is needed.
 *
 * WebSocket upgrades (the browser handoff's driver connects out over wss)
 * are relayed: the upstream socket is opened with fetch and bridged to a
 * WebSocketPair whose client end goes back to the sandbox. They never carry
 * credentials (see egressDecision).
 *
 * The request's URL carries the host the sandbox named in its Host header;
 * the TLS server name (SNI) isn't visible here. Credentials are decided on
 * that host, and the request is re-sent to that same host, so a credential
 * only reaches the host it is bound to, whatever SNI the sandbox used.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { egressDecision, type SandboxEgressProps } from "./egress-policy.js";

export class SandboxEgress extends WorkerEntrypoint<unknown, SandboxEgressProps> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    const decision = egressDecision(url, this.ctx.props, { websocket: upgrade });
    if (!decision.allowed) {
      console.log(JSON.stringify({ sandboxEgress: "deny", host: url.hostname, websocket: upgrade }));
      return new Response(`${decision.reason}\n`, { status: 403, headers: { "content-type": "text/plain" } });
    }
    const outbound = new Request(request);
    // Overwrites a placeholder the sandbox may have sent in the same header.
    for (const [name, value] of decision.headers) outbound.headers.set(name, value);
    if (!upgrade) return fetch(outbound);
    return relayWebSocket(outbound, url, (done) => this.ctx.waitUntil(done));
  }
}

/** A close code that may be sent: 1005, 1006 and 1015 only describe a close, and are replaced by 1000. */
function sendableCode(code?: number): number {
  return code === undefined || code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
}

/**
 * Open the upstream WebSocket and bridge it to a new pair; the client end
 * answers the sandbox. `keepAlive` holds this invocation open until both
 * sides close, and the end is logged (who closed, with what, after how long).
 */
async function relayWebSocket(request: Request, url: URL, keepAlive: (done: Promise<void>) => void): Promise<Response> {
  // fetch() opens WebSockets over http(s) URLs.
  const upstreamUrl = new URL(url);
  if (upstreamUrl.protocol === "wss:") upstreamUrl.protocol = "https:";
  if (upstreamUrl.protocol === "ws:") upstreamUrl.protocol = "http:";
  const response = await fetch(new Request(upstreamUrl, request));
  const upstream = response.webSocket;
  console.log(JSON.stringify({ sandboxEgress: "websocket", host: url.hostname, status: response.status, upstream: Boolean(upstream) }));
  if (!upstream) return response;
  upstream.accept();
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  const opened = Date.now();
  let ended = false;
  let finish!: () => void;
  keepAlive(new Promise<void>((resolve) => (finish = resolve)));
  const end = (side: "sandbox" | "upstream", how: string, code?: number, reason?: string) => {
    if (ended) return;
    ended = true;
    console.log(JSON.stringify({ sandboxEgress: "websocket ended", host: url.hostname, first: side, how, code, reason, ms: Date.now() - opened }));
    // Close both ends; one may already be closed.
    for (const socket of [server, upstream]) {
      try {
        socket.close(how === "error" ? 1011 : sendableCode(code), how === "error" ? `${side} side failed` : reason);
      } catch {
        // already closed
      }
    }
    finish();
  };
  server.addEventListener("message", (event) => upstream.send(event.data));
  upstream.addEventListener("message", (event) => server.send(event.data));
  server.addEventListener("close", (event) => end("sandbox", "close", event.code, event.reason));
  upstream.addEventListener("close", (event) => end("upstream", "close", event.code, event.reason));
  server.addEventListener("error", () => end("sandbox", "error"));
  upstream.addEventListener("error", () => end("upstream", "error"));
  // The subprotocol the upstream chose (the driver asks for json.webpubsub.azure.v1).
  const protocol = response.headers.get("sec-websocket-protocol");
  return new Response(null, { status: 101, webSocket: client, headers: protocol ? { "sec-websocket-protocol": protocol } : {} });
}

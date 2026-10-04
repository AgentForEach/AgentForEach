/**
 * Test Worker for the realtime conformance suite on workerd: the realtime
 * Durable Objects and upgrade router as the gateway wires them, an echo
 * handler standing in for the gateway's client events, and a small control
 * API (/test/*) the Node harness drives the provider through.
 */

import { CloudflareRealtime, handleRealtimeUpgrade } from "../../dist/realtime/provider.js";
import { defineUserSocket } from "../../dist/realtime/objects.js";
export { Relay } from "../../dist/realtime/objects.js";

type Env = { REALTIME_USER_SOCKET: any; REALTIME_RELAY: any; REALTIME_SIGNING_KEY: string };

// The conformance suite's echo handler stands in for the gateway's client event handler.
export const UserSocket = defineUserSocket<Env>({
  onEvent: () => async (e) => {
    if ((e.data as { fail?: boolean } | null)?.fail) throw new Error("conformance handler failed on purpose");
    return { reply: { echo: e.data, event: e.event, userId: e.userId } };
  },
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const options = { userSockets: env.REALTIME_USER_SOCKET, relays: env.REALTIME_RELAY, signingKey: env.REALTIME_SIGNING_KEY };
    const upgraded = await handleRealtimeUpgrade(request, options);
    if (upgraded) return upgraded;
    const provider = new CloudflareRealtime({ ...options, publicBaseUrl: new URL(request.url).origin, hub: "agentforeach" });
    const body: any = await request.json().catch(() => ({}));
    switch (new URL(request.url).pathname) {
      case "/test/clientAccess": return Response.json(await provider.clientAccess(body.userId, body.options));
      case "/test/groupAccess": return Response.json(await provider.relay.groupAccess(body));
      case "/test/sendToUser": await provider.sendToUser(body.userId, body.data); return Response.json({});
      case "/test/isUserOnline": return Response.json(await provider.isUserOnline(body.userId));
      case "/test/disconnectUser": await provider.disconnectUser(body.userId, body.reason); return Response.json({});
      case "/test/relayHost": return Response.json(provider.relay.host);
    }
    return new Response("not found", { status: 404 });
  },
};

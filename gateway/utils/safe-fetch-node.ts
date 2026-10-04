/**
 * AgentForEach Utils — safeFetch's Node transport
 *
 * Importing this module installs it. The Node entry point (the Azure
 * Functions app, `gateway/index.ts`) does, first thing; any other Node
 * caller gets it anyway, loaded by safe-fetch.ts on the first request.
 *
 * undici connects with the guarded lookup, so every address a hostname
 * resolves to is checked by the lookup the socket actually uses: the address
 * checked is the address connected to, and DNS rebinding (resolve public,
 * then private) can't slip past. Kept apart from safe-fetch.ts so a bundle
 * for a fetch-only runtime (a Cloudflare Worker) never reaches undici.
 */

import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import {
  blockedAddressReason,
  guardedLookup,
  installSafeFetchTransport,
  systemResolver,
  type SafeFetchTransport,
} from "./safe-fetch.js";

let defaultAgent: Agent | undefined;

export const nodeTransport: SafeFetchTransport = {
  name: "node",
  send(url, init, guard) {
    // A caller's own resolver or address test (tests) gets an agent of its own;
    // everyone else shares one.
    const dispatcher = guard.custom
      ? new Agent({ connect: { lookup: guardedLookup(guard.resolver, guard.isBlocked) } })
      : (defaultAgent ??= new Agent({ connect: { lookup: guardedLookup(systemResolver, blockedAddressReason) } }));
    return undiciFetch(url, { ...(init as UndiciRequestInit), dispatcher }) as unknown as Promise<Response>;
  },
};

installSafeFetchTransport(nodeTransport);

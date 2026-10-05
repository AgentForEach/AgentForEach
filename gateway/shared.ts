/**
 * AgentForEach Gateway — Shared Client Singleton
 *
 * Provides a lazily-initialized, cached AgentClient for use across
 * all Azure Function handlers. The client is created once per process
 * and reused across invocations (Azure Functions Node.js v4 model
 * shares a single process across invocations on the same instance).
 *
 * Configuration is auto-resolved from agentforeach.json by each subsystem's
 * config module (database, llms, websocket, sessions, memory).
 * Environment variables override agentforeach.json values as documented in
 * each config module.
 */

import { background } from "@agentforeach/platform";
import { createAgentClient, type AgentClient } from "./client/index.js";

let _client: AgentClient | null = null;
let _initPromise: Promise<void> | null = null;

/**
 * Get the shared AgentClient singleton.
 *
 * Lazily creates and initializes the client on first call.
 * Subsequent calls return the cached instance.
 *
 * All configuration is auto-resolved from agentforeach.json via each
 * subsystem's config module. No manual config wiring needed.
 */
export async function getAgentClient(): Promise<AgentClient> {
  if (!_client) {
    _client = createAgentClient();
    _initPromise = _client.initialize();
    // Every request in this process or isolate awaits it. On a Worker, a
    // request that ends first would take its I/O with it and leave the rest
    // waiting forever, so it is background work of the request that began it.
    background(_initPromise, () => {});
  }

  try {
    // Await initialization (no-ops after first call resolves)
    await _initPromise;
  } catch (err) {
    // Allow retries after transient init failures.
    _client = null;
    _initPromise = null;
    throw err;
  }
  return _client;
}

/** For tests: use this client as the shared one, or none (the next call creates one). */
export function setAgentClientForTests(client: AgentClient | null): void {
  _client = client;
  _initPromise = client ? Promise.resolve() : null;
}

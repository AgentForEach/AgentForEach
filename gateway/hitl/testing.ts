/**
 * AgentForEach HITL Module — test fixtures (imported by tests only)
 */

import { InMemoryStorage } from "@agentforeach/storage";
import { HitlStore } from "./store.js";
import type { HitlRunState } from "./types.js";

/** A pending request of u1's for a gated tool, saved now with a 300 s timeout; `fields` override. */
export function hitlState(
  requestId: string,
  fields: Partial<HitlRunState> & { tool?: string; args?: Record<string, unknown>; userId?: string } = {},
): HitlRunState {
  const { tool = "fixture_send_note", args = {}, userId = "u1", ...rest } = fields;
  return {
    requestId,
    orchestrationId: `hitl-${requestId}`,
    originalRequest: { userId, message: "m", sessionId: "s1" },
    runId: `run-${requestId}`,
    sessionId: "s1",
    toolRound: 1,
    pendingToolCall: { callId: "c1", name: tool, arguments: args },
    completedToolResults: [],
    independentToolCalls: [],
    conversationState: {},
    providerId: "openai",
    model: "m",
    createdAt: Date.now(),
    status: "pending",
    timeoutSeconds: 300,
    ...rest,
  };
}

/** An in-memory HITL store holding `states`, and a source for the functions that take one. */
export async function storeWith(...states: HitlRunState[]) {
  const store = new HitlStore(new InMemoryStorage());
  await store.initialize();
  for (const state of states) await store.create(state);
  return { store, source: async () => store };
}

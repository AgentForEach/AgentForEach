/**
 * AgentForEach Client Layer — Slash Commands Tests
 *
 * Tests the command parser and handler:
 *   - parseCommand()      — extracts command name + args from message text
 *   - tryHandleCommand()  — dispatches /new, /reset, /compact via mock deps
 *
 * Verifies hook emissions, session deletion, and compaction flow.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand, tryHandleCommand } from "./commands.js";
import { HookEmitter } from "../hooks/index.js";
import type { RunnerDeps } from "./runner.js";
import type { SendRequest, ClientStreamEvent } from "./types.js";
import type { Session } from "../sessions/types.js";

// ============================================================================
// Mock Helpers
// ============================================================================

/** Create a minimal mock Session. */
function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: "u1:sess1",
    userId: "u1",
    agentId: "default",
    sessionId: "sess1",
    messageSeq: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Tracks calls to mock methods. */
interface MockCalls {
  sessionGet: Array<{ userId: string; sessionId: string }>;
  sessionDelete: Array<{ userId: string; sessionId: string }>;
  hookEvents: Array<{ hook: string; event: unknown }>;
}

/**
 * Build a minimal RunnerDeps mock for command testing.
 *
 * Returns deps + call tracker so tests can verify interactions.
 */
function makeMockDeps(options?: {
  session?: Session | null;
  compactionRetainCount?: number;
  compactionModel?: string;
  runCompactionShouldThrow?: boolean;
}): { deps: RunnerDeps; calls: MockCalls } {
  const session = options?.session !== undefined ? options.session : makeSession();
  const compactionRetainCount = options?.compactionRetainCount ?? 5;
  const compactionModel = options?.compactionModel ?? "gpt-4o-mini";

  const calls: MockCalls = {
    sessionGet: [],
    sessionDelete: [],
    hookEvents: [],
  };

  const hooks = new HookEmitter();

  // Spy on all hook emissions
  const originalEmit = hooks.emit.bind(hooks);
  hooks.emit = async (hook: any, event: any) => {
    calls.hookEvents.push({ hook, event });
    return originalEmit(hook, event);
  };

  const deps: RunnerDeps = {
    provider: {
      id: "openai",
      createResponse: async () => ({ } as any),
      streamResponse: (async function* () {})(),
    } as any,
    memory: {} as any,
    cronStore: {} as any,
    promptStore: {} as any,
    sessionStore: {
      get: async (userId: string, sessionId: string) => {
        calls.sessionGet.push({ userId, sessionId });
        return session;
      },
      delete: async (userId: string, sessionId: string) => {
        calls.sessionDelete.push({ userId, sessionId });
        return true;
      },
      getConfig: () => ({
        containerId: "sessions",
        messagesContainerId: "session-messages",
        ttlSeconds: 86400,
        maxHistoryMessages: 100,
        defaultAgentId: "default",
        compactionThreshold: 60,
        compactionRetainCount,
        compactionModel,
      }),
      getMessageStore: () => ({} as any),
    } as any,
    defaultModel: "gpt-4o",
    realtimeEnabled: false,
    streamToClient: false,
    autoRecall: false,
    autoCapture: false,
    usageStore: {} as any,
    hooks,
  };

  return { deps, calls };
}

/** Build a minimal SendRequest for testing. */
function makeRequest(
  message: string,
  overrides?: Partial<SendRequest>,
): SendRequest {
  return {
    userId: "u1",
    message,
    ...overrides,
  };
}

// ============================================================================
// Tests — parseCommand()
// ============================================================================

test("parseCommand", async (t) => {
  await t.test("parses /new command", () => {
    const result = parseCommand("/new");
    assert.deepEqual(result, { name: "new", args: "" });
  });

  await t.test("parses /reset command", () => {
    const result = parseCommand("/reset");
    assert.deepEqual(result, { name: "reset", args: "" });
  });

  await t.test("parses /compact command", () => {
    const result = parseCommand("/compact");
    assert.deepEqual(result, { name: "compact", args: "" });
  });

  await t.test("extracts args after command name", () => {
    const result = parseCommand("/compact force please");
    assert.deepEqual(result, { name: "compact", args: "force please" });
  });

  await t.test("is case-insensitive", () => {
    assert.deepEqual(parseCommand("/NEW"), { name: "new", args: "" });
    assert.deepEqual(parseCommand("/Reset"), { name: "reset", args: "" });
    assert.deepEqual(parseCommand("/COMPACT"), { name: "compact", args: "" });
  });

  await t.test("trims leading/trailing whitespace", () => {
    assert.deepEqual(parseCommand("  /new  "), { name: "new", args: "" });
    assert.deepEqual(parseCommand("  /compact  some args  "), {
      name: "compact",
      args: "some args",
    });
  });

  await t.test("returns null for regular messages", () => {
    assert.equal(parseCommand("Hello world"), null);
    assert.equal(parseCommand("What is /new?"), null);
    assert.equal(parseCommand(""), null);
    assert.equal(parseCommand("   "), null);
  });

  await t.test("returns null for unrecognized commands", () => {
    assert.equal(parseCommand("/help"), null);
    assert.equal(parseCommand("/export"), null);
    assert.equal(parseCommand("/unknown"), null);
    assert.equal(parseCommand("/newone"), null); // no prefix matching
  });

  await t.test("returns null for bare slash", () => {
    assert.equal(parseCommand("/"), null);
  });

  await t.test("handles tabs as whitespace separators", () => {
    const result = parseCommand("/compact\tsome args");
    assert.deepEqual(result, { name: "compact", args: "some args" });
  });
});

// ============================================================================
// Tests — tryHandleCommand() — Non-commands
// ============================================================================

test("tryHandleCommand returns null for non-command messages", async () => {
  const { deps } = makeMockDeps();
  const result = await tryHandleCommand(
    makeRequest("Hello, Assistant!"),
    deps,
  );
  assert.equal(result, null);
});

// ============================================================================
// Tests — tryHandleCommand() — /new and /reset
// ============================================================================

test("tryHandleCommand /new", async (t) => {
  await t.test("without sessionId returns reset message", async () => {
    const { deps, calls } = makeMockDeps();
    const result = await tryHandleCommand(
      makeRequest("/new"),
      deps,
    );

    assert.ok(result);
    assert.equal(result.status, "completed");
    assert.ok(result.text.includes("Session reset"));

    // No session deletion when no sessionId
    assert.equal(calls.sessionDelete.length, 0);
  });

  await t.test("with sessionId deletes session", async () => {
    const { deps, calls } = makeMockDeps();
    const result = await tryHandleCommand(
      makeRequest("/new", { sessionId: "sess1" }),
      deps,
    );

    assert.ok(result);
    assert.equal(result.status, "completed");
    assert.ok(result.text.includes("Session reset"));

    // Session was loaded and deleted
    assert.equal(calls.sessionGet.length, 1);
    assert.deepEqual(calls.sessionGet[0], { userId: "u1", sessionId: "sess1" });
    assert.equal(calls.sessionDelete.length, 1);
    assert.deepEqual(calls.sessionDelete[0], { userId: "u1", sessionId: "sess1" });
  });

  await t.test("emits command hook", async () => {
    const { deps, calls } = makeMockDeps();
    await tryHandleCommand(makeRequest("/new"), deps);

    const commandHooks = calls.hookEvents.filter((e) => e.hook === "command");
    assert.equal(commandHooks.length, 1);
    assert.deepEqual((commandHooks[0].event as any).name, "new");
    assert.deepEqual((commandHooks[0].event as any).userId, "u1");
  });

  await t.test("emits before_reset and session_end hooks when sessionId provided", async () => {
    const { deps, calls } = makeMockDeps();
    await tryHandleCommand(
      makeRequest("/new", { sessionId: "sess1" }),
      deps,
    );

    const beforeReset = calls.hookEvents.filter((e) => e.hook === "before_reset");
    assert.equal(beforeReset.length, 1);
    assert.equal((beforeReset[0].event as any).userId, "u1");
    assert.equal((beforeReset[0].event as any).sessionId, "sess1");

    const sessionEnd = calls.hookEvents.filter((e) => e.hook === "session_end");
    assert.equal(sessionEnd.length, 1);
    assert.equal((sessionEnd[0].event as any).sessionId, "sess1");
  });

  await t.test("before_reset fires BEFORE session deletion", async () => {
    const timeline: string[] = [];
    const { deps } = makeMockDeps();

    // Track deletion timing
    (deps.sessionStore as any).delete = async (userId: string, sessionId: string) => {
      timeline.push("delete");
      return true;
    };

    // Track before_reset timing
    deps.hooks.on("before_reset", () => {
      timeline.push("before_reset");
    });

    await tryHandleCommand(
      makeRequest("/new", { sessionId: "sess1" }),
      deps,
    );

    assert.equal(timeline[0], "before_reset");
    assert.equal(timeline[1], "delete");
  });
});

test("tryHandleCommand /reset behaves identically to /new", async () => {
  const { deps, calls } = makeMockDeps();
  const result = await tryHandleCommand(
    makeRequest("/reset", { sessionId: "sess1" }),
    deps,
  );

  assert.ok(result);
  assert.equal(result.status, "completed");
  assert.ok(result.text.includes("Session reset"));
  assert.equal(calls.sessionDelete.length, 1);
});

// ============================================================================
// Tests — tryHandleCommand() — /compact
// ============================================================================

test("tryHandleCommand /compact", async (t) => {
  await t.test("without sessionId returns error message", async () => {
    const { deps } = makeMockDeps();
    const result = await tryHandleCommand(
      makeRequest("/compact"),
      deps,
    );

    assert.ok(result);
    assert.equal(result.status, "completed");
    assert.ok(result.text.includes("No active session"));
  });

  await t.test("with non-existent session returns error message", async () => {
    const { deps } = makeMockDeps({ session: null });
    const result = await tryHandleCommand(
      makeRequest("/compact", { sessionId: "gone" }),
      deps,
    );

    assert.ok(result);
    assert.ok(result.text.includes("No active session"));
  });

  await t.test("with not enough messages returns threshold message", async () => {
    // Session has 10 messages, retain count is 20 → boundary = 10 - 20 = -10 ≤ 0
    const { deps } = makeMockDeps({
      session: makeSession({ messageSeq: 10 }),
      compactionRetainCount: 20,
    });
    const result = await tryHandleCommand(
      makeRequest("/compact", { sessionId: "sess1" }),
      deps,
    );

    assert.ok(result);
    assert.ok(result.text.includes("Not enough to compact"));
  });

  await t.test("emits command hook", async () => {
    const { deps, calls } = makeMockDeps({ session: null });
    await tryHandleCommand(
      makeRequest("/compact", { sessionId: "sess1" }),
      deps,
    );

    const commandHooks = calls.hookEvents.filter((e) => e.hook === "command");
    assert.equal(commandHooks.length, 1);
    assert.equal((commandHooks[0].event as any).name, "compact");
  });
});

// ============================================================================
// Tests — tryHandleCommand() — Response shape
// ============================================================================

test("tryHandleCommand response shape", async (t) => {
  await t.test("includes required SendResponse fields", async () => {
    const { deps } = makeMockDeps();
    const result = await tryHandleCommand(makeRequest("/new"), deps);

    assert.ok(result);
    assert.ok(result.runId); // UUID
    assert.equal(typeof result.text, "string");
    assert.equal(result.sessionId, "");
    assert.deepEqual(result.identity, { name: "Assistant" });
    assert.equal(result.providerId, "openai");
    assert.equal(result.model, "gpt-4o");
    assert.equal(result.memoriesRecalled, 0);
    assert.equal(result.memoryCaptured, false);
    assert.equal(typeof result.durationMs, "number");
    assert.equal(result.status, "completed");
  });

  await t.test("includes sessionId from request when provided", async () => {
    const { deps } = makeMockDeps();
    const result = await tryHandleCommand(
      makeRequest("/new", { sessionId: "sess1" }),
      deps,
    );

    assert.ok(result);
    assert.equal(result.sessionId, "sess1");
  });
});

// ============================================================================
// Tests — tryHandleCommand() — Streaming callback
// ============================================================================

test("tryHandleCommand calls onStream with done event", async () => {
  const { deps } = makeMockDeps();
  const events: ClientStreamEvent[] = [];

  await tryHandleCommand(
    makeRequest("/new"),
    deps,
    (event) => events.push(event),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "done");
  assert.ok((events[0] as any).response);
});

// ============================================================================
// Tests — tryHandleCommand() — Error handling
// ============================================================================

test("tryHandleCommand returns failed response on handler error", async () => {
  const { deps } = makeMockDeps();

  // Make session.get throw
  (deps.sessionStore as any).get = async () => {
    throw new Error("Cosmos DB unavailable");
  };

  const events: ClientStreamEvent[] = [];
  const result = await tryHandleCommand(
    makeRequest("/reset", { sessionId: "sess1" }),
    deps,
    (event) => events.push(event),
  );

  assert.ok(result);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Cosmos DB unavailable");
  assert.equal(result.text, "");

  // onStream receives error event
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
});

// ============================================================================
// Tests — Hook Integration (before_reset awaited before deletion)
// ============================================================================

test("before_reset hook completes before session deletion", async () => {
  const { deps } = makeMockDeps();
  let memoryExtracted = false;

  // Simulate a memory extraction hook that takes some time
  deps.hooks.on("before_reset", async () => {
    // Simulate async work (e.g., extracting memories)
    await new Promise((r) => setTimeout(r, 20));
    memoryExtracted = true;
  });

  // Track deletion
  let deletedBeforeExtraction = false;
  (deps.sessionStore as any).delete = async (_userId: string, _sessionId: string) => {
    if (!memoryExtracted) {
      deletedBeforeExtraction = true;
    }
    return true;
  };

  await tryHandleCommand(
    makeRequest("/new", { sessionId: "sess1" }),
    deps,
  );

  assert.equal(memoryExtracted, true);
  assert.equal(deletedBeforeExtraction, false);
});

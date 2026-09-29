/**
 * AgentForEach Hooks Module — HookEmitter Tests
 *
 * Tests the two execution models:
 *   - emit()          — void hooks, parallel, errors caught
 *   - emitWaterfall() — modifying hooks, sequential by priority, first result wins
 *
 * Also covers: registration, deregistration, priority ordering,
 * introspection (hasHandlers, handlerCount), and clear().
 */

import test from "node:test";
import assert from "node:assert/strict";
import { HookEmitter } from "./emitter.js";

// ============================================================================
// Helpers
// ============================================================================

/** Capture stderr output during a callback (for error-logging assertions). */
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const original = console.error;
  const captured: string[] = [];
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return captured;
}

/** Small delay to let async ops settle. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Tests — Registration & Introspection
// ============================================================================

test("on() registers a handler and hasHandlers() returns true", () => {
  const hooks = new HookEmitter();
  assert.equal(hooks.hasHandlers("run_started"), false);
  assert.equal(hooks.handlerCount("run_started"), 0);

  hooks.on("run_started", () => {});
  assert.equal(hooks.hasHandlers("run_started"), true);
  assert.equal(hooks.handlerCount("run_started"), 1);
});

test("on() allows multiple handlers on the same hook", () => {
  const hooks = new HookEmitter();
  hooks.on("run_started", () => {});
  hooks.on("run_started", () => {});
  hooks.on("run_started", () => {});
  assert.equal(hooks.handlerCount("run_started"), 3);
});

test("off() removes the exact handler reference", () => {
  const hooks = new HookEmitter();
  const handler = () => {};
  hooks.on("run_started", handler);
  assert.equal(hooks.handlerCount("run_started"), 1);

  hooks.off("run_started", handler);
  assert.equal(hooks.hasHandlers("run_started"), false);
  assert.equal(hooks.handlerCount("run_started"), 0);
});

test("off() only removes the matching handler, not others", () => {
  const hooks = new HookEmitter();
  const h1 = () => {};
  const h2 = () => {};
  hooks.on("run_started", h1);
  hooks.on("run_started", h2);

  hooks.off("run_started", h1);
  assert.equal(hooks.handlerCount("run_started"), 1);
});

test("off() is a no-op for unregistered hooks or handlers", () => {
  const hooks = new HookEmitter();
  // No handlers registered at all
  hooks.off("run_started", () => {});
  assert.equal(hooks.hasHandlers("run_started"), false);

  // Handler not registered for this hook
  const h = () => {};
  hooks.on("run_started", () => {});
  hooks.off("run_started", h);
  assert.equal(hooks.handlerCount("run_started"), 1);
});

test("clear() removes all handlers for all hooks", () => {
  const hooks = new HookEmitter();
  hooks.on("run_started", () => {});
  hooks.on("run_completed", () => {});
  hooks.on("session_created", () => {});

  hooks.clear();
  assert.equal(hooks.hasHandlers("run_started"), false);
  assert.equal(hooks.hasHandlers("run_completed"), false);
  assert.equal(hooks.hasHandlers("session_created"), false);
});

// ============================================================================
// Tests — Void Hooks (emit)
// ============================================================================

test("emit() calls all handlers with the event payload", async () => {
  const hooks = new HookEmitter();
  const received: Array<{ runId: string; userId: string; agentId: string }> = [];

  hooks.on("run_started", (event) => { received.push(event); });
  hooks.on("run_started", (event) => { received.push(event); });

  const payload = { runId: "r1", userId: "u1", agentId: "default" };
  await hooks.emit("run_started", payload);

  assert.equal(received.length, 2);
  assert.deepEqual(received[0], payload);
  assert.deepEqual(received[1], payload);
});

test("emit() runs handlers in parallel", async () => {
  const hooks = new HookEmitter();
  const order: number[] = [];

  // Handler 1 takes longer but should start immediately
  hooks.on("run_started", async () => {
    await delay(20);
    order.push(1);
  });

  // Handler 2 is fast — should finish before handler 1
  hooks.on("run_started", async () => {
    await delay(1);
    order.push(2);
  });

  await hooks.emit("run_started", { runId: "r1", userId: "u1", agentId: "a1" });

  // Both should have completed
  assert.equal(order.length, 2);
  // The fast handler should have finished first (parallel execution)
  assert.equal(order[0], 2);
  assert.equal(order[1], 1);
});

test("emit() catches handler errors and logs them to stderr", async () => {
  const hooks = new HookEmitter();
  const received: string[] = [];

  hooks.on("run_started", () => {
    received.push("ok");
  });
  hooks.on("run_started", () => {
    throw new Error("handler exploded");
  });
  hooks.on("run_started", () => {
    received.push("also ok");
  });

  const logs = await captureStderr(async () => {
    await hooks.emit("run_started", { runId: "r1", userId: "u1", agentId: "a1" });
  });

  // Non-throwing handlers still ran
  assert.equal(received.length, 2);
  assert.ok(received.includes("ok"));
  assert.ok(received.includes("also ok"));

  // Error was logged
  assert.ok(logs.length > 0);
  assert.ok(logs.some((l) => l.includes("run_started") && l.includes("handler exploded")));
});

test("emit() resolves immediately when no handlers registered", async () => {
  const hooks = new HookEmitter();
  // Should not throw
  await hooks.emit("run_started", { runId: "r1", userId: "u1", agentId: "a1" });
});

test("emit() handles async handlers that reject", async () => {
  const hooks = new HookEmitter();

  hooks.on("run_completed", async () => {
    throw new Error("async failure");
  });

  const logs = await captureStderr(async () => {
    await hooks.emit("run_completed", {
      runId: "r1",
      response: {} as any,
    });
  });

  assert.ok(logs.some((l) => l.includes("async failure")));
});

// ============================================================================
// Tests — Modifying Hooks (emitWaterfall)
// ============================================================================

test("emitWaterfall() returns the first non-undefined result", async () => {
  const hooks = new HookEmitter();

  hooks.on("before_prompt_build", () => undefined);
  hooks.on("before_prompt_build", () => ({ extraContext: "injected" }));
  hooks.on("before_prompt_build", () => ({ extraContext: "should not win" }));

  const result = await hooks.emitWaterfall("before_prompt_build", {
    context: {} as any,
  });

  assert.deepEqual(result, { extraContext: "injected" });
});

test("emitWaterfall() returns undefined when no handler returns a value", async () => {
  const hooks = new HookEmitter();

  hooks.on("before_prompt_build", () => undefined);
  hooks.on("before_prompt_build", () => undefined);

  const result = await hooks.emitWaterfall("before_prompt_build", {
    context: {} as any,
  });

  assert.equal(result, undefined);
});

test("emitWaterfall() returns undefined when no handlers registered", async () => {
  const hooks = new HookEmitter();

  const result = await hooks.emitWaterfall("before_prompt_build", {
    context: {} as any,
  });

  assert.equal(result, undefined);
});

test("emitWaterfall() runs handlers sequentially (not in parallel)", async () => {
  const hooks = new HookEmitter();
  const order: number[] = [];

  hooks.on("before_tool_call", async () => {
    await delay(10);
    order.push(1);
    return undefined;
  });

  hooks.on("before_tool_call", async () => {
    order.push(2);
    return { block: true, blockReason: "blocked" };
  });

  await hooks.emitWaterfall("before_tool_call", {
    name: "test",
    callId: "c1",
    args: {},
  });

  // Handler 1 runs first (despite being slower), then handler 2
  assert.deepEqual(order, [1, 2]);
});

test("emitWaterfall() propagates errors to the caller", async () => {
  const hooks = new HookEmitter();

  hooks.on("before_llm_call", () => {
    throw new Error("critical failure");
  });

  await assert.rejects(
    () =>
      hooks.emitWaterfall("before_llm_call", {
        request: {} as any,
      }),
    { message: "critical failure" },
  );
});

test("emitWaterfall() stops after first non-undefined result", async () => {
  const hooks = new HookEmitter();
  const called: number[] = [];

  hooks.on("message_sending", () => {
    called.push(1);
    return { text: "modified" };
  });

  hooks.on("message_sending", () => {
    called.push(2);
    return { text: "should not run" };
  });

  const result = await hooks.emitWaterfall("message_sending", {
    text: "original",
    chatId: "chat1",
  });

  assert.deepEqual(result, { text: "modified" });
  // Only the first handler should have run
  assert.deepEqual(called, [1]);
});

// ============================================================================
// Tests — Priority Ordering
// ============================================================================

test("emit() handlers are sorted by descending priority", async () => {
  const hooks = new HookEmitter();
  const order: number[] = [];

  hooks.on("session_end", () => { order.push(1); }, 0);
  hooks.on("session_end", () => { order.push(2); }, 10);
  hooks.on("session_end", () => { order.push(3); }, 5);

  await hooks.emit("session_end", { userId: "u1", sessionId: "s1" });

  // Despite parallel execution, allSettled preserves array order
  // which is sorted by priority (descending): 10, 5, 0 → handlers 2, 3, 1
  // Since parallel, we can't guarantee completion order, but the entries
  // are iterated in priority order. With synchronous handlers, the push
  // order should reflect the sorted order.
  assert.deepEqual(order, [2, 3, 1]);
});

test("emitWaterfall() runs handlers in descending priority order", async () => {
  const hooks = new HookEmitter();
  const order: number[] = [];

  hooks.on("before_tool_call", () => {
    order.push(1);
    return undefined;
  }, 0);

  hooks.on("before_tool_call", () => {
    order.push(2);
    return undefined;
  }, 10);

  hooks.on("before_tool_call", () => {
    order.push(3);
    return undefined;
  }, 5);

  await hooks.emitWaterfall("before_tool_call", {
    name: "test",
    callId: "c1",
    args: {},
  });

  // Sequential, sorted by descending priority: 10 → 5 → 0
  assert.deepEqual(order, [2, 3, 1]);
});

test("higher priority handler wins in emitWaterfall()", async () => {
  const hooks = new HookEmitter();

  // Lower priority — registers first
  hooks.on("before_tool_call", () => {
    return { block: false };
  }, 0);

  // Higher priority — registered second but runs first
  hooks.on("before_tool_call", () => {
    return { block: true, blockReason: "high priority blocked it" };
  }, 10);

  const result = await hooks.emitWaterfall("before_tool_call", {
    name: "dangerous",
    callId: "c1",
    args: {},
  });

  assert.deepEqual(result, { block: true, blockReason: "high priority blocked it" });
});

// ============================================================================
// Tests — Default priority
// ============================================================================

test("default priority is 0", async () => {
  const hooks = new HookEmitter();
  const order: number[] = [];

  // Explicitly priority 0
  hooks.on("session_end", () => { order.push(1); }, 0);
  // Default (should also be 0 — order depends on insertion)
  hooks.on("session_end", () => { order.push(2); });
  // Higher priority
  hooks.on("session_end", () => { order.push(3); }, 1);

  await hooks.emit("session_end", { userId: "u1", sessionId: "s1" });

  // Priority 1 first, then the two priority-0 handlers in insertion order
  assert.equal(order[0], 3);
  // The two priority-0 handlers maintain insertion order within same priority
  assert.ok(order.includes(1));
  assert.ok(order.includes(2));
});

// ============================================================================
// Tests — Type Safety (compile-time checks, verified by tsc)
// ============================================================================

test("void hook handler receives correct event type", async () => {
  const hooks = new HookEmitter();

  hooks.on("memories_recalled", (event) => {
    // These would fail at compile time if types were wrong
    const _count: number = event.count;
    const _context: string = event.context;
    assert.equal(typeof _count, "number");
    assert.equal(typeof _context, "string");
  });

  await hooks.emit("memories_recalled", { count: 5, context: "test memories" });
});

test("modifying hook handler receives correct event and can return result", async () => {
  const hooks = new HookEmitter();

  hooks.on("message_sending", (event) => {
    // Type-safe event access
    const _text: string = event.text;
    const _chatId: string = event.chatId;
    assert.equal(_text, "hello");
    assert.equal(_chatId, "chat1");
    return { text: "modified", cancel: false };
  });

  const result = await hooks.emitWaterfall("message_sending", {
    text: "hello",
    chatId: "chat1",
  });

  assert.deepEqual(result, { text: "modified", cancel: false });
});

// ============================================================================
// Tests — Edge Cases
// ============================================================================

test("emit() handles mix of sync and async handlers", async () => {
  const hooks = new HookEmitter();
  const received: string[] = [];

  // Sync handler
  hooks.on("run_started", () => { received.push("sync"); });
  // Async handler
  hooks.on("run_started", async () => {
    await delay(1);
    received.push("async");
  });

  await hooks.emit("run_started", { runId: "r1", userId: "u1", agentId: "a1" });

  assert.equal(received.length, 2);
  assert.ok(received.includes("sync"));
  assert.ok(received.includes("async"));
});

test("emitWaterfall() handles mix of sync and async handlers", async () => {
  const hooks = new HookEmitter();

  // Sync handler returns undefined
  hooks.on("before_prompt_build", () => undefined, 10);
  // Async handler returns a value
  hooks.on("before_prompt_build", async () => {
    await delay(1);
    return { extraContext: "async result" };
  }, 5);

  const result = await hooks.emitWaterfall("before_prompt_build", {
    context: {} as any,
  });

  assert.deepEqual(result, { extraContext: "async result" });
});

test("registering the same function twice creates two entries", () => {
  const hooks = new HookEmitter();
  const handler = () => {};
  hooks.on("run_started", handler);
  hooks.on("run_started", handler);
  assert.equal(hooks.handlerCount("run_started"), 2);
});

test("off() removes only one instance of a duplicated handler", () => {
  const hooks = new HookEmitter();
  const handler = () => {};
  hooks.on("run_started", handler);
  hooks.on("run_started", handler);
  hooks.off("run_started", handler);
  assert.equal(hooks.handlerCount("run_started"), 1);
});

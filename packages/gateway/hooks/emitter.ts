/**
 * AgentForEach Hooks Module — Emitter
 *
 * A typed, priority-based event emitter for lifecycle hooks.
 *
 * Two execution models:
 *   - `emit()` — Fire void hooks in parallel. Errors are caught and logged,
 *     never propagated. Used for observe-only hooks (run_started, llm_response, etc.).
 *   - `emitWaterfall()` — Fire modifying hooks sequentially by descending priority.
 *     First non-undefined result wins. Errors propagate to the caller.
 *     Used for hooks that can alter data (before_prompt_build, before_tool_call, etc.).
 *
 * Priority: higher number = runs first. Default priority is 0.
 *
 * Equivalent to OpenClaw's HookRunner but without directory discovery,
 * HOOK.md metadata, or plugin registration — just a clean typed emitter.
 */

import type {
  HookEventMap,
  HookResultMap,
  HookHandler,
  VoidHookName,
  ModifyingHookName,
} from "./types.js";

// ============================================================================
// Internal Types
// ============================================================================

interface HandlerEntry<K extends keyof HookEventMap> {
  handler: HookHandler<K>;
  priority: number;
}

// ============================================================================
// HookEmitter
// ============================================================================

export class HookEmitter {
  /**
   * Internal registry: hook name → sorted handler entries.
   * Handlers are kept sorted by descending priority (highest first).
   */
  private registry = new Map<
    keyof HookEventMap,
    HandlerEntry<keyof HookEventMap>[]
  >();

  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------

  /**
   * Register a handler for a hook.
   *
   * @param hook - The hook name.
   * @param handler - The handler function.
   * @param priority - Execution priority (higher = runs first). Default: 0.
   */
  on<K extends keyof HookEventMap>(
    hook: K,
    handler: HookHandler<K>,
    priority = 0,
  ): void {
    let entries = this.registry.get(hook);
    if (!entries) {
      entries = [];
      this.registry.set(hook, entries);
    }

    entries.push({
      handler: handler as HookHandler<keyof HookEventMap>,
      priority,
    });

    // Re-sort by descending priority
    entries.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Unregister a handler for a hook.
   *
   * @param hook - The hook name.
   * @param handler - The exact handler reference to remove.
   */
  off<K extends keyof HookEventMap>(
    hook: K,
    handler: HookHandler<K>,
  ): void {
    const entries = this.registry.get(hook);
    if (!entries) return;

    const index = entries.findIndex(
      (e) => e.handler === (handler as HookHandler<keyof HookEventMap>),
    );
    if (index !== -1) {
      entries.splice(index, 1);
    }

    // Clean up empty arrays
    if (entries.length === 0) {
      this.registry.delete(hook);
    }
  }

  // --------------------------------------------------------------------------
  // Void Hooks — Parallel, errors caught
  // --------------------------------------------------------------------------

  /**
   * Fire a void hook. All handlers run in parallel via `Promise.allSettled()`.
   * Errors are caught and logged to stderr — never propagated.
   *
   * Returns a promise that resolves when all handlers have settled.
   * Callers can `await` this if they need handlers to complete before
   * proceeding (e.g., `before_reset`), or fire-and-forget for
   * purely observational hooks.
   */
  async emit<K extends VoidHookName>(
    hook: K,
    event: HookEventMap[K],
  ): Promise<void> {
    const entries = this.registry.get(hook);
    if (!entries || entries.length === 0) return;

    const results = await Promise.allSettled(
      entries.map(async (entry) =>
        (entry.handler as (event: HookEventMap[K]) => void | Promise<void>)(
          event,
        ),
      ),
    );

    // Log rejections but don't propagate
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(`[hooks] ${String(hook)} handler error:`, result.reason);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Modifying Hooks — Sequential, first result wins
  // --------------------------------------------------------------------------

  /**
   * Fire a modifying hook. Handlers run sequentially in descending priority
   * order. The first non-undefined result is returned.
   *
   * Errors propagate to the caller (modifying hooks are on the critical path).
   *
   * @returns The first non-undefined handler result, or undefined if no
   *          handler returned a value.
   */
  async emitWaterfall<K extends ModifyingHookName>(
    hook: K,
    event: HookEventMap[K],
  ): Promise<HookResultMap[K] | undefined> {
    const entries = this.registry.get(hook);
    if (!entries || entries.length === 0) return undefined;

    for (const entry of entries) {
      const result = await (
        entry.handler as (
          event: HookEventMap[K],
        ) => HookResultMap[K] | undefined | Promise<HookResultMap[K] | undefined>
      )(event);

      if (result !== undefined) {
        return result;
      }
    }

    return undefined;
  }

  // --------------------------------------------------------------------------
  // Introspection
  // --------------------------------------------------------------------------

  /**
   * Check if any handlers are registered for a hook.
   * Useful for skipping expensive event construction when no one is listening.
   */
  hasHandlers(hook: keyof HookEventMap): boolean {
    const entries = this.registry.get(hook);
    return !!entries && entries.length > 0;
  }

  /**
   * Get the count of registered handlers for a hook.
   */
  handlerCount(hook: keyof HookEventMap): number {
    return this.registry.get(hook)?.length ?? 0;
  }

  /**
   * Remove all handlers for all hooks. Useful for testing.
   */
  clear(): void {
    this.registry.clear();
  }
}

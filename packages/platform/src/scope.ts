/**
 * The invocation scope: one per HTTP request, schedule tick, durable job
 * step or alarm, opened by the host around the handler and reached below it
 * with `currentScope()` (AsyncLocalStorage, available in Node and in
 * workerd with nodejs_compat).
 *
 * It does three things for code that can't know which host it runs on:
 * - `background(work)`: work the handler doesn't wait for. The host decides
 *   what keeps it alive (`keepAlive`): Cloudflare passes `ctx.waitUntil`; on
 *   Azure nothing is passed, and the work runs detached exactly as before.
 * - `resource(key, create)`: something that must not outlive the invocation
 *   on a host that isn't persistent (a database pool, MCP connections).
 * - `onEnd(cleanup)`: runs once the background work has settled.
 *
 * `settle()` is the host's: it waits for the background work (including work
 * that work starts), then runs the cleanups. A host that must keep its
 * response timing (Azure) calls it without awaiting it, off the response
 * path; a durable job step awaits it before the step returns. A host that
 * freezes once the invocation returns (Lambda) awaits `settleBy(deadlineAt)`,
 * which stops waiting at the invocation's deadline and says what was left.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { InvocationKind, InvocationScope, OpenScopeOptions, ScopeKey } from "./host.js";

const active = new AsyncLocalStorage<Scope>();

/** Errors from background work nobody else handled: logged, never thrown. */
function logBackgroundError(err: unknown): void {
  console.error("[platform] background work failed:", err);
}

class Scope implements InvocationScope {
  readonly invocationId: string;
  readonly kind: InvocationKind;
  private readonly keepAlive: ((work: Promise<unknown>) => void) | undefined;
  private readonly pending = new Set<Promise<void>>();
  private readonly resources = new Map<ScopeKey<unknown>, unknown>();
  private readonly cleanups: Array<() => void | Promise<void>> = [];
  private settling: Promise<void> | undefined;
  /** Set once the background work is done and the cleanups start. */
  private ending = false;

  constructor(options: OpenScopeOptions) {
    this.invocationId = options.invocationId;
    this.kind = options.kind;
    this.keepAlive = options.keepAlive;
  }

  background(work: Promise<unknown>): void {
    const tracked = work.then(
      () => undefined,
      (err) => logBackgroundError(err),
    );
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
    this.keepAlive?.(tracked);
  }

  resource<T>(key: ScopeKey<T>, create: () => T): T {
    // Background work still belongs to the invocation, so resources stay
    // open to it while it runs, even after the handler has returned.
    if (this.ending) throw new Error(`The invocation is over: "${key.name}" can't be opened in it any more.`);
    if (!this.resources.has(key)) this.resources.set(key, create());
    return this.resources.get(key) as T;
  }

  onEnd(cleanup: () => void | Promise<void>): void {
    this.cleanups.push(cleanup);
  }

  /** Background work still running. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Background work (and what it starts), then cleanups, newest first. Idempotent. */
  settle(): Promise<void> {
    this.settling ??= (async () => {
      while (this.pending.size > 0) await Promise.all([...this.pending]);
      this.ending = true;
      for (const cleanup of this.cleanups.reverse()) {
        try {
          await cleanup();
        } catch (err) {
          logBackgroundError(err);
        }
      }
    })();
    return this.settling;
  }
}

/** The scope of the invocation this code runs in, if a host opened one. */
export function currentScope(): InvocationScope | undefined {
  return active.getStore();
}

/**
 * Work the caller doesn't wait for. In a scope, the host keeps it alive as
 * far as it can; with no scope (tests, scripts), it runs detached as a plain
 * promise would. Either way its errors go to `onError`, or are logged.
 */
export function background(work: Promise<unknown>, onError?: (err: unknown) => void): void {
  const handled = onError ? work.catch(onError) : work;
  const scope = active.getStore();
  if (scope) scope.background(handled);
  else void handled.catch(logBackgroundError);
}

/** Name a kind of scoped resource. Keys compare by identity: make one per kind, at module scope. */
export function scopeKey<T>(name: string): ScopeKey<T> {
  return { name };
}

/** A scope a host has opened: run the invocation in it, then settle it. */
export interface OpenedScope {
  readonly scope: InvocationScope;
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Wait for background work, then run cleanups. See the module docs for when to await it. */
  settle(): Promise<void>;
  /**
   * `settle()`, but stop waiting at `deadlineAt` (epoch ms). `settled` is
   * false when the deadline came first; `pending` is the background work
   * still running then, for the host to log as cut off.
   */
  settleBy(deadlineAt: number): Promise<SettleOutcome>;
}

export interface SettleOutcome {
  settled: boolean;
  pending: number;
}

/** For hosts: open the scope for one invocation. */
export function openScope(options: OpenScopeOptions): OpenedScope {
  const scope = new Scope(options);
  return {
    scope,
    run: (fn) => active.run(scope, fn),
    settle: () => scope.settle(),
    async settleBy(deadlineAt) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, deadlineAt - Date.now()));
      });
      try {
        const settled = await Promise.race([scope.settle().then(() => true), deadline]);
        return { settled, pending: settled ? 0 : scope.pendingCount };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

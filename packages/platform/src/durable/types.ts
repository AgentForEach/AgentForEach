/**
 * The Durable port: work that must outlive the request that starts it.
 *
 * Three primitives cover everything the gateway needs:
 *
 * - **Jobs** run a handler once per instance id: a chat turn in the
 *   background, a channel turn, a cron run. Starting an id that is already
 *   pending or running starts nothing (`started: false`); starting an id
 *   whose instance has finished replaces it.
 * - **Waits** pause until an event arrives or a timeout passes, then run one
 *   of two handlers: a HITL form, answered or expired.
 * - **Alarms** run forever, one tick at a time: each tick returns when to
 *   tick next, and `wakeAlarm` brings the next tick forward. The cron
 *   scheduler shards are alarms.
 *
 * The gateway defines what each kind does (`DurableRegistry`); a platform
 * pack runs them (Azure: Durable Functions; Cloudflare: Workflows and
 * Durable Objects) and passes the conformance suite in `./conformance.ts`.
 * Handlers run at least once: a host may rerun a handler that was cut off
 * mid-way, so handlers guard their own side effects where it matters.
 */

import type { HandlerContext } from "../host.js";

// ============================================================================
// Instances
// ============================================================================

/**
 * Where an instance is. `pending`: started, not yet running. `running`:
 * running, or (for a wait or alarm) sleeping until its event, timer or next
 * tick. `suspended`: paused by an operator.
 */
export type DurableStatus = "pending" | "running" | "suspended" | "completed" | "failed" | "terminated";

export interface InstanceInfo {
  status: DurableStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Statuses in which an instance still has work to do. */
export function isActive(status: DurableStatus | undefined): boolean {
  return status === "pending" || status === "running";
}

// ============================================================================
// Definitions (what each kind does)
// ============================================================================

/** What a handler gets: logging, and the id of the instance it runs for. */
export interface DurableContext extends HandlerContext {
  readonly instanceId: string;
  /**
   * 1 for a handler's first run; more when the host runs it again because
   * an earlier run was cut off (a restart, a deploy). A handler whose side
   * effects mustn't repeat can stop on a re-run. Hosts that can't tell
   * leave it unset.
   */
  readonly attempt?: number;
}

export interface JobDefinition<I = unknown> {
  /** Unique name; instances carry it. */
  readonly kind: string;
  /** The job. Throwing fails the instance; it is not retried. */
  run(input: I, context: DurableContext): Promise<void>;
}

export interface WaitDefinition<I = unknown, E = unknown> {
  readonly kind: string;
  /** The event name `signal` must use for this kind. */
  readonly event: string;
  /** Runs once when the wait begins, before waiting (e.g. send the form). */
  start?(input: I, context: DurableContext): Promise<void>;
  /** The event arrived before the timeout. */
  onEvent(input: I, payload: E, context: DurableContext): Promise<void>;
  /** The timeout passed first. */
  onTimeout(input: I, context: DurableContext): Promise<void>;
}

export interface AlarmDefinition<I = unknown> {
  readonly kind: string;
  /**
   * One tick. Returns when to tick next (epoch ms). A time in the past ticks
   * again at once. Hosts may wake earlier than asked (e.g. to stay within
   * their longest timer), never later than they can help.
   */
  tick(input: I, context: DurableContext): Promise<number>;
}

// ============================================================================
// Operations
// ============================================================================

export interface StartResult {
  /** False when an instance with this id is already pending or running. */
  started: boolean;
}

/** `suspended`: the alarm exists but an operator paused it; nothing was started. */
export type EnsureResult = "started" | "running" | "suspended";

export interface Durable {
  /**
   * Start a job. With `id` omitted, a fresh id is used. An id whose instance
   * finished (completed, failed or terminated) is replaced.
   */
  startJob<I>(kind: string, input: I, id?: string): Promise<StartResult & { id: string }>;

  /** Start a wait that times out after `timeoutMs`. Same id rules as jobs. */
  startWait<I>(kind: string, id: string, input: I, timeoutMs: number): Promise<StartResult>;

  /**
   * Deliver the wait's event. Returns false, delivering nothing, when no
   * wait with this id is pending or running.
   */
  signal(id: string, event: string, payload: unknown): Promise<boolean>;

  /**
   * Start the alarm unless it is pending or running. A finished or failed
   * alarm is replaced; a suspended one is left alone (see `terminate`).
   */
  ensureAlarm<I>(kind: string, id: string, input: I): Promise<EnsureResult>;

  /** Bring the next tick forward. Returns false when the alarm isn't pending or running. */
  wakeAlarm(id: string): Promise<boolean>;

  /** Stop an instance of any kind. No effect on one that has finished or doesn't exist. */
  terminate(id: string, reason: string): Promise<void>;

  /** Where an instance is, or null if there is none with this id. */
  status(id: string): Promise<InstanceInfo | null>;
}

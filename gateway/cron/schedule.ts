/**
 * AgentForEach Cron System — Schedule Computation
 *
 * Computes next fire times for all schedule types: at, every, cron.
 * Includes stagger logic for top-of-hour cron expressions.
 *
 * Ported from OpenClaw's src/cron/schedule.ts and src/cron/stagger.ts.
 */

import { createHash } from "node:crypto";
import { Cron } from "croner";
import type { CronSchedule } from "./types.js";
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS } from "./config.js";

// ============================================================================
// Next Run Computation
// ============================================================================

/**
 * Compute the next fire time for a schedule.
 *
 * @param schedule - The schedule definition.
 * @param nowMs - Current time (epoch ms).
 * @returns Next fire time (epoch ms), or undefined if the schedule is exhausted.
 */
export function computeNextRunAtMs(
  schedule: CronSchedule,
  nowMs: number,
): number | undefined {
  switch (schedule.kind) {
    case "at":
      return computeAtNextRun(schedule.at, nowMs);
    case "every":
      return computeEveryNextRun(schedule.everyMs, nowMs, schedule.anchorMs);
    case "cron":
      return computeCronNextRun(schedule.expr, nowMs, schedule.tz, schedule.staggerMs);
  }
}

// ============================================================================
// "at" — One-shot
// ============================================================================

/**
 * Parse an absolute one-shot time.
 * For parity with OpenClaw, past timestamps remain schedulable (immediately due)
 * until the job is terminally handled by execution state transitions.
 */
function computeAtNextRun(at: string, _nowMs: number): number | undefined {
  const targetMs = parseAbsoluteTimeMs(at);
  if (targetMs === undefined) return undefined;
  // OpenClaw parity: one-shot jobs remain due until execution applies a
  // terminal result (disable/delete). Returning the raw target timestamp
  // keeps past-due one-shots runnable instead of silently unscheduling them.
  return targetMs;
}

/**
 * Parse an ISO-8601 timestamp or epoch-ms string into epoch milliseconds.
 *
 * Handles:
 * - Pure numeric strings → epoch ms
 * - ISO-8601 with timezone (2026-01-01T08:00:00Z)
 * - ISO date only (2026-01-01 → appends T00:00:00Z)
 * - ISO datetime without timezone → appends Z (treated as UTC)
 */
export function parseAbsoluteTimeMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // Pure numeric → epoch ms
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  }

  // ISO date only (yyyy-mm-dd)
  let iso = trimmed;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    iso += "T00:00:00Z";
  } else if (/^\d{4}-\d{2}-\d{2}T[\d:]+$/.test(iso) && !iso.endsWith("Z")) {
    // ISO datetime without timezone → UTC
    iso += "Z";
  }

  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

// ============================================================================
// "every" — Recurring interval
// ============================================================================

/**
 * Compute the next fire time for a recurring interval.
 * Uses anchor-based alignment so fires are predictable.
 */
function computeEveryNextRun(
  everyMs: number,
  nowMs: number,
  anchorMs?: number,
): number | undefined {
  const safeEveryMs = Math.max(1, Math.floor(everyMs));
  const anchor = Math.max(0, Math.floor(anchorMs ?? nowMs));
  if (nowMs < anchor) {
    return anchor;
  }
  const elapsed = nowMs - anchor;
  const steps = Math.max(1, Math.floor((elapsed + safeEveryMs - 1) / safeEveryMs));
  return anchor + steps * safeEveryMs;
}

// ============================================================================
// "cron" — Cron expression
// ============================================================================

/**
 * Compute the next fire time for a cron expression, with optional stagger offset.
 */
function computeCronNextRun(
  expr: string,
  nowMs: number,
  tz?: string,
  _staggerMs?: number,
): number | undefined {
  const timezone = resolveCronTimezone(tz);

  const cron = new Cron(expr, { timezone, catch: false });
  const next = cron.nextRun(new Date(nowMs));
  if (!next) return undefined;

  let nextMs = next.getTime();

  // Same-second guard: if croner returns "now", advance to next whole second
  // to prevent rescheduling loops (ported from OpenClaw)
  if (nextMs <= nowMs) {
    const retryNext = cron.nextRun(new Date(nowMs + 1000));
    if (!retryNext) return undefined;
    nextMs = retryNext.getTime();
  }

  return nextMs;
}

/**
 * Compute next run with a per-job deterministic stagger offset.
 * Use this instead of computeNextRunAtMs when you have the jobId.
 */
export function computeNextRunWithStagger(
  schedule: CronSchedule,
  nowMs: number,
  jobId: string,
): number | undefined {
  if (schedule.kind !== "cron") {
    return computeNextRunAtMs(schedule, nowMs);
  }

  const staggerWindow = resolveCronStaggerMs(schedule.expr, schedule.staggerMs);
  const offsetMs = resolveStableCronOffsetMs(jobId, staggerWindow);
  if (offsetMs <= 0) {
    return computeCronNextRun(schedule.expr, nowMs, schedule.tz, schedule.staggerMs);
  }

  // Shift the cursor backwards by offset so we can still target the current
  // base schedule window when the staggered slot has not passed yet.
  let cursorMs = Math.max(0, nowMs - offsetMs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const baseNext = computeCronNextRun(schedule.expr, cursorMs, schedule.tz, schedule.staggerMs);
    if (baseNext === undefined) {
      return undefined;
    }
    const shifted = baseNext + offsetMs;
    if (shifted > nowMs) {
      return shifted;
    }
    cursorMs = Math.max(cursorMs + 1, baseNext + 1_000);
  }
  return undefined;
}

// ============================================================================
// Timezone
// ============================================================================

/**
 * Resolve cron timezone.
 * Falls back to host timezone if not specified.
 */
export function resolveCronTimezone(tz?: string): string {
  const trimmed = typeof tz === "string" ? tz.trim() : "";
  if (trimmed) return trimmed;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ============================================================================
// Stagger (ported from OpenClaw src/cron/stagger.ts)
// ============================================================================

/**
 * Check if a cron expression fires at the top of every hour (minute = 0, hour = *).
 * These get automatic stagger to prevent thundering herd.
 */
export function isRecurringTopOfHourCronExpr(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  // 5-field: "0 * * * *"   → minute=0, hour=*
  // 6-field: "0 0 * * * *" → second=0, minute=0, hour=*
  if (parts.length === 5) {
    return parts[0] === "0" && parts[1].includes("*");
  }
  if (parts.length === 6) {
    return parts[0] === "0" && parts[1] === "0" && parts[2].includes("*");
  }
  return false;
}

/**
 * Resolve the effective stagger window for a cron expression.
 *
 * - If `explicitStaggerMs` is set (including 0), use it.
 * - If the expression is a top-of-hour pattern, use the default 5-min stagger.
 * - Otherwise, 0 (no stagger).
 */
export function resolveCronStaggerMs(
  expr: string,
  explicitStaggerMs?: number,
): number {
  if (typeof explicitStaggerMs === "number") {
    return Math.max(0, Math.floor(explicitStaggerMs));
  }
  if (isRecurringTopOfHourCronExpr(expr)) {
    return DEFAULT_TOP_OF_HOUR_STAGGER_MS;
  }
  return 0;
}

/**
 * Compute a deterministic per-job stagger offset using SHA-256(jobId).
 *
 * The offset is stable for a given jobId, evenly distributed within the window.
 * Ported from OpenClaw's resolveStableCronOffsetMs.
 */
export function resolveStableCronOffsetMs(
  jobId: string,
  staggerMs: number,
): number {
  if (staggerMs <= 0) return 0;
  const digest = createHash("sha256").update(jobId).digest();
  return digest.readUInt32BE(0) % staggerMs;
}

#!/usr/bin/env node

/**
 * Comprehensive end-to-end test for scheduled cron execution.
 *
 * Creates jobs at staggered intervals (1m, 3m, 5m, 6m, 7.5m, 10m, 12m),
 * waits for each to fire via the scheduler, and validates:
 *   - Correct model (gpt-4.1-mini, NOT gpt-4o)
 *   - System prompt loaded (input_tokens >> 20)
 *   - Correct summary produced
 *   - Execution happened within a reasonable window of the due time
 *
 * Usage:
 *   node scripts/test-cron-scheduled-e2e.mjs
 *   AGENTFOREACH_BASE_URL=http://localhost:7071 node scripts/test-cron-scheduled-e2e.mjs
 *   On a cloud stack, also set LOADTEST_JWT_SECRET (scripts/load-test/make-config.mjs)
 *
 * Prerequisites:
 *   - func host running locally (or deployed function accessible)
 *   - Scheduler already started
 *   - If testing locally, deployed function must be STOPPED to avoid race
 */

import process from "node:process";
import { userHeaders } from "./lib/test-auth.mjs";

// ============================================================================
// Config
// ============================================================================

const BASE_URL =
  process.env.AGENTFOREACH_BASE_URL?.trim() || "http://localhost:7071";
const USER_ID = process.env.CRON_E2E_USER ?? "e2e-sched-test";
const EXPECTED_MODEL = process.env.CRON_E2E_MODEL ?? "gpt-4.1-mini";
// Minimum input tokens to verify system prompt was loaded (not just the user message)
const MIN_INPUT_TOKENS = 100;
// How long after due time to wait for execution before giving up (ms)
const POLL_TIMEOUT_MS = 120_000;
// Polling interval (ms)
const POLL_INTERVAL_MS = 5_000;
// Grace window: how many seconds after due time the execution is allowed to land
const MAX_EXECUTION_DELAY_S = 90;

// ============================================================================
// Test cases — each gets a unique prompt so we can verify the output
// ============================================================================

const TEST_CASES = [
  {
    label: "1min",
    delayMinutes: 1,
    message: "What is 7 * 8? Reply with just the number.",
    expectSummaryContains: "56",
  },
  {
    label: "3min",
    delayMinutes: 3,
    message: "What is the capital of France? Reply with just the city name.",
    expectSummaryContains: "Paris",
  },
  {
    label: "5min",
    delayMinutes: 5,
    message: "What is 123 + 456? Reply with just the number.",
    expectSummaryContains: "579",
  },
  {
    label: "6min",
    delayMinutes: 6,
    message: "What is the square root of 144? Reply with just the number.",
    expectSummaryContains: "12",
  },
  {
    label: "7.5min",
    delayMinutes: 7.5,
    message: "What is 15 * 15? Reply with just the number.",
    expectSummaryContains: "225",
  },
  {
    label: "10min",
    delayMinutes: 10,
    message: "What is 1000 - 357? Reply with just the number.",
    expectSummaryContains: "643",
  },
  {
    label: "12min",
    delayMinutes: 12,
    message: "What is 2 to the power of 10? Reply with just the number.",
    expectSummaryContains: "1024",
  },
];

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function utcNow() {
  return new Date().toISOString();
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

async function request({ method = "GET", path, body, expected = [200] }) {
  const headers = userHeaders(USER_ID);
  if (body !== undefined) headers["content-type"] = "application/json";

  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }

  if (!expected.includes(res.status)) {
    throw new Error(
      `HTTP ${res.status} ${method} ${path}: ${text.slice(0, 500)}`,
    );
  }
  return { status: res.status, json, text };
}

// ============================================================================
// API wrappers
// ============================================================================

async function ensureSchedulerRunning() {
  // /cron/status and /cron/start need the admin role. Without it, rely on the
  // CronSchedulerHealthCheck timer, which starts the scheduler.
  const { status, json } = await request({ path: "/cron/status", expected: [200, 403] });
  if (status === 403) {
    console.log("  (not an admin: relying on the scheduler health-check timer)");
    return;
  }
  const allRunning = json?.statuses?.every(
    (s) => s.runtimeStatus === "Running" || s.runtimeStatus === "Pending",
  );
  if (allRunning) return;

  console.log("  Scheduler not running — starting...");
  await request({ method: "POST", path: "/cron/start", body: {} });
  await sleep(3_000);
}

async function cleanupJobs() {
  const { json } = await request({ path: "/cron/jobs?includeDisabled=true" });
  const jobs = json?.jobs ?? [];
  const toDelete = jobs.filter(
    (j) => j?.userId === USER_ID && typeof j.id === "string",
  );
  if (toDelete.length === 0) return;

  console.log(`  Cleaning up ${toDelete.length} old job(s)...`);
  await Promise.all(
    toDelete.map((j) =>
      request({
        method: "DELETE",
        path: `/cron/jobs/${j.id}`,
        expected: [200, 404],
      }),
    ),
  );
}

async function createJob(tc, dueAt) {
  const { json } = await request({
    method: "POST",
    path: "/cron/jobs",
    body: {
      name: `e2e-sched-${tc.label}`,
      payload: {
        message: tc.message,
        instructions: "You are a helpful assistant. Answer concisely.",
      },
      schedule: { kind: "at", at: dueAt },
      delivery: { mode: "none" },
      deleteAfterRun: false,
    },
    expected: [201],
  });
  return json;
}

async function getRuns(jobId) {
  const { json } = await request({ path: `/cron/runs/${jobId}` });
  return json?.runs ?? [];
}

async function deleteJob(jobId) {
  await request({
    method: "DELETE",
    path: `/cron/jobs/${jobId}`,
    expected: [200, 404],
  });
}

// ============================================================================
// Core test logic
// ============================================================================

/**
 * Poll for runs until we find one, or time out.
 */
async function waitForRun(jobId, label, dueAtMs) {
  const deadline = dueAtMs + POLL_TIMEOUT_MS;
  const startPoll = Date.now();

  while (Date.now() < deadline) {
    const runs = await getRuns(jobId);
    if (runs.length > 0) {
      const elapsed = Date.now() - startPoll;
      return { run: runs[0], pollDurationMs: elapsed };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `[${label}] Timed out waiting for run (jobId=${jobId}). ` +
      `Polled for ${fmtDuration(Date.now() - startPoll)} after due time.`,
  );
}

function validateRun(tc, run, dueAtMs) {
  const errors = [];

  // 1. Status
  if (run.status !== "ok") {
    errors.push(`status=${run.status}, expected=ok, error=${run.error ?? "?"}`);
  }

  // 2. Model
  if (run.model !== EXPECTED_MODEL) {
    errors.push(`model=${run.model}, expected=${EXPECTED_MODEL}`);
  }

  // 3. Input tokens (system prompt loaded?)
  const inputTokens = run.usage?.input_tokens ?? 0;
  if (inputTokens < MIN_INPUT_TOKENS) {
    errors.push(
      `input_tokens=${inputTokens} (< ${MIN_INPUT_TOKENS}), system prompt likely missing`,
    );
  }

  // 4. Summary contains expected answer
  const summary = (run.summary ?? "").toLowerCase();
  if (!summary.includes(tc.expectSummaryContains.toLowerCase())) {
    errors.push(
      `summary="${run.summary}", expected to contain "${tc.expectSummaryContains}"`,
    );
  }

  // 5. Execution time within grace window
  const executionTs = run.ts ?? 0;
  const delaySec = (executionTs - dueAtMs) / 1000;
  if (delaySec > MAX_EXECUTION_DELAY_S) {
    errors.push(
      `execution delay=${delaySec.toFixed(1)}s, max allowed=${MAX_EXECUTION_DELAY_S}s`,
    );
  }

  return errors;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const testStart = Date.now();
  const nowMs = Date.now();
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  AgentForEach Cron Scheduled Execution — E2E Test`);
  console.log(`  ${utcNow()}`);
  console.log(`  Base URL: ${BASE_URL}`);
  console.log(`  User: ${USER_ID}`);
  console.log(`  Expected model: ${EXPECTED_MODEL}`);
  console.log(`  Test cases: ${TEST_CASES.length}`);
  console.log(`${"=".repeat(70)}\n`);

  // ── Pre-flight ───────────────────────────────────────────────────────────
  console.log("▸ Pre-flight checks...");
  await ensureSchedulerRunning();
  await cleanupJobs();
  console.log("  ✓ Scheduler running, old jobs cleaned\n");

  // ── Create all jobs ──────────────────────────────────────────────────────
  console.log("▸ Creating jobs...");

  /** @type {{ tc: typeof TEST_CASES[0], jobId: string, dueAtMs: number }[]} */
  const jobs = [];

  for (const tc of TEST_CASES) {
    const dueAtMs = nowMs + tc.delayMinutes * 60_000;
    const dueAt = new Date(dueAtMs).toISOString();
    const job = await createJob(tc, dueAt);
    jobs.push({ tc, jobId: job.id, dueAtMs });
    const minutesFromNow = ((dueAtMs - Date.now()) / 60_000).toFixed(1);
    console.log(
      `  ✓ [${tc.label.padEnd(6)}] ${job.id}  due ${dueAt}  (in ${minutesFromNow}m)`,
    );
  }
  console.log();

  // ── Wait and poll for results ────────────────────────────────────────────
  console.log("▸ Waiting for scheduled executions...\n");

  // Sort by due time so we poll in order
  jobs.sort((a, b) => a.dueAtMs - b.dueAtMs);

  /** @type {{ label: string, passed: boolean, details: string }[]} */
  const results = [];

  for (const { tc, jobId, dueAtMs } of jobs) {
    const dueIn = Math.max(0, dueAtMs - Date.now());
    if (dueIn > 0) {
      const waitLabel = fmtDuration(dueIn + 15_000); // add 15s buffer
      console.log(
        `  ⏳ [${tc.label.padEnd(6)}] Due in ${fmtDuration(dueIn)}, waiting ~${waitLabel}...`,
      );
      // Wait until just past due time + a small buffer
      await sleep(dueIn + 15_000);
    }

    try {
      const { run, pollDurationMs } = await waitForRun(jobId, tc.label, dueAtMs);
      const errors = validateRun(tc, run, dueAtMs);

      if (errors.length === 0) {
        const delaySec = ((run.ts - dueAtMs) / 1000).toFixed(1);
        results.push({
          label: tc.label,
          passed: true,
          details:
            `model=${run.model}, tokens=${run.usage?.input_tokens}, ` +
            `summary="${run.summary}", delay=${delaySec}s, poll=${fmtDuration(pollDurationMs)}`,
        });
        console.log(
          `  ✅ [${tc.label.padEnd(6)}] PASS — model=${run.model}, input_tokens=${run.usage?.input_tokens}, ` +
            `summary="${run.summary}", delay=${delaySec}s`,
        );
      } else {
        results.push({
          label: tc.label,
          passed: false,
          details: errors.join("; "),
        });
        console.log(`  ❌ [${tc.label.padEnd(6)}] FAIL — ${errors.join("; ")}`);
      }
    } catch (err) {
      results.push({
        label: tc.label,
        passed: false,
        details: err.message,
      });
      console.log(`  ❌ [${tc.label.padEnd(6)}] FAIL — ${err.message}`);
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  console.log("\n▸ Cleaning up test jobs...");
  for (const { jobId } of jobs) {
    await deleteJob(jobId).catch(() => {});
  }
  console.log("  ✓ Done\n");

  // ── Summary ──────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalDuration = fmtDuration(Date.now() - testStart);

  console.log(`${"=".repeat(70)}`);
  console.log(`  RESULTS: ${passed}/${results.length} passed, ${failed} failed`);
  console.log(`  Duration: ${totalDuration}`);
  console.log(`${"=".repeat(70)}`);
  console.log();

  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`  ${icon} [${r.label.padEnd(6)}] ${r.details}`);
  }
  console.log();

  if (failed > 0) {
    console.error(`\n⚠️  ${failed} test(s) FAILED\n`);
    process.exit(1);
  }

  console.log(`\n🎉 All ${passed} tests passed!\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\n💥 Unhandled error:", err);
  process.exit(2);
});

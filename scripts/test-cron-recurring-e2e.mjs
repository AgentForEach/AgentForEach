#!/usr/bin/env node

/**
 * End-to-end test for RECURRING cron schedules.
 *
 * Tests both schedule kinds that produce multiple executions:
 *   1. "every" — interval-based (everyMs)
 *   2. "cron"  — cron-expression-based (expr)
 *
 * For each job we wait long enough to observe at least 2 runs, then validate:
 *   - Correct model (gpt-4.1-mini, NOT gpt-4o)
 *   - System prompt loaded (input_tokens >> 20)
 *   - Correct summary produced
 *   - Multiple runs landed (recurring re-scheduling works)
 *
 * The default minimum interval (minEveryMs / minCronIntervalMs) is 180 000 ms
 * (3 min), so the shortest interval we test is 3 minutes.
 *
 * Estimated wall-clock time: ~8 minutes (wait for 2+ runs at 3-min intervals).
 *
 * Usage:
 *   node scripts/test-cron-recurring-e2e.mjs
 *   AGENTFOREACH_BASE_URL=http://localhost:7071 node scripts/test-cron-recurring-e2e.mjs
 *
 * Prerequisites:
 *   - func host running locally (or deployed function accessible)
 *   - Scheduler already started
 *   - If testing locally, deployed function must be STOPPED to avoid race
 */

import process from "node:process";

// ============================================================================
// Config
// ============================================================================

const BASE_URL =
  process.env.AGENTFOREACH_BASE_URL?.trim() || "http://localhost:7071";
const USER_ID = process.env.CRON_E2E_USER ?? "e2e-recur-test";
const EXPECTED_MODEL = process.env.CRON_E2E_MODEL ?? "gpt-4.1-mini";
// Minimum input tokens to verify system prompt was loaded
const MIN_INPUT_TOKENS = 100;
// How long after expected 2nd-run time to keep polling before giving up
const POLL_TIMEOUT_MS = 240_000;
// Polling interval (ms)
const POLL_INTERVAL_MS = 5_000;
// Grace window: how many seconds late a run can be
const MAX_EXECUTION_DELAY_S = 120;
// How many runs each recurring job must accumulate
const MIN_EXPECTED_RUNS = 2;

// ============================================================================
// Test cases
// ============================================================================

/**
 * Each test case describes a recurring job.  We wait for at least
 * MIN_EXPECTED_RUNS executions, then validate every run.
 *
 * waitMinutes = enough wall-clock time for 2+ fires, plus buffer.
 */
const TEST_CASES = [
  // ── "every" schedule job ───────────────────────────────────────────────
  {
    label: "every-3m",
    kind: "every",
    schedule: { kind: "every", everyMs: 180_000 }, // 3 min (minimum allowed)
    waitMinutes: 8, // 2 fires ≈ 6 min + buffer
    message: "What is 9 * 9? Reply with just the number.",
    expectSummaryContains: "81",
  },

  // ── "cron" expression job ──────────────────────────────────────────────
  {
    label: "cron-3m",
    kind: "cron",
    schedule: { kind: "cron", expr: "*/3 * * * *" }, // every 3 min
    waitMinutes: 8,
    message: "What is 144 / 12? Reply with just the number.",
    expectSummaryContains: "12",
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
  const headers = { "x-user-id": USER_ID };
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

async function createJob(tc) {
  const expiresAt = Date.now() + 30 * 60 * 1000; // 30 min from now
  const { json } = await request({
    method: "POST",
    path: "/cron/jobs",
    body: {
      name: `e2e-recur-${tc.label}`,
      payload: {
        message: tc.message,
        instructions: "You are a helpful assistant. Answer concisely.",
      },
      schedule: tc.schedule,
      delivery: { mode: "none" },
      deleteAfterRun: false,
      expiresAt,
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
 * Poll until we observe at least `minRuns` completed runs, or time out.
 */
async function waitForRuns(jobId, label, minRuns, deadlineMs) {
  const startPoll = Date.now();

  while (Date.now() < deadlineMs) {
    const runs = await getRuns(jobId);
    const completed = runs.filter((r) => r.status === "ok" || r.status === "error");
    if (completed.length >= minRuns) {
      return { runs: completed, pollDurationMs: Date.now() - startPoll };
    }
    const remaining = fmtDuration(deadlineMs - Date.now());
    process.stdout.write(
      `\r  ⏳ [${label.padEnd(10)}] ${completed.length}/${minRuns} runs so far, ~${remaining} remaining...   `,
    );
    await sleep(POLL_INTERVAL_MS);
  }

  // Final check
  const runs = await getRuns(jobId);
  const completed = runs.filter((r) => r.status === "ok" || r.status === "error");
  if (completed.length >= minRuns) {
    return { runs: completed, pollDurationMs: Date.now() - startPoll };
  }

  throw new Error(
    `[${label}] Timed out: only ${completed.length}/${minRuns} runs after ${fmtDuration(Date.now() - startPoll)}`,
  );
}

function validateRun(tc, run, runIndex) {
  const errors = [];

  // 1. Status
  if (run.status !== "ok") {
    errors.push(`run#${runIndex}: status=${run.status}, error=${run.error ?? "?"}`);
  }

  // 2. Model
  if (run.model !== EXPECTED_MODEL) {
    errors.push(`run#${runIndex}: model=${run.model}, expected=${EXPECTED_MODEL}`);
  }

  // 3. Input tokens
  const inputTokens = run.usage?.input_tokens ?? 0;
  if (inputTokens < MIN_INPUT_TOKENS) {
    errors.push(
      `run#${runIndex}: input_tokens=${inputTokens} (< ${MIN_INPUT_TOKENS}), system prompt likely missing`,
    );
  }

  // 4. Summary contains expected answer
  const summary = (run.summary ?? "").toLowerCase();
  if (!summary.includes(tc.expectSummaryContains.toLowerCase())) {
    errors.push(
      `run#${runIndex}: summary="${run.summary}", expected to contain "${tc.expectSummaryContains}"`,
    );
  }

  return errors;
}

/**
 * Validate timing gaps between consecutive runs.
 * Returns warnings (logged) rather than hard errors, because:
 *   - Cron expressions fire at absolute clock minutes, so the first gap
 *     can be arbitrarily short depending on creation time.
 *   - Scheduler jitter, claim latency, and LLM execution time can stretch gaps.
 */
function validateRunTimings(runs, intervalMs, label) {
  const warnings = [];
  const sorted = [...runs].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].ts ?? 0) - (sorted[i - 1].ts ?? 0);
    const expectedGap = intervalMs;
    // Allow ±50% tolerance on interval gap
    const minGap = expectedGap * 0.5;
    const maxGap = expectedGap * 2.0;
    if (gap < minGap || gap > maxGap) {
      warnings.push(
        `${label}: gap between run#${i - 1}→#${i} = ${fmtDuration(gap)}, expected ~${fmtDuration(expectedGap)} (±50%)`,
      );
    }
  }

  return warnings;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const testStart = Date.now();
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  AgentForEach Cron Recurring Execution — E2E Test`);
  console.log(`  ${utcNow()}`);
  console.log(`  Base URL: ${BASE_URL}`);
  console.log(`  User: ${USER_ID}`);
  console.log(`  Expected model: ${EXPECTED_MODEL}`);
  console.log(`  Test cases: ${TEST_CASES.length}`);
  console.log(`  Min expected runs per job: ${MIN_EXPECTED_RUNS}`);
  console.log(`${"=".repeat(70)}\n`);

  // ── Pre-flight ───────────────────────────────────────────────────────────
  console.log("▸ Pre-flight checks...");
  await ensureSchedulerRunning();
  await cleanupJobs();
  console.log("  ✓ Scheduler running, old jobs cleaned\n");

  // ── Create all jobs ──────────────────────────────────────────────────────
  console.log("▸ Creating recurring jobs...");

  /** @type {{ tc: typeof TEST_CASES[0], jobId: string, createdAtMs: number }[]} */
  const jobs = [];

  for (const tc of TEST_CASES) {
    const createdAtMs = Date.now();
    const job = await createJob(tc);
    jobs.push({ tc, jobId: job.id, createdAtMs });

    const schedDesc =
      tc.kind === "every"
        ? `every ${tc.schedule.everyMs / 1000}s`
        : `cron "${tc.schedule.expr}"`;
    console.log(
      `  ✓ [${tc.label.padEnd(10)}] ${job.id}  schedule=${schedDesc}  wait=${tc.waitMinutes}m`,
    );
  }
  console.log();

  // ── Wait for recurring executions ────────────────────────────────────────
  console.log("▸ Waiting for recurring executions...\n");

  // Process jobs in order of waitMinutes (shortest first)
  const sortedJobs = [...jobs].sort(
    (a, b) => a.tc.waitMinutes - b.tc.waitMinutes,
  );

  /** @type {{ label: string, passed: boolean, details: string, runCount: number }[]} */
  const results = [];

  for (const { tc, jobId, createdAtMs } of sortedJobs) {
    const deadlineMs = createdAtMs + tc.waitMinutes * 60_000 + POLL_TIMEOUT_MS;

    // Wait until enough time has passed for at least MIN_EXPECTED_RUNS executions
    const intervalMs =
      tc.kind === "every" ? tc.schedule.everyMs : estimateCronIntervalMs(tc.schedule.expr);
    const minWaitMs = intervalMs * MIN_EXPECTED_RUNS;
    const waitUntil = createdAtMs + minWaitMs + 60_000; // +60s buffer for scheduler jitter
    const waitRemaining = Math.max(0, waitUntil - Date.now());

    if (waitRemaining > 0) {
      console.log(
        `  ⏳ [${tc.label.padEnd(10)}] Waiting ${fmtDuration(waitRemaining)} for ${MIN_EXPECTED_RUNS}+ runs...`,
      );
      await sleep(waitRemaining);
    }

    try {
      const { runs, pollDurationMs } = await waitForRuns(
        jobId,
        tc.label,
        MIN_EXPECTED_RUNS,
        deadlineMs,
      );

      // Clear the progress line
      process.stdout.write("\r" + " ".repeat(100) + "\r");

      // Validate each run
      const allErrors = [];
      for (let i = 0; i < runs.length; i++) {
        allErrors.push(...validateRun(tc, runs[i], i));
      }

      // Validate timing gaps between runs (warnings only, not hard failures)
      const timingWarnings = validateRunTimings(runs, intervalMs, tc.label);

      if (allErrors.length === 0) {
        const models = runs.map((r) => r.model).join(", ");
        const tokens = runs.map((r) => r.usage?.input_tokens ?? "?").join(", ");
        const summaries = runs.map((r) => `"${r.summary}"`).join(", ");
        let detailStr =
            `${runs.length} runs, models=[${models}], tokens=[${tokens}], ` +
            `summaries=[${summaries}], poll=${fmtDuration(pollDurationMs)}`;
        if (timingWarnings.length > 0) {
          detailStr += ` ⚡ timing: ${timingWarnings.join("; ")}`;
        }
        results.push({
          label: tc.label,
          passed: true,
          runCount: runs.length,
          details: detailStr,
        });
        console.log(
          `  ✅ [${tc.label.padEnd(10)}] PASS — ${runs.length} runs, model=${runs[0].model}, ` +
            `tokens=[${tokens}]`,
        );
        if (timingWarnings.length > 0) {
          console.log(`     ⚡ Timing warning: ${timingWarnings.join("; ")}`);
        }
      } else {
        results.push({
          label: tc.label,
          passed: false,
          runCount: runs.length,
          details: allErrors.join("; "),
        });
        console.log(
          `  ❌ [${tc.label.padEnd(10)}] FAIL — ${allErrors.join("; ")}`,
        );
      }
    } catch (err) {
      // Clear the progress line
      process.stdout.write("\r" + " ".repeat(100) + "\r");

      results.push({
        label: tc.label,
        passed: false,
        runCount: 0,
        details: err.message,
      });
      console.log(`  ❌ [${tc.label.padEnd(10)}] FAIL — ${err.message}`);
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
  console.log(`  Total runs observed: ${results.reduce((s, r) => s + r.runCount, 0)}`);
  console.log(`  Duration: ${totalDuration}`);
  console.log(`${"=".repeat(70)}`);
  console.log();

  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`  ${icon} [${r.label.padEnd(10)}] (${r.runCount} runs) ${r.details}`);
  }
  console.log();

  if (failed > 0) {
    console.error(`\n⚠️  ${failed} test(s) FAILED\n`);
    process.exit(1);
  }

  console.log(`\n🎉 All ${passed} tests passed!\n`);
  process.exit(0);
}

/**
 * Rough estimate of cron interval in ms (for timing-gap validation).
 * Only handles simple cases like *./{n} patterns.
 */
function estimateCronIntervalMs(expr) {
  const parts = expr.split(/\s+/);
  // Check minute field for */N
  const minuteField = parts[0];
  const match = /^\*\/(\d+)$/.exec(minuteField);
  if (match) {
    return parseInt(match[1], 10) * 60_000;
  }
  // Fallback: assume 5 min
  return 300_000;
}

main().catch((err) => {
  console.error("\n💥 Unhandled error:", err);
  process.exit(2);
});

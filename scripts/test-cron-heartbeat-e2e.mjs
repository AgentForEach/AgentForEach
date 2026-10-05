#!/usr/bin/env node

/**
 * Advanced end-to-end cron/heartbeat validation for deployed AgentForEach gateway.
 *
 * Covers:
 * - Cron scheduler status
 * - wakeMode="now" immediate delivery path (multi-user concurrent)
 * - wakeMode="next-heartbeat" deferred delivery path (multi-user concurrent)
 * - Scheduler due-run execution (without force-run, mixed wake modes)
 * - Multi-user isolation (endpoint and session-content isolation)
 *
 * Usage:
 *   node scripts/test-cron-heartbeat-e2e.mjs --base https://<your-app>.azurewebsites.net
 *   AGENTFOREACH_BASE_URL=https://<your-app>.azurewebsites.net node scripts/test-cron-heartbeat-e2e.mjs --users 5 --due-users 3
 *   On a cloud stack, also set LOADTEST_JWT_SECRET (scripts/load-test/make-config.mjs)
 *
 * The base URL is required (--base or AGENTFOREACH_BASE_URL).
 */

import process from "node:process";
import { userHeaders } from "./lib/test-auth.mjs";

const DEFAULT_BASE_URL = process.env.AGENTFOREACH_BASE_URL?.trim() || "";
const USAGE =
  "Usage: node scripts/test-cron-heartbeat-e2e.mjs --base https://<your-app>.azurewebsites.net [--users N] [--due-users N]\n" +
  "       (or set AGENTFOREACH_BASE_URL instead of --base)";
const DEFAULT_USERS = Number.parseInt(process.env.CRON_E2E_USERS ?? "4", 10);
const DEFAULT_DUE_USERS = Number.parseInt(process.env.CRON_E2E_DUE_USERS ?? "2", 10);

function parseArgs(argv) {
  const out = {
    base: DEFAULT_BASE_URL,
    users: Number.isFinite(DEFAULT_USERS) && DEFAULT_USERS > 0 ? DEFAULT_USERS : 4,
    dueUsers: Number.isFinite(DEFAULT_DUE_USERS) && DEFAULT_DUE_USERS > 0 ? DEFAULT_DUE_USERS : 2,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base" && argv[i + 1]) {
      out.base = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--users" && argv[i + 1]) {
      out.users = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg === "--due-users" && argv[i + 1]) {
      out.dueUsers = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!out.base) {
    console.error(`Error: no gateway URL.\n${USAGE}`);
    process.exit(2);
  }
  if (!Number.isFinite(out.users) || out.users < 2) {
    throw new Error("--users must be >= 2");
  }
  if (!Number.isFinite(out.dueUsers) || out.dueUsers < 1) {
    throw new Error("--due-users must be >= 1");
  }
  out.users = Math.floor(out.users);
  out.dueUsers = Math.min(Math.floor(out.dueUsers), out.users);
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message, context) {
  if (!condition) {
    const suffix = context ? ` | context=${JSON.stringify(context)}` : "";
    throw new Error(`${message}${suffix}`);
  }
}

async function requestJson({
  baseUrl,
  method = "GET",
  path,
  userId,
  body,
  expected = [200],
}) {
  const headers = userHeaders(userId);
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // best effort
  }

  if (!expected.includes(res.status)) {
    throw new Error(
      `Unexpected status ${res.status} for ${method} ${path}. Body: ${text.slice(0, 1200)}`,
    );
  }

  return { status: res.status, json, text };
}

async function listJobs(baseUrl, userId, includeDisabled = true) {
  const suffix = includeDisabled ? "?includeDisabled=true" : "";
  const res = await requestJson({
    baseUrl,
    method: "GET",
    path: `/cron/jobs${suffix}`,
    userId,
    expected: [200],
  });
  return Array.isArray(res.json?.jobs) ? res.json.jobs : [];
}

async function cleanupUserJobs(baseUrl, userId) {
  const jobs = await listJobs(baseUrl, userId, true);
  await Promise.all(
    jobs
      .filter((job) => typeof job?.id === "string")
      .map((job) =>
        requestJson({
          baseUrl,
          method: "DELETE",
          path: `/cron/jobs/${job.id}`,
          userId,
          expected: [200, 404],
        }),
      ),
  );
}

async function getSessionMessages(baseUrl, userId, sessionId) {
  const res = await requestJson({
    baseUrl,
    method: "GET",
    path: `/api/sessions/${encodeURIComponent(sessionId)}`,
    userId,
    expected: [200, 404],
  });
  if (res.status === 404) return [];
  return Array.isArray(res.json?.messages) ? res.json.messages : [];
}

function hasUserMessage(messages, text) {
  return messages.some(
    (m) => m?.role === "user" && typeof m?.content === "string" && m.content.includes(text),
  );
}

function hasAssistantAfterUserMessage(messages, text) {
  const idx = messages.findIndex(
    (m) => m?.role === "user" && typeof m?.content === "string" && m.content.includes(text),
  );
  if (idx < 0) return false;
  for (let i = idx + 1; i < messages.length; i += 1) {
    if (messages[i]?.role === "assistant") return true;
  }
  return false;
}

async function waitFor(conditionFn, opts) {
  const { timeoutMs = 90_000, intervalMs = 2_500, label = "condition" } = opts ?? {};
  const started = Date.now();
  for (;;) {
    const value = await conditionFn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

async function createMainJob({
  baseUrl,
  userId,
  sessionId,
  name,
  text,
  wakeMode,
  atIso,
}) {
  const res = await requestJson({
    baseUrl,
    method: "POST",
    path: "/cron/jobs",
    userId,
    expected: [201],
    body: {
      name,
      schedule: { kind: "at", at: atIso },
      sessionTarget: "main",
      wakeMode,
      enabled: true,
      deleteAfterRun: false,
      sessionId,
      payload: { kind: "systemEvent", text },
    },
  });
  assert(typeof res.json?.id === "string", "Job id missing on create", res.json);
  return res.json;
}

/** Force-run a job and wait for its run record: the run is dispatched (202) and recorded when it finishes. */
async function runJobNow(baseUrl, userId, jobId) {
  await requestJson({
    baseUrl,
    method: "POST",
    path: `/cron/jobs/${jobId}/run`,
    userId,
    expected: [202],
  });
  let runs = [];
  await waitFor(
    async () => (runs = await getRuns(baseUrl, userId, jobId)).length > 0,
    { timeoutMs: 120_000, intervalMs: 2_000, label: `force-run record for ${jobId}` },
  );
  return { json: runs[0] };
}

async function getRuns(baseUrl, userId, jobId) {
  const res = await requestJson({
    baseUrl,
    method: "GET",
    path: `/cron/runs/${jobId}`,
    userId,
    expected: [200, 404],
  });
  if (res.status === 404) return [];
  return Array.isArray(res.json?.runs) ? res.json.runs : [];
}

function makeUsers(count) {
  const stamp = Date.now();
  return Array.from({ length: count }, (_, idx) => {
    const n = idx + 1;
    return {
      idx,
      name: `u${n}`,
      userId: `cron-e2e-${stamp}-u${n}`,
      sessionId: `sess-${stamp}-u${n}`,
      nowText: `E2E NOW ${stamp} U${n}`,
      hbText: `E2E HB ${stamp} U${n}`,
      dueText: `E2E DUE ${stamp} U${n}`,
      nowJobId: "",
      hbJobId: "",
      dueJobId: "",
    };
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  const baseUrl = opts.base;
  const users = makeUsers(opts.users);

  console.log(`[INFO] Base URL: ${baseUrl}`);
  console.log(`[INFO] Users: ${users.length} | Due users: ${opts.dueUsers}`);
  console.log(`[INFO] User IDs: ${users.map((u) => u.userId).join(", ")}`);

  const health = await requestJson({ baseUrl, path: "/api/health", expected: [200] });
  assert(health.json?.status === "ok", "Health check did not return ok", health.json);
  console.log("[PASS] Health endpoint");

  // Scheduler status is admin-only; a non-admin caller gets 403 and relies on
  // the CronSchedulerHealthCheck timer having started the scheduler.
  const status = await requestJson({
    baseUrl,
    method: "GET",
    path: "/cron/status",
    userId: users[0].userId,
    expected: [200, 403],
  });
  if (status.status === 403) {
    console.log("[SKIP] /cron/status needs an admin caller");
  } else {
    assert(Number(status.json?.shardCount ?? 0) >= 1, "Invalid shardCount", status.json);
    assert(
      Array.isArray(status.json?.statuses) &&
        status.json.statuses.some((s) => s?.runtimeStatus === "Running"),
      "No scheduler shard is running",
      status.json,
    );
    console.log("[PASS] Cron status shows running scheduler");
  }

  let cleanupAttempted = false;
  try {
    await Promise.all(users.map((u) => cleanupUserJobs(baseUrl, u.userId)));
    console.log("[PASS] Cleanup for all test users");

    // ------------------------------------------------------------------------
    // 1) Concurrent force-run for wakeMode=now and wakeMode=next-heartbeat
    // ------------------------------------------------------------------------
    await Promise.all(
      users.map(async (u) => {
        const nowJob = await createMainJob({
          baseUrl,
          userId: u.userId,
          sessionId: u.sessionId,
          name: `e2e-wake-now-${u.name}`,
          text: u.nowText,
          wakeMode: "now",
          atIso: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
        u.nowJobId = nowJob.id;

        const hbJob = await createMainJob({
          baseUrl,
          userId: u.userId,
          sessionId: u.sessionId,
          name: `e2e-wake-hb-${u.name}`,
          text: u.hbText,
          wakeMode: "next-heartbeat",
          atIso: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
        u.hbJobId = hbJob.id;
      }),
    );
    console.log("[PASS] Created force-run jobs for all users");

    const runResults = await Promise.all(
      users.flatMap((u) => [
        runJobNow(baseUrl, u.userId, u.nowJobId),
        runJobNow(baseUrl, u.userId, u.hbJobId),
      ]),
    );
    for (const res of runResults) {
      assert(res.json?.status === "ok", "Force-run recorded a non-ok run", res.json);
    }
    console.log("[PASS] Force-run succeeded for all wakeMode jobs");

    // Validate heartbeat-queue response exists for at least one next-heartbeat run
    const hbRunResults = runResults.filter(
      (res) => typeof res.json?.summary === "string" && res.json.summary.includes("QUEUED_NEXT_HEARTBEAT"),
    );
    assert(hbRunResults.length >= users.length, "Not all next-heartbeat runs returned queued summary");
    console.log("[PASS] next-heartbeat queued summaries confirmed");

    // Delivery checks per user
    await Promise.all(
      users.map((u) =>
        waitFor(
          async () => {
            const messages = await getSessionMessages(baseUrl, u.userId, u.sessionId);
            const nowDelivered =
              hasUserMessage(messages, u.nowText) &&
              hasAssistantAfterUserMessage(messages, u.nowText);
            const hbDelivered =
              hasUserMessage(messages, u.hbText) &&
              hasAssistantAfterUserMessage(messages, u.hbText);
            return nowDelivered && hbDelivered;
          },
          {
            timeoutMs: 120_000,
            intervalMs: 3_000,
            label: `wakeMode deliveries for ${u.userId}`,
          },
        ),
      ),
    );
    console.log("[PASS] All users received wakeMode now + next-heartbeat deliveries");

    // ------------------------------------------------------------------------
    // 2) Scheduler-due jobs (no force-run), mixed wake modes
    // ------------------------------------------------------------------------
    const dueUsers = users.slice(0, opts.dueUsers);
    await Promise.all(
      dueUsers.map(async (u) => {
        const wakeMode = u.idx % 2 === 0 ? "next-heartbeat" : "now";
        const dueJob = await createMainJob({
          baseUrl,
          userId: u.userId,
          sessionId: u.sessionId,
          name: `e2e-due-${u.name}`,
          text: u.dueText,
          wakeMode,
          atIso: new Date(Date.now() + 70_000).toISOString(),
        });
        u.dueJobId = dueJob.id;
      }),
    );
    console.log("[PASS] Created scheduler-due jobs");

    await Promise.all(
      dueUsers.map((u) =>
        waitFor(
          async () => {
            const runs = await getRuns(baseUrl, u.userId, u.dueJobId);
            return runs.length > 0;
          },
          {
            timeoutMs: 210_000,
            intervalMs: 5_000,
            label: `due run record for ${u.userId}`,
          },
        ),
      ),
    );
    console.log("[PASS] Scheduler executed due jobs and recorded runs");

    await Promise.all(
      dueUsers.map((u) =>
        waitFor(
          async () => {
            const messages = await getSessionMessages(baseUrl, u.userId, u.sessionId);
            return (
              hasUserMessage(messages, u.dueText) &&
              hasAssistantAfterUserMessage(messages, u.dueText)
            );
          },
          {
            timeoutMs: 240_000,
            intervalMs: 5_000,
            label: `due delivery for ${u.userId}`,
          },
        ),
      ),
    );
    console.log("[PASS] Scheduler-due deliveries reached sessions");

    // ------------------------------------------------------------------------
    // 3) Isolation checks
    // ------------------------------------------------------------------------
    const crossChecks = [];
    for (let i = 0; i < users.length; i += 1) {
      const owner = users[i];
      const reader = users[(i + 1) % users.length];
      crossChecks.push(
        requestJson({
          baseUrl,
          method: "GET",
          path: `/cron/jobs/${owner.nowJobId}`,
          userId: reader.userId,
          expected: [404],
        }),
      );
    }
    const crossResults = await Promise.all(crossChecks);
    assert(crossResults.every((r) => r.status === 404), "Cross-user cron read was not blocked");
    console.log("[PASS] Cross-user cron access denied across user set");

    // Session contamination check:
    // each user's session should not contain another user's marker tokens.
    const allMarkers = users.flatMap((u) => [u.nowText, u.hbText, u.dueText]);
    await Promise.all(
      users.map(async (u) => {
        const messages = await getSessionMessages(baseUrl, u.userId, u.sessionId);
        const content = messages
          .map((m) => (typeof m?.content === "string" ? m.content : ""))
          .join("\n");
        const ownMarkers = [u.nowText, u.hbText, u.dueText];
        const foreignMarkers = allMarkers.filter(
          (marker) => !ownMarkers.includes(marker),
        );
        const leak = foreignMarkers.find((marker) => content.includes(marker));
        assert(!leak, "Session contains foreign user marker", {
          userId: u.userId,
          leakedMarker: leak,
        });
      }),
    );
    console.log("[PASS] Session-content isolation validated");

    console.log("\n[RESULT] Advanced multi-user cron/wakeMode/heartbeat e2e suite passed.");
  } finally {
    cleanupAttempted = true;
    await Promise.all(
      users.map(async (u) => {
        try {
          await cleanupUserJobs(baseUrl, u.userId);
        } catch {
          // best effort cleanup
        }
      }),
    );
    if (cleanupAttempted) {
      console.log("[INFO] Cleanup attempted for all test users");
    }
  }
}

main().catch((err) => {
  console.error("\n[FAIL]", err?.message ?? err);
  process.exit(1);
});


#!/usr/bin/env node

/**
 * Multi-user smoke test for AgentForEach gateway.
 *
 * Validates:
 * - Health/auth basics
 * - Cron endpoint lifecycle per user
 * - Cron isolation between users
 * - Memory store/search/recall per user
 * - Memory isolation between users
 *
 * Usage:
 *   node scripts/test-multi-user-smoke.mjs --base https://<your-app>.azurewebsites.net --users 4
 *   AGENTFOREACH_BASE_URL=https://<your-app>.azurewebsites.net node scripts/test-multi-user-smoke.mjs
 *
 * The base URL is required (--base or AGENTFOREACH_BASE_URL).
 *
 * Optional env vars:
 *   AGENTFOREACH_TEST_USERS=3
 *   LOADTEST_JWT_SECRET=...           // sign each user in with a JWT (a cloud stack; scripts/load-test/make-config.mjs)
 *   AGENTFOREACH_AUTH_BEARER=...      // if your env requires Authorization header
 */

import process from "node:process";
import { userHeaders } from "./lib/test-auth.mjs";

const DEFAULT_USER_COUNT = 3;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base" && argv[i + 1]) {
      out.base = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--users" && argv[i + 1]) {
      out.users = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  console.log(
    [
      "AgentForEach multi-user smoke test",
      "",
      "Options:",
      "  --base <url>    Base URL of the gateway (required, or set AGENTFOREACH_BASE_URL)",
      "  --users <n>     Number of synthetic users (default env AGENTFOREACH_TEST_USERS or 3)",
      "  --help          Show this help",
      "",
      "Env:",
      "  AGENTFOREACH_BASE_URL",
      "  AGENTFOREACH_TEST_USERS",
      "  AGENTFOREACH_AUTH_BEARER",
    ].join("\n"),
  );
}

function nowIsoPlusMinutes(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function randSuffix() {
  return Math.random().toString(36).slice(2, 10);
}

function assert(condition, message, context = undefined) {
  if (!condition) {
    const suffix = context ? ` | context=${JSON.stringify(context)}` : "";
    throw new Error(`${message}${suffix}`);
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function requestJson({
  baseUrl,
  path,
  method = "GET",
  userId,
  body,
  expectedStatuses,
  authBearer,
}) {
  const headers = userHeaders(userId);
  if (authBearer) headers.Authorization = `Bearer ${authBearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const json = safeJsonParse(text);
  const ok = expectedStatuses.includes(res.status);
  if (!ok) {
    throw new Error(
      [
        `Unexpected HTTP status for ${method} ${path}`,
        `Expected: ${expectedStatuses.join(", ")} | Actual: ${res.status}`,
        `Body: ${text.slice(0, 1000)}`,
      ].join("\n"),
    );
  }
  return { status: res.status, json, text };
}

function extractChatText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const text = payload.text;
  return typeof text === "string" ? text : "";
}

async function ensureTokenInMemory({
  baseUrl,
  userId,
  token,
  sessionBase,
  authBearer,
  maxAttempts = 3,
}) {
  let lastSearchText = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await requestJson({
      baseUrl,
      path: "/api/chat",
      method: "POST",
      userId,
      authBearer,
      expectedStatuses: [200],
      body: {
        wait: true, // reply in the response, not only over the socket
        sessionId: `${sessionBase}-store-${attempt}`,
        message:
          // Not "token=…": a model rightly refuses to store what looks like a secret.
          `Call memory_store now with this exact text: The user's favourite word is ${token}. ` +
          "Then reply with exactly: STORED",
      },
    });

    const searchResp = await requestJson({
      baseUrl,
      path: "/api/chat",
      method: "POST",
      userId,
      authBearer,
      expectedStatuses: [200],
      body: {
        wait: true, // reply in the response, not only over the socket
        sessionId: `${sessionBase}-search-${attempt}`,
        message:
          `Call memory_search for this query exactly: ${token}. ` +
          "Return only the user's favourite word if found, else return NOT_FOUND.",
      },
    });
    lastSearchText = extractChatText(searchResp.json);
    if (lastSearchText.includes(token)) {
      return;
    }
  }

  throw new Error(
    `Memory token not found after ${maxAttempts} attempt(s)` +
      ` | userId=${userId} token=${token} lastSearchText=${JSON.stringify(lastSearchText)}`,
  );
}

async function runForUser({
  baseUrl,
  userId,
  token,
  authBearer,
  shared,
}) {
  const createdAt = nowIsoPlusMinutes(5);

  const createResp = await requestJson({
    baseUrl,
    path: "/cron/jobs",
    method: "POST",
    userId,
    authBearer,
    expectedStatuses: [201],
    body: {
      name: `Smoke job ${userId}`,
      schedule: { kind: "at", at: createdAt },
      payload: { kind: "agentTurn", message: `Reminder ping for ${userId}.` },
      sessionTarget: "isolated",
      enabled: true,
      deleteAfterRun: false,
    },
  });
  const job = createResp.json;
  assert(job && typeof job.id === "string", "Cron create response missing job id", createResp.json);
  const jobId = job.id;
  shared.jobs.push({ userId, jobId });

  const getResp = await requestJson({
    baseUrl,
    path: `/cron/jobs/${jobId}`,
    method: "GET",
    userId,
    authBearer,
    expectedStatuses: [200],
  });
  assert(getResp.json?.id === jobId, "Cron get returned wrong job id", getResp.json);

  const listResp = await requestJson({
    baseUrl,
    path: "/cron/jobs",
    method: "GET",
    userId,
    authBearer,
    expectedStatuses: [200],
  });
  assert(Array.isArray(listResp.json?.jobs), "Cron list missing jobs array", listResp.json);
  assert(
    listResp.json.jobs.some((j) => j?.id === jobId),
    "Cron list does not include created job",
    listResp.json,
  );

  const runResp = await requestJson({
    baseUrl,
    path: `/cron/jobs/${jobId}/run`,
    method: "POST",
    userId,
    authBearer,
    expectedStatuses: [202],
  });
  assert(runResp.json?.jobId === jobId, "Cron force-run returned wrong job id", runResp.json);

  // The force-run is dispatched (202); its run is recorded when it finishes.
  let runsResp;
  for (const deadline = Date.now() + 180_000; ; ) {
    runsResp = await requestJson({
      baseUrl,
      path: `/cron/runs/${jobId}`,
      method: "GET",
      userId,
      authBearer,
      expectedStatuses: [200],
    });
    if (Number(runsResp.json?.count ?? 0) >= 1 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  assert(
    Number(runsResp.json?.count ?? 0) >= 1,
    "Cron runs did not record execution",
    runsResp.json,
  );

  const sessionBase = `smoke-${userId}-${randSuffix()}`;
  await ensureTokenInMemory({
    baseUrl,
    userId,
    token,
    sessionBase,
    authBearer,
  });

  return { userId, token, jobId };
}

async function checkCronIsolation({
  baseUrl,
  pairA,
  pairB,
  authBearer,
}) {
  const getAsOther = await requestJson({
    baseUrl,
    path: `/cron/jobs/${pairA.jobId}`,
    method: "GET",
    userId: pairB.userId,
    authBearer,
    expectedStatuses: [404],
  });
  assert(getAsOther.status === 404, "Cross-user cron get should be 404");

  const runsAsOther = await requestJson({
    baseUrl,
    path: `/cron/runs/${pairA.jobId}`,
    method: "GET",
    userId: pairB.userId,
    authBearer,
    expectedStatuses: [404],
  });
  assert(runsAsOther.status === 404, "Cross-user cron runs should be 404");
}

async function checkMemoryIsolation({
  baseUrl,
  user,
  otherToken,
  authBearer,
}) {
  const sessionId = `isolation-${user.userId}-${randSuffix()}`;
  const resp = await requestJson({
    baseUrl,
    path: "/api/chat",
    method: "POST",
    userId: user.userId,
    authBearer,
    expectedStatuses: [200],
    body: {
      wait: true, // reply in the response, not only over the socket
      sessionId,
      message:
        `Call memory_search with this exact query: ${user.token}. ` +
        "Return only the user's favourite word if found, else return NOT_FOUND.",
    },
  });
  const text = extractChatText(resp.json);
  assert(text.includes(user.token), "Isolation check failed: own token missing", { userId: user.userId, text });
  assert(
    !text.includes(otherToken),
    "Isolation check failed: other user's token leaked",
    { userId: user.userId, text, otherToken },
  );
}

async function cleanupJobs({ baseUrl, jobs, authBearer }) {
  await Promise.all(
    jobs.map(async ({ userId, jobId }) => {
      try {
        await requestJson({
          baseUrl,
          path: `/cron/jobs/${jobId}`,
          method: "DELETE",
          userId,
          authBearer,
          expectedStatuses: [200, 404],
        });
      } catch {
        // Best-effort cleanup.
      }
    }),
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  const baseRaw = (args.base || process.env.AGENTFOREACH_BASE_URL || "").trim();
  if (!baseRaw) {
    console.error("Error: no gateway URL. Pass --base https://<your-app>.azurewebsites.net or set AGENTFOREACH_BASE_URL.\n");
    usage();
    process.exit(2);
  }
  const baseUrl = baseRaw.replace(/\/+$/, "");
  const userCountRaw = args.users ?? process.env.AGENTFOREACH_TEST_USERS ?? DEFAULT_USER_COUNT;
  const userCount = Number(userCountRaw);
  const authBearer = process.env.AGENTFOREACH_AUTH_BEARER;

  assert(Number.isInteger(userCount) && userCount >= 2, "User count must be an integer >= 2");

  const runId = `${Date.now()}-${randSuffix()}`;
  const users = Array.from({ length: userCount }, (_, idx) => ({
    userId: `smoke-user-${idx + 1}-${runId}`,
    token: `tok-${idx + 1}-${runId}`,
  }));
  const shared = { jobs: [] };

  console.log(`[multi-user-smoke] baseUrl=${baseUrl}`);
  console.log(`[multi-user-smoke] users=${userCount}`);
  console.log(`[multi-user-smoke] runId=${runId}`);

  const health = await requestJson({
    baseUrl,
    path: "/api/health",
    method: "GET",
    expectedStatuses: [200],
  });
  assert(health.json?.status === "ok", "Health endpoint did not return ok", health.json);
  console.log("[pass] /api/health");

  const unauthorizedCron = await requestJson({
    baseUrl,
    path: "/cron/jobs",
    method: "GET",
    expectedStatuses: [401, 200],
  });
  if (unauthorizedCron.status === 401) {
    console.log("[pass] unauthenticated cron access blocked");
  } else {
    console.log("[warn] unauthenticated cron access not blocked (expected in local/insecure mode)");
  }

  // Global scheduler control is admin-only; the scheduler itself is started
  // by the CronSchedulerHealthCheck timer.
  for (const [path, method] of [["/cron/start", "POST"], ["/cron/status", "GET"]]) {
    await requestJson({
      baseUrl,
      path,
      method,
      userId: users[0].userId,
      authBearer,
      expectedStatuses: [403],
    });
    console.log(`[pass] ${path} refused for a non-admin user`);
  }

  let perUserResults = [];
  try {
    perUserResults = await Promise.all(
      users.map((u) => runForUser({
        baseUrl,
        userId: u.userId,
        token: u.token,
        authBearer,
        shared,
      })),
    );
    console.log("[pass] per-user cron + memory flow");

    for (let i = 0; i < perUserResults.length; i += 1) {
      const a = perUserResults[i];
      const b = perUserResults[(i + 1) % perUserResults.length];
      await checkCronIsolation({ baseUrl, pairA: a, pairB: b, authBearer });
    }
    console.log("[pass] cross-user cron isolation");

    for (let i = 0; i < perUserResults.length; i += 1) {
      const user = perUserResults[i];
      const other = perUserResults[(i + 1) % perUserResults.length];
      await checkMemoryIsolation({
        baseUrl,
        user,
        otherToken: other.token,
        authBearer,
      });
    }
    console.log("[pass] cross-user memory isolation");
  } finally {
    await cleanupJobs({ baseUrl, jobs: shared.jobs, authBearer });
    console.log(`[cleanup] attempted delete for ${shared.jobs.length} cron job(s)`);
  }

  console.log("");
  console.log("All multi-user smoke checks passed.");
}

main().catch((err) => {
  console.error("");
  console.error("Multi-user smoke test failed.");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

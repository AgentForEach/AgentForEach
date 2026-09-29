#!/usr/bin/env node
/**
 * Load test: N simulated users, each with its own identity, socket and
 * session, sending chat turns through the production path (POST /api/chat →
 * background turn → reply over Web PubSub).
 *
 * Measures, per turn: accept latency (HTTP), time to first streamed text,
 * time to the final event, outcome (completed / error code / timeout), and
 * the token usage the final event reports.
 *
 *   node scripts/load-test/run.mjs \
 *     --base-url https://<app>.azurewebsites.net \
 *     --jwt-secret "$LOADTEST_JWT_SECRET" --jwt-issuer agentforeach-loadtest --jwt-audience agentforeach \
 *     --users 200 --turns 5 --ramp-seconds 120 --think-ms 5000 \
 *     --mix chat=80,memory=15,cron=5 --out docs/benchmarks/run-1.json
 *
 * The stack must accept HS256 JWTs signed with --jwt-secret (auth provider
 * "jwt", algorithm HS256, same issuer/audience). Locally, --auth header sends
 * x-user-id instead (AUTH_ALLOW_INSECURE_USER_ID_HEADER=true).
 *
 * Needs Node 22+ (global WebSocket).
 */

import { createHmac, randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ============================================================================
// Options
// ============================================================================

function parseArgs(argv) {
  const opts = {
    baseUrl: "http://localhost:7071",
    auth: "jwt",
    jwtSecret: process.env.LOADTEST_JWT_SECRET,
    jwtIssuer: "agentforeach-loadtest",
    jwtAudience: "agentforeach",
    users: 10,
    turns: 3,
    rampSeconds: 10,
    thinkMs: 2000,
    turnTimeoutMs: 300_000,
    mix: "chat=80,memory=15,cron=5",
    userPrefix: `lt-${Date.now().toString(36)}`,
    model: undefined,
    out: undefined,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (!(key in opts)) throw new Error(`unknown option --${argv[i].replace(/^--/, "")}`);
    opts[key] = typeof opts[key] === "number" ? Number(value) : value;
    i++;
  }
  if (opts.auth === "jwt" && !opts.jwtSecret) throw new Error("--jwt-secret (or LOADTEST_JWT_SECRET) is required");
  opts.mixWeights = Object.fromEntries(
    opts.mix.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k.trim(), Number(v)];
    }),
  );
  return opts;
}

// ============================================================================
// Scenarios
// ============================================================================

const COLOURS = ["teal", "amber", "crimson", "violet", "olive", "indigo"];

/** Messages per scenario; each returns the text for the user's n-th turn. */
const SCENARIOS = {
  chat: (n) =>
    [
      "Give me three ideas for a quick weeknight dinner.",
      "Summarise the plot of Hamlet in two sentences.",
      "What's a good way to start learning to run?",
      "Explain compound interest to a teenager.",
      "Write a haiku about Monday mornings.",
    ][n % 5],
  memory: (n) =>
    n % 2 === 0
      ? `Please remember that my favourite colour is ${COLOURS[n % COLOURS.length]}.`
      : "What's my favourite colour?",
  cron: () => "Remind me in 3 hours to stretch.",
  sandbox: () => "Use Python to compute the 30th Fibonacci number and tell me the result.",
};

function pickScenario(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [name, w] of Object.entries(weights)) {
    if ((r -= w) < 0) return name;
  }
  return "chat";
}

// ============================================================================
// Auth
// ============================================================================

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function jwtFor(opts, userId) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ sub: userId, iss: opts.jwtIssuer, aud: opts.jwtAudience, iat: now, exp: now + 6 * 3600 });
  const sig = createHmac("sha256", opts.jwtSecret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function authHeaders(opts, userId) {
  return opts.auth === "header" ? { "x-user-id": userId } : { authorization: `Bearer ${jwtFor(opts, userId)}` };
}

// ============================================================================
// One simulated user
// ============================================================================

async function openSocket(opts, userId, onChatEvent) {
  const res = await fetch(`${opts.baseUrl}/negotiate`, { headers: authHeaders(opts, userId) });
  if (!res.ok) throw new Error(`negotiate ${res.status}`);
  const { url } = await res.json();
  const ws = new WebSocket(url, "json.webpubsub.azure.v1");
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
  });
  ws.addEventListener("message", (ev) => {
    let frame;
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    let data = frame.type === "message" ? frame.data : frame;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (data?.type === "event" && data.event === "chat" && data.payload) onChatEvent(data.payload);
  });
  return ws;
}

async function runUser(opts, index, results, startAt) {
  const userId = `${opts.userPrefix}-${index}`;
  const sessionId = randomUUID();
  const waiting = new Map(); // runId -> { firstDeltaAt, resolve }
  const early = new Map(); // events that arrived before the POST returned

  const onChatEvent = (p) => {
    if (!p.runId) return;
    const w = waiting.get(p.runId);
    if (!w) {
      if (!early.has(p.runId)) early.set(p.runId, []);
      early.get(p.runId).push({ p, at: Date.now() });
      return;
    }
    handle(w, p, Date.now());
  };
  const handle = (w, p, at) => {
    if (p.state === "delta" && !w.firstDeltaAt) w.firstDeltaAt = at;
    if (p.state === "final" || p.state === "error") w.resolve({ p, at });
  };

  await sleep(Math.max(0, startAt - Date.now()));
  let ws;
  try {
    ws = await openSocket(opts, userId, onChatEvent);
  } catch (err) {
    results.push({ userId, scenario: "connect", outcome: `connect_failed: ${err.message}` });
    return;
  }

  try {
    for (let n = 0; n < opts.turns; n++) {
      const scenario = pickScenario(opts.mixWeights);
      const message = SCENARIOS[scenario](n);
      const t0 = Date.now();
      const record = { userId, scenario, turn: n };
      try {
        const res = await fetch(`${opts.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders(opts, userId) },
          body: JSON.stringify({ message, sessionId, idempotencyKey: randomUUID(), ...(opts.model ? { model: opts.model } : {}) }),
        });
        record.acceptMs = Date.now() - t0;
        record.httpStatus = res.status;
        const body = await res.json().catch(() => ({}));
        if (res.status !== 202 && res.status !== 200) {
          record.outcome = body.error ?? `http_${res.status}`;
        } else if (res.status === 200 && body.text !== undefined) {
          // Sync mode (local dev): the reply is in the response.
          record.totalMs = Date.now() - t0;
          record.outcome = body.status === "completed" ? "completed" : body.error ?? body.status;
          record.usage = body.usage;
        } else {
          record.runId = body.runId;
          const w = { firstDeltaAt: 0 };
          const done = new Promise((resolve) => (w.resolve = resolve));
          waiting.set(body.runId, w);
          for (const e of early.get(body.runId) ?? []) handle(w, e.p, e.at);
          early.delete(body.runId);
          const final = await Promise.race([done, sleep(opts.turnTimeoutMs).then(() => undefined)]);
          waiting.delete(body.runId);
          if (!final) record.outcome = "timeout";
          else {
            record.totalMs = final.at - t0;
            if (w.firstDeltaAt) record.firstTextMs = w.firstDeltaAt - t0;
            record.outcome = final.p.state === "final" ? "completed" : final.p.code ?? "error";
            record.usage = final.p.usage;
          }
        }
      } catch (err) {
        record.outcome = `client_error: ${err.message}`;
      }
      results.push(record);
      await sleep(opts.thinkMs * (0.5 + Math.random()));
    }
  } finally {
    ws.close();
  }
}

// ============================================================================
// Report
// ============================================================================

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarise(opts, results, startedAt, endedAt) {
  const turns = results.filter((r) => r.scenario !== "connect");
  const completed = turns.filter((r) => r.outcome === "completed");
  const stats = (key, rows = completed) => {
    const xs = rows.map((r) => r[key]).filter((v) => typeof v === "number").sort((a, b) => a - b);
    return { p50: percentile(xs, 50), p95: percentile(xs, 95), p99: percentile(xs, 99), max: xs.at(-1) ?? null };
  };
  const outcomes = {};
  for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const tokens = completed.reduce(
    (acc, r) => ({
      input: acc.input + (r.usage?.inputTokens ?? 0),
      output: acc.output + (r.usage?.outputTokens ?? 0),
    }),
    { input: 0, output: 0 },
  );
  const minutes = (endedAt - startedAt) / 60_000;
  return {
    options: { ...opts, jwtSecret: undefined, mixWeights: undefined },
    startedAt: new Date(startedAt).toISOString(),
    durationMinutes: Number(minutes.toFixed(2)),
    users: opts.users,
    turns: turns.length,
    completed: completed.length,
    failureRate: turns.length ? Number((1 - completed.length / turns.length).toFixed(4)) : null,
    throughputTurnsPerMinute: Number((completed.length / minutes).toFixed(1)),
    acceptMs: stats("acceptMs", turns),
    firstTextMs: stats("firstTextMs"),
    totalMs: stats("totalMs"),
    byScenario: Object.fromEntries(
      Object.keys(SCENARIOS).map((s) => {
        const rows = completed.filter((r) => r.scenario === s);
        return [s, { completed: rows.length, totalMs: stats("totalMs", rows) }];
      }),
    ),
    outcomes,
    tokens,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// Main
// ============================================================================

const opts = parseArgs(process.argv);
const results = [];
const startedAt = Date.now();
console.log(`load test: ${opts.users} users × ${opts.turns} turns against ${opts.baseUrl}`);
const progress = setInterval(() => {
  const done = results.filter((r) => r.outcome === "completed").length;
  console.log(`  ${Math.round((Date.now() - startedAt) / 1000)}s: ${results.length} turns, ${done} completed`);
}, 10_000);

await Promise.all(
  Array.from({ length: opts.users }, (_, i) =>
    runUser(opts, i, results, startedAt + (opts.rampSeconds * 1000 * i) / opts.users),
  ),
);
clearInterval(progress);

const summary = summarise(opts, results, startedAt, Date.now());
console.log(JSON.stringify(summary, null, 2));
if (opts.out) {
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify({ summary, results }, null, 2));
  console.log(`wrote ${opts.out}`);
}
// Don't wait for every socket's close handshake.
process.exit(summary.failureRate === 0 ? 0 : 1);

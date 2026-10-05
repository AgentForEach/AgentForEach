#!/usr/bin/env node

/**
 * Acceptance checks against a deployed AWS stack (docs/AWS.md#check-a-deployment),
 * as two real users signed in through the foundation's Cognito pool.
 *
 * It creates two synthetic Cognito users (admin-created, random passwords), and
 * a disabled cron job; it removes the job, erases both users' data and deletes
 * both users at the end, whatever happened. Never run by CI.
 *
 * Checks: health; sign-in refused without a valid token; per-user isolation of
 * sessions, cron jobs, chat runs and HITL forms; realtime tokens and AppSync
 * subscriptions (another user's channel refused; events reach only their user;
 * reconnect); POST /api/chat with wait:true refused (Lambda can't hold a turn);
 * a durable chat turn, idempotent on its key, followed with GET /api/chat/runs/{runId};
 * EventBridge running a due job. With AWS_LIVE_MODEL_FLOWS=1, a model is
 * required to answer, and the sandbox tool and HITL answer continuation are
 * checked end to end.
 *
 * Usage:
 *   pulumi -C deploy/aws/foundation stack output --json --stack <foundation> > /tmp/afe-foundation.json
 *   pulumi -C deploy/aws/infra stack output --json --stack <name> > /tmp/afe-application.json
 *   AWS_APPLICATION_LIVE=1 node scripts/test-aws-application-live.mjs /tmp/afe-foundation.json /tmp/afe-application.json
 *
 * Environment:
 *   AWS_REGION              the stack's region (default: the API URL's)
 *   AWS_LIVE_PROVIDER_ID    providerId for chat turns (default: the deployment's default provider)
 *   AWS_LIVE_MODEL_FLOWS=1  fail unless the model answers, and run the tool and HITL flows
 *   AWS_LIVE_CHECK_MATCH    a regular expression: run only the checks whose names match
 *   AWS_LIVE_REPORT         also write the JSON report to this file
 *   AWS_LIVE_REALTIME_CLIENT  path to the portable realtime client module (default below)
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

if (process.env.AWS_APPLICATION_LIVE !== "1") {
  console.error("Set AWS_APPLICATION_LIVE=1 to run against a deployed stack (it creates and deletes two Cognito users).");
  process.exit(2);
}
const [foundationPath, applicationPath] = process.argv.slice(2);
if (!foundationPath || !applicationPath) {
  console.error("usage: test-aws-application-live.mjs <foundation-outputs.json> <application-outputs.json>");
  process.exit(2);
}
const foundation = JSON.parse(await readFile(foundationPath, "utf8"));
const application = JSON.parse(await readFile(applicationPath, "utf8"));
const base = new URL(application.apiUrl);
assert.equal(base.protocol, "https:");
const region = process.env.AWS_REGION ?? base.hostname.match(/execute-api\.([a-z0-9-]+)\./)?.[1] ?? "us-west-2";
const providerId = process.env.AWS_LIVE_PROVIDER_ID;
const requireModel = process.env.AWS_LIVE_MODEL_FLOWS === "1";
const checkMatch = process.env.AWS_LIVE_CHECK_MATCH ? new RegExp(process.env.AWS_LIVE_CHECK_MATCH) : undefined;
// The portable realtime client (packages/platform/src/realtime/client), dependency-free ESM.
const clientPath =
  process.env.AWS_LIVE_REALTIME_CLIENT ?? fileURLToPath(new URL("../packages/platform/dist/realtime/client/index.js", import.meta.url));

const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "afe-live-"));
const report = { checkedAt: new Date().toISOString(), api: base.origin, checks: [], blockers: [] };
const users = [];
const sockets = [];
const jobs = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An AWS CLI call; the input goes through a private file, never the command line. */
async function aws(service, operation, input) {
  const path = join(directory, `${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(input), { mode: 0o600 });
  try {
    const { stdout } = await run("aws", [service, operation, "--cli-input-json", `file://${path}`, "--region", region, "--output", "json"], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } finally {
    await rm(path, { force: true });
  }
}

const cleanupCheck = (name) => name.startsWith("remove synthetic") || name.startsWith("erase synthetic");
async function check(name, fn) {
  if (checkMatch && !checkMatch.test(name) && !cleanupCheck(name)) return;
  try {
    await fn();
    report.checks.push({ name, status: "passed" });
    console.log("PASS", name);
  } catch (error) {
    report.checks.push({ name, status: "failed", error: String(error.message).slice(0, 600) });
    console.log("FAIL", name, String(error.message).slice(0, 300));
  }
}

async function request(path, user, method = "GET", body, headers = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { ...(user ? { authorization: `Bearer ${user.token}` } : {}), "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(35_000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}
const ok = (response, status = 200) => {
  assert.equal(response.status, status, `HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 350)}`);
  return response.data;
};
/** The connection descriptor from /api/token (R2): AppSync's carries its endpoint, authorization and channels. */
const descriptorOf = (access) => access.descriptor ?? access;

async function connect(access, options) {
  let client;
  try {
    client = await import(pathToFileURL(clientPath).href);
  } catch (error) {
    throw new Error(`the portable realtime client isn't at ${clientPath} (${error.message}); set AWS_LIVE_REALTIME_CLIENT`);
  }
  return client.connectRealtime(descriptorOf(access), options);
}

async function waitForRun(user, runId, done, seconds) {
  let state;
  for (let i = 0; i < seconds; i += 1) {
    state = ok(await request(`/api/chat/runs/${runId}`, user));
    if (done.includes(state.status)) return state;
    await sleep(1000);
  }
  throw new Error(`run ${runId} still ${state?.status} after ${seconds} s`);
}

try {
  for (let i = 0; i < 2; i += 1) {
    const name = `afe-test-${randomUUID()}`;
    const password = `${randomBytes(24).toString("base64url")}aA9!`;
    await aws("cognito-idp", "admin-create-user", { UserPoolId: foundation.userPoolId, Username: name, MessageAction: "SUPPRESS" });
    const user = { name };
    users.push(user);
    await aws("cognito-idp", "admin-set-user-password", { UserPoolId: foundation.userPoolId, Username: name, Password: password, Permanent: true });
    const auth = await aws("cognito-idp", "admin-initiate-auth", {
      UserPoolId: foundation.userPoolId,
      ClientId: foundation.jwtAudience,
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: name, PASSWORD: password },
    });
    user.token = auth.AuthenticationResult.IdToken;
    user.id = JSON.parse(Buffer.from(user.token.split(".")[1], "base64url").toString()).sub;
  }
  const [a, b] = users;

  await check("health", async () => assert.equal(ok(await request("/api/health")).service, "agentforeach-gateway"));
  await check("missing and invalid tokens refused", async () => {
    assert.equal((await request("/api/sessions")).status, 401);
    assert.equal((await request("/api/sessions", { token: "invalid" })).status, 401);
  });
  await check("each user sees only their sessions", async () => {
    assert.deepEqual(ok(await request("/api/sessions", a)).sessions, []);
    assert.deepEqual(ok(await request("/api/sessions", b)).sessions, []);
  });
  await check("usage and pending forms", async () => {
    ok(await request("/api/usage", a));
    assert.deepEqual(ok(await request("/api/hitl/pending", a)).requests, []);
  });
  await check("admin routes and erasure confirmation enforced", async () => {
    assert.equal((await request(`/api/admin/users/${b.id}/data`, a, "DELETE")).status, 403);
    assert.equal((await request("/api/me/data", a, "DELETE")).status, 400);
  });

  let accessA;
  let accessB;
  let framesA = [];
  let framesB = [];
  await check("realtime tokens and AppSync subscriptions", async () => {
    accessA = ok(await request("/api/token", a, "POST"));
    accessB = ok(await request("/api/token", b, "POST"));
    assert.equal(descriptorOf(accessA).protocol, "appsync-events");
    assert.notDeepEqual(descriptorOf(accessA).channels, descriptorOf(accessB).channels);
    sockets.push(await connect(accessA, { onMessage: (frame) => framesA.push(frame), timeoutMs: 20_000 }));
    sockets.push(await connect(accessB, { onMessage: (frame) => framesB.push(frame), timeoutMs: 20_000 }));
  });
  if (accessA && accessB) {
    await check("another user's channel refused", async () => {
      const stolen = { ...descriptorOf(accessA), channels: [descriptorOf(accessB).channels[0]] };
      await assert.rejects(connect({ descriptor: stolen }, { timeoutMs: 20_000 }));
    });
  }
  await check("events reach only their user", async () => {
    assert.equal(sockets.length, 2, "both realtime connections are open");
    framesA = [];
    framesB = [];
    ok(await request("/api/chat/abort", a, "POST", {}));
    for (let i = 0; i < 30 && !framesA.length; i += 1) await sleep(200);
    assert.ok(framesA.length > 0, "no event arrived");
    assert.equal(framesB.length, 0, "an event reached the other user");
  });
  if (accessA) {
    await check("realtime reconnect", async () => {
      const socket = await connect(ok(await request("/api/token", a, "POST")), { timeoutMs: 20_000 });
      socket.close();
    });
  }

  await check("cron jobs: create, read and update, and isolation", async () => {
    const job = ok(
      await request(
        "/cron/jobs",
        a,
        "POST",
        {
          name: "AWS acceptance",
          enabled: false,
          deleteAfterRun: false,
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          payload: { kind: "agentTurn", message: "Synthetic AWS acceptance check" },
          delivery: { mode: "none" },
        },
      ),
      201,
    );
    jobs.push({ id: job.id, user: a });
    ok(await request(`/cron/jobs/${job.id}`, a));
    assert.equal((await request(`/cron/jobs/${job.id}`, b)).status, 404);
    assert.equal((await request(`/cron/jobs/${job.id}`, b, "PATCH", { name: "forbidden" })).status, 404);
    ok(await request(`/cron/jobs/${job.id}`, a, "PATCH", { name: "AWS acceptance, updated" }));
  });
  if (jobs.length) {
    await check("EventBridge runs a due job and its result is kept", async () => {
      const { id, user } = jobs[0];
      ok(await request(`/cron/jobs/${id}`, user, "PATCH", { enabled: true, schedule: { kind: "at", at: new Date(Date.now() + 15_000).toISOString() }, maxRuns: 1 }));
      let runs = [];
      for (let i = 0; i < 90 && !runs.length; i += 1) {
        runs = ok(await request(`/cron/runs/${id}`, user)).runs;
        if (!runs.length) await sleep(2000);
      }
      assert.ok(runs.length, "no run reached the job's history");
      if (requireModel) assert.equal(runs[0].status, "ok", String(runs[0].error ?? "the scheduled turn failed"));
      if (runs[0].status !== "ok") report.blockers.push(`Scheduled turn ended ${runs[0].status}: the model's answer is unverified`);
    });
  }

  await check("wait:true refused: Lambda can't hold a turn open", async () => {
    const refused = await request("/api/chat", a, "POST", { message: "hello", wait: true, sessionId: `aws-wait-${randomUUID()}` });
    assert.equal(refused.status, 400);
  });
  await check("a durable chat turn: idempotent, followed by its run, private to its user", async () => {
    const sessionId = `aws-live-${randomUUID()}`;
    const body = { message: "Reply with the word ready.", sessionId, idempotencyKey: randomUUID(), ...(providerId ? { providerId } : {}) };
    const accepted = ok(await request("/api/chat", b, "POST", body), 202);
    assert.ok(accepted.runId);
    const again = ok(await request("/api/chat", b, "POST", body), 202);
    assert.equal(again.runId, accepted.runId);
    assert.equal((await request(`/api/chat/runs/${accepted.runId}`, a)).status, 404);
    const state = await waitForRun(b, accepted.runId, ["completed", "failed", "aborted", "incomplete"], 120);
    if (requireModel) assert.equal(state.status, "completed");
    if (state.status !== "completed") report.blockers.push(`The chat turn ended ${state.status}: the model's answer is unverified`);
    assert.equal((await request(`/api/sessions/${sessionId}`, a)).status, 404);
  });

  if (requireModel) {
    await check("the model runs the AgentCore sandbox and the events arrive over AppSync", async () => {
      const sessionId = `aws-tool-${randomUUID()}`;
      framesB = [];
      const accepted = ok(
        await request(
          "/api/chat",
          b,
          "POST",
          {
            sessionId,
            idempotencyKey: randomUUID(),
            ...(providerId ? { providerId } : {}),
            message:
              'Use sandbox_exec to run python3 -c "import uuid; print(uuid.uuid4())". Reply with the UUID it printed. Do not invent one or use another tool.',
          },
        ),
        202,
      );
      const state = await waitForRun(b, accepted.runId, ["completed", "failed", "aborted", "awaiting_input"], 180);
      assert.equal(state.status, "completed");
      const saved = ok(await request(`/api/sessions/${sessionId}`, b));
      const replies = saved.messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
      assert.match(replies, /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/i);
      const ofRun = framesB.filter((f) => f.payload?.runId === accepted.runId);
      assert.ok(ofRun.some((f) => f.payload?.state === "tool_start" && f.payload?.name === "sandbox_exec"), "no sandbox tool event arrived");
      assert.ok(ofRun.some((f) => f.payload?.state === "final"), "no final reply arrived");
    });
    for (const cancelled of [false, true]) {
      await check(`a HITL form ${cancelled ? "cancelled" : "answered"} resumes the durable turn`, async () => {
        const sessionId = `aws-hitl-${randomUUID()}`;
        const start = ok(
          await request(
            "/api/chat",
            a,
            "POST",
            {
              sessionId,
              idempotencyKey: randomUUID(),
              ...(providerId ? { providerId } : {}),
              message:
                'For this test, call request_user_input with type confirmation, title "Confirm the check", and proposedData {"approved":true}. Wait for my answer, then reply with a short acknowledgement.',
            },
          ),
          202,
        );
        let pending;
        for (let i = 0; i < 90 && !pending; i += 1) {
          pending = ok(await request("/api/hitl/pending", a)).requests.find((r) => r.sessionId === sessionId);
          if (!pending) await sleep(1000);
        }
        assert.ok(pending, `the model didn't ask (run ${start.runId})`);
        assert.equal((await request(`/api/hitl/${pending.requestId}`, b)).status, 404);
        const answer = { message: cancelled ? "I cancelled the form." : "I answered the form.", sessionId, idempotencyKey: randomUUID(), hitlInputResponse: { requestId: pending.requestId, data: { approved: !cancelled }, cancelled } };
        assert.equal((await request("/api/chat", b, "POST", answer)).status, 404);
        const accepted = ok(await request("/api/chat", a, "POST", answer), 202);
        assert.ok(accepted.runId, "a direct input answer starts its continuation turn");
        const resumed = await waitForRun(a, accepted.runId, ["completed", "failed", "aborted"], 120);
        assert.equal(resumed.status, "completed");
        const status = ok(await request(`/api/hitl/${pending.requestId}`, a));
        assert.equal(status.status, cancelled ? "cancelled" : "responded");
        const duplicate = ok(await request("/api/chat", a, "POST", answer), 202);
        assert.equal(duplicate.runId, accepted.runId, "the same answer is the same continuation");
        const saved = ok(await request(`/api/sessions/${sessionId}`, a));
        assert.ok(saved.messages.some((m) => m.role === "assistant"), "no reply after the answer");
      });
    }
  }
} catch (error) {
  report.blockers.push(String(error.message).slice(0, 600));
} finally {
  for (const socket of sockets) socket.close?.();
  for (const { id, user } of jobs) await check(`remove synthetic cron job ${id}`, async () => ok(await request(`/cron/jobs/${id}`, user, "DELETE")));
  for (const user of users) {
    if (user.token) {
      await check(`erase synthetic user data ${user.name}`, async () => ok(await request("/api/me/data", user, "DELETE", undefined, { "x-confirm-erase": "yes" })));
    }
    await check(`remove synthetic Cognito user ${user.name}`, async () =>
      aws("cognito-idp", "admin-delete-user", { UserPoolId: foundation.userPoolId, Username: user.name }),
    );
  }
  await rm(directory, { recursive: true, force: true });
  if (process.env.AWS_LIVE_REPORT) await writeFile(process.env.AWS_LIVE_REPORT, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (report.blockers.length || report.checks.some((c) => c.status === "failed")) process.exitCode = 1;
}

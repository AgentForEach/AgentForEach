#!/usr/bin/env node
/**
 * End-to-end check of a human-in-the-loop wait, against a running gateway
 * whose model is the load-test mock (scripts/load-test/mock-llm.mjs): a chat
 * message containing the mock's ask phrase makes the model call
 * request_user_input, and the run waits for the user.
 *
 *   --mode answer   the form (an input_request) arrives over the realtime
 *                   socket; this answers it, and the run resumes and replies
 *                   (a final event). A request_user_input form (the direct
 *                   path) is answered the way web chat does, with a chat
 *                   request carrying hitlInputResponse; a gated tool's form
 *                   (the durable wait) with an input_response frame.
 *                   --answer-after-ms N waits N ms first, as a person would.
 *   --mode timeout  this doesn't answer; input_expired arrives once the
 *                   form's timeout (hitl.defaultTimeoutSeconds) passes.
 *
 * A gated tool's run: --phrase is the mock's MOCK_TOOL_CALLS phrase for that
 * tool, and --fixture-url the MCP fixture serving it
 * (scripts/test-fixtures/mcp-gated-tool.mjs); then this also checks the tool
 * ran once when answered, and not at all when the form expired.
 *
 *   node scripts/test-hitl-e2e.mjs --base-url http://127.0.0.1:8812 \
 *     --jwt-secret "$LOADTEST_JWT_SECRET" --mode answer
 *
 * Auth is an HS256 JWT as in scripts/load-test (issuer agentforeach-loadtest,
 * audience agentforeach). Exits 0 when the expected events arrived. Needs
 * Node 22+ (global WebSocket).
 */

import { createHmac, randomUUID } from "node:crypto";

const opts = {
  baseUrl: "http://127.0.0.1:8812",
  jwtSecret: process.env.LOADTEST_JWT_SECRET,
  mode: "answer",
  waitMs: 120_000,
  phrase: "ask me first",
  /** How long a person takes to answer the form (0: at once). */
  answerAfterMs: 0,
  /** The MCP fixture's base URL, to check what the gated tool received. */
  fixtureUrl: "",
};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (!(key in opts)) throw new Error(`unknown option ${process.argv[i]}`);
  opts[key] = typeof opts[key] === "number" ? Number(process.argv[i + 1]) : process.argv[i + 1];
}
if (!opts.jwtSecret) throw new Error("--jwt-secret (or LOADTEST_JWT_SECRET) is required");
if (!["answer", "timeout"].includes(opts.mode)) throw new Error("--mode is answer or timeout");

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(userId) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url({ sub: userId, iss: "agentforeach-loadtest", aud: "agentforeach", iat: now, exp: now + 3600 });
  return `${head}.${body}.${createHmac("sha256", opts.jwtSecret).update(`${head}.${body}`).digest("base64url")}`;
}

const userId = `hitl-e2e-${Date.now().toString(36)}`;
const auth = { authorization: `Bearer ${token(userId)}` };
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const events = [];

const negotiate = await fetch(`${opts.baseUrl}/negotiate`, { headers: auth });
if (!negotiate.ok) throw new Error(`negotiate ${negotiate.status}`);
const ws = new WebSocket((await negotiate.json()).url, "json.webpubsub.azure.v1");
await new Promise((ok, fail) => {
  ws.addEventListener("open", ok, { once: true });
  ws.addEventListener("error", () => fail(new Error("socket error")), { once: true });
});

let resolveDone;
const done = new Promise((r) => (resolveDone = r));
const sessionId = randomUUID();
/** Set once the form is answered: a final before that is the run parking on the wait. */
let answered = false;

ws.addEventListener("message", (ev) => {
  let frame;
  try {
    frame = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  let data = frame.type === "message" ? frame.data : frame;
  if (typeof data === "string") data = JSON.parse(data);
  if (data?.type !== "event" || data.event !== "chat" || !data.payload) return;
  const p = data.payload;
  if (p.sessionId && p.sessionId !== sessionId) return;
  if (p.state !== "delta") events.push(p.state);
  if (p.state === "input_request") {
    console.log(`${elapsed()} input_request: ${p.formType} from ${p.toolName} "${p.intent ?? ""}" (timeout ${p.timeoutSeconds}s)`);
    if (opts.mode === "answer") {
      setTimeout(() => {
        answered = true;
        void answer(p).then((how) => console.log(`${elapsed()} answered it (${how})`));
      }, opts.answerAfterMs);
    }
  } else if (p.state === "input_expired") {
    console.log(`${elapsed()} input_expired: ${p.reason ?? ""}`);
    if (opts.mode === "timeout") resolveDone(true);
  } else if (p.state === "final") {
    console.log(`${elapsed()} final: ${String(p.text ?? p.message ?? "").slice(0, 80)}`);
    if (opts.mode === "answer" && answered) resolveDone(true);
  } else if (p.state === "error") {
    console.log(`${elapsed()} error: ${p.code ?? ""} ${p.message ?? ""}`);
  }
});

/** Answer a form: a direct form with a chat request, a gated tool's with an input_response frame. */
async function answer(request) {
  const data = { confirmed: true };
  if (request.toolName === "request_user_input") {
    const res = await fetch(`${opts.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ message: "Yes, go ahead.", sessionId, idempotencyKey: randomUUID(), hitlInputResponse: { requestId: request.requestId, data } }),
    });
    return `chat request with hitlInputResponse, ${res.status}`;
  }
  ws.send(JSON.stringify({ type: "event", event: "message", dataType: "json", data: { type: "input_response", requestId: request.requestId, data } }));
  return "input_response frame";
}

if (opts.fixtureUrl) await fetch(`${opts.fixtureUrl}/calls`, { method: "DELETE" });
const chat = await fetch(`${opts.baseUrl}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json", ...auth },
  body: JSON.stringify({ message: `Please ${opts.phrase}, then say hello.`, sessionId, idempotencyKey: randomUUID() }),
});
console.log(`${elapsed()} POST /api/chat ${chat.status}`);

const arrived = await Promise.race([done, new Promise((r) => setTimeout(() => r(false), opts.waitMs))]);
ws.close();
console.log(`events: ${events.join(" → ") || "(none)"}`);
if (!arrived) console.log(`✖ ${opts.mode}: the expected events didn't arrive within ${opts.waitMs / 1000}s`);
let ok = arrived;
if (opts.fixtureUrl) {
  const calls = await (await fetch(`${opts.fixtureUrl}/calls`)).json();
  const expected = opts.mode === "answer" ? 1 : 0;
  const count = calls.length;
  console.log(`fixture tool calls: ${count} (expected ${expected})`);
  if (count !== expected) console.log(`✖ ${opts.mode}: the gated tool ran ${count} time(s), expected ${expected}`);
  ok &&= count === expected;
}
if (ok) console.log(`✔ ${opts.mode}: as expected`);
process.exit(ok ? 0 : 1);

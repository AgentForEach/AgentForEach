// The web chat's reply and form recovery (index.html), run in a VM against a fake fetch.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("index.html", import.meta.url), "utf8");
const source = html.slice(html.indexOf("async function recoverRun("), html.indexOf("\nasync function send(text)"));

function client(fetch) {
  const events = [], statuses = [];
  const state = { generation: 1, completed: new Set(), forms: new Map(), baseUrl: "https://gateway.test", headers: {} };
  const context = vm.createContext({
    state, fetch, AbortSignal, encodeURIComponent,
    setTimeout: (resolve) => resolve(),
    onChatEvent: (event) => { events.push(event); state.completed.add(event.runId); },
    showForm: (form) => { state.forms.set(form.requestId, form); },
    setStatus: (status) => statuses.push(status),
  });
  vm.runInContext(source, context);
  return {
    state, events, statuses,
    run: () => context.recoverRun("r1", "s1", 1, "https://gateway.test", { authorization: "Bearer test" }),
    restore: () => context.restorePendingForms(1),
    approval: () => context.recoverApproval("a1", 1, "https://gateway.test", {}),
  };
}

test("recovers a completed run by its run id, never another turn's reply", async () => {
  const calls = [];
  const c = client(async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.authorization, "Bearer test");
    if (url.includes("/runs/")) return Response.json({ status: "completed", startedAtMs: 100, finishedAtMs: 200 });
    return Response.json({ messages: [{ runId: "r1", role: "assistant", content: "correct reply" }, { runId: "r2", role: "assistant", content: "different reply" }] });
  });
  await c.run();
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0].text, "correct reply");
  assert.equal(calls.length, 2);
});

test("a run that already ended, or a switch of user, recovers nothing", async () => {
  const c = client(async () => { throw new Error("must not fetch"); });
  c.state.completed.add("r1");
  await c.run();
  assert.equal(c.events.length, 0);
  c.state.completed.clear();
  c.state.generation = 2;
  await c.run();
  assert.equal(c.events.length, 0);
});

test("a late session fetch can't repeat a live final event", async () => {
  const c = client(async (url) => {
    if (url.includes("/runs/")) return Response.json({ status: "completed" });
    c.state.completed.add("r1");
    return Response.json({ messages: [{ runId: "r1", role: "assistant", content: "duplicate" }] });
  });
  await c.run();
  assert.equal(c.events.length, 0);
});

test("failed and aborted runs show; a gateway without the status route is left alone", async () => {
  for (const status of ["failed", "aborted"]) {
    const c = client(async () => Response.json({ status, error: "failed safely" }));
    await c.run();
    assert.equal(c.events[0].state, status === "failed" ? "error" : "aborted");
  }
  const noRoute = client(async () => new Response("not found", { status: 404 }));
  await noRoute.run();
  assert.equal(noRoute.events.length, 0);
  assert.equal(noRoute.statuses.length, 0);
});

test("a status route that is never reachable (a cross-origin 404) is given up quietly", async () => {
  let calls = 0;
  const c = client(async () => { calls++; throw new TypeError("Failed to fetch"); });
  await c.run();
  assert.equal(calls, 5);
  assert.equal(c.events.length, 0);
  assert.equal(c.statuses.length, 0);
});

test("brief network and service failures don't abandon the recovery", async () => {
  let count = 0;
  const c = client(async (url) => {
    count++;
    if (count === 1) throw new Error("network lost");
    if (count === 2) return new Response("busy", { status: 503 });
    if (url.includes("/runs/")) return Response.json({ status: "completed" });
    return Response.json({ messages: [{ runId: "r1", role: "assistant", content: "recovered" }] });
  });
  await c.run();
  assert.equal(c.events[0].text, "recovered");
  assert.equal(c.statuses.length, 0);
});

test("a run awaiting input shows its form, once", async () => {
  const c = client(async (url) =>
    url.includes("/runs/") ? Response.json({ status: "awaiting_input" }) : Response.json({ requests: [{ requestId: "a1", intent: "Confirm" }] }),
  );
  await c.run();
  await c.restore();
  assert.equal(c.state.forms.size, 1);
});

test("an accepted answer is followed to its continuation's reply, and its new forms", async () => {
  let checks = 0;
  const c = client(async (url) => {
    if (url.endsWith("/pending")) return Response.json({ requests: [{ requestId: "nested" }] });
    if (url.includes("/hitl/")) {
      // The continuation is named once it has finished.
      const resumed = ++checks > 1 ? { resumedRunId: "run-next" } : {};
      return Response.json({ requestId: "a1", status: "responded", sessionId: "s1", runId: "run-asked", answeredAt: "2026-10-05T10:00:00Z", ...resumed });
    }
    return Response.json({ messages: [{ role: "assistant", runId: "run-next", content: "approved reply" }, { role: "assistant", runId: "run-asked", content: "unrelated" }] });
  });
  await c.approval();
  assert.equal(checks, 2);
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0].text, "approved reply");
  assert.ok(c.state.forms.has("nested"));
});

test("an answer whose request expired, or whose continuation failed, says so", async () => {
  for (const [status, note] of [["expired", "The input request expired."], ["failed", "The continuation failed."]]) {
    const c = client(async () => Response.json({ requestId: "a1", status, sessionId: "s1", runId: "run-asked" }));
    await c.approval();
    assert.equal(c.events.length, 0);
    assert.ok(c.statuses[0].startsWith(note), c.statuses[0]);
  }
});

test("an answer on a gateway without the approval route is left alone", async () => {
  for (const fail of [async () => new Response("", { status: 404 }), async () => { throw new TypeError("Failed to fetch"); }]) {
    let calls = 0;
    const c = client(async (...args) => { calls++; return fail(...args); });
    await c.approval();
    assert.ok(calls <= 5, `gave up after ${calls} calls`);
    assert.equal(c.events.length, 0);
    assert.equal(c.statuses.length, 0);
  }
});

test("the page's inline scripts parse without a bundler", () => {
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

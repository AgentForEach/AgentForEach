// The durable conformance suite against the test Worker (see run.mjs).
import { runDurableConformance } from "@agentforeach/platform/durable/conformance";

const base = process.env.DURABLE_WORKER_URL;
if (!base) throw new Error("Set DURABLE_WORKER_URL, or use run.mjs");

const call = async (area, op, ...args) => {
  // JSON would turn an omitted optional argument (startJob's id) into null.
  while (args.length > 0 && args.at(-1) === undefined) args.pop();
  const response = await fetch(`${base}/${area}/${op}`, { method: "POST", body: JSON.stringify(args) });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${area}/${op}: ${response.status} ${body.error ?? ""}`);
  return body.result;
};
const revive = (info) => info && { ...info, createdAt: info.createdAt && new Date(info.createdAt), updatedAt: info.updatedAt && new Date(info.updatedAt) };

const durable = {
  startJob: (kind, input, id) => call("durable", "startJob", kind, input, id),
  startWait: (kind, id, input, timeoutMs) => call("durable", "startWait", kind, id, input, timeoutMs),
  signal: (id, event, payload) => call("durable", "signal", id, event, payload),
  ensureAlarm: (kind, id, input) => call("durable", "ensureAlarm", kind, id, input),
  wakeAlarm: (id) => call("durable", "wakeAlarm", id),
  terminate: (id, reason) => call("durable", "terminate", id, reason),
  status: async (id) => revive(await call("durable", "status", id)),
};
const recorder = {
  calls: (id) => call("recorder", "calls", id),
  gateHeld: (key) => call("recorder", "gateHeld", key),
  release: (key) => call("recorder", "release", key),
  setNextTickIn: (id, ms) => call("recorder", "setNextTickIn", id, ms),
};

// unitMs matches the Worker's UNIT_MS.
runDurableConformance({
  name: "cloudflare (workerd)",
  connect: async () => ({ durable, recorder }),
  unitMs: 100,
  patienceMs: 15_000,
});

// workerd only: Durable Object storage caps each value (2 MB on SQLite-backed
// objects), so a large input (chat attachments reach 20 MiB) must survive the
// engine's chunking intact, multi-byte characters included.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";

it("cloudflare (workerd): a job input far above one storage value arrives intact", async () => {
  const big = "aé✓𝄞".repeat(1_500_000); // 7.5 M UTF-16 units, about 15 MB of UTF-8
  const id = `conf-large-${Date.now()}`;
  assert.equal((await durable.startJob("conformance-job", { value: big }, id)).started, true);
  const deadline = Date.now() + 30_000;
  let status;
  while ((status = (await durable.status(id))?.status) !== "completed" && status !== "failed" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(status, "completed");
  const [recorded] = await recorder.calls(id);
  const digest = (s) => createHash("sha256").update(s).digest("hex");
  assert.equal(recorded.input.value.length, big.length);
  assert.equal(digest(recorded.input.value), digest(big));
});

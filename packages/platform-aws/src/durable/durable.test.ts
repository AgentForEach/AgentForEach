/**
 * The Lambda durable Durable passes the durable conformance suite on the
 * durable execution SDK's local runner (real checkpoints, replays, callbacks
 * and callback timeouts), with the instance table in the storage SDK's
 * in-memory adapter. Then the parts the suite can't reach: the sweep, the
 * Lambda control's requests, and the retry rule of handler steps.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { DurableRegistry, type Durable } from "@agentforeach/platform";
import { runDurableConformance } from "@agentforeach/platform/durable/conformance";
import { eq, InMemoryStorage } from "@agentforeach/storage";
import { DURABLE_INSTANCES_COLLECTION } from "../collections.js";
import { isPublishedVersionArn, lambdaControl } from "./control.js";
import { createLambdaDurable } from "./durable.js";
import { createLambdaDurableHandler, handlerStep } from "./handler.js";
import { rowId, type InstanceRow, type LambdaDurableOptions } from "./instances.js";
import { LOCAL_FUNCTION_ARN, LocalDurableControl } from "./local.testkit.js";
import { durableSweep } from "./sweep.js";

const quiet = { log() {}, warn() {}, error() {}, debug() {} };
const controls: LocalDurableControl[] = [];

/** A Durable and its durable handler on the local runner, sharing one in-memory database. */
function localPack(registry: DurableRegistry, extra: Partial<LambdaDurableOptions> = {}) {
  const storage = new InMemoryStorage();
  const control = new LocalDurableControl();
  controls.push(control);
  const options: LambdaDurableOptions = {
    functionArn: LOCAL_FUNCTION_ARN,
    executionPrefix: "test-stack",
    storage: () => storage,
    control,
    logger: quiet,
    ...extra,
  };
  control.handler = createLambdaDurableHandler(registry, options);
  return { durable: createLambdaDurable(registry, options), control, storage, options };
}

async function rowOf(storage: InMemoryStorage, instanceId: string): Promise<InstanceRow | null> {
  const id = rowId(instanceId);
  return (await storage.collection<InstanceRow>(DURABLE_INSTANCES_COLLECTION)).read(id, id);
}

before(() => LocalDurableTestRunner.setupTestEnvironment({ skipTime: false }));
after(async () => {
  await Promise.all(controls.map((c) => c.settled(10_000)));
  await LocalDurableTestRunner.teardownTestEnvironment();
});

let conformance: ReturnType<typeof localPack> | undefined;

// Callback timeouts and waits are whole seconds on Lambda: a unit of half a
// second keeps every interval the suite asks for above its rounding.
runDurableConformance({
  name: "aws (Lambda durable functions on the SDK's local runner)",
  unitMs: 500,
  patienceMs: 15_000,
  create: (registry): Durable => (conformance = localPack(registry)).durable,
  // Lambda closes the execution early (its timeout); the sweep starts the instance again.
  interrupt: async (instanceId, release) => {
    const { control, storage, options } = conformance!;
    const row = await rowOf(storage, instanceId);
    control.interrupt(row!.executionArn!);
    const report = await durableSweep(options);
    assert.equal(report.redispatched, 1);
    await release();
  },
});

// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
    await sleep(25);
  }
}

test("the input stays in the database: the invocation carries a reference", async () => {
  const registry = new DurableRegistry().defineJob({ kind: "J", run: async () => {} });
  const { durable, control, storage } = localPack(registry);
  await durable.startJob("J", { userId: "alice", secret: "x".repeat(1000) }, "job-ref");
  const [execution] = control.executions.values();
  const row = await rowOf(storage, "job-ref");
  assert.deepEqual(execution.reference, { id: "job-ref", kind: "J", execution: row!.execution });
  const owned = await (await storage.collection<InstanceRow>(DURABLE_INSTANCES_COLLECTION)).find({ where: eq("userId", "alice") });
  assert.deepEqual(owned.map((row) => row.instanceId), ["job-ref"], "account erasure can find the stored input by user");
  assert.match(row!.execution, /^test-stack-[0-9a-f]{16}-[0-9a-f]{16}$/);
  await until("completed", async () => (await durable.status("job-ref"))?.status === "completed");
  const done = await rowOf(storage, "job-ref");
  assert.equal(done!.input, undefined, "a finished instance keeps no input");
  assert.equal(done!.ttl, 3600, "and expires after the retention");
});

test("a replaced instance gets a new execution name; names are never reused", async () => {
  const registry = new DurableRegistry().defineJob({ kind: "J", run: async () => {} });
  const { durable, control } = localPack(registry);
  for (let i = 0; i < 2; i++) {
    await durable.startJob("J", { i }, "job-twice");
    await until("completed", async () => (await durable.status("job-twice"))?.status === "completed");
  }
  const names = [...control.executions.values()].map((e) => e.name);
  assert.equal(new Set(names).size, 2);
});

test("a failed invoke fails the row, so the id can start again", async () => {
  const registry = new DurableRegistry().defineJob({ kind: "J", run: async () => {} });
  const { durable, control } = localPack(registry);
  const start = control.start.bind(control);
  control.start = async () => {
    throw new Error("throttled");
  };
  await assert.rejects(durable.startJob("J", {}, "job-throttled"), /throttled/);
  assert.equal((await durable.status("job-throttled"))?.status, "failed");
  control.start = start;
  assert.equal((await durable.startJob("J", {}, "job-throttled")).started, true);
});

test("the sweep starts a row whose invoke went unanswered, under the same name", async () => {
  const registry = new DurableRegistry().defineJob({ kind: "J", run: async () => {} });
  const { durable, control, storage, options } = localPack(registry);
  const start = control.start.bind(control);
  let lost = true;
  // The invoke reached Lambda, but its answer was lost: no ARN recorded, and the caller saw an error.
  control.start = async (name, reference) => {
    if (!lost) return start(name, reference);
    lost = false;
    throw new Error("socket hang up");
  };
  await assert.rejects(durable.startJob("J", {}, "job-lost"));
  // The failed start marked the row failed; put it back as an unanswered pending row to sweep.
  const collection = await storage.collection<InstanceRow>(DURABLE_INSTANCES_COLLECTION);
  const row = (await rowOf(storage, "job-lost"))!;
  await collection.upsert({ ...row, status: "pending", ttl: undefined, input: "{}", updatedAt: Date.now() - 120_000 });
  const report = await durableSweep({ ...options, dispatchGraceMs: 60_000 });
  assert.equal(report.dispatched, 1);
  await until("completed", async () => (await durable.status("job-lost"))?.status === "completed");
  assert.deepEqual([...control.executions.values()].map((e) => e.name), [row.execution]);
});

test("the sweep fails a row whose execution ended without recording it", async () => {
  const registry = new DurableRegistry().defineJob({ kind: "J", run: async () => {} });
  const { durable, control, storage, options } = localPack(registry);
  await durable.startJob("J", {}, "job-orphan");
  await until("completed", async () => (await durable.status("job-orphan"))?.status === "completed");
  const collection = await storage.collection<InstanceRow>(DURABLE_INSTANCES_COLLECTION);
  const row = (await rowOf(storage, "job-orphan"))!;
  await collection.upsert({ ...row, status: "running", ttl: undefined });
  const [execution] = control.executions.values();
  await until("the execution ended", () => execution.status === "SUCCEEDED");
  assert.equal((await durableSweep(options)).failed, 1);
  assert.equal((await durable.status("job-orphan"))?.status, "failed");
});

test("status() checks the execution of an active row that hasn't moved for a minute", async () => {
  const registry = new DurableRegistry().defineJob({ kind: "J", run: async () => {} });
  const { durable, control, storage } = localPack(registry);
  await durable.startJob("J", {}, "job-stale");
  const [execution] = control.executions.values();
  await until("the execution ended", () => execution.status === "SUCCEEDED");
  const collection = await storage.collection<InstanceRow>(DURABLE_INSTANCES_COLLECTION);
  const row = (await rowOf(storage, "job-stale"))!;
  // Fresh: reported as stored. Unchanged for over a minute: its ended execution fails it.
  await collection.upsert({ ...row, status: "running", ttl: undefined, updatedAt: Date.now() });
  assert.equal((await durable.status("job-stale"))?.status, "running");
  await collection.upsert({ ...row, status: "running", ttl: undefined, updatedAt: Date.now() - 120_000 });
  assert.equal((await durable.status("job-stale"))?.status, "failed");
});

test("an instance cut off more than maxRuns times fails without running again", async () => {
  let runs = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const registry = new DurableRegistry().defineJob({
    kind: "J",
    run: async () => {
      runs++;
      await held;
    },
  });
  const { durable, control, storage, options } = localPack(registry, { maxRuns: 2 });
  await durable.startJob("J", {}, "job-cut");
  await until("first run", () => runs === 1);
  control.interrupt((await rowOf(storage, "job-cut"))!.executionArn!);
  await durableSweep(options);
  await until("second run", () => runs === 2);
  control.interrupt((await rowOf(storage, "job-cut"))!.executionArn!);
  await durableSweep(options);
  await until("failed", async () => (await durable.status("job-cut"))?.status === "failed");
  assert.equal(runs, 2);
  // Let the held runs end; the row stays failed.
  release();
  await Promise.all([...control.executions.values()].map((e) => e.done));
  assert.equal((await durable.status("job-cut"))?.status, "failed");
});

test("a signal sent again by the sweep reaches a wait whose callback was lost", async () => {
  const registry = new DurableRegistry().defineWait({
    kind: "W",
    event: "answer",
    onEvent: async () => {},
    onTimeout: async () => {},
  });
  const { durable, control, storage, options } = localPack(registry);
  await durable.startWait("W", "wait-lost", {}, 60_000);
  await until("waiting", async () => !!(await rowOf(storage, "wait-lost"))?.callbackId);
  const send = control.sendCallback.bind(control);
  control.sendCallback = async () => {
    throw new Error("network");
  };
  assert.equal(await durable.signal("wait-lost", "answer", 1), true);
  await sleep(1500);
  assert.equal((await durable.status("wait-lost"))?.status, "running", "the lost callback didn't wake it");
  control.sendCallback = send;
  assert.equal((await durableSweep(options)).woken, 1);
  await until("completed", async () => (await durable.status("wait-lost"))?.status === "completed");
});

test("an alarm hands over to a fresh execution after ticksPerExecution ticks, and keeps ticking", async () => {
  let ticks = 0;
  const registry = new DurableRegistry().defineAlarm({ kind: "A", tick: async () => (ticks++, Date.now()) });
  const { durable, control } = localPack(registry, { ticksPerExecution: 2 });
  await durable.ensureAlarm("A", "alarm-handover", {});
  await until("five ticks", () => ticks >= 5, 15_000);
  assert.ok(control.executions.size >= 2, "more than one execution ran it");
  await durable.terminate("alarm-handover", "test");
});

test("handler steps run at most once per attempt, and retry only when cut off, never after throwing", async () => {
  const { StepInterruptedError, StepSemantics } = await import("@aws/durable-execution-sdk-js");
  const config = handlerStep(3);
  assert.equal(config.semantics, StepSemantics.AtMostOncePerRetry);
  const retry = config.retryStrategy!;
  assert.equal(retry(new StepInterruptedError("1", "run"), 2).shouldRetry, true);
  assert.equal(retry(new StepInterruptedError("1", "run"), 4).shouldRetry, false);
  assert.equal(retry(new Error("database down"), 1).shouldRetry, false);
});

test("the Lambda control invokes the published version with the execution name and a reference", async () => {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const arn = "arn:aws:lambda:us-east-1:123456789012:function:agentforeach-durable:7";
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "InvokeCommand") {
        return { StatusCode: 202, DurableExecutionArn: `${arn}/durable-execution/n-1/e-1` };
      }
      if (command.constructor.name === "GetDurableExecutionCommand") return { Status: "TIMED_OUT" };
      return {};
    },
  };
  const control = lambdaControl(arn, client as never);
  assert.equal(await control.start("n-1", { id: "i", kind: "K", execution: "n-1" }), `${arn}/durable-execution/n-1/e-1`);
  assert.equal(sent[0].name, "InvokeCommand");
  assert.equal(sent[0].input.FunctionName, arn);
  assert.equal(sent[0].input.InvocationType, "Event");
  assert.equal(sent[0].input.DurableExecutionName, "n-1");
  assert.deepEqual(JSON.parse(Buffer.from(sent[0].input.Payload as Uint8Array).toString()), { id: "i", kind: "K", execution: "n-1" });
  // An execution of an earlier version of the same function is still its own.
  const older = "arn:aws:lambda:us-east-1:123456789012:function:agentforeach-durable:6/durable-execution/n-0/e-0";
  assert.equal(await control.status(older), "TIMED_OUT");
  await assert.rejects(control.status("arn:aws:lambda:us-east-1:123456789012:function:other:1/durable-execution/x/y"), /Unexpected/);
  await control.sendCallback("cb-1");
  assert.equal(sent.at(-1)!.name, "SendDurableExecutionCallbackSuccessCommand");
  await control.stop!(older, "operator");
  assert.equal(sent.at(-1)!.name, "StopDurableExecutionCommand");
  await assert.rejects(control.start("bad name!", { id: "i", kind: "K", execution: "x" }), /Invalid durable execution name/);
  for (const suffix of ["", ":$LATEST", ":live"]) {
    assert.equal(isPublishedVersionArn(arn.replace(/:7$/, suffix)), false);
    assert.throws(() => lambdaControl(arn.replace(/:7$/, suffix), client as never), /published version/);
  }
});

test("the Lambda control refuses an acknowledgement without an execution ARN", async () => {
  const control = lambdaControl("arn:aws:lambda:us-east-1:123456789012:function:d:1", { send: async () => ({ StatusCode: 202 }) } as never);
  await assert.rejects(control.start("n", { id: "i", kind: "K", execution: "n" }), /did not acknowledge/);
});

test("an execution prefix must fit Lambda's execution names", () => {
  const registry = new DurableRegistry();
  for (const executionPrefix of ["", "has space", "x".repeat(31)]) {
    assert.throws(
      () => createLambdaDurable(registry, { functionArn: LOCAL_FUNCTION_ARN, executionPrefix, storage: () => new InMemoryStorage(), control: new LocalDurableControl() }),
      /prefix/,
    );
  }
});

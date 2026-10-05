import test from "node:test";
import assert from "node:assert/strict";
import { background, currentScope, openScope, scopeKey } from "./scope.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("code below the handler sees its invocation's scope, through awaits, timers and parallel work", async () => {
  const opened = openScope({ invocationId: "inv-1", kind: "http" });
  const seen = await opened.run(async () => {
    const ids = [currentScope()?.invocationId];
    await tick(5);
    ids.push(currentScope()?.invocationId);
    ids.push(...(await Promise.all([1, 2].map(async () => (await tick(), currentScope()?.invocationId)))));
    return ids;
  });
  assert.deepEqual(seen, ["inv-1", "inv-1", "inv-1", "inv-1"]);
  assert.equal(currentScope(), undefined, "nothing leaks outside the scope");
});

test("two invocations at once each see their own scope", async () => {
  const a = openScope({ invocationId: "a", kind: "http" });
  const b = openScope({ invocationId: "b", kind: "job" });
  const [ra, rb] = await Promise.all([
    a.run(async () => (await tick(10), currentScope()?.invocationId)),
    b.run(async () => (await tick(1), `${currentScope()?.invocationId}:${currentScope()?.kind}`)),
  ]);
  assert.deepEqual([ra, rb], ["a", "b:job"]);
});

test("background work goes to the host's keepAlive, and settle waits for it and what it starts", async () => {
  const kept: Promise<unknown>[] = [];
  const opened = openScope({ invocationId: "x", kind: "http", keepAlive: (work) => kept.push(work) });
  const done: string[] = [];
  await opened.run(async () => {
    background(
      tick(20).then(() => {
        done.push("first");
        background(tick(20).then(() => done.push("started by the first")));
      }),
    );
  });
  assert.deepEqual(done, [], "the handler returned before its background work");
  await opened.settle();
  assert.deepEqual(done, ["first", "started by the first"]);
  assert.equal(kept.length, 2, "each piece of work was handed to keepAlive");
});

test("a failed background job is logged, not thrown, and onError sees it when given", async () => {
  const errors: unknown[] = [];
  const opened = openScope({ invocationId: "x", kind: "http" });
  await opened.run(async () => {
    background(Promise.reject(new Error("boom")), (err) => errors.push(err));
    background(Promise.reject(new Error("unhandled, logged")));
  });
  await opened.settle(); // resolves: background failures never reject settle
  assert.equal((errors[0] as Error).message, "boom");
});

test("with no scope, background work runs detached as a plain promise would", async () => {
  let ran = false;
  background(tick(5).then(() => (ran = true)));
  assert.equal(ran, false);
  await tick(20);
  assert.equal(ran, true);
});

test("a resource is created once per invocation, and cleaned up after background work, newest first", async () => {
  const POOL = scopeKey<{ id: number }>("pool");
  const order: string[] = [];
  let created = 0;
  const opened = openScope({ invocationId: "x", kind: "schedule" });
  await opened.run(async () => {
    const scope = currentScope()!;
    const get = () =>
      scope.resource(POOL, () => {
        const pool = { id: ++created };
        scope.onEnd(() => {
          order.push(`end pool ${pool.id}`);
        });
        return pool;
      });
    assert.equal(get(), get(), "the same resource within the invocation");
    scope.onEnd(() => {
      order.push("end registered later");
    });
    background(tick(10).then(() => order.push("background")));
  });
  await opened.settle();
  assert.deepEqual(order, ["background", "end registered later", "end pool 1"]);
  assert.equal(created, 1);
  assert.throws(() => opened.scope.resource(POOL, () => ({ id: 99 })), /invocation is over: "pool"/);
  await opened.settle(); // idempotent: cleanups ran once
  assert.equal(order.length, 3);
});

test("background work still running after the handler can use (and open) the invocation's resources", async () => {
  const CLIENT = scopeKey<{ invocation: string }>("client");
  const opened = openScope({ invocationId: "x", kind: "http" });
  let usedLate: unknown;
  await opened.run(async () => {
    currentScope()!.resource(CLIENT, () => ({ invocation: "x" }));
    background(
      tick(20).then(() => {
        usedLate = currentScope()!.resource(CLIENT, () => ({ invocation: "a second one" }));
        currentScope()!.resource(scopeKey<number>("opened late"), () => 1);
      }),
    );
  });
  const settled = opened.settle(); // Azure starts settling right after the response
  await settled;
  assert.deepEqual(usedLate, { invocation: "x" }, "the same resource, not a new one");
});

test("a cleanup that throws doesn't stop the others", async () => {
  const order: string[] = [];
  const opened = openScope({ invocationId: "x", kind: "alarm" });
  opened.scope.onEnd(() => {
    order.push("second");
  });
  opened.scope.onEnd(() => {
    throw new Error("cleanup failed");
  });
  await opened.settle();
  assert.deepEqual(order, ["second"]);
});

test("settleBy waits for background work and cleanups when they finish before the deadline", async () => {
  const opened = openScope({ invocationId: "s", kind: "http" });
  const done: string[] = [];
  await opened.run(async () => {
    background(tick(10).then(() => done.push("work")));
    currentScope()!.onEnd(() => void done.push("cleanup"));
  });
  assert.deepEqual(await opened.settleBy(Date.now() + 1_000), { settled: true, pending: 0 });
  assert.deepEqual(done, ["work", "cleanup"]);
});

test("settleBy stops waiting at the deadline and counts the work it cut off", async () => {
  const opened = openScope({ invocationId: "t", kind: "http" });
  let release!: () => void;
  await opened.run(async () => {
    background(new Promise<void>((resolve) => (release = resolve)));
    background(new Promise<void>(() => {}));
    background(tick(1));
  });
  const started = Date.now();
  assert.deepEqual(await opened.settleBy(Date.now() + 30), { settled: false, pending: 2 });
  assert.ok(Date.now() - started < 500, "returned at the deadline");
  assert.deepEqual(await opened.settleBy(Date.now() - 1), { settled: false, pending: 2 }, "a past deadline doesn't wait");
  release();
});

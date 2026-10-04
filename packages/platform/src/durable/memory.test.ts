import assert from "node:assert/strict";
import test from "node:test";
import { runDurableConformance } from "./conformance.js";
import { InMemoryDurable } from "./memory.js";
import { DurableRegistry } from "./registry.js";
import { background } from "../scope.js";

// The in-memory implementation must pass the same suite as every cloud's.
runDurableConformance({ name: "memory", create: (registry) => new InMemoryDurable(registry) });

test("a job counts as finished only after its background work", async () => {
  let backgroundDone = false;
  const registry = new DurableRegistry().defineJob({
    kind: "bg",
    async run() {
      background(new Promise<void>((r) => setTimeout(() => ((backgroundDone = true), r()), 30)));
    },
  });
  const durable = new InMemoryDurable(registry);
  await durable.startJob("bg", {}, "bg-1");
  for (let i = 0; i < 100 && (await durable.status("bg-1"))?.status !== "completed"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal((await durable.status("bg-1"))?.status, "completed");
  assert.equal(backgroundDone, true);
});

test("a kind can be defined only once, across jobs, waits and alarms", () => {
  const registry = new DurableRegistry().defineJob({ kind: "k", run: async () => {} });
  assert.throws(() => registry.defineAlarm({ kind: "k", tick: async () => 0 }), /already defined/);
  assert.throws(() => registry.job("missing"), /Unknown durable job kind/);
});

test("starting an unknown kind throws", async () => {
  const durable = new InMemoryDurable(new DurableRegistry());
  await assert.rejects(durable.startJob("nope", {}), /Unknown durable job kind/);
});

test("a terminated run that finishes later doesn't complete the run that replaced it", async () => {
  const releases: Array<() => void> = [];
  const registry = new DurableRegistry().defineJob({
    kind: "slow",
    run: () => new Promise<void>((r) => releases.push(r)),
  });
  const durable = new InMemoryDurable(registry);
  await durable.startJob("slow", {}, "s-1");
  for (let i = 0; i < 50 && releases.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
  await durable.terminate("s-1", "test");
  assert.equal((await durable.startJob("slow", {}, "s-1")).started, true);
  for (let i = 0; i < 50 && releases.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  releases[0](); // the terminated run ends
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await durable.status("s-1"))?.status, "running", "the new run is still running");
  assert.equal((await durable.startJob("slow", {}, "s-1")).started, false, "and still dedupes");
  releases[1]();
  for (let i = 0; i < 50 && (await durable.status("s-1"))?.status !== "completed"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await durable.status("s-1"))?.status, "completed");
});

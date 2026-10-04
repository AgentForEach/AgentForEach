/**
 * ContainerSandbox against a fake container and storage, in Node (the
 * "cloudflare:workers" import resolves to a stub).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./workers-loader.testkit.js", import.meta.url);
const { ContainerSandbox } = await import("./container-sandbox.js");
const { snapshotSetTag, snapshotTag } = await import("./snapshot-registry.js");

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** What the sandbox server saw, in order: "health", "env:<json>", or the path. */
class FakeContainer {
  private up = false;
  /** While set, every call to the container service fails as if its connection dropped. */
  serviceDown = false;
  get running() {
    if (this.serviceDown) throw new Error("Container service disconnected.");
    return this.up;
  }
  set running(value: boolean) {
    this.up = value;
  }
  images = { sandbox: "registry.cloudflare.com/acct/app-sandbox:v1" };
  /** The image the running container was started from, and its /mnt/data. */
  image = "";
  files: Record<string, string> = {};
  /** What each snapshot holds: the image it was taken on, and its files. */
  snapshotData = new Map<string, { image: string; files: Record<string, string> }>();
  calls: string[] = [];
  env: Record<string, string> = {};
  intercepts = 0;
  inactivityTimeouts: number[] = [];
  /** Snapshots that fail before one succeeds. */
  failSnapshots = 0;
  /** Applying egress rules never finishes (a start stuck on the platform's side). */
  hangIntercept = false;
  /** POST /archive fails (unpacking on the new image). */
  failUnpack = false;
  /**
   * After a destroy, the platform says stopped but is still tearing down for
   * this long: a container started meanwhile dies on its first call.
   */
  ghostMs = 0;
  private ghostUntil = 0;
  private ghost = false;
  /** The next call finds the container gone ("has not been started"). */
  failNextCall = false;
  /** Held until opened: the next /health, the next /env. */
  holdHealth?: Gate;
  holdEnv?: Gate;
  private snapshots = 0;
  /** After destroy(), keep reporting running for this long, refusing calls meanwhile. */
  lingerMs = 0;
  private stopping = false;
  private refuseWhileStopping() {
    if (this.stopping) throw new Error("The container has not been started");
  }

  start(options: { image?: string; containerSnapshot?: { id: string } } = {}) {
    this.refuseWhileStopping();
    this.running = true;
    this.ghost = Date.now() < this.ghostUntil;
    this.env = {};
    if (options.containerSnapshot) {
      const saved = this.snapshotData.get(options.containerSnapshot.id);
      this.image = saved?.image ?? this.images.sandbox;
      this.files = { ...(saved?.files ?? {}) };
    } else {
      this.image = options.image ?? this.images.sandbox;
      this.files = {};
    }
  }
  async destroy() {
    if (this.ghostMs) this.ghostUntil = Date.now() + this.ghostMs;
    if (!this.lingerMs) {
      this.running = false;
      this.exit?.();
      return;
    }
    this.stopping = true;
    setTimeout(() => {
      this.running = false;
      this.stopping = false;
    }, this.lingerMs);
  }
  private exit?: () => void;
  private lost?: (err: Error) => void;
  monitor() {
    return new Promise<void>((resolve, reject) => {
      this.exit = resolve;
      this.lost = reject;
    });
  }
  /** The container stops on its own (killed, crashed): monitor() resolves. */
  crash() {
    this.running = false;
    this.exit?.();
  }
  /** monitor() loses its connection while the container runs on. */
  dropMonitor() {
    this.lost?.(new Error("Network connection lost."));
  }
  async interceptOutboundHttps() {
    this.refuseWhileStopping();
    if (this.hangIntercept) return new Promise<void>(() => {});
    this.intercepts++;
  }
  async interceptAllOutboundHttp() {}
  async setInactivityTimeout(ms: number) {
    this.inactivityTimeouts.push(ms);
  }
  async snapshotContainer() {
    if (this.failSnapshots > 0) {
      this.failSnapshots--;
      throw new Error("snapshot service unavailable");
    }
    const id = `fresh-${++this.snapshots}`;
    this.snapshotData.set(id, { image: this.image, files: { ...this.files } });
    return { id };
  }
  getTcpPort() {
    return {
      fetch: async (url: string, init: { method?: string; body?: string | ReadableStream<Uint8Array> } = {}) => {
        if (this.serviceDown) throw new Error("Network connection lost.");
        if (this.ghost || this.failNextCall) {
          this.failNextCall = false;
          this.ghost = false;
          this.running = false;
          throw new Error("The container has not been started");
        }
        const path = new URL(url).pathname;
        if (path === "/health") {
          const hold = this.holdHealth;
          this.holdHealth = undefined;
          await hold?.promise;
          this.calls.push("health");
          return Response.json({ status: "ok" });
        }
        if (path === "/env") {
          const hold = this.holdEnv;
          this.holdEnv = undefined;
          await hold?.promise;
          this.env = (JSON.parse((init.body as string) ?? "{}") as { vars: Record<string, string> }).vars;
          this.calls.push(`env:${JSON.stringify(this.env)}`);
          return Response.json({ success: true });
        }
        if (path === "/archive") {
          this.calls.push(`${init.method ?? "GET"} /archive`);
          if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify(this.files)); // stands in for the tar
          if (this.failUnpack) return new Response("tar: unexpected end of file", { status: 500 });
          this.files = JSON.parse(await new Response(init.body as ReadableStream<Uint8Array>).text());
          return Response.json({ ok: true });
        }
        this.calls.push(path);
        return Response.json({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false, truncated: false });
      },
    };
  }
}

function fakeState(container: FakeContainer) {
  const store = new Map<string, unknown>();
  const storage = {
    async get(key: string | string[]) {
      if (Array.isArray(key)) return new Map(key.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
      return store.get(key);
    },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === "string") store.set(key, value);
      else for (const [k, v] of Object.entries(key)) store.set(k, v);
    },
    async delete(key: string | string[]) {
      if (Array.isArray(key)) return key.filter((k) => store.delete(k)).length;
      return store.delete(key);
    },
    async deleteAll() {
      store.clear();
    },
    async list({ prefix }: { prefix: string }) {
      return new Map([...store].filter(([k]) => k.startsWith(prefix)));
    },
    async setAlarm(at: number) {
      store.set("__alarm", at);
    },
    async getAlarm() {
      return (store.get("__alarm") as number | undefined) ?? null;
    },
    async deleteAlarm() {
      store.delete("__alarm");
    },
  };
  const ctx = {
    storage,
    container,
    exports: { SandboxEgress: () => ({}) },
    waitUntil: (p: Promise<unknown>) => void p.catch(() => {}),
  };
  return { ctx, store };
}

function sandbox(container: FakeContainer, state = fakeState(container)) {
  type Ctor = new (ctx: unknown, env: unknown) => InstanceType<typeof ContainerSandbox>;
  const object = new (ContainerSandbox as unknown as Ctor)(state.ctx, {});
  // The alarm's keep-alive wait, recorded instead of waited.
  const keptAlive: number[] = [];
  (object as unknown as { keepAlive(ms: number): Promise<void> }).keepAlive = async (ms) => void keptAlive.push(ms);
  return { object, keptAlive, ...state };
}

const options = { instance: "standard-2", idleMs: 300_000, allowHosts: [], internet: false };
const exec = (command: string) => ({ path: "/exec", method: "POST" as const, body: JSON.stringify({ command }) });
const setEnv = (vars: Record<string, string>) => ({ path: "/env", method: "POST" as const, body: JSON.stringify({ vars }) });

async function until(condition: () => boolean) {
  // Time-based: some steps (crypto.subtle) resolve off the event loop's immediate queue.
  for (const deadline = Date.now() + 2000; Date.now() < deadline && !condition(); ) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(condition(), "condition never held");
}

test("a call arriving mid-start waits until the server answers and its env is restored (review R1)", async () => {
  const container = new FakeContainer();
  const { object, store } = sandbox(container);
  store.set("env", { A: "1" });
  container.holdHealth = gate();
  const health = container.holdHealth;

  const first = object.request(exec("first"), options);
  await until(() => container.running && container.intercepts === 1);
  const second = object.request(exec("second"), options);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(container.calls, [], "nothing reaches the server before it is ready");

  health.open();
  await Promise.all([first, second]);
  assert.deepEqual(container.calls, ["health", 'env:{"A":"1"}', "/exec", "/exec"]);
});

test("an env update mid-start lands after the restore, not before it (review R1)", async () => {
  const container = new FakeContainer();
  const { object, store } = sandbox(container);
  store.set("env", { A: "old" });
  container.holdEnv = gate();
  const restore = container.holdEnv;

  const first = object.request(exec("first"), options);
  await until(() => container.calls.includes("health"));
  const update = object.request(setEnv({ A: "new" }), options);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  restore.open();
  await Promise.all([first, update]);

  assert.deepEqual(container.env, { A: "new" }, "the server has the newer set");
  assert.deepEqual(store.get("env"), { A: "new" }, "and so does the object");
  assert.deepEqual(
    container.calls.filter((call) => call !== "/exec"),
    ["health", 'env:{"A":"old"}', 'env:{"A":"new"}'],
  );
});

test("a reloaded object applies its egress rules and env again before the first call", async () => {
  const container = new FakeContainer();
  const state = fakeState(container);
  const before = sandbox(container, state).object;
  await before.request(setEnv({ A: "1" }), options);
  assert.equal(container.intercepts, 1);

  // The object is evicted while its container keeps running; a new instance takes over.
  const after = sandbox(container, state).object;
  container.calls = [];
  await after.request(exec("ls"), options);
  assert.equal(container.intercepts, 2, "rules applied again");
  assert.deepEqual(container.calls, ['env:{"A":"1"}', "/exec"]);
});

/** A sandbox that slept before: snapshot snap-2 is current, snap-1 superseded. */
function sleptBefore(container: FakeContainer) {
  const state = fakeState(container);
  const record = (id: string) => ({ id, image: container.images.sandbox, at: "2026-10-02T00:00:00Z" });
  state.store.set("snapshot", record("snap-2"));
  state.store.set("snapshots", [record("snap-1"), record("snap-2")]);
  return sandbox(container, state);
}

const deletion = { accountId: "acct", apiToken: "api-token" };

/**
 * A registry call: a snapshot tag's manifest points at a config whose set id
 * is "set-of-<tag>"; a DELETE on a tag is recorded.
 */
function manifestCall(url: string, method: string, deleted: string[]): Response {
  const blob = /\/blobs\/config-of-(.+)$/.exec(url);
  if (blob) return Response.json({ snapshot_set_id: `set-of-${blob[1]}` });
  const reference = url.split("/manifests/")[1];
  if (method === "DELETE") {
    deleted.push(reference);
    return new Response(null, { status: 204 });
  }
  return Response.json({ config: { digest: `config-of-${reference}` } });
}

/** Answers the Cloudflare API and registry; DELETEs wait for `deletes` when given. */
function fakeRegistry(deletes?: Gate) {
  const deleted: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/credentials")) return Response.json({ success: true, result: { password: "p" } });
    if (url.endsWith("/gc/layers")) return new Response(null, { status: 202 });
    await deletes?.promise;
    return manifestCall(url, init?.method ?? "GET", deleted);
  }) as typeof fetch;
  return { fetcher, deleted };
}

async function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} was held up`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test("a slow snapshot registry doesn't hold up the sandbox while an erasure deletes (review R2)", async (t) => {
  const container = new FakeContainer();
  const { object } = sleptBefore(container);
  const deletes = gate();
  const registry = fakeRegistry(deletes);
  t.mock.method(globalThis, "fetch", registry.fetcher);

  const erasure = object.forget(deletion); // its registry calls wait on the gate
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The lifecycle queue is free: a new start runs while the registry hangs.
  assert.equal((await within(1000, object.request(exec("ls"), options), "a start")).status, 200);
  deletes.open();
  await erasure;
});

test("no snapshot is deleted while its sandbox lives: they are deltas, each needs its parent (live check)", async (t) => {
  const container = new FakeContainer();
  const { object, store } = sleptBefore(container);
  const registry = fakeRegistry();
  t.mock.method(globalThis, "fetch", registry.fetcher);

  await object.request(exec("ls"), options);
  await object.suspend();
  await object.request(exec("ls"), options);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(registry.deleted, [], "nothing deleted as the sandbox sleeps and wakes");
  assert.deepEqual(
    (store.get("snapshots") as Array<{ id: string }>).map((s) => s.id),
    ["snap-1", "snap-2", "fresh-1"],
    "the whole chain stays recorded, for erasure",
  );
});

test("erasure keeps the snapshots the registry wouldn't delete, and a retry deletes them (multi-tenant review)", async (t) => {
  const container = new FakeContainer();
  const { object, store } = sleptBefore(container);
  let refuse = true;
  const deleted: string[] = [];
  t.mock.method(globalThis, "fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/credentials")) return Response.json({ success: true, result: { password: "p" } });
    if (url.endsWith("/gc/layers")) return new Response(null, { status: 202 });
    if (refuse) return new Response(null, { status: 503 });
    return manifestCall(url, init?.method ?? "GET", deleted);
  }) as typeof fetch);

  await assert.rejects(object.forget(deletion), /2 of 2 snapshots could not be deleted/);
  assert.deepEqual(
    (store.get("snapshots") as Array<{ id: string }>).map((s) => s.id),
    ["snap-1", "snap-2"],
    "the list survives the failed erasure",
  );
  assert.equal(store.get("snapshot"), undefined, "everything else is gone");

  refuse = false;
  await object.forget(deletion);
  assert.deepEqual(deleted, [
    await snapshotTag("snap-1"),
    await snapshotSetTag(`set-of-${await snapshotTag("snap-1")}`),
    await snapshotTag("snap-2"),
    await snapshotSetTag(`set-of-${await snapshotTag("snap-2")}`),
  ]);
  assert.equal(store.size, 0, "nothing left after the retry");
});

test("the sandbox asks to be indexed from its start until the backend confirms", async () => {
  const container = new FakeContainer();
  const { object } = sandbox(container);
  const asks = async () => (await object.request(exec("true"), options)).headers.get("x-sandbox-unindexed");
  assert.equal(await asks(), "1", "the starting call");
  assert.equal(await asks(), "1", "and every call after, until confirmed");
  await object.indexed();
  assert.equal(await asks(), null);
  await object.suspend();
  assert.equal(await asks(), "1", "a new start asks again");
});

test("a failed idle snapshot keeps the container running and retries, without giving up (independent review)", async (t) => {
  t.mock.method(console, "error", () => {});
  const container = new FakeContainer();
  const { object, store } = sandbox(container);
  await object.request(exec("echo work > notes.txt"), options);
  store.set("lastActivity", Date.now() - options.idleMs - 1000);
  container.failSnapshots = 3;

  const delays: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = Date.now();
    await object.alarm(); // doesn't throw: the runtime's own retries would give up
    assert.equal(container.running, true, "never stopped without a snapshot");
    const delay = (store.get("snapshotRetryAt") as number) - before;
    delays.push(Math.round(delay / 1000));
    assert.ok(container.inactivityTimeouts.at(-1)! > options.idleMs + delay, "the inactivity stop is pushed past the next try");
    assert.ok(typeof store.get("__alarm") === "number", "the loop goes on, keeping the object alive until the retry");
    store.set("snapshotRetryAt", 0); // the retry is due
  }
  assert.deepEqual(delays, [30, 60, 120], "doubling");
  assert.equal(store.get("snapshotFailures"), 3);

  await object.alarm();
  assert.equal(container.running, false, "stopped once a snapshot succeeded");
  assert.equal((store.get("snapshot") as { id: string }).id, "fresh-1");
  assert.equal(store.get("snapshotFailures"), undefined);
});

test("the first call after an erasure waits for the old container to stop, then starts a fresh one (live check)", async () => {
  const container = new FakeContainer();
  const { object } = sandbox(container);
  await object.request(exec("echo before"), options);
  container.lingerMs = 300; // destroy() returns while the container still reports running

  assert.equal(await object.forget(), true);
  assert.equal(container.running, false, "forget returns once the container has stopped");
  const after = await object.request(exec("echo after"), options);
  assert.equal(after.status, 200);
  assert.equal(after.headers.get("x-sandbox-unindexed"), "1", "a fresh start");
});

test("a container that stops without being asked is reported loudly; one this object stops is not (live run)", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => errors.push(line));
  const container = new FakeContainer();
  const { object } = sandbox(container);
  await object.request(exec("echo hi"), options);

  container.crash();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /CONTAINER STOPPED WITHOUT A SNAPSHOT/);

  await object.request(exec("echo again"), options); // a fresh start
  await object.suspend(); // this object's own stop
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(errors.length, 1, "no report for a stop this object made");
});

test("while the container runs, each alarm keeps the object alive until the next check and arms the next (live rerun)", async () => {
  const container = new FakeContainer();
  const { object, store, keptAlive } = sandbox(container);
  await object.request(exec("echo hi"), options);
  assert.equal(typeof store.get("__alarm"), "number", "the first request starts the loop");
  const armed = store.get("__alarm");
  await object.request(exec("echo again"), options);
  assert.equal(store.get("__alarm"), armed, "a request doesn't push the loop's alarm out");

  store.delete("__alarm");
  await object.alarm(); // not idle yet
  assert.equal(container.running, true);
  assert.ok(keptAlive[0] > 0 && keptAlive[0] <= 3 * 60_000, `waited ${keptAlive[0]} ms, at most 3 minutes`);
  assert.ok((store.get("__alarm") as number) <= Date.now(), "and armed the next alarm at once");

  store.set("lastActivity", Date.now() - options.idleMs - 1);
  await object.alarm(); // idle: snapshot and stop, and the loop ends
  assert.equal(container.running, false);
  assert.equal(keptAlive.length, 1, "no keep-alive once the container is stopped");
});

test("a container that vanished while nobody watched is reported by the next alarm or start (live rerun)", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => errors.push(line));
  const container = new FakeContainer();
  const state = fakeState(container);
  await sandbox(container, state).object.request(exec("echo hi"), options);

  // The object is evicted (its monitor gone with it), then the container stops.
  container.running = false;
  const later = sandbox(container, state).object;
  await later.alarm();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /CONTAINER STOPPED WITHOUT A SNAPSHOT.*"noticedIn":"alarm"/);

  await later.request(exec("echo fresh"), options); // a fresh start: nothing more to report
  container.running = false;
  await sandbox(container, state).object.request(exec("echo again"), options);
  assert.equal(errors.length, 2);
  assert.match(errors[1], /"noticedIn":"start"/);
});

const V1 = "registry.cloudflare.com/acct/app-sandbox:v1";
const V2 = "registry.cloudflare.com/acct/app-sandbox:v2";

/** A sandbox that slept on image v1, while the deployment now runs v2. */
function sleptOnOldImage(container: FakeContainer) {
  const state = fakeState(container);
  container.images.sandbox = V2;
  container.snapshotData.set("snap-v1", { image: V1, files: { "notes.txt": "mine", ".browser/profile/Cookies": "session" } });
  const record = { id: "snap-v1", image: V1, at: "2026-10-02T00:00:00Z" };
  state.store.set("snapshot", record);
  state.store.set("snapshots", [record]);
  state.store.set("env", { A: "1" });
  return sandbox(container, state);
}

test("after an image change, the files move to a fresh container on the new image, and a new chain starts (live run 3)", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: string) => logs.push(String(line)));
  const container = new FakeContainer();
  const { object, store } = sleptOnOldImage(container);

  assert.equal((await object.request(exec("ls"), options)).status, 200);
  assert.equal(container.image, V2, "the container runs the new image");
  assert.deepEqual(container.files, { "notes.txt": "mine", ".browser/profile/Cookies": "session" }, "with the user's files");
  assert.deepEqual(container.env, { A: "1" }, "env applied again, not carried in the archive");
  const current = store.get("snapshot") as { id: string; image: string };
  assert.equal(current.image, V2, "a snapshot of the new container is current");
  assert.equal(container.snapshotData.get(current.id)!.image, V2);
  assert.deepEqual((store.get("snapshots") as Array<{ id: string }>).map((s) => s.id), ["snap-v1", current.id], "the old chain stays recorded, for erasure");
  assert.equal([...store.keys()].filter((k) => k.startsWith("upgrade:")).length, 0, "the archive is dropped");
  assert.ok(logs.some((l) => /"image upgraded"/.test(l)));

  await object.suspend();
  assert.equal((store.get("snapshot") as { image: string }).image, V2);
});

test("a failed upgrade keeps the old container and its snapshot, says so, and waits a day to retry (live run 3)", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => errors.push(String(line)));
  t.mock.method(console, "warn", () => {});
  const container = new FakeContainer();
  const { object, store } = sleptOnOldImage(container);
  container.failUnpack = true;

  assert.equal((await object.request(exec("ls"), options)).status, 200, "the call still works, on the old image");
  assert.equal(container.image, V1);
  assert.deepEqual(container.files, { "notes.txt": "mine", ".browser/profile/Cookies": "session" }, "nothing lost");
  assert.equal((store.get("snapshot") as { id: string }).id, "snap-v1", "the old snapshot is still current");
  assert.ok(errors.some((e) => /IMAGE UPGRADE FAILED/.test(e)));

  await object.suspend();
  assert.equal((store.get("snapshot") as { image: string }).image, V1, "a snapshot of an old-image container is recorded under the old image");

  container.calls = [];
  await object.request(exec("ls"), options);
  assert.equal(container.image, V1);
  assert.equal(container.calls.filter((c) => c.includes("/archive")).length, 0, "not tried again within a day");
});

test("a start stuck applying egress rules fails the call after the start timeout, with a retryable message (live run 3)", async (t) => {
  t.mock.method(console, "log", () => {});
  const container = new FakeContainer();
  const { object } = sandbox(container);
  (object as unknown as { startTimeoutMs: number }).startTimeoutMs = 50;
  container.hangIntercept = true;
  await assert.rejects(object.request(exec("ls"), options), /didn't start within 0.05 s.*Try again/);
  assert.equal(container.running, false, "the stuck container is stopped");
});

test("a monitor that loses its connection isn't a stop; an alarm that does checks again instead of failing (live run 3)", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => errors.push(String(line)));
  t.mock.method(console, "warn", () => {});
  const container = new FakeContainer();
  const { object, store } = sandbox(container);
  await object.request(exec("echo hi"), options);

  container.dropMonitor(); // "Network connection lost.", but the container runs on
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(errors.length, 0, "no false report");
  assert.ok(store.get("containerUp"), "still known to be up");

  container.serviceDown = true; // "Container service disconnected."
  store.delete("__alarm");
  await object.alarm(); // doesn't throw
  assert.ok((store.get("__alarm") as number) > Date.now(), "checks again shortly");
  assert.equal(errors.length, 0);
  container.serviceDown = false;
});

test("one keep-alive loop at a time: a request doesn't arm a second alarm while one waits (live run 3)", async () => {
  const container = new FakeContainer();
  const { object, store } = sandbox(container);
  await object.request(exec("echo hi"), options);
  const waiting = gate();
  let waits = 0;
  (object as unknown as { keepAlive(ms: number): Promise<void> }).keepAlive = async () => {
    waits++;
    await waiting.promise;
  };
  store.delete("__alarm");
  const first = object.alarm(); // waits in its handler
  await until(() => waits === 1);
  await object.request(exec("echo during"), options);
  assert.equal(store.get("__alarm"), undefined, "no alarm armed while the loop waits");
  await object.alarm(); // an overlapping alarm returns at once
  assert.equal(waits, 1);
  waiting.open();
  await first;
  assert.equal(typeof store.get("__alarm"), "number", "the loop arms its next alarm");
});

test("the start after a timed-out start waits for the old container to go away, and succeeds (live run 4)", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const container = new FakeContainer();
  const { object } = sandbox(container);
  Object.assign(object as unknown as { startTimeoutMs: number; settleMs: number }, { startTimeoutMs: 100, settleMs: 150 });
  container.hangIntercept = true;
  container.ghostMs = 120; // still tearing down for a while after its destroy
  await assert.rejects(object.request(exec("ls"), options), /didn't start within/);

  container.hangIntercept = false;
  const response = await object.request(exec("ls"), options);
  assert.equal(response.status, 200, "no 'has not been started': it waited out the teardown");
  assert.equal(container.calls.filter((c) => c === "/exec").length, 1);
});

test("a start that meets a container still going away is tried again, within its bound (live run 4)", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const container = new FakeContainer();
  const { object } = sandbox(container);
  Object.assign(object as unknown as { settleMs: number }, { settleMs: 20 });
  await object.request(exec("ls"), options);
  container.ghostMs = 10;
  await object.suspend(); // a destroy: the next start lands in its teardown
  const response = await object.request(exec("ls"), options);
  assert.equal(response.status, 200, "the first attempt died, the next one worked");
});

test("an exec that finds the container gone starts it again and is sent once more (live run 4)", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const container = new FakeContainer();
  const { object } = sandbox(container);
  await object.request(exec("ls"), options);
  container.calls = [];
  container.failNextCall = true; // it died since: the request can't have run
  const response = await object.request(exec("echo once"), options);
  assert.equal(response.status, 200);
  assert.equal(container.calls.filter((c) => c === "/exec").length, 1, "the command ran once");
});

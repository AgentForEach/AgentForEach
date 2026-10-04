/**
 * One sandbox on Cloudflare Containers: a Durable Object per sandbox
 * identifier, running the AgentForEach sandbox image (server.mjs on port
 * 8080) with `ctx.container`, under the `durable_object` scheduling policy.
 *
 *   - Wake: a request to a stopped sandbox restores its last snapshot (or
 *     starts the image fresh), registers the egress intercepts again (they
 *     are not part of a snapshot), and waits for server.mjs to answer.
 *   - Sleep: an alarm snapshots the whole disk after `idleMs` without a
 *     request, then stops the container. Memory and processes are lost, as
 *     with ACA Sandboxes' Disk mode; files and the server's env file stay.
 *   - Egress: the container has no internet of its own; all HTTP and HTTPS
 *     goes to the SandboxEgress entrypoint, which applies the allowlist and
 *     adds credential headers (egress-policy.ts).
 *   - Image upgrades: a snapshot is tied to the image it was taken from, so a
 *     sleeping sandbox keeps its old image after a deploy (verified live), as
 *     an ACA sandbox keeps the disk image it was created from, until it is
 *     deleted or its snapshot expires (30 days unused); new sandboxes get the
 *     new image. No file is ever lost. Where the runtime offers directory
 *     snapshots (`snapshotDirectory`: experimental, absent in production on
 *     2026-10-02), /mnt/data moves to the new image instead, and anything
 *     installed elsewhere on the old disk is left behind.
 *   - A deploy doesn't reach a running sandbox's object: it keeps the old
 *     code until the container stops (verified live).
 *
 * Restores pass `instance`, `env` and `entrypoint` again: without them a
 * restore comes back as a 458 MiB machine without the CA variables
 * (docs/Cloudflare_Evaluation.md).
 */

import { DurableObject } from "cloudflare:workers";
import type { EgressCredential } from "@agentforeach/platform";
import { DATA_DIR } from "@agentforeach/platform/sandbox/shared";
import type { SandboxEgressProps } from "./egress-policy.js";
import { UNINDEXED_HEADER } from "./protocol.js";
import { SerialQueue } from "./serial-queue.js";
import { SnapshotRegistry, imageRepository, type SnapshotDeletionOptions } from "./snapshot-registry.js";

/** server.mjs's port in the sandbox image. */
const SERVER_PORT = 8080;
/** Cloudflare's interception CA, written into the container shortly after it starts. */
const RUNTIME_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/** Storage key prefix of the identifiers in a user's index object. */
const INDEX_PREFIX = "sandbox:";
/** The header carrying the per-start token server.mjs requires. */
const TOKEN_HEADER = "x-sandbox-token";
/** How long a start may take before it is abandoned. */
/** A start, from the container's start to its server answering, egress rules included. */
const START_TIMEOUT_MS = 90_000;
/** Largest /mnt/data an image upgrade carries over, and the chunks it is held in meanwhile. */
const UPGRADE_MAX_BYTES = 1024 ** 3;
const UPGRADE_CHUNK_BYTES = 1024 ** 2;
/** How long a failed image upgrade waits before it is tried again. */
const UPGRADE_RETRY_MS = 24 * 60 * 60_000;
/** A request longer than this is logged (path and program), to see what holds a sandbox. */
const SLOW_REQUEST_MS = 30_000;
/** How many times a start that failed for a stopping container (or a lost connection) is tried. */
const START_ATTEMPTS = 3;
/** Errors that say a start met a container still going away, or lost its connection: worth another try. */
const START_RETRYABLE = /has not been started|is not running|container service disconnected|network connection lost/i;
/** Errors from losing the connection to the container service, which say nothing about the container. */
const SERVICE_LOST = /container service disconnected|network connection lost/i;
/** How long past the next idle check the container's own inactivity stop waits (a backstop). */
const INACTIVITY_MARGIN_MS = 5 * 60_000;
/** Retries of a failed idle snapshot: doubling from this, up to the cap, never giving up. */
const SNAPSHOT_RETRY_BASE_MS = 30_000;
const SNAPSHOT_RETRY_MAX_MS = 10 * 60_000;
/**
 * Longest an alarm waits in its handler, keeping this object in memory while
 * the container runs, before arming the next (as @cloudflare/containers does).
 */
const KEEPALIVE_MAX_MS = 3 * 60_000;
/** How long a destroyed container may take to report that it stopped. */
const STOP_TIMEOUT_MS = 30_000;
/** What the runtime says when a call reaches a container that is stopping or stopped. */
const NOT_STARTED = /has not been started|is not running/i;

/**
 * Wait for the interception CA, trust it, then run server.mjs. The CA only
 * exists after the container starts, so it can't be baked into the image.
 */
const ENTRYPOINT = [
  "sh",
  "-c",
  `for i in $(seq 1 100); do [ -f ${RUNTIME_CA} ] && break; sleep 0.1; done; ` +
    `if [ -f ${RUNTIME_CA} ]; then cp ${RUNTIME_CA} /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates >/dev/null 2>&1; fi; ` +
    `exec node /opt/sandbox/server.mjs`,
];
const CA_ENV = {
  NODE_EXTRA_CA_CERTS: RUNTIME_CA,
  REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
  SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
  PIP_CERT: "/etc/ssl/certs/ca-certificates.crt",
  CURL_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
};

/** How the gateway wants this sandbox run; sent with every call. */
export interface ContainerSandboxOptions {
  /** Instance type, e.g. "standard-2". */
  instance: string;
  /** Snapshot and stop after this long without a request. */
  idleMs: number;
  /** Hosts the sandbox may reach (exact, or "*.domain"). */
  allowHosts: string[];
  /** Open egress (networkAccess "enabled"). */
  internet: boolean;
}

/** A request for the sandbox server. */
export interface SandboxServerRequest {
  path: string;
  method: "GET" | "POST";
  body?: string;
}

type SnapshotRecord = { id: string; image: string; at: string };
/** A directory snapshot handle (experimental runtime API). */
type DirectorySnapshot = { id: string; size: number; dir: string; name?: string };

export class ContainerSandbox extends DurableObject {
  /** Calls running now; the idle alarm never stops a sandbox mid-call. */
  private inFlight = 0;
  /**
   * Whether the sandbox is ready for requests, as far as this object (since
   * it was loaded) knows: running, with this object's egress rules applied,
   * answering, and its env restored. Set only at the end of a start, so a
   * call arriving mid-start waits for it in the lifecycle queue.
   */
  private ready = false;
  /** Bumped on each start and destroy, so a stale monitor can tell its container is gone. */
  private generation = 0;
  /** Set while this object is stopping the container itself (sleep, forget, ...). */
  private stopping = false;
  /** An alarm is waiting in its handler (the keep-alive loop), so no second loop starts. */
  private keepingAlive = false;
  /** How long a start may take (tests shorten it). */
  protected startTimeoutMs = START_TIMEOUT_MS;
  /**
   * How long the next start waits after a failed start's container was
   * destroyed: it can report stopped while still going away, and a start
   * right then fails (seen live). Tests shorten it.
   */
  protected settleMs = 10_000;
  /**
   * Lifecycle changes (start, sleep, forget, new egress rules) run one at a
   * time, so an erasure can't interleave with a sleep whose snapshot would
   * land after it, or with a start. Requests themselves don't wait on it
   * once the sandbox runs.
   */
  private readonly lifecycle = new SerialQueue();

  private serial<T>(work: () => Promise<T>): Promise<T> {
    return this.lifecycle.run(work);
  }

  /** Run a request against this sandbox's server, starting the sandbox if it sleeps. */
  async request(request: SandboxServerRequest, options: ContainerSandboxOptions): Promise<Response> {
    this.inFlight++;
    const began = Date.now();
    try {
      let response: Response;
      if (request.path === "/env" && request.method === "POST") {
        // Env changes go through the lifecycle queue: the remembered set and
        // the server's never diverge, and a restore during a start can't land
        // after (and undo) a newer set.
        response = await this.serial(async () => {
          if (request.body) await this.rememberEnv(request.body);
          const started = await this.readyLocked(options);
          return this.sendOrRestart(request, started, options, () => this.readyLocked(options));
        });
      } else {
        response = await this.sendOrRestart(request, await this.ensureStarted(options), options, () =>
          this.serial(() => this.readyLocked(options)),
        );
      }
      return slowLogged(response, request, began);
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Send, and if the container turned out not to be running ("has not been
   * started": the request never reached it, so nothing ran), start it again
   * and send once more.
   */
  private async sendOrRestart(
    request: SandboxServerRequest,
    started: boolean,
    options: ContainerSandboxOptions,
    restart: () => Promise<boolean>,
  ): Promise<Response> {
    try {
      return await this.send(request, started, options);
    } catch (err) {
      if (!NOT_STARTED.test(err instanceof Error ? err.message : String(err))) throw err;
      console.warn(`[sandbox] the container wasn't running for ${request.path}; starting it again and sending once more`);
      this.ready = false;
      const again = await restart();
      return this.send(request, started || again, options);
    }
  }

  /** Forward a request to the running sandbox's server. */
  private async send(request: SandboxServerRequest, started: boolean, options: ContainerSandboxOptions): Promise<Response> {
    const unindexed = started || (await this.ctx.storage.get<boolean>("unindexed")) === true;
    await this.touch(options);
    const response = await this.container().getTcpPort(SERVER_PORT).fetch(`http://sandbox${request.path}`, {
      method: request.method,
      body: request.body,
      headers: { ...(request.body ? { "content-type": "application/json" } : {}), [TOKEN_HEADER]: await this.serverToken() },
    });
    if (!unindexed) return response;
    // Until the caller confirms, ask it to index this sandbox under its owner.
    const headers = new Headers(response.headers);
    headers.set(UNINDEXED_HEADER, "1");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  /** Replace the credentials the egress handler adds; applied at once if the sandbox runs. */
  async setEgressCredentials(credentials: EgressCredential[], options: ContainerSandboxOptions): Promise<void> {
    await this.serial(async () => {
      await this.ctx.storage.put("credentials", credentials);
      if (this.container().running) await this.intercept(options);
    });
  }

  /** Remember a sandbox identifier of this user (this object is the user's index). Idempotent. */
  async track(identifier: string): Promise<void> {
    // One key per identifier: no array that grows with every conversation.
    await this.ctx.storage.put(`${INDEX_PREFIX}${identifier}`, 1);
  }

  /** The backend put this sandbox in its owner's index: stop asking (until the next start). */
  async indexed(): Promise<void> {
    await this.ctx.storage.delete("unindexed");
  }

  async untrack(identifier: string): Promise<void> {
    await this.ctx.storage.delete(`${INDEX_PREFIX}${identifier}`);
  }

  async tracked(): Promise<string[]> {
    const keys = await this.ctx.storage.list({ prefix: INDEX_PREFIX });
    return [...keys.keys()].map((key) => key.slice(INDEX_PREFIX.length));
  }

  /**
   * Stop the sandbox and forget it: its snapshot reference, credentials and
   * state. Returns whether there was a sandbox. With `snapshotDeletion` its
   * snapshots are then deleted from the registry; the ones that fail stay
   * recorded and the call throws, so erasing again retries them. Without
   * it, the snapshots expire after 30 days unused.
   */
  async forget(snapshotDeletion?: SnapshotDeletionOptions): Promise<boolean> {
    // After any start or sleep in progress, so neither writes state back afterwards.
    const { existed, snapshots } = await this.serial(async () => {
      const existed = this.container().running || (await this.ctx.storage.get("snapshot")) !== undefined;
      const snapshots = (await this.ctx.storage.get<SnapshotRecord[]>("snapshots")) ?? [];
      if (this.container().running) await this.destroy("sandbox deleted");
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      // The list alone stays until the registry confirms each deletion.
      if (snapshotDeletion && snapshots.length > 0) await this.ctx.storage.put("snapshots", snapshots);
      this.ready = false;
      return { existed, snapshots };
    });
    if (!snapshotDeletion || snapshots.length === 0) return existed;
    // Outside the lifecycle queue: a slow registry must not hold up other calls.
    const gone = await this.deleteFromRegistry(snapshotDeletion, snapshots);
    // Read again: a sandbox started and slept meanwhile records its own snapshots.
    const left = ((await this.ctx.storage.get<SnapshotRecord[]>("snapshots")) ?? []).filter((s) => !gone.has(s.id));
    if (left.length > 0) await this.ctx.storage.put("snapshots", left);
    else await this.ctx.storage.delete("snapshots");
    const failed = snapshots.filter((s) => !gone.has(s.id)).length;
    if (failed > 0) {
      throw new Error(`${failed} of ${snapshots.length} snapshots could not be deleted from the registry; they stay recorded for a retry`);
    }
    return existed;
  }

  /** Snapshot and stop the sandbox now, as the idle alarm does. Returns whether it was running. */
  async suspend(): Promise<boolean> {
    return this.serial(async () => {
      if (!this.container().running) return false;
      try {
        await this.sleep("suspend");
      } catch (err) {
        await this.snapshotFailed(err);
        throw err;
      }
      return true;
    });
  }

  /**
   * Idle check and keep-alive. The runtime stops a container some time after
   * its Durable Object goes inactive, without a snapshot (seen live: idle
   * sandboxes gone 3.5 to 5 minutes in, before their 300 s idle check). So
   * while the container runs, each alarm waits in its handler until the next
   * check is due (at most 3 minutes), keeping this object in memory, then
   * arms the next one at once, as @cloudflare/containers' Container class
   * does. A sandbox idle for `idleMs` is snapshotted and stopped.
   */
  async alarm(): Promise<void> {
    // One keep-alive loop at a time: an alarm armed while another waits (by a
    // request) would otherwise start a second, overlapping one.
    if (this.keepingAlive) return;
    try {
      await this.alarmOnce();
    } catch (err) {
      // The connection to the container service dropped: nothing is known
      // about the container, so check again shortly rather than fail.
      if (!SERVICE_LOST.test(err instanceof Error ? err.message : String(err))) throw err;
      console.warn(`[sandbox] alarm: ${err instanceof Error ? err.message : String(err)}; checking again in 10 s`);
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
    }
  }

  private async alarmOnce(): Promise<void> {
    const outcome = await this.serial(async () => {
      if (!this.container().running) {
        // Unknown (the service is unreachable): look again soon, keeping the object up.
        return (await this.noticeLostContainer("alarm")) === "unknown" ? "recheck" : "stopped";
      }
      const { last, idleMs, retryAt } = await this.idleState();
      const idle = this.inFlight === 0 && Date.now() - last >= idleMs;
      if (!idle || Date.now() < retryAt) return "running";
      try {
        await this.sleep("idle");
        return "stopped";
      } catch (err) {
        // Not rethrown: the runtime's alarm retries give up after a few
        // minutes. This loop retries instead, keeping the container alive.
        await this.snapshotFailed(err);
        return "running";
      }
    });
    if (outcome === "stopped") return;
    if (outcome === "recheck") {
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
      return;
    }
    const { last, idleMs, retryAt } = await this.idleState();
    const due = this.inFlight > 0 ? Date.now() + 10_000 : Math.max(last + idleMs, retryAt);
    this.keepingAlive = true;
    try {
      await this.keepAlive(Math.min(Math.max(due - Date.now(), 1_000), KEEPALIVE_MAX_MS));
    } finally {
      this.keepingAlive = false;
    }
    if (this.container().running) await this.ctx.storage.setAlarm(Date.now());
    else await this.serial(() => this.noticeLostContainer("alarm"));
  }

  /** Wait in the alarm handler, which keeps this object in memory. (Tests replace it.) */
  protected keepAlive(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async idleState(): Promise<{ last: number; idleMs: number; retryAt: number }> {
    const values = await this.ctx.storage.get<number>(["lastActivity", "idleMs", "snapshotRetryAt"]);
    return { last: values.get("lastActivity") ?? 0, idleMs: values.get("idleMs") ?? 0, retryAt: values.get("snapshotRetryAt") ?? 0 };
  }

  /**
   * The container is gone though this object didn't stop it (a stored marker
   * says it was up): report it. Called from the alarm and before a start, so
   * a stop is reported even when the invocation that started it is long over.
   */
  private async noticeLostContainer(noticedIn: string): Promise<"lost" | "unknown" | "none"> {
    const up = await this.ctx.storage.get<{ since: number; kind: string }>("containerUp");
    if (!up) return "none";
    // Only a container that is really gone: not one behind a dropped connection.
    const state = await this.containerState();
    if (state !== "down") return state === "up" ? "none" : "unknown";
    await this.ctx.storage.delete("containerUp");
    this.ready = false;
    console.error(JSON.stringify({ sandbox: "CONTAINER STOPPED WITHOUT A SNAPSHOT", kind: up.kind, noticedIn, upMs: Date.now() - up.since }));
    return "lost";
  }

  /**
   * Whether the container is up, confirmed by asking its server: "down" when
   * the runtime says it isn't running or a call says it isn't started,
   * "unknown" when the container service can't be reached at all.
   */
  private async containerState(): Promise<"up" | "down" | "unknown"> {
    try {
      if (!this.container().running) return "down";
      const response = await this.container().getTcpPort(SERVER_PORT).fetch("http://sandbox/health", {
        signal: AbortSignal.timeout(5_000),
        headers: { [TOKEN_HEADER]: await this.serverToken() },
      });
      await response.body?.cancel();
      return "up";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (NOT_STARTED.test(message)) return "down";
      return "unknown";
    }
  }

  /**
   * A snapshot failed, so the container keeps running: stopping it now would
   * lose every change since it woke. Try again later (doubling, never giving
   * up), and push the container's inactivity stop past the next try.
   */
  private async snapshotFailed(err: unknown): Promise<void> {
    const failures = ((await this.ctx.storage.get<number>("snapshotFailures")) ?? 0) + 1;
    const delay = Math.min(SNAPSHOT_RETRY_BASE_MS * 2 ** (failures - 1), SNAPSHOT_RETRY_MAX_MS);
    const last = (await this.ctx.storage.get<number>("lastActivity")) ?? Date.now();
    // The alarm loop tries again at this time, keeping the object (and so the container) alive meanwhile.
    await this.ctx.storage.put({ snapshotFailures: failures, snapshotRetryAt: Date.now() + delay });
    // Counted from now or from the last activity, it outlasts the next try either way.
    if (this.container().running) await this.container().setInactivityTimeout(Date.now() - last + delay + INACTIVITY_MARGIN_MS);
    console.error(
      JSON.stringify({
        sandbox: "SNAPSHOT FAILED: the container keeps running until a snapshot succeeds",
        failures,
        retryInMs: delay,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  /** Snapshot the disk, then stop the container. */
  private async sleep(reason: string): Promise<void> {
    const c = this.container();
    const snapshot = await c.snapshotContainer({ name: `${reason}-${Date.now()}` });
    // Under the image this container runs, which after a restore is the
    // snapshot's, whatever the deployment's image is now.
    const image = (await this.ctx.storage.get<string>("runningImage")) ?? c.images.sandbox;
    if (image !== c.images.sandbox) {
      console.log(JSON.stringify({ sandbox: "snapshot of a container on an older image", image, deployed: c.images.sandbox }));
    }
    const record: SnapshotRecord = { id: snapshot.id, image, at: new Date().toISOString() };
    const taken = (await this.ctx.storage.get<SnapshotRecord[]>("snapshots")) ?? [];
    // Every snapshot is recorded: they are deltas on one another, so erasure
    // deletes them all (opt-in), and nothing deletes one while the sandbox lives.
    await this.ctx.storage.put({ snapshot: record, snapshots: [...taken, record] });
    await this.ctx.storage.delete(["snapshotFailures", "snapshotRetryAt"]);
    await this.destroy(reason);
    this.ready = false;
  }

  /**
   * Destroy the container and wait until it reports that it stopped. Right
   * after destroy() it can still report running, and a call that trusted
   * that (applying egress rules, a start) failed with "The container has not
   * been started" (seen live after an erasure).
   */
  private async destroy(reason: string, { settle = false } = {}): Promise<void> {
    this.stopping = true;
    try {
      await this.container().destroy(reason);
      await this.stopped();
      await this.ctx.storage.delete("containerUp");
      // After a failed start, give the platform a moment before the next start.
      if (settle) await this.ctx.storage.put("settleUntil", Date.now() + this.settleMs);
    } finally {
      this.stopping = false;
      this.generation++;
    }
  }

  private async stopped(): Promise<void> {
    const c = this.container();
    for (const deadline = Date.now() + STOP_TIMEOUT_MS; c.running && Date.now() < deadline; ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Delete snapshots from the registry; returns the ids that are gone (or can never be deleted). */
  private async deleteFromRegistry(options: SnapshotDeletionOptions, snapshots: SnapshotRecord[]): Promise<Set<string>> {
    const registry = new SnapshotRegistry(options);
    const gone = new Set<string>();
    for (const [image, records] of groupBy(snapshots, (s) => s.image)) {
      const repository = imageRepository(image, options.accountId);
      if (!repository) {
        console.warn(`[sandbox] can't tell the registry repository of image "${image}"; its snapshots expire on their own`);
        for (const r of records) gone.add(r.id);
        continue;
      }
      try {
        const result = await registry.delete(repository, records.map((r) => r.id));
        console.log(JSON.stringify({ sandbox: "snapshots deleted", ...result }));
        for (const r of records) gone.add(r.id);
      } catch (err) {
        console.warn(`[sandbox] deleting snapshots failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return gone;
  }

  private async touch(options: ContainerSandboxOptions): Promise<void> {
    await this.ctx.storage.put({ lastActivity: Date.now(), idleMs: options.idleMs });
    // The alarm loop keeps this object alive while the container runs; start it if it isn't going.
    if (!this.keepingAlive && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  private container(): Container {
    if (!this.ctx.container) throw new Error("ContainerSandbox: this Durable Object has no container (check wrangler.jsonc)");
    return this.ctx.container;
  }

  /** Start the container unless it is ready; true when this call started it. */
  private async ensureStarted(options: ContainerSandboxOptions): Promise<boolean> {
    if (this.container().running && this.ready) return false;
    return this.serial(() => this.readyLocked(options));
  }

  /** ensureStarted's work, run in the lifecycle queue. */
  /**
   * ensureStarted's work, in the lifecycle queue. A start that meets a
   * container still going away (after a failed start, an erasure, a stop by
   * the runtime) or loses its connection is tried again, up to
   * START_ATTEMPTS in all: each waits for the old container to be down and
   * settled first. All of it within one budget, so a call can't hang.
   */
  private async readyLocked(options: ContainerSandboxOptions): Promise<boolean> {
    const deadline = Date.now() + this.startTimeoutMs + 30_000;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.settled(deadline);
        return await this.readyOnce(options, Math.min(this.startTimeoutMs, deadline - Date.now()));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!START_RETRYABLE.test(message) || attempt >= START_ATTEMPTS || Date.now() > deadline - 5_000) throw err;
        console.warn(`[sandbox] start attempt ${attempt} failed (${message}); trying again once the old container is down`);
        this.ready = false;
        const c = this.container();
        if (c.running) await this.destroy("start failed", { settle: true }).catch(() => undefined);
        else await this.ctx.storage.put("settleUntil", Date.now() + Math.min(this.settleMs, 2_000 * attempt));
      }
    }
  }

  /** Wait until the last container is down and any settle time after a failed start has passed. */
  private async settled(deadline: number): Promise<void> {
    await this.stopped();
    const until = (await this.ctx.storage.get<number>("settleUntil")) ?? 0;
    const wait = Math.min(until, deadline - 5_000) - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (until) await this.ctx.storage.delete("settleUntil");
  }

  private async readyOnce(options: ContainerSandboxOptions, budgetMs = this.startTimeoutMs): Promise<boolean> {
    const c = this.container();
    if (!c.running) {
      await this.noticeLostContainer("start");
      // Indexed on every start, so a sandbox made again after an erasure is found by the next one.
      await this.ctx.storage.put("unindexed", true);
      await this.start(options, budgetMs);
      return true;
    }
    if (!this.ready) {
      // Running, but this object was reloaded (its intercepts may be gone), or
      // a start failed after the server came up: apply the rules and the env.
      await this.intercept(options);
      await this.restoreEnv();
      this.ready = true;
    }
    return false;
  }

  /**
   * Options every start and restore needs (a restore doesn't inherit them):
   * size, no internet of its own, the entrypoint, the CA variables, and a new
   * token for the sandbox server, so only this object can call it.
   */
  private async startOptions(options: ContainerSandboxOptions) {
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
    await this.ctx.storage.put("serverToken", token);
    return {
      instance: options.instance as ContainerStartupOptions["instance"],
      enableInternet: false,
      entrypoint: ENTRYPOINT,
      // Env set through the server stays in its memory (never in a snapshot);
      // this object keeps it and applies it again after each start.
      // Every name resolves to the egress interceptor's placeholder address
      // here, so the browser learns it and leaves address checks to the
      // egress handler (SandboxEgress refuses local and private targets).
      // The browser imports the egress CA into Chromium's own store from SANDBOX_EGRESS_CA.
      env: {
        ...CA_ENV,
        SANDBOX_SERVER_TOKEN: token,
        SANDBOX_ENV_FILE: "memory",
        SANDBOX_EGRESS_PLACEHOLDERS: "probe",
        SANDBOX_EGRESS_CA: RUNTIME_CA,
      },
    };
  }

  /** Keep the env vars the gateway sets (the whole set), to apply again after a restart. */
  private async rememberEnv(body: string): Promise<void> {
    try {
      const vars = (JSON.parse(body) as { vars?: Record<string, string> }).vars;
      if (vars && typeof vars === "object") await this.ctx.storage.put("env", vars);
    } catch {
      // Not JSON: the server refuses it anyway.
    }
  }

  /** Apply the remembered env to a freshly started server (it holds env in memory only). */
  private async restoreEnv(): Promise<void> {
    const vars = await this.ctx.storage.get<Record<string, string>>("env");
    if (!vars || Object.keys(vars).length === 0) return;
    const response = await this.container().getTcpPort(SERVER_PORT).fetch("http://sandbox/env", {
      method: "POST",
      body: JSON.stringify({ vars }),
      headers: { "content-type": "application/json", [TOKEN_HEADER]: await this.serverToken() },
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`sandbox env could not be restored: HTTP ${response.status}`);
  }

  /** The current sandbox server token (kept in storage, so a reloaded object still has it). */
  private async serverToken(): Promise<string> {
    return (await this.ctx.storage.get<string>("serverToken")) ?? "";
  }

  private async start(options: ContainerSandboxOptions, budgetMs = this.startTimeoutMs): Promise<void> {
    const c = this.container();
    const image = c.images.sandbox;
    const snapshot = await this.ctx.storage.get<SnapshotRecord>("snapshot");
    const common = await this.startOptions(options);

    if (snapshot && snapshot.image !== image) {
      await this.upgradeImage(snapshot, options);
      return;
    }
    // A snapshot carries its own image: `image` and `containerSnapshot` are mutually exclusive.
    await this.ctx.storage.put("runningImage", snapshot ? snapshot.image : image);
    c.start(snapshot ? { ...common, containerSnapshot: { id: snapshot.id } } : { ...common, image });
    await this.afterStart(options, snapshot ? "restore" : "fresh", budgetMs);
  }

  /**
   * The deployed image changed since the snapshot. A rootfs snapshot carries
   * its whole OS, so restoring it means the old image whatever the start
   * asks for: only the files can move.
   *
   * 1. Restore the old snapshot.
   * 2. Stream /mnt/data out of it as a tar (the server's GET /archive) into
   *    this object's storage, in chunks; one Durable Object has one
   *    container, so the two can't run side by side.
   * 3. Stop it, start fresh on the new image, stream the tar in (POST /archive).
   * 4. Snapshot it at once: a new chain, on the new image.
   *
   * Env vars (in the server's memory, applied again by afterStart) and
   * credentials (egress rules) don't travel in the tar. Until step 4 the old
   * snapshot stays current, so a failure anywhere restores it again and
   * nothing is lost; the upgrade is tried again a day later, and logged.
   * The old chain is no longer restored: it expires (30 days) or goes with
   * an erasure.
   */
  private async upgradeImage(snapshot: SnapshotRecord, options: ContainerSandboxOptions): Promise<void> {
    const c = this.container();
    const target = c.images.sandbox;
    await this.restoreOld(snapshot, options, "restore (image upgrade)");
    const blocked = await this.ctx.storage.get<{ from: string; to: string; at: number; reason: string }>("upgradeBlocked");
    if (blocked && blocked.from === snapshot.image && blocked.to === target && Date.now() - blocked.at < UPGRADE_RETRY_MS) {
      console.warn(JSON.stringify({ sandbox: "image upgrade skipped: it failed recently", from: snapshot.image, to: target, reason: blocked.reason }));
      return;
    }
    const began = Date.now();
    try {
      const bytes = await this.saveArchive();
      await this.destroy("image upgrade");
      this.ready = false;
      await this.ctx.storage.put("runningImage", target);
      c.start({ ...(await this.startOptions(options)), image: target });
      await this.afterStart(options, "fresh (image upgrade)");
      await this.loadArchive();
      const fresh = await c.snapshotContainer({ name: `upgrade-${Date.now()}` });
      const record: SnapshotRecord = { id: fresh.id, image: target, at: new Date().toISOString() };
      const taken = (await this.ctx.storage.get<SnapshotRecord[]>("snapshots")) ?? [];
      await this.ctx.storage.put({ snapshot: record, snapshots: [...taken, record] });
      await this.ctx.storage.delete("upgradeBlocked");
      console.log(JSON.stringify({ sandbox: "image upgraded", from: snapshot.image, to: target, bytes, ms: Date.now() - began }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ sandbox: "IMAGE UPGRADE FAILED: staying on the old image", from: snapshot.image, to: target, reason }));
      await this.ctx.storage.put("upgradeBlocked", { from: snapshot.image, to: target, at: Date.now(), reason });
      // The old snapshot is still current: run it again if the new container took its place.
      if ((await this.ctx.storage.get<string>("runningImage")) !== snapshot.image || !c.running) {
        if (c.running) await this.destroy("image upgrade failed");
        this.ready = false;
        await this.restoreOld(snapshot, options, "restore (image upgrade failed)");
      }
    } finally {
      await this.dropArchive();
    }
  }

  private async restoreOld(snapshot: SnapshotRecord, options: ContainerSandboxOptions, kind: string): Promise<void> {
    await this.ctx.storage.put("runningImage", snapshot.image);
    this.container().start({ ...(await this.startOptions(options)), containerSnapshot: { id: snapshot.id } });
    await this.afterStart(options, kind);
  }

  /** Stream the running container's /mnt/data archive into storage; its size in bytes. */
  private async saveArchive(): Promise<number> {
    const response = await this.container().getTcpPort(SERVER_PORT).fetch("http://sandbox/archive", {
      headers: { [TOKEN_HEADER]: await this.serverToken() },
    });
    if (!response.ok || !response.body) throw new Error(`archiving /mnt/data failed: HTTP ${response.status}`);
    const reader = response.body.getReader();
    let chunks = 0;
    let total = 0;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (pendingBytes === 0) return;
      const chunk = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const part of pending) {
        chunk.set(part, offset);
        offset += part.byteLength;
      }
      await this.ctx.storage.put(`upgrade:${chunks++}`, chunk);
      pending = [];
      pendingBytes = 0;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > UPGRADE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`/mnt/data is larger than ${UPGRADE_MAX_BYTES / 1024 ** 3} GiB compressed, too large to move`);
      }
      pending.push(value);
      pendingBytes += value.byteLength;
      if (pendingBytes >= UPGRADE_CHUNK_BYTES) await flush();
    }
    await flush();
    await this.ctx.storage.put("upgrade:chunks", chunks);
    return total;
  }

  /** Stream the stored archive into the running container's /mnt/data. */
  private async loadArchive(): Promise<void> {
    const chunks = (await this.ctx.storage.get<number>("upgrade:chunks")) ?? 0;
    let next = 0;
    const storage = this.ctx.storage;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (next >= chunks) return controller.close();
        controller.enqueue((await storage.get<Uint8Array>(`upgrade:${next++}`)) ?? new Uint8Array(0));
      },
    });
    const response = await this.container().getTcpPort(SERVER_PORT).fetch("http://sandbox/archive", {
      method: "POST",
      body,
      headers: { "content-type": "application/gzip", [TOKEN_HEADER]: await this.serverToken() },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`unpacking /mnt/data failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }

  private async dropArchive(): Promise<void> {
    const keys = [...(await this.ctx.storage.list({ prefix: "upgrade:" })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
  }

  private async afterStart(options: ContainerSandboxOptions, kind: string, budgetMs = this.startTimeoutMs): Promise<void> {
    const c = this.container();
    const started = Date.now();
    const phase = (name: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ sandbox: "start", kind, phase: name, ms: Date.now() - started, ...extra }));
    const generation = ++this.generation;
    // Any stop this object didn't ask for loses the disk since the last
    // snapshot: say so loudly, whether the container exited or was killed.
    const exited = async (err?: unknown) => {
      if (this.stopping || generation !== this.generation) return;
      // A monitor that loses its connection hasn't seen a stop: ask the container.
      if ((await this.containerState()) !== "down") {
        console.warn(JSON.stringify({ sandbox: "monitor ended, but the container isn't known to have stopped", kind, error: err instanceof Error ? err.message : String(err ?? "exited") }));
        return;
      }
      this.ready = false;
      // Reported once: here if this invocation is still around to see it, else by the next alarm or start.
      if (!(await this.ctx.storage.get("containerUp"))) return;
      await this.ctx.storage.delete("containerUp");
      console.error(
        JSON.stringify({
          sandbox: "CONTAINER STOPPED WITHOUT A SNAPSHOT",
          kind,
          ranMs: Date.now() - started,
          error: err === undefined ? "exited" : err instanceof Error ? err.message : String(err),
        }),
      );
    };
    this.ctx.waitUntil(c.monitor().then(() => exited(), exited));
    // The whole start is bounded: a start stuck on Cloudflare's side (seen
    // live: 8 minutes waiting to apply egress rules) fails the call instead.
    const deadline = started + budgetMs;
    const intercepting = Date.now();
    const intercepted = await withTimeout(this.intercept(options), budgetMs);
    if (!intercepted) {
      phase("timed out applying egress rules");
      await this.destroy("start timed out", { settle: true }).catch(() => undefined);
      this.ready = false;
      throw new Error(`The sandbox didn't start within ${this.startTimeoutMs / 1000} s (Cloudflare was slow to place it). Try again.`);
    }
    // On a machine without the image yet, this waits for the image pull and boot.
    phase("intercepted", { interceptMs: Date.now() - intercepting });
    // A backstop if an alarm is missed; the alarm normally stops it first.
    await c.setInactivityTimeout(options.idleMs + INACTIVITY_MARGIN_MS);
    let lastError = "no answer";
    while (Date.now() < deadline) {
      try {
        const response = await c.getTcpPort(SERVER_PORT).fetch("http://sandbox/health", {
          signal: AbortSignal.timeout(2000),
          headers: { [TOKEN_HEADER]: await this.serverToken() },
        });
        if (response.ok) {
          await this.restoreEnv();
          // Up until this object stops it; if it vanishes instead, the marker says so later.
          await this.ctx.storage.put("containerUp", { since: started, kind });
          this.ready = true;
          phase("ready");
          return;
        }
        lastError = `HTTP ${response.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // The container is gone (it met an old one going away): fail now, so the start is tried again.
        if (START_RETRYABLE.test(lastError) && (await this.containerState()) === "down") throw err;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    phase(`timed out: ${lastError}`);
    await this.destroy("start timed out", { settle: true }).catch(() => undefined);
    this.ready = false;
    throw new Error(`The sandbox didn't start within ${this.startTimeoutMs / 1000} s (${lastError}). Try again.`);
  }

  /** Send all of the container's HTTP and HTTPS to the egress handler, with current rules. */
  private async intercept(options: ContainerSandboxOptions): Promise<void> {
    const props: SandboxEgressProps = {
      allowHosts: options.allowHosts,
      internet: options.internet,
      credentials: (await this.ctx.storage.get<EgressCredential[]>("credentials")) ?? [],
    };
    const exports = this.ctx.exports as unknown as Record<string, (opts: { props: SandboxEgressProps }) => Fetcher>;
    if (typeof exports.SandboxEgress !== "function") {
      throw new Error("ContainerSandbox: export SandboxEgress from the worker entry (it handles the sandbox's egress)");
    }
    const policy = exports.SandboxEgress({ props });
    const c = this.container();
    try {
      await c.interceptOutboundHttps("*", policy);
      await c.interceptAllOutboundHttp(policy);
    } catch (err) {
      // Half-applied rules (new ones on HTTPS, old ones on HTTP) could keep a
      // revoked credential alive: fail closed, and let the next call start over.
      this.ready = false;
      await this.destroy("egress rules could not be applied", { settle: true }).catch(() => undefined);
      throw err;
    }
  }
}

/** Whether `work` finished within `ms` (it keeps running if not; its failure then is ignored). */
async function withTimeout(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  work.catch(() => undefined);
  try {
    return await Promise.race([work.then(() => true as const), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Log a request that took longer than SLOW_REQUEST_MS, counting until its
 * response body is done: the Durable Object call lasts until then, which can
 * be long after the response's headers.
 */
function slowLogged(response: Response, request: SandboxServerRequest, began: number): Response {
  const log = (phase: string) => {
    const ms = Date.now() - began;
    if (ms > SLOW_REQUEST_MS) console.log(JSON.stringify({ sandbox: "slow request", path: request.path, program: programOf(request), phase, ms }));
  };
  if (!response.body) {
    log("done");
    return response;
  }
  let logged = false;
  const once = (phase: string) => {
    if (!logged) log(phase);
    logged = true;
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush: () => once("body done"),
    }),
  );
  // A caller that stops reading cancels the body; that ends the call too.
  const reader = body.getReader();
  const watched = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      once("body cancelled");
      return reader.cancel(reason);
    },
  });
  return new Response(watched, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** The program a request runs, for the slow-request log: never its arguments. */
function programOf(request: SandboxServerRequest): string | undefined {
  if (request.path !== "/exec" || !request.body) return undefined;
  try {
    const words = String((JSON.parse(request.body) as { command?: string }).command ?? "").trim().split(/\s+/);
    return words[0] === "afe-browser" ? words.slice(0, 2).join(" ") : words[0]?.slice(0, 40);
  } catch {
    return undefined;
  }
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

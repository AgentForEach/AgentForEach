/**
 * One durable instance (a job, a wait or an alarm), run by one Durable
 * Object: its record and input live in the object's storage, and the
 * object's alarm drives it.
 *
 * - A job: `start` stores it and sets the alarm for now; the alarm runs it.
 * - A wait: the alarm runs `start`, then sleeps until the timeout; `signal`
 *   stores the event and sets the alarm for now; the alarm runs `onEvent`,
 *   or `onTimeout` once the timeout passed without one.
 * - An alarm: each alarm runs a tick and sets the alarm for the time the
 *   tick returned (or now, if `wake` came during the tick).
 *
 * Handler failures mark the instance failed; they are never thrown out of
 * the alarm, so Cloudflare doesn't retry them. An alarm cut off mid-way
 * (eviction, deploy) is retried by Cloudflare, so handlers run at least once,
 * as the port allows. A failure in the engine's own bookkeeping re-arms the
 * alarm with backoff, and an instance that is active with no alarm and no
 * progress for `staleMs` counts as dead, so nothing stays stuck.
 *
 * A finished instance keeps no input: its input (and a wait's answer) is
 * deleted when it finishes, and the whole object is cleared `retentionMs`
 * later, as Azure purges finished orchestrations.
 *
 * Runtime-free: the Durable Object passes its storage in, so the engine runs
 * (and passes the conformance suite) in Node too.
 */

import { openScope } from "@agentforeach/platform";
import type {
  DurableContext,
  DurableRegistry,
  DurableStatus,
  EnsureResult,
  InstanceInfo,
  StartResult,
} from "@agentforeach/platform";

/** The parts of `DurableObjectStorage` the engine uses. */
export interface InstanceStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

type InstanceType = "job" | "wait" | "alarm";

interface InstanceRecord {
  id: string;
  type: InstanceType;
  kind: string;
  status: DurableStatus;
  createdAt: number;
  updatedAt: number;
  /** Bumped on every (re)start, so a finishing run can tell it was replaced. */
  generation: number;
  /** Input chunks stored under `input:<generation>:<n>`. */
  inputChunks: number;
  /** Wait: epoch ms of the timeout. */
  timeoutAt?: number;
  /** Wait: the start handler has run. */
  waiting?: boolean;
  /** Wait: the event, once delivered. */
  event?: { name: string; payload: unknown };
  /** Alarm: a tick is running. */
  ticking?: boolean;
  /** Alarm: woken while ticking. */
  wokenDuringTick?: boolean;
  /** Bookkeeping failures in a row (see `retryLater`). */
  failures?: number;
  /** Runs of the handler so far (a job's run, a wait's onEvent/onTimeout); see `DurableContext.attempt`. */
  attempts?: number;
  /** Wait: its onEvent or onTimeout is running, so the outcome is decided and signals are refused. */
  firing?: boolean;
  /**
   * The handler's result, once it returned. An alarm that re-enters after a
   * bookkeeping failure finishes with it instead of running the handler again
   * (which would count as a re-run).
   */
  handlerOk?: boolean;
}

const RECORD = "record";
/** Storage values are capped (2 MB on SQLite-backed objects); inputs are stored in chunks below that. */
const CHUNK_CHARS = 512 * 1024;

function active(status: DurableStatus | undefined): boolean {
  return status === "pending" || status === "running";
}

export interface EngineOptions {
  /** Where handler logs go. Default: console. */
  logger?: Pick<Console, "log" | "warn" | "error" | "debug">;
  /** Clock; replaceable in tests. */
  now?: () => number;
  /** How long a finished instance is kept before its object is cleared. Default 1 hour. */
  retentionMs?: number;
  /**
   * An active instance with no pending alarm and no progress for this long
   * is dead. Longer than an alarm handler may run (15 min). Default 20 min.
   */
  staleMs?: number;
  /** First bookkeeping retry delay; it doubles each time. Default 2 s. */
  retryBaseMs?: number;
}

/** Bookkeeping retries before an instance is marked failed. */
const MAX_FAILURES = 5;

export class DurableInstanceEngine {
  private readonly logger: Pick<Console, "log" | "warn" | "error" | "debug">;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly staleMs: number;
  private readonly retryBaseMs: number;

  constructor(
    private readonly storage: InstanceStorage,
    private readonly registry: DurableRegistry,
    options: EngineOptions = {},
  ) {
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? 60 * 60 * 1000;
    this.staleMs = options.staleMs ?? 20 * 60 * 1000;
    this.retryBaseMs = options.retryBaseMs ?? 2000;
  }

  // --------------------------------------------------------------------------
  // Operations (the Durable Object's RPC methods)
  // --------------------------------------------------------------------------

  async start(id: string, type: InstanceType, kind: string, input: unknown, timeoutMs?: number): Promise<StartResult> {
    if (type === "job") this.registry.job(kind);
    else if (type === "wait") this.registry.wait(kind);
    else this.registry.alarm(kind);
    const previous = await this.record();
    if (previous && (await this.live(previous))) return { started: false };

    const now = this.now();
    const generation = (previous?.generation ?? 0) + 1;
    const json = JSON.stringify(input ?? null);
    const chunks: Record<string, unknown> = {};
    let count = 0;
    for (let i = 0; i < json.length || count === 0; i += CHUNK_CHARS) chunks[`input:${generation}:${count++}`] = json.slice(i, i + CHUNK_CHARS);
    const record: InstanceRecord = {
      id,
      type,
      kind,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      generation,
      inputChunks: count,
      ...(type === "wait" ? { timeoutAt: now + Math.max(0, timeoutMs ?? 0) } : {}),
    };
    if (previous) await this.storage.delete(this.inputKeys(previous));
    await this.storage.put({ ...chunks, [RECORD]: record });
    await this.storage.setAlarm(now);
    return { started: true };
  }

  async signal(event: string, payload: unknown): Promise<boolean> {
    const record = await this.record();
    if (!record || record.type !== "wait" || !(await this.live(record))) return false;
    // Too late: the wait is already concluding (or past its timeout, about to).
    if (record.firing || (record.waiting && !record.event && this.now() >= (record.timeoutAt ?? 0))) return false;
    if (event !== this.registry.wait(record.kind).event || record.event) return true;
    await this.save({ ...record, event: { name: event, payload } });
    if (record.waiting) await this.storage.setAlarm(this.now());
    return true;
  }

  async ensureAlarm(id: string, kind: string, input: unknown): Promise<EnsureResult> {
    const record = await this.record();
    if (record?.status === "suspended") return "suspended";
    if (record && (await this.live(record))) return "running";
    return (await this.start(id, "alarm", kind, input)).started ? "started" : "running";
  }

  async wake(): Promise<boolean> {
    const record = await this.record();
    if (!record || record.type !== "alarm" || !(await this.live(record))) return false;
    if (record.ticking) await this.save({ ...record, wokenDuringTick: true });
    else await this.storage.setAlarm(this.now());
    return true;
  }

  async terminate(): Promise<void> {
    const record = await this.record();
    if (!record || !(active(record.status) || record.status === "suspended")) return;
    await this.storage.delete(this.inputKeys(record));
    await this.save({ ...record, status: "terminated", inputChunks: 0, event: undefined, ticking: false });
    await this.storage.setAlarm(this.now() + this.retentionMs);
  }

  async status(): Promise<InstanceInfo | null> {
    const record = await this.record();
    if (!record) return null;
    return { status: record.status, createdAt: new Date(record.createdAt), updatedAt: new Date(record.updatedAt) };
  }

  // --------------------------------------------------------------------------
  // The Durable Object's alarm
  // --------------------------------------------------------------------------

  async alarm(): Promise<void> {
    const record = await this.record();
    if (!record) return;
    if (!active(record.status)) return this.expire(record);
    try {
      if (record.type === "job") await this.runJob(record);
      else if (record.type === "wait") await this.runWait(record);
      else await this.runAlarm(record);
    } catch (err) {
      await this.retryLater(record.generation, err);
    }
  }

  /** Clear a finished instance once its retention has passed; until then, sleep until it does. */
  private async expire(record: InstanceRecord): Promise<void> {
    const due = record.updatedAt + this.retentionMs;
    if (this.now() >= due) await this.storage.deleteAll();
    else await this.storage.setAlarm(due);
  }

  /**
   * The engine's own bookkeeping failed (storage, a bad input): try again
   * later with backoff, and give up (failed) after MAX_FAILURES. Never
   * throws, so Cloudflare's own alarm retries don't run out on us.
   */
  private async retryLater(generation: number, cause: unknown): Promise<void> {
    this.logger.error(`[durable] alarm bookkeeping failed; retrying later:`, cause);
    try {
      const record = await this.record();
      if (!record || record.generation !== generation || !active(record.status)) return;
      const failures = (record.failures ?? 0) + 1;
      if (failures >= MAX_FAILURES) return this.finish(generation, false);
      await this.save({ ...record, failures, ticking: false });
      await this.storage.setAlarm(this.now() + this.retryBaseMs * 2 ** (failures - 1));
    } catch (err) {
      this.logger.error(`[durable] could not schedule a retry:`, err);
    }
  }

  /**
   * Whether an active instance is still alive: it has an alarm pending, or it
   * made progress within `staleMs` (a handler is running). One that has
   * neither can never run again, so it's treated as finished.
   */
  private async live(record: InstanceRecord): Promise<boolean> {
    if (!active(record.status)) return false;
    if (this.now() - record.updatedAt < this.staleMs) return true;
    return (await this.storage.getAlarm()) !== null;
  }

  private async runJob(record: InstanceRecord): Promise<void> {
    if (record.handlerOk !== undefined) return this.finish(record.generation, record.handlerOk);
    // A job that is already "running" here was cut off (Cloudflare re-runs an
    // interrupted alarm from the start): count the attempt so it can tell.
    // Read the input first: a read that fails is retried, and mustn't count.
    const input = await this.input(record);
    const attempt = (record.attempts ?? 0) + 1;
    await this.save({ ...record, status: "running", attempts: attempt });
    const ok = await this.step(record, "job", (ctx) => this.registry.job(record.kind).run(input, ctx), attempt);
    await this.handlerReturned(record.generation, ok);
    await this.finish(record.generation, ok);
  }

  /** Record that the handler returned, so a retried finish doesn't run it again. */
  private async handlerReturned(generation: number, ok: boolean): Promise<void> {
    const record = await this.record();
    if (record && record.generation === generation && active(record.status)) await this.save({ ...record, handlerOk: ok });
  }

  private async runWait(record: InstanceRecord): Promise<void> {
    const definition = this.registry.wait(record.kind);
    const input = await this.input(record);
    if (!record.waiting) {
      await this.save({ ...record, status: "running" });
      if (definition.start && !(await this.step(record, "job", (ctx) => definition.start!(input, ctx)))) {
        return this.finish(record.generation, false);
      }
      const after = await this.record();
      if (!after || after.generation !== record.generation || !active(after.status)) return;
      record = { ...after, waiting: true };
      await this.save(record);
    }
    if (!record.event && this.now() < (record.timeoutAt ?? 0)) {
      await this.storage.setAlarm(record.timeoutAt!);
      return;
    }
    if (record.handlerOk !== undefined) return this.finish(record.generation, record.handlerOk);
    // The outcome is decided: mark it (which also shows the instance is alive
    // while the handler runs) before running the handler.
    const attempt = (record.attempts ?? 0) + 1;
    await this.save({ ...record, firing: true, attempts: attempt });
    const payload = record.event?.payload;
    const ok = record.event
      ? await this.step(record, "job", (ctx) => definition.onEvent(input, payload, ctx), attempt)
      : await this.step(record, "job", (ctx) => definition.onTimeout(input, ctx), attempt);
    await this.handlerReturned(record.generation, ok);
    return this.finish(record.generation, ok);
  }

  private async runAlarm(record: InstanceRecord): Promise<void> {
    await this.save({ ...record, status: "running", ticking: true, wokenDuringTick: false });
    const input = await this.input(record);
    let next = this.now();
    const ok = await this.step(record, "alarm", async (ctx) => {
      next = await this.registry.alarm(record.kind).tick(input, ctx);
    });
    const after = await this.record();
    if (!after || after.generation !== record.generation || !active(after.status)) return;
    if (!ok) return this.finish(record.generation, false);
    await this.save({ ...after, ticking: false, wokenDuringTick: false });
    await this.storage.setAlarm(after.wokenDuringTick ? this.now() : Math.max(next, this.now()));
  }

  // --------------------------------------------------------------------------

  private async record(): Promise<InstanceRecord | undefined> {
    return this.storage.get<InstanceRecord>(RECORD);
  }

  private async save(record: InstanceRecord): Promise<void> {
    await this.storage.put({ [RECORD]: { ...record, updatedAt: this.now() } });
  }

  private inputKeys(record: InstanceRecord): string[] {
    return Array.from({ length: record.inputChunks }, (_, i) => `input:${record.generation}:${i}`);
  }

  private async input(record: InstanceRecord): Promise<unknown> {
    let json = "";
    for (const key of this.inputKeys(record)) json += (await this.storage.get<string>(key)) ?? "";
    return JSON.parse(json || "null");
  }

  /**
   * Mark the run finished, unless it was terminated or replaced meanwhile.
   * Its input and any answer are deleted now; the object is cleared after
   * `retentionMs`.
   */
  private async finish(generation: number, ok: boolean): Promise<void> {
    const record = await this.record();
    if (!record || record.generation !== generation || !active(record.status)) return;
    await this.storage.delete(this.inputKeys(record));
    await this.save({
      ...record,
      status: ok ? "completed" : "failed",
      ticking: false,
      inputChunks: 0,
      event: undefined,
      failures: undefined,
      firing: false,
    });
    await this.storage.setAlarm(this.now() + this.retentionMs);
  }

  /** Run one handler in its own scope, awaiting its background work; true when it succeeded. */
  private async step(
    record: InstanceRecord,
    kind: "job" | "alarm",
    run: (ctx: DurableContext) => Promise<void>,
    attempt = 1,
  ): Promise<boolean> {
    const invocationId = crypto.randomUUID();
    const l = this.logger;
    const ctx: DurableContext = {
      instanceId: record.id,
      invocationId,
      attempt,
      log: (...a) => l.log(...a),
      warn: (...a) => l.warn(...a),
      error: (...a) => l.error(...a),
      trace: (...a) => l.debug(...a),
    };
    const opened = openScope({ invocationId, kind });
    try {
      await opened.run(() => run(ctx));
      return true;
    } catch (err) {
      ctx.error(`[durable] ${record.type} ${record.kind} ${record.id} failed:`, err);
      return false;
    } finally {
      await opened.settle();
    }
  }
}

/**
 * AgentForEach Skills Layer — ACA Sandboxes Client (primary backend)
 *
 * REST client for Azure Container Apps Sandboxes (Microsoft.App/sandboxGroups).
 * Each user (or conversation, per identifierStrategy) gets one sandbox: a
 * microVM with its own kernel. It auto-suspends when idle, which snapshots
 * its disk (or disk + memory), and is resumed on the next sandbox tool call.
 * Files in /mnt/data therefore survive idle periods, unlike Dynamic Sessions,
 * where the session is destroyed after cooldown.
 *
 * Sandboxes are found by label, so no extra state store is needed:
 *   agentforeach-owner = sha256(identifier)[0..32]   one sandbox per owner
 *   agentforeach-user  = sha256(userId)[0..32]       all of a user's sandboxes
 * Hashes keep user ids out of Azure resource labels. Ownership is checked
 * strictly (fail closed) on every lookup and on every state read.
 *
 * Data plane (api-version 2026-02-01-preview, audience dynamicsessions.io):
 *   base = {endpoint}/subscriptions/{sub}/resourceGroups/{rg}/sandboxGroups/{group}
 *   GET    {base}/sandboxes?labels=k=v              list (value[] + nextLink)
 *   PUT    {base}/sandboxes                          create
 *   GET    {base}/sandboxes/{id}                     state
 *   POST   {base}/sandboxes/{id}/resume              resume a stopped sandbox
 *   POST   {base}/sandboxes/{id}/lifecycle           replaces the whole lifecycle policy
 *   POST   {base}/sandboxes/{id}/egresspolicy        replaces the whole egress policy
 *   POST   {base}/sandboxes/{id}/executeShellCommand {command} → {exitCode, stdout, stderr}
 *   PUT    {base}/sandboxes/{id}/files?path=&createDirs=true   (octet-stream body)
 *   GET    {base}/sandboxes/{id}/files?path=
 *   GET    {base}/sandboxes/{id}/files/list?path=     → {entries[]}
 *   DELETE {base}/sandboxes/{id}
 *
 * The contract was taken from the azure-containerapps-sandbox Python SDK
 * (0.1.0b4), including its retry of 403s while a new role assignment
 * propagates. The service is in preview, so expect it to move.
 */

import { createHash } from "node:crypto";
import type {
  EgressCredential,
  SandboxBackend,
  SandboxConfig,
  AcaSandboxesConfig,
  SandboxExecArgs,
  SandboxExecResult,
  SandboxFileWriteArgs,
  SandboxFileWriteResult,
  SandboxFileReadArgs,
  SandboxFileReadResult,
  SandboxFileReadBinaryResult,
  SandboxFileInfo,
} from "./types.js";
import { createDefaultTokenProvider, type TokenProvider } from "../../utils/azure-token.js";
import { DATA_DIR, dataPath, DEFAULT_MAX_OUTPUT_CHARS, shellQuote, truncate } from "./shared.js";

// ============================================================================
// Constants
// ============================================================================

export const ACA_SANDBOXES_API_VERSION = "2026-02-01-preview";

const OWNER_LABEL = "agentforeach-owner";
const USER_LABEL = "agentforeach-user";
/** Exit code `timeout(1)` uses when it kills the command. */
const TIMEOUT_EXIT_CODE = 124;
/** Treat a sandbox as still running if it was used this recently. */
const ASSUME_RUNNING_MARGIN_MS = 30_000;
/** How long to keep retrying 403s while a role assignment propagates (SDK: ~60-100 s). */
const RBAC_PROPAGATION_BUDGET_MS = 90_000;
/** Attempts for throttling, timeouts and server errors. */
const MAX_TRANSIENT_ATTEMPTS = 4;

const ENV_FILE = '"${HOME:-/tmp}/.agentforeach/env"';

// ============================================================================
// Wire types
// ============================================================================

type WireSandbox = {
  id?: string;
  state?: string;
  stateDetails?: { stoppedReason?: string };
  createdAt?: string;
  labels?: Record<string, string>;
};

type WireSandboxList = WireSandbox[] | { value?: WireSandbox[]; nextLink?: string };

type WireExecResult = { exitCode?: number; stdout?: string; stderr?: string };

/**
 * The live service returns isDir / modifiedTime (Unix seconds); the SDK
 * models isDirectory / modifiedAt. Accept both.
 */
type WireDirListing = {
  entries?: Array<{
    name?: string;
    size?: number;
    isDir?: boolean;
    isDirectory?: boolean;
    modifiedTime?: number;
    modifiedAt?: string;
  }>;
};

export class AcaSandboxesHttpError extends Error {
  override name = "AcaSandboxesHttpError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The sandbox no longer exists (or is being deleted); a new one can be created. */
class SandboxGoneError extends Error {
  override name = "SandboxGoneError";
}

/**
 * How a request may be retried.
 * - "all":      safe to repeat (reads, idempotent writes).
 * - "rejected": only when the service refused it before acting (403 during
 *               RBAC propagation, 429). Used for exec, which must not run twice.
 */
type RetryMode = "all" | "rejected";

type RequestOptions = {
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: Buffer;
  contentType?: string;
  timeoutMs?: number;
  /** `path` is a full URL (a nextLink) rather than relative to the group. */
  absolute?: boolean;
  /** Statuses returned to the caller instead of thrown. */
  allowStatuses?: number[];
  retry?: RetryMode;
};

export type AcaSandboxesClientOptions = {
  tokenProvider?: TokenProvider;
  /** Poll interval while waiting for Running (default 250 ms). */
  pollIntervalMs?: number;
  /** Give up waiting for Running after this long (default 90 s). */
  readyTimeoutMs?: number;
  /** Base delay for retry backoff (default 1000 ms). */
  retryBaseMs?: number;
};

// ============================================================================
// Helpers
// ============================================================================

/** Stable, non-reversible label value. */
export function labelHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Identifiers are JSON so `user:with:colons` can't collide with a user + session pair. */
function encodeIdentifier(userId: string, sessionId?: string): string {
  return JSON.stringify(sessionId ? [userId, sessionId] : [userId]);
}

function userIdOf(identifier: string): string {
  const parsed = JSON.parse(identifier) as unknown;
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
    throw new Error("Invalid sandbox identifier");
  }
  return parsed[0];
}

/**
 * Wrap a user command: run in /mnt/data, load env vars from setEnv, and
 * enforce the timeout inside the sandbox so a runaway command can't hold
 * the HTTP call open.
 */
export function buildExecCommand(command: string, timeoutSec: number): string {
  return [
    `mkdir -p ${DATA_DIR} && cd ${DATA_DIR}`,
    `{ [ -f ${ENV_FILE} ] && . ${ENV_FILE}; true; }`,
    `timeout -k 5 ${Math.max(1, Math.floor(timeoutSec))} bash -c ${shellQuote(command)}`,
  ].join(" && ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 409 GlobalSandboxNotRunning: the sandbox isn't Running, so the call didn't run. */
function isNotRunning(err: unknown): boolean {
  return err instanceof AcaSandboxesHttpError && err.status === 409;
}

function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

// ============================================================================
// AcaSandboxesClient
// ============================================================================

export class AcaSandboxesClient implements SandboxBackend {
  private readonly config: SandboxConfig;
  private readonly sbx: AcaSandboxesConfig;
  private readonly tokenProvider: TokenProvider;
  private readonly pollIntervalMs: number;
  private readonly readyTimeoutMs: number;
  private readonly retryBaseMs: number;

  /** identifier → sandbox id, per Function instance. */
  private readonly sandboxIds = new Map<string, string>();
  /** identifier → in-flight lookup/create, so parallel tool calls share one. */
  private readonly resolving = new Map<string, Promise<string>>();
  /** sandbox id → last time we saw it running or used it. */
  private readonly lastActiveMs = new Map<string, number>();

  constructor(config: SandboxConfig, options: AcaSandboxesClientOptions = {}) {
    if (!config.sandboxes) {
      throw new Error("AcaSandboxesClient requires skills.sandbox.sandboxes config");
    }
    this.config = config;
    this.sbx = config.sandboxes;
    this.tokenProvider = options.tokenProvider ?? createDefaultTokenProvider();
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
  }

  // --------------------------------------------------------------------------
  // SandboxBackend
  // --------------------------------------------------------------------------

  async exec(args: SandboxExecArgs, sessionIdentifier: string): Promise<SandboxExecResult> {
    const timeoutSec = Math.min(args.timeout ?? this.sbx.defaultTimeoutSec, this.sbx.maxTimeoutSec);
    const maxChars = this.config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    const started = Date.now();

    const result = await this.withSandbox(sessionIdentifier, (id) =>
      this.json<WireExecResult>("POST", `/sandboxes/${id}/executeShellCommand`, {
        body: { command: buildExecCommand(args.command, timeoutSec) },
        timeoutMs: (timeoutSec + 20) * 1000,
        retry: "rejected",
      }),
    );

    const stdout = truncate(result.stdout ?? "", maxChars);
    const stderr = truncate(result.stderr ?? "", maxChars);
    // The SDK treats a missing exitCode as success.
    const exitCode = result.exitCode ?? 0;
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode,
      // A command can also exit 124 on its own; that is reported as a timeout too.
      timedOut: exitCode === TIMEOUT_EXIT_CODE,
      truncated: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - started,
      sessionId: sessionIdentifier,
    };
  }

  async fileWrite(
    args: SandboxFileWriteArgs,
    sessionIdentifier: string,
  ): Promise<SandboxFileWriteResult> {
    const content = Buffer.from(args.content, "utf-8");
    await this.withSandbox(sessionIdentifier, (id) =>
      this.send("PUT", `/sandboxes/${id}/files`, {
        query: { path: dataPath(args.filename), createDirs: "true" },
        rawBody: content,
        contentType: "application/octet-stream",
      }),
    );
    return {
      success: true,
      filename: args.filename,
      sizeBytes: content.byteLength,
      sessionId: sessionIdentifier,
    };
  }

  async fileRead(
    args: SandboxFileReadArgs,
    sessionIdentifier: string,
  ): Promise<SandboxFileReadResult> {
    const bytes = await this.readBytes(args.filename, sessionIdentifier);
    return {
      content: bytes.toString("utf-8"),
      filename: args.filename,
      sizeBytes: bytes.byteLength,
      sessionId: sessionIdentifier,
    };
  }

  async fileReadBinary(
    args: SandboxFileReadArgs,
    sessionIdentifier: string,
  ): Promise<SandboxFileReadBinaryResult> {
    const bytes = await this.readBytes(args.filename, sessionIdentifier);
    return {
      contentBase64: bytes.toString("base64"),
      filename: args.filename,
      sizeBytes: bytes.byteLength,
      sessionId: sessionIdentifier,
    };
  }

  async fileList(sessionIdentifier: string): Promise<SandboxFileInfo[]> {
    let listing: WireDirListing;
    try {
      listing = await this.withSandbox(sessionIdentifier, (id) =>
        this.json<WireDirListing>("GET", `/sandboxes/${id}/files/list`, {
          query: { path: DATA_DIR },
        }),
      );
    } catch (err) {
      // A fresh sandbox has no /mnt/data yet.
      if (err instanceof AcaSandboxesHttpError && err.status === 404) return [];
      throw err;
    }
    return (listing.entries ?? [])
      .filter((e) => !(e.isDir ?? e.isDirectory) && e.name)
      .map((e) => ({
        filename: e.name!,
        size: e.size ?? 0,
        lastModified:
          e.modifiedAt ?? (e.modifiedTime ? new Date(e.modifiedTime * 1000).toISOString() : ""),
      }));
  }

  /**
   * Replace the env file that every exec sources. Called with the user's
   * current credentials each turn (possibly none), so revoked secrets don't
   * linger on the persistent disk.
   */
  async setEnv(vars: Record<string, string>, sessionIdentifier: string): Promise<void> {
    const lines = Object.entries(vars).map(([key, value]) => {
      const safeKey = key.replace(/[^A-Za-z0-9_]/g, "_");
      return `export ${safeKey}=${shellQuote(value)}\n`;
    });
    const b64 = Buffer.from(lines.join(""), "utf-8").toString("base64");
    const command =
      `umask 077 && mkdir -p "\${HOME:-/tmp}/.agentforeach" && ` +
      `printf %s '${b64}' | base64 -d > ${ENV_FILE}`;

    const result = await this.withSandbox(sessionIdentifier, (id) =>
      this.json<WireExecResult>("POST", `/sandboxes/${id}/executeShellCommand`, {
        body: { command },
        timeoutMs: 30_000,
        retry: "all", // overwriting the file is idempotent
      }),
    );
    if ((result.exitCode ?? 0) !== 0) {
      throw new Error(`Failed to set sandbox environment: ${result.stderr ?? ""}`.trim());
    }
  }

  /**
   * Have the egress proxy set each credential's header on requests to its
   * hosts, so the secret never enters the sandbox (verified live: the proxy
   * overwrites a placeholder header sent by curl). Replaces the whole
   * policy, so an empty list removes previously injected credentials.
   */
  async setEgressCredentials(
    credentials: EgressCredential[],
    sessionIdentifier: string,
  ): Promise<void> {
    await this.withSandbox(sessionIdentifier, (id) =>
      this.send("POST", `/sandboxes/${id}/egresspolicy`, {
        body: this.egressPolicy(credentials),
      }),
    );
  }

  resolveIdentifier(userId: string, sessionId?: string): string {
    return encodeIdentifier(
      userId,
      this.config.identifierStrategy === "sessionId" ? sessionId : undefined,
    );
  }

  isReady(): boolean {
    return (
      this.config.enabled &&
      !!this.sbx.subscriptionId &&
      !!this.sbx.resourceGroup &&
      !!this.sbx.sandboxGroup &&
      !!this.sbx.endpoint
    );
  }

  /**
   * Delete every sandbox (and so its snapshots and files) a user has, across
   * all their conversations. Used by account erasure (account/erase.ts).
   */
  async deleteUserSandboxes(userId: string): Promise<number> {
    const owned = await this.listByLabel(USER_LABEL, labelHash(userId));
    for (const s of owned) {
      await this.send("DELETE", `/sandboxes/${s.id}`, { allowStatuses: [404] });
      this.lastActiveMs.delete(s.id!);
    }
    for (const [identifier, id] of this.sandboxIds) {
      if (owned.some((s) => s.id === id)) this.sandboxIds.delete(identifier);
    }
    return owned.length;
  }

  // --------------------------------------------------------------------------
  // Sandbox lifecycle
  // --------------------------------------------------------------------------

  /**
   * Run `fn` against the identifier's sandbox, creating or resuming it first.
   * If the sandbox disappeared (auto-deleted, or deleted elsewhere), forget it
   * and retry once on a new one.
   */
  private async withSandbox<T>(identifier: string, fn: (id: string) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const id = await this.resolveSandbox(identifier);
      try {
        await this.ensureRunning(id, identifier);
        const result = await fn(id);
        this.lastActiveMs.set(id, Date.now());
        return result;
      } catch (err) {
        if (attempt === 0 && isNotRunning(err)) {
          // Stopped behind our back (another instance, or an operator). The
          // call was refused, not run, so resume and try once more.
          this.lastActiveMs.delete(id);
          continue;
        }
        if (attempt === 0 && (await this.isGone(err, id))) {
          this.sandboxIds.delete(identifier);
          this.lastActiveMs.delete(id);
          continue;
        }
        // Our view of its state may be stale (suspended by another instance).
        this.lastActiveMs.delete(id);
        throw err;
      }
    }
  }

  private async isGone(err: unknown, id: string): Promise<boolean> {
    if (err instanceof SandboxGoneError) return true;
    if (!(err instanceof AcaSandboxesHttpError) || err.status !== 404) return false;
    // A 404 from /files means a missing file; only a 404 on the sandbox itself means gone.
    const probe = await this.send("GET", `/sandboxes/${id}`, { allowStatuses: [404] });
    return probe.status === 404;
  }

  private resolveSandbox(identifier: string): Promise<string> {
    const cached = this.sandboxIds.get(identifier);
    if (cached) return Promise.resolve(cached);

    let pending = this.resolving.get(identifier);
    if (!pending) {
      pending = this.findOrCreate(identifier)
        .then((id) => {
          this.sandboxIds.set(identifier, id);
          return id;
        })
        .finally(() => this.resolving.delete(identifier));
      this.resolving.set(identifier, pending);
    }
    return pending;
  }

  /** Oldest live sandbox for an owner, so racing instances converge on one. */
  private async oldestOwned(identifier: string): Promise<WireSandbox | undefined> {
    const owned = (await this.listByLabel(OWNER_LABEL, labelHash(identifier))).filter(
      (s) => !/^(deleting|failed)$/i.test(s.state ?? ""),
    );
    owned.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    return owned[0];
  }

  private async findOrCreate(identifier: string): Promise<string> {
    const existing = await this.oldestOwned(identifier);
    if (existing?.id) return existing.id;

    const started = Date.now();
    const created = await this.json<WireSandbox>("PUT", "/sandboxes", {
      body: this.createBody(identifier),
    });
    if (!created.id) throw new Error("ACA Sandboxes create returned no sandbox id");
    console.log(`[sandbox] created ${created.id} in ${Date.now() - started}ms`);

    // Another instance may have created one at the same moment. Keep the
    // oldest and remove ours if it lost.
    const winner = await this.oldestOwned(identifier);
    if (winner?.id && winner.id !== created.id) {
      console.warn(`[sandbox] create race: using ${winner.id}, deleting ${created.id}`);
      await this.send("DELETE", `/sandboxes/${created.id}`, { allowStatuses: [404] }).catch(() => {});
      return winner.id;
    }

    await this.applyLifecycle(created.id, identifier);
    return created.id;
  }

  /**
   * The SDK sets auto-delete through POST /lifecycle rather than on create.
   * That call REPLACES the whole lifecycle policy (verified live), so it must
   * repeat auto-suspend, or the sandbox would never suspend and bill forever.
   * It needs a running sandbox; failure is logged, not fatal, because the
   * create body already set auto-suspend.
   */
  private async applyLifecycle(id: string, identifier: string): Promise<void> {
    if (this.sbx.autoDeleteDays <= 0) return;
    try {
      await this.ensureRunning(id, identifier);
      await this.send("POST", `/sandboxes/${id}/lifecycle`, {
        body: {
          autoSuspendPolicy: this.autoSuspendPolicy(),
          autoDeletePolicy: {
            enabled: true,
            deleteIntervalInSeconds: this.sbx.autoDeleteDays * 86_400,
          },
        },
      });
    } catch (err) {
      console.warn(`[sandbox] could not set auto-delete on ${id}: ${(err as Error).message}`);
    }
  }

  private autoSuspendPolicy() {
    return { enabled: true, interval: this.sbx.autoSuspendSec, mode: this.sbx.suspendMode };
  }

  private async listByLabel(key: string, value: string): Promise<WireSandbox[]> {
    const out: WireSandbox[] = [];
    let page = await this.json<WireSandboxList>("GET", "/sandboxes", {
      query: { labels: `${key}=${value}` },
    });
    const endpointOrigin = new URL(this.sbx.endpoint).origin;
    for (;;) {
      if (Array.isArray(page)) {
        out.push(...page);
        break;
      }
      out.push(...(page.value ?? []));
      if (!page.nextLink) break;
      if (new URL(page.nextLink).origin !== endpointOrigin) {
        throw new Error("Refusing to follow a nextLink outside the sandbox endpoint");
      }
      page = await this.json<WireSandboxList>("GET", page.nextLink, { absolute: true });
    }
    // Fail closed: never hand a user a sandbox whose label we can't see match.
    return out.filter((s) => s.id && s.labels?.[key] === value);
  }

  /**
   * Deny by default with full inspection (non-HTTP traffic blocked too), or
   * allow everything when networkAccess is "enabled". Credential rules are
   * Transforms: they permit the host and set the header.
   */
  private egressPolicy(credentials: EgressCredential[] = []): Record<string, unknown> {
    const rules = credentials.flatMap((c) =>
      c.hosts.map((host, i) => ({
        name: `cred-${c.key}-${i}`,
        match: { host },
        action: {
          type: "Transform",
          headers: [{ operation: "Set", name: c.header, value: c.value }],
        },
      })),
    );
    if (this.config.networkAccess === "enabled") {
      // Rules need inspection; Partial leaves non-HTTP traffic alone.
      return rules.length
        ? { defaultAction: "Allow", trafficInspection: "Partial", rules }
        : { defaultAction: "Allow" };
    }
    const hosts = this.sbx.egressAllowHosts;
    return {
      defaultAction: "Deny",
      trafficInspection: "Full",
      ...(hosts.length ? { hostRules: hosts.map((pattern) => ({ pattern, action: "Allow" })) } : {}),
      ...(rules.length ? { rules } : {}),
    };
  }

  private createBody(identifier: string): Record<string, unknown> {
    const s = this.sbx;
    return {
      sourcesRef: s.diskImageId
        ? { diskImage: { id: s.diskImageId } }
        : { diskImage: { name: s.diskImage, isPublic: true } },
      resources: { cpu: s.cpu, memory: s.memory, ...(s.disk ? { disk: s.disk } : {}) },
      lifecycle: { autoSuspendPolicy: this.autoSuspendPolicy() },
      labels: {
        app: "agentforeach",
        [OWNER_LABEL]: labelHash(identifier),
        [USER_LABEL]: labelHash(userIdOf(identifier)),
      },
      egressPolicy: this.egressPolicy(),
    };
  }

  /**
   * Resume if suspended and wait until Running, checking the sandbox still
   * belongs to this owner. Skips the round-trip if it was used recently.
   */
  private async ensureRunning(id: string, identifier: string): Promise<void> {
    const last = this.lastActiveMs.get(id);
    const idleBudgetMs = this.sbx.autoSuspendSec * 1000 - ASSUME_RUNNING_MARGIN_MS;
    if (last && Date.now() - last < idleBudgetMs) return;

    const started = Date.now();
    const deadline = started + this.readyTimeoutMs;
    let resumeRequested = false;
    for (;;) {
      const sandbox = await this.json<WireSandbox>("GET", `/sandboxes/${id}`);
      if (sandbox.labels?.[OWNER_LABEL] !== labelHash(identifier)) {
        throw new Error(`Sandbox ${id} does not belong to this owner`);
      }
      const state = (sandbox.state ?? "").toLowerCase();
      if (state === "running") {
        if (resumeRequested) console.log(`[sandbox] resumed ${id} in ${Date.now() - started}ms`);
        this.lastActiveMs.set(id, Date.now());
        return;
      }
      if (state === "deleting" || state === "failed") {
        throw new SandboxGoneError(`Sandbox ${id} is ${sandbox.state}`);
      }
      if (sandbox.stateDetails?.stoppedReason === "Disabled") {
        throw new Error(`Sandbox ${id} is administratively disabled and cannot be resumed`);
      }
      if (!resumeRequested && /^(stopped|suspended|idle)$/.test(state)) {
        // 409: another instance is already resuming it; polling covers that.
        await this.send("POST", `/sandboxes/${id}/resume`, { allowStatuses: [409] });
        resumeRequested = true;
      }
      if (Date.now() > deadline) {
        throw new Error(`Sandbox ${id} not running after ${this.readyTimeoutMs}ms (state ${sandbox.state})`);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  private async readBytes(filename: string, identifier: string): Promise<Buffer> {
    const resp = await this.withSandbox(identifier, (id) =>
      this.send("GET", `/sandboxes/${id}/files`, { query: { path: dataPath(filename) } }),
    );
    return Buffer.from(await resp.arrayBuffer());
  }

  // --------------------------------------------------------------------------
  // HTTP plumbing
  // --------------------------------------------------------------------------

  private get basePath(): string {
    const s = this.sbx;
    return (
      `/subscriptions/${encodeURIComponent(s.subscriptionId)}` +
      `/resourceGroups/${encodeURIComponent(s.resourceGroup)}` +
      `/sandboxGroups/${encodeURIComponent(s.sandboxGroup)}`
    );
  }

  private async send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = new URL(opts.absolute ? path : `${this.sbx.endpoint}${this.basePath}${path}`);
    if (!url.searchParams.has("api-version")) {
      url.searchParams.set("api-version", ACA_SANDBOXES_API_VERSION);
    }
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    let body: BodyInit | undefined;
    let contentType: string | undefined;
    if (opts.rawBody) {
      contentType = opts.contentType ?? "application/octet-stream";
      body = new Uint8Array(opts.rawBody);
    } else if (opts.body !== undefined) {
      contentType = "application/json";
      body = JSON.stringify(opts.body);
    }

    const retry = opts.retry ?? "all";
    const firstAttempt = Date.now();
    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.tokenProvider.getToken()}`,
      };
      if (contentType) headers["Content-Type"] = contentType;

      const resp = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (resp.ok || opts.allowStatuses?.includes(resp.status)) return resp;

      const retryable =
        (resp.status === 403 && Date.now() - firstAttempt < RBAC_PROPAGATION_BUDGET_MS) ||
        (resp.status === 429 && attempt < MAX_TRANSIENT_ATTEMPTS) ||
        (retry === "all" && isTransient(resp.status) && attempt < MAX_TRANSIENT_ATTEMPTS);
      if (retryable) {
        await resp.body?.cancel().catch(() => {});
        const retryAfterSec = Number(resp.headers.get("retry-after"));
        const backoff = Math.min(this.retryBaseMs * 2 ** (attempt - 1), this.retryBaseMs * 10);
        await sleep(retryAfterSec > 0 ? retryAfterSec * 1000 : backoff);
        continue;
      }

      const text = await resp.text().catch(() => "");
      // Relative path only: this message can reach the model.
      const where = url.pathname.startsWith(this.basePath)
        ? url.pathname.slice(this.basePath.length)
        : "(nextLink)";
      throw new AcaSandboxesHttpError(
        resp.status,
        `ACA sandbox ${method} ${where} failed: ${resp.status} ${text.slice(0, 300)}`,
      );
    }
  }

  private async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const resp = await this.send(method, path, opts);
    if (resp.status === 204) return {} as T;
    const text = await resp.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}

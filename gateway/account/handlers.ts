/**
 * AgentForEach — account erasure endpoints
 *
 *   DELETE /api/me/data                    the caller's own data
 *   DELETE /api/admin/users/{userId}/data  any user's data (admin role)
 *
 * Both require the header `x-confirm-erase: yes`, so a stray request (or a
 * client bug) can't wipe an account, and are rate-limited (each call runs
 * cross-partition queries). The user's running turns are stopped first, and
 * a second pass after a short pause removes anything they wrote while
 * stopping. The response lists what was deleted; a 500 with `errors` means
 * some steps failed and the call can be repeated.
 */

import type { HandlerContext, HttpRequestLike, HttpResult, RouteDef } from "@agentforeach/platform";
import { isAdmin, resolveAuthContext } from "../auth/index.js";
import { getSharedStorage } from "../database/index.js";
import { loadSkillsConfig, createSandboxBackend, ExportBlobStore } from "../skills/index.js";
import { resolveObjectStorage } from "../objects/index.js";
import { handleCorsHeaders } from "../utils/request-http.js";
import { eraseUserData, type ErasureReport } from "./erase.js";
import { AbortStore } from "../client/abort-store.js";
import { RateLimiter } from "../ratelimit/index.js";

/** At most one erasure a minute and five a day per account. */
const ERASE_LIMIT = { enabled: true, perMinute: 1, perDay: 5, exemptChannels: [], containerId: "rate-limits", scope: "erase" };
/** Time for running turns to notice the abort marker (they poll every 2.5 s). */
const ABORT_PROPAGATION_MS = 3_000;
/** Pause before the second pass, for writes of turns that were stopping. */
const SECOND_PASS_DELAY_MS = 10_000;

function cors(request: HttpRequestLike): Record<string, string> {
  return {
    ...handleCorsHeaders(request),
    "Access-Control-Allow-Methods": "DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-confirm-erase",
  };
}

function json(request: HttpRequestLike, status: number, body: unknown): HttpResult {
  return { status, headers: { ...cors(request), "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function erase(request: HttpRequestLike, context: HandlerContext, userId: string): Promise<HttpResult> {
  if (request.headers.get("x-confirm-erase") !== "yes") {
    return json(request, 400, { error: "Send the header x-confirm-erase: yes to erase all data for this account" });
  }
  const limit = await new RateLimiter(getSharedStorage(), ERASE_LIMIT).check(userId);
  if (!limit.allowed) {
    return json(request, 429, { error: "Erasure was requested too recently", retryAfterSeconds: limit.retryAfterSeconds });
  }
  // Stop the user's running turns (on any instance) so they don't write
  // after the first pass. Runs poll the marker every 2.5 s, and the first
  // pass deletes it with the rest of the user's data, so let them see it.
  const aborts = new AbortStore(getSharedStorage());
  await aborts
    .initialize()
    .then(() => aborts.requestAbort(userId))
    .then(() => new Promise((r) => setTimeout(r, ABORT_PROPAGATION_MS)))
    .catch(() => undefined);
  const skills = loadSkillsConfig();
  const sandbox = skills.sandbox ? createSandboxBackend(skills.sandbox) : undefined;
  const storage = skills.enabled ? resolveObjectStorage(skills.storageConnectionString) : undefined;
  const targets = {
    sandbox,
    exports: storage ? new ExportBlobStore(storage) : undefined,
  };
  const first = await eraseUserData(getSharedStorage(), userId, targets);
  await new Promise((r) => setTimeout(r, SECOND_PASS_DELAY_MS));
  // The sandboxes again too: a turn still running during the first pass
  // could have started one (deleting none is a cheap list).
  const second = await eraseUserData(getSharedStorage(), userId, { ...targets, exports: undefined });
  const report = mergeReports(first, second);
  if (report.errors.length > 0) context.warn(`[account] erasure incomplete: ${report.errors.join("; ")}`);
  return json(request, report.errors.length > 0 ? 500 : 200, report);
}

export const routes: RouteDef[] = [];

routes.push({
  name: "accountEraseSelf",
  methods: ["DELETE", "OPTIONS"],
  route: "api/me/data",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return { status: 204, headers: cors(request) };
    const auth = await resolveAuthContext(request);
    if (!auth) return json(request, 401, { error: "Unauthorized" });
    return erase(request, context, auth.userId);
  },
});

routes.push({
  name: "accountEraseUser",
  methods: ["DELETE", "OPTIONS"],
  route: "api/admin/users/{userId}/data",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return { status: 204, headers: cors(request) };
    const auth = await resolveAuthContext(request);
    if (!auth) return json(request, 401, { error: "Unauthorized" });
    if (!isAdmin(auth)) return json(request, 403, { error: "Admin role required" });
    const userId = request.params.userId;
    if (!userId) return json(request, 400, { error: "userId is required" });
    return erase(request, context, userId);
  },
});

function mergeReports(a: ErasureReport, b: ErasureReport): ErasureReport {
  const containers = { ...a.containers };
  for (const [k, v] of Object.entries(b.containers)) containers[k] = (containers[k] ?? 0) + v;
  return {
    containers,
    sandboxes: a.sandboxes + b.sandboxes,
    exportedFiles: a.exportedFiles + b.exportedFiles,
    errors: [...a.errors, ...b.errors],
    skipped: a.skipped,
  };
}

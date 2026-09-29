/**
 * AgentForEach Cron — request guards for the HTTP API
 *
 * The API takes JSON from any authenticated user. Scheduler bookkeeping
 * (state, shard, version, timestamps) is written by the scheduler only, so a
 * user's PATCH is reduced to the fields a user may set.
 */

import { INVALID_SESSION_ID_MESSAGE, isValidSessionId } from "../sessions/ids.js";
import type { CronJobPatch } from "./types.js";
import { stripServerOnlyDeliveryFields } from "./recipient-policy.js";

/** Fields a user may change on their own job. */
const USER_PATCHABLE_FIELDS = [
  "name",
  "description",
  "enabled",
  "deleteAfterRun",
  "schedule",
  "sessionTarget",
  "wakeMode",
  "agentId",
  "sessionId",
  "payload",
  "delivery",
  "expiresAt",
  "maxRuns",
] as const;

export type SanitizedPatch = { ok: true; patch: CronJobPatch } | { ok: false; error: string };

/**
 * Keep only user-settable fields. Anything else (state.nextRunAtMs,
 * state.runningToken, runCount, shardId, version…) is dropped, so a user can
 * neither force runs nor bypass maxRuns.
 */
export function sanitizeUserCronPatch(body: unknown): SanitizedPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const source = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of USER_PATCHABLE_FIELDS) {
    if (key in source) patch[key] = source[key];
  }
  if (patch.delivery !== undefined) {
    patch.delivery = stripServerOnlyDeliveryFields(patch.delivery);
  }
  if (patch.sessionId !== undefined && !isValidSessionId(patch.sessionId)) {
    return { ok: false, error: INVALID_SESSION_ID_MESSAGE };
  }
  return { ok: true, patch: patch as CronJobPatch };
}

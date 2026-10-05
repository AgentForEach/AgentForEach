/**
 * The database collections the AWS pack stores, with no SDK import, so the
 * gateway's catalog (and `npm run db:catalog`) can list them on any host.
 */

import type { CollectionSpec } from "@agentforeach/storage";

/**
 * One row per durable instance (job, wait or alarm), keyed by a hash of the
 * instance id: its kind, status and input, the name of the Lambda durable
 * execution running it now (names can't be reused, so every start,
 * replacement, continuation and re-dispatch gets a new one), and what a wait
 * or alarm is waiting on. Finished rows expire after an hour (the pack's
 * `retentionMs`); active rows never do. See `./durable/instances.ts`.
 */
export const DURABLE_INSTANCES_COLLECTION: CollectionSpec = {
  name: "aws-durable-instances",
  partitionKey: "id",
  defaultTtl: -1,
  indexes: ["status", "sweptAt", "userId"],
  unindexed: ["input", "event"],
};

/**
 * What the durable conformance kinds record when the suite runs against the
 * deployed durable function (connect mode, `./durable/conformance.ts`): the
 * handler calls per instance, the gates and the alarm intervals, each under
 * its own key. Rows expire after a day.
 */
export const DURABLE_CONFORMANCE_COLLECTION: CollectionSpec = {
  name: "aws-durable-conformance",
  partitionKey: "key",
  defaultTtl: 24 * 60 * 60,
  unindexed: ["call"],
};

/**
 * The AgentCore runtime sessions each sandbox owner has started, so account
 * erasure can stop them all (StopRuntimeSession), even after a cold start.
 * Keyed by `owner`, a hash of the user id, not `userId`: the generic erasure
 * must not delete these handles before the sessions are stopped; the
 * backend removes each one once its stop succeeds.
 */
export const AWS_SANDBOX_SESSIONS: CollectionSpec = { name: "aws-sandbox-sessions", partitionKey: "owner" };

/**
 * Per owner: the generation (raised by every erasure, so the next call
 * starts afresh), the checkpoint lease, and which compute holds each
 * workspace. Hashes only, no content; kept after erasure, so stale writers
 * stay fenced.
 */
export const AWS_SANDBOX_WORKSPACES: CollectionSpec = { name: "aws-sandbox-workspaces", partitionKey: "owner" };

/** The aws-agentcore sandbox backend's collections. */
export const AWS_SANDBOX_COLLECTIONS: readonly CollectionSpec[] = [AWS_SANDBOX_SESSIONS, AWS_SANDBOX_WORKSPACES];

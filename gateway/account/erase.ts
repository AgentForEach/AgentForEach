/**
 * AgentForEach — erase a user's data
 *
 * Deletes everything stored about one user: every document that belongs to
 * them, their sandboxes and their exported files. Driven by the collection
 * catalog (database/catalog.ts), the same list the IaC provisions, so a
 * collection added later is covered without touching this file:
 *
 *   - collections partitioned by the user (userId): the whole partition;
 *   - other collections (messages, channel index, pairing codes, cron index,
 *     runs, heartbeat events): documents whose userId is the
 *     user, found with one cross-partition query each.
 *
 * Not deleted here, because they hold no identifying content and expire on
 * their own: rate-limit counters and WhatsApp delivery state (minutes to
 * days). Durable Functions history is purged an hour after a run
 * (handlers/durable-purge.ts). Per-instance caches (prompt documents) expire
 * within minutes.
 */

import { eq, type CollectionSpec, type StorageAdapter } from "@agentforeach/storage";
import type { SandboxBackend } from "@agentforeach/platform";
import { recordCollectionSpecs } from "../database/catalog.js";
import { redactId } from "../utils/redact.js";

/** Deletes in flight at once per container. */
const DELETE_CONCURRENCY = 16;

/** Partition key field that means "one partition per user". */
const USER_PARTITION = "userId";

export type ErasureReport = {
  /** Documents deleted, by collection. */
  containers: Record<string, number>;
  sandboxes: number;
  exportedFiles: number;
  /** Steps that failed; the rest still ran. Safe to run the erasure again. */
  errors: string[];
  /** Data this deployment can't delete automatically (e.g. a sandbox backend without per-user deletion). */
  skipped: string[];
};

export type ErasureTargets = {
  /** The sandbox backend: its sandboxes are deleted unless they keep nothing anyway. */
  sandbox?: Pick<SandboxBackend, "capabilities" | "deleteUserSandboxes" | "erasureNotes">;
  /** Export store (sandbox_file_export downloads). */
  exports?: { deleteUserFiles(userId: string): Promise<number> };
  /** Collections to consider (default: the catalog). For tests. */
  catalog?: CollectionSpec[];
};

type Keyed = { id: string; pk?: string };

export async function eraseUserData(
  storage: StorageAdapter,
  userId: string,
  targets: ErasureTargets = {},
): Promise<ErasureReport> {
  const report: ErasureReport = { containers: {}, sandboxes: 0, exportedFiles: 0, errors: [], skipped: [] };
  const catalog = targets.catalog ?? (await recordCollectionSpecs());
  await storage.initialize();

  for (const spec of catalog) {
    try {
      const container = await storage.collection(spec);
      let docs: Keyed[];
      if (spec.partitionKey === USER_PARTITION) {
        // The user's partition: everything in it.
        docs = (await container.find<{ id: string }>({ partitionKey: userId, select: ["id"] })).map((d) => ({
          id: d.id,
          pk: userId,
        }));
      } else {
        // Across partitions: the documents carrying the user's id.
        docs = await container.find<Keyed>({
          where: eq("userId", userId),
          select: ["id", { field: spec.partitionKey, as: "pk" }],
        });
      }
      let deleted = 0;
      const pending = docs.filter((d) => typeof d.pk === "string");
      for (let i = 0; i < pending.length; i += DELETE_CONCURRENCY) {
        const results = await Promise.all(
          pending.slice(i, i + DELETE_CONCURRENCY).map((d) => container.delete(d.id, d.pk!)),
        );
        deleted += results.filter(Boolean).length;
      }
      if (deleted > 0) report.containers[spec.name] = deleted;
    } catch (err) {
      report.errors.push(`${spec.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (targets.sandbox && targets.sandbox.capabilities.persistence !== "none") {
    try {
      report.sandboxes = await targets.sandbox.deleteUserSandboxes(userId);
    } catch (err) {
      report.errors.push(`sandboxes: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const note of targets.sandbox.erasureNotes ?? []) report.skipped.push(`sandboxes: ${note}`);
  } else if (targets.sandbox) {
    report.skipped.push("sandboxes: this sandbox backend keeps nothing per user; sessions expire after their cooldown");
  }
  if (targets.exports) {
    try {
      report.exportedFiles = await targets.exports.deleteUserFiles(userId);
    } catch (err) {
      report.errors.push(`exports: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const total = Object.values(report.containers).reduce((a, b) => a + b, 0);
  console.log(
    `[account] erased user=${redactId(userId)} documents=${total} sandboxes=${report.sandboxes} ` +
      `exports=${report.exportedFiles} errors=${report.errors.length}`,
  );
  return report;
}

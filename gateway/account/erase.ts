/**
 * AgentForEach — erase a user's data
 *
 * Deletes everything stored about one user: every Cosmos document that
 * belongs to them, their sandboxes and their exported files. Driven by the
 * container catalog (database/catalog.ts), the same list the IaC provisions,
 * so a container added later is covered without touching this file:
 *
 *   - containers partitioned by the user (/userId, /chittiUserId): the whole
 *     partition;
 *   - other containers (messages, channel index, pairing codes, cron index,
 *     runs, heartbeat events): documents whose userId or chittiUserId is the
 *     user, found with one cross-partition query each.
 *
 * Not deleted here, because they hold no identifying content and expire on
 * their own: rate-limit counters and WhatsApp delivery state (minutes to
 * days). Durable Functions history is purged an hour after a run
 * (handlers/durable-purge.ts). Per-instance caches (prompt documents) expire
 * within minutes.
 */

import type { DatabaseProvider } from "../database/index.js";
import { recordContainerCatalog, type CatalogContainer } from "../database/catalog.js";
import { redactId } from "../utils/redact.js";

/** Deletes in flight at once per container. */
const DELETE_CONCURRENCY = 16;

/** Partition key paths that mean "one partition per user". */
const USER_PARTITIONS = new Set(["/userId", "/chittiUserId"]);

export type ErasureReport = {
  /** Documents deleted, by container. */
  containers: Record<string, number>;
  sandboxes: number;
  exportedFiles: number;
  /** Steps that failed; the rest still ran. Safe to run the erasure again. */
  errors: string[];
  /** Data this deployment can't delete automatically (e.g. a sandbox backend without per-user deletion). */
  skipped: string[];
};

export type ErasureTargets = {
  /** Sandbox backend with per-user deletion (ACA Sandboxes). */
  sandbox?: { deleteUserSandboxes?(userId: string): Promise<number> };
  /** Export store (sandbox_file_export downloads). */
  exports?: { deleteUserFiles(userId: string): Promise<number> };
  /** Containers to consider (default: the catalog). For tests. */
  catalog?: CatalogContainer[];
};

type Keyed = { id: string; pk?: string };

export async function eraseUserData(
  db: DatabaseProvider,
  userId: string,
  targets: ErasureTargets = {},
): Promise<ErasureReport> {
  const report: ErasureReport = { containers: {}, sandboxes: 0, exportedFiles: 0, errors: [], skipped: [] };
  const catalog = targets.catalog ?? (await recordContainerCatalog());
  await db.initialize();

  for (const def of catalog) {
    const pkPath = (def.partitionKey as { paths: string[] }).paths[0]!;
    try {
      const container = await db.getOrCreateContainer(def);
      let docs: Keyed[];
      if (USER_PARTITIONS.has(pkPath)) {
        docs = (await container.queryWithParams<{ id: string }>("SELECT c.id FROM c", [], { partitionKey: userId })).map(
          (d) => ({ id: d.id, pk: userId }),
        );
      } else {
        const field = pkPath.slice(1);
        docs = await container.queryWithParams<Keyed>(
          `SELECT c.id, c["${field}"] AS pk FROM c WHERE c.userId = @user OR c.chittiUserId = @user`,
          [{ name: "@user", value: userId }],
        );
      }
      let deleted = 0;
      const pending = docs.filter((d) => typeof d.pk === "string");
      for (let i = 0; i < pending.length; i += DELETE_CONCURRENCY) {
        const results = await Promise.all(
          pending.slice(i, i + DELETE_CONCURRENCY).map((d) => container.delete(d.id, d.pk!)),
        );
        deleted += results.filter(Boolean).length;
      }
      if (deleted > 0) report.containers[def.id] = deleted;
    } catch (err) {
      report.errors.push(`${def.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (targets.sandbox?.deleteUserSandboxes) {
    try {
      report.sandboxes = await targets.sandbox.deleteUserSandboxes(userId);
    } catch (err) {
      report.errors.push(`sandboxes: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (targets.sandbox) {
    report.skipped.push("sandboxes: this sandbox backend can't delete per user; sessions expire after their cooldown");
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

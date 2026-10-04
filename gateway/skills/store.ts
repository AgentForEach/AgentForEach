/**
 * AgentForEach Skills Layer — User Skill Store
 *
 * Persistence layer for per-user skill configurations. Follows the same
 * container setup pattern as episodes/store.ts.
 *
 * Document structure:
 *   - id: "{userId}:{skillId}"
 *   - partitionKey: /userId
 *   - Credentials excluded from indexing for security
 */

import { and, eq, isDefined, type Collection, type CollectionSpec, type StorageAdapter } from "@agentforeach/storage";
import type { UserSkillConfig, SkillAuditEntry } from "./types.js";

/** The user-skills collection; credentials are never indexed. */
export function userSkillsCollection(containerId = "user-skills"): CollectionSpec {
  return { name: containerId, partitionKey: "userId", unindexed: ["credentials"] };
}

// ============================================================================
// User Skill Store
// ============================================================================

export class UserSkillStore {
  private storage: StorageAdapter;
  private containerId: string;
  private container!: Collection<UserSkillConfig>;
  private initialized = false;

  constructor(storage: StorageAdapter, containerId = "user-skills") {
    this.storage = storage;
    this.containerId = containerId;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.storage.initialize();
    this.container = await this.storage.collection<UserSkillConfig>(userSkillsCollection(this.containerId));
    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  /** Build a document ID from userId + skillId. */
  static buildId(userId: string, skillId: string): string {
    return `${userId}:${skillId}`;
  }

  /** Get a single skill config for a user. */
  async get(
    userId: string,
    skillId: string,
  ): Promise<UserSkillConfig | null> {
    await this.ensureInitialized();
    const id = UserSkillStore.buildId(userId, skillId);
    return this.container.read(id, userId);
  }

  /** Get all skill configs for a user (excludes audit entries). */
  async getAllForUser(userId: string): Promise<UserSkillConfig[]> {
    await this.ensureInitialized();
    return this.container.find<UserSkillConfig>({
      partitionKey: userId,
      where: and(eq("userId", userId), isDefined("enabled")),
      orderBy: { field: "skillId" },
    });
  }

  /** Create or update a skill config. */
  async upsert(config: UserSkillConfig): Promise<UserSkillConfig> {
    await this.ensureInitialized();
    return this.container.upsert(config);
  }

  /** Delete a skill config. */
  async delete(userId: string, skillId: string): Promise<boolean> {
    await this.ensureInitialized();
    const id = UserSkillStore.buildId(userId, skillId);
    return this.container.delete(id, userId);
  }

  // --------------------------------------------------------------------------
  // Audit Logging
  // --------------------------------------------------------------------------

  /**
   * Write an audit entry for a skill configuration change.
   *
   * Audit documents are stored in the same container (same partition key)
   * with a different ID pattern: "audit:{userId}:{skillId}:{timestamp}".
   * Credential *values* are never logged — only the keys that were set.
   */
  async logAudit(entry: SkillAuditEntry): Promise<void> {
    await this.ensureInitialized();
    // Documents are schema-less; the collection type doesn't restrict them.
    await this.container.upsert(entry as unknown as UserSkillConfig);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

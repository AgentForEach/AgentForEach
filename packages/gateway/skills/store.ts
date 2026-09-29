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

import type {
  DatabaseProvider,
  ContainerHandle,
  ContainerOptions,
} from "../database/index.js";
import type { UserSkillConfig, SkillAuditEntry } from "./types.js";

// ============================================================================
// User Skill Store
// ============================================================================

export class UserSkillStore {
  private db: DatabaseProvider;
  private containerId: string;
  private container!: ContainerHandle<UserSkillConfig>;
  private initialized = false;

  constructor(db: DatabaseProvider, containerId = "user-skills") {
    this.db = db;
    this.containerId = containerId;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.db.initialize();

    const containerDef: ContainerOptions = {
      id: this.containerId,
      partitionKey: { paths: ["/userId"] },
      indexingPolicy: {
        automatic: true,
        indexingMode: "consistent",
        includedPaths: [{ path: "/*" }],
        excludedPaths: [
          { path: "/credentials/*" },
          { path: '/"_etag"/?' },
        ],
      },
    };

    this.container =
      await this.db.getOrCreateContainer<UserSkillConfig>(containerDef);
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
    return this.container.queryWithParams(
      "SELECT * FROM c WHERE c.userId = @userId AND IS_DEFINED(c.enabled) ORDER BY c.skillId",
      [{ name: "@userId", value: userId }],
      { partitionKey: userId },
    );
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
    // Cosmos is schema-less; the container type doesn't restrict actual documents.
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

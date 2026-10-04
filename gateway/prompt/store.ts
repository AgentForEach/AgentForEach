/**
 * AgentForEach Prompt Layer — Cosmos DB Store
 *
 * Manages CRUD operations for structured prompt documents in Cosmos DB.
 * Each document type has typed data fields (not markdown blobs).
 *
 * Container: "prompt-documents"
 *   - Partition key: /userId
 *   - Document ID format: {userId}:{agentId}:{documentType}
 *
 * Also manages the onboarding state (tracked per user+agent).
 *
 * Features:
 *   - Typed read/write for all 8 prompt document types
 *   - Field-level partial updates via `patchData()`
 *   - Upsert with version tracking
 *   - Bulk load of all documents for a user+agent
 *   - In-memory cache with TTL for hot reads
 *   - Onboarding state management
 *   - Template seeding for new users (skips if onboarding completed)
 */

import {
  and,
  eq,
  type Collection,
  type CollectionSpec,
  type PatchOperation,
  type StorageAdapter,
} from "@agentforeach/storage";
import type {
  PromptDocument,
  PromptDocumentType,
  PromptDataMap,
  OnboardingState,
} from "./types.js";
import { PROMPT_DOCUMENT_ORDER } from "./types.js";
import { DEFAULT_TEMPLATES } from "./templates.js";
import {
  isOnboardingEnabled,
  isPromptStatic,
  STATIC_LOCKED_TYPES,
} from "./prompt-config.js";
import { redactId } from "../utils/redact.js";

// ============================================================================
// Constants
// ============================================================================

const PROMPT_CONTAINER_ID = "prompt-documents";
const ONBOARDING_CONTAINER_ID = "onboarding-state";

export const PROMPT_COLLECTION: CollectionSpec = { name: PROMPT_CONTAINER_ID, partitionKey: "userId" };
export const ONBOARDING_COLLECTION: CollectionSpec = { name: ONBOARDING_CONTAINER_ID, partitionKey: "userId" };

/** Default agent ID when the user has a single agent. */
export const DEFAULT_AGENT_ID = "default";

/** Cache TTL in milliseconds (5 minutes). */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Users whose documents one instance keeps cached. */
const CACHE_MAX_ENTRIES = 5_000;

/** Log prefix for prompt store operations. */
const LOG_PREFIX = "[prompt-store]";

/** Check if a value is a plain object (not array, not null). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function shouldRepairDocumentData(
  documentType: PromptDocumentType,
  data: unknown,
): boolean {
  if (!isPlainObject(data)) return true;

  const defaultData = DEFAULT_TEMPLATES[documentType] as unknown;
  if (!isPlainObject(defaultData)) return false;

  // Legacy corruption path: document exists but data is an empty object
  // for document types that should have non-empty defaults.
  return Object.keys(data).length === 0 && Object.keys(defaultData).length > 0;
}

/** Structural equality for template data (plain JSON: objects/arrays/scalars). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => deepEqual(a[key], (b as Record<string, unknown>)[key]))
    );
  }
  return false;
}

/**
 * Whether a stored document should be refreshed to the current template.
 *
 * Only in static mode, and only for the types static mode locks: those can
 * never have been edited — `prompt_update` rejects them and no other write
 * path exists — so a stored copy that differs from the template is simply a
 * seed from an older config, still describing behaviour the config has since
 * changed. Deploying a template change would otherwise never reach an
 * existing account. USER is writable and is deliberately never touched.
 */
function isLockedTemplateStale(
  documentType: PromptDocumentType,
  data: unknown,
): boolean {
  if (!isPromptStatic() || !STATIC_LOCKED_TYPES.has(documentType)) return false;
  return !deepEqual(data, DEFAULT_TEMPLATES[documentType]);
}

// ============================================================================
// Store
// ============================================================================

/**
 * Cosmos DB store for structured prompt documents and onboarding state.
 *
 * Usage:
 * ```ts
 * const store = new PromptDocumentStore(getSharedStorage());
 * await store.initialize();
 *
 * // Seed default templates for a new user
 * await store.seedDefaults("user_123", "default");
 *
 * // Load all documents for prompt assembly
 * const docs = await store.loadAll("user_123", "default");
 *
 * // Get typed data for a specific document
 * const userData = await store.getData("user_123", "default", "USER");
 *
 * // Update specific fields (used by LLM tools)
 * await store.patchData("user_123", "default", "USER", {
 *   timezone: "America/New_York",
 *   name: "Alice",
 * });
 * ```
 */
export class PromptDocumentStore {
  private storage: StorageAdapter;
  private promptContainer!: Collection<PromptDocument>;
  private onboardingContainer!: Collection<OnboardingState>;
  private initialized = false;

  /**
   * In-memory cache: key = `{userId}:{agentId}` → documents map.
   *
   * Serverless note: This cache lives in-process and resets on cold starts.
   * It acts as a warm-instance optimization — within a single Azure Functions
   * host that handles multiple invocations, the cache avoids repeated Cosmos reads.
   * Each function instance has its own cache; there is no cross-instance sharing.
   * Correctness does not depend on the cache — it is purely a performance optimization.
   */
  private cache = new Map<
    string,
    { docs: Map<PromptDocumentType, PromptDocument>; expiresAt: number }
  >();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * Initialize the prompt-document and onboarding-state collections.
   * Safe to call multiple times.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.promptContainer = await this.storage.collection<PromptDocument>(PROMPT_COLLECTION);
    this.onboardingContainer = await this.storage.collection<OnboardingState>(ONBOARDING_COLLECTION);

    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // Document ID Helpers
  // --------------------------------------------------------------------------

  /**
   * Build a deterministic document ID from its components.
   * Format: `{userId}:{agentId}:{documentType}`
   */
  private buildDocumentId(
    userId: string,
    agentId: string,
    documentType: PromptDocumentType,
  ): string {
    return `${userId}:${agentId}:${documentType}`;
  }

  /**
   * Build the cache key for a user+agent pair. JSON, not "user:agent": the
   * cache is shared by every user in the process, and ids may contain ":".
   */
  private buildCacheKey(userId: string, agentId: string): string {
    return JSON.stringify([userId, agentId]);
  }

  // --------------------------------------------------------------------------
  // Read Operations
  // --------------------------------------------------------------------------

  /**
   * Load a single prompt document.
   *
   * @returns The document, or null if it doesn't exist.
   */
  async load(
    userId: string,
    agentId: string,
    documentType: PromptDocumentType,
  ): Promise<PromptDocument | null> {
    this.ensureInitialized();
    const id = this.buildDocumentId(userId, agentId, documentType);
    return this.promptContainer.read(id, userId);
  }

  /**
   * Get typed data for a specific document type.
   * Returns null if the document doesn't exist.
   */
  async getData<T extends PromptDocumentType>(
    userId: string,
    agentId: string,
    documentType: T,
  ): Promise<PromptDataMap[T] | null> {
    const doc = await this.load(userId, agentId, documentType);
    if (!doc) return null;
    return doc.data as PromptDataMap[T];
  }

  /**
   * Load all prompt documents for a user+agent, returned as a map
   * keyed by document type.
   *
   * Results are cached in memory with a TTL. Use `invalidateCache()`
   * to force a fresh read.
   *
   * Returns a shallow clone of the cached map so callers cannot corrupt
   * the cache by mutating the returned map.
   *
   * Cache coherence note: The cache is per-process and invalidated on
   * any write via this store. However, if multiple tool calls within the
   * same request hold references to earlier snapshots, they may see stale
   * data. In practice, tool calls are processed sequentially within a
   * request, so this is not a concern.
   */
  async loadAll(
    userId: string,
    agentId: string,
  ): Promise<Map<PromptDocumentType, PromptDocument>> {
    this.ensureInitialized();

    // Check cache — return a shallow clone to prevent caller mutation
    const cacheKey = this.buildCacheKey(userId, agentId);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return new Map(cached.docs);
    }

    // Query all documents for this user+agent
    const docs = await this.promptContainer.find<PromptDocument>({
      partitionKey: userId,
      where: and(eq("userId", userId), eq("agentId", agentId)),
    });

    const docsMap = new Map<PromptDocumentType, PromptDocument>();
    for (const doc of docs) {
      docsMap.set(doc.documentType, doc);
    }

    // Update cache. Bounded: a long-lived instance sees many users, and
    // entries are only replaced, never removed, on their own. Map keeps
    // insertion order, so dropping the first key drops the oldest entry.
    this.cache.delete(cacheKey);
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(cacheKey, {
      docs: docsMap,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    // Return a clone so callers cannot corrupt the cache
    return new Map(docsMap);
  }

  /**
   * Load documents filtered for a specific session type.
   *
   * @param documentTypes - Specific types to load (e.g., MINIMAL_SESSION_DOCUMENTS).
   */
  async loadFiltered(
    userId: string,
    agentId: string,
    documentTypes: readonly PromptDocumentType[],
  ): Promise<Map<PromptDocumentType, PromptDocument>> {
    this.ensureInitialized();

    const allDocs = await this.loadAll(userId, agentId);
    const filtered = new Map<PromptDocumentType, PromptDocument>();

    for (const docType of documentTypes) {
      const doc = allDocs.get(docType);
      if (doc) filtered.set(docType, doc);
    }

    return filtered;
  }

  // --------------------------------------------------------------------------
  // Write Operations
  // --------------------------------------------------------------------------

  /**
   * Create or update a prompt document's structured data.
   * Replaces the entire data object. For partial updates, use `patchData()`.
   *
   * Concurrency note: This performs a read-then-upsert without server-side
   * etag enforcement. For concurrent field-level writes, prefer `patchData()`
   * which uses Cosmos DB's atomic `patch()` operation.
   */
  async upsertData<T extends PromptDocumentType>(
    userId: string,
    agentId: string,
    documentType: T,
    data: PromptDataMap[T],
  ): Promise<PromptDocument> {
    this.ensureInitialized();

    const id = this.buildDocumentId(userId, agentId, documentType);
    const now = new Date().toISOString();

    // Check if document already exists
    const existing = await this.promptContainer.read(id, userId);

    const doc: PromptDocument = {
      id,
      userId,
      agentId,
      documentType,
      data,
      version: existing ? existing.version + 1 : 1,
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    };

    const result = await this.promptContainer.upsert(doc);

    // Invalidate cache for this user+agent
    this.invalidateCache(userId, agentId);
    console.log(
      `${LOG_PREFIX} Upserted ${documentType} for ${redactId(userId)}:${agentId} (v${doc.version})`,
    );

    return result;
  }

  /**
   * Partially update fields in a prompt document's data.
   *
   * When the document already exists, uses Cosmos DB's native atomic `patch()`
   * operation — individual field updates are applied server-side in a single
   * write, eliminating read-mutate-upsert race conditions.
   *
   * When the document does not exist, creates it from the default template
   * with the updates merged in.
   *
   * For sub-object fields (e.g., `integrations`, `custom`), performs a
   * shallow merge of sub-keys. Null values in sub-objects delete those
   * sub-keys.
   *
   * Used by the LLM's `prompt_update` tool for field-level edits.
   */
  async patchData<T extends PromptDocumentType>(
    userId: string,
    agentId: string,
    documentType: T,
    updates: Partial<PromptDataMap[T]>,
  ): Promise<PromptDocument> {
    this.ensureInitialized();

    const id = this.buildDocumentId(userId, agentId, documentType);
    const now = new Date().toISOString();

    const existing = await this.promptContainer.read(id, userId);

    if (existing) {
      // ----- Existing document: use Cosmos native atomic patch -----
      const operations: PatchOperation[] = [];
      const existingData = existing.data as Record<string, unknown>;

      for (const [key, value] of Object.entries(updates)) {
        const path = `/data/${key}`;

        if (value === null || value === undefined) {
          // Only remove if the field actually exists (remove on missing path throws)
          if (key in existingData) {
            operations.push({ op: "remove", path });
          }
        } else if (isPlainObject(value) && isPlainObject(existingData[key])) {
          // Deep merge sub-objects (e.g., integrations, custom)
          const mergedSub = {
            ...(existingData[key] as Record<string, unknown>),
            ...(value as Record<string, unknown>),
          };
          // Delete null/undefined sub-keys (#1 fix)
          for (const subKey of Object.keys(mergedSub)) {
            if (mergedSub[subKey] === null || mergedSub[subKey] === undefined) {
              delete mergedSub[subKey];
            }
          }
          operations.push({ op: "set", path, value: mergedSub });
        } else {
          // Scalar, array, or new sub-object — set directly
          operations.push({ op: "set", path, value });
        }
      }

      if (operations.length === 0) {
        return existing; // No-op
      }

      // Atomically increment version and update timestamp
      operations.push({ op: "incr", path: "/version", value: 1 });
      operations.push({ op: "set", path: "/updatedAt", value: now });

      const result = await this.promptContainer.patch(id, userId, operations);
      this.invalidateCache(userId, agentId);
      console.log(
        `${LOG_PREFIX} Patched ${documentType} for ${redactId(userId)}:${agentId}: ${Object.keys(updates).join(", ")}`,
      );
      return result;
    }

    // ----- New document: create from default template + updates -----
    const defaultData = {
      ...(DEFAULT_TEMPLATES[documentType] as PromptDataMap[T]),
    };
    const mergedData = defaultData as Record<string, unknown>;

    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined) {
        delete mergedData[key];
      } else if (isPlainObject(value) && isPlainObject(mergedData[key])) {
        const mergedSub = {
          ...(mergedData[key] as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
        for (const subKey of Object.keys(mergedSub)) {
          if (mergedSub[subKey] === null || mergedSub[subKey] === undefined) {
            delete mergedSub[subKey];
          }
        }
        mergedData[key] = mergedSub;
      } else {
        mergedData[key] = value;
      }
    }

    const doc: PromptDocument = {
      id,
      userId,
      agentId,
      documentType,
      data: mergedData as PromptDataMap[T],
      version: 1,
      updatedAt: now,
      createdAt: now,
    };

    const result = await this.promptContainer.upsert(doc);
    this.invalidateCache(userId, agentId);
    console.log(
      `${LOG_PREFIX} Created ${documentType} for ${redactId(userId)}:${agentId}`,
    );
    return result;
  }

  /**
   * Delete a prompt document.
   *
   * @returns true if deleted, false if not found.
   */
  async deleteDocument(
    userId: string,
    agentId: string,
    documentType: PromptDocumentType,
  ): Promise<boolean> {
    this.ensureInitialized();

    const id = this.buildDocumentId(userId, agentId, documentType);
    const result = await this.promptContainer.delete(id, userId);

    if (result) {
      this.invalidateCache(userId, agentId);
      console.log(
        `${LOG_PREFIX} Deleted ${documentType} for ${redactId(userId)}:${agentId}`,
      );
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Seeding / Onboarding
  // --------------------------------------------------------------------------

  /**
   * Seed default templates for a new user+agent.
   *
   * Only creates documents that don't already exist AND only if onboarding
   * has not been completed. This prevents re-seeding BOOTSTRAP after
   * onboarding (which would restart the onboarding flow).
   *
   * In static prompt mode, existing documents of the locked types are also
   * refreshed to the current template whenever they differ from it — locked
   * types have no write path besides seeding, so a difference can only be an
   * older config's seed (see `isLockedTemplateStale`).
   *
   * @returns Array of document types that were newly seeded.
   */
  async seedDefaults(
    userId: string,
    agentId: string,
  ): Promise<PromptDocumentType[]> {
    this.ensureInitialized();

    // Check if onboarding was already completed — skip seeding BOOTSTRAP
    const onboardingState = await this.getOnboardingState(userId, agentId);
    const onboardingCompleted = onboardingState?.completed === true;

    // When onboarding is disabled in config, treat it the same as completed
    const skipBootstrap = onboardingCompleted || !isOnboardingEnabled();

    const existing = await this.loadAll(userId, agentId);
    const now = new Date().toISOString();

    // Collect documents that need seeding
    const toSeed: { docType: PromptDocumentType; doc: PromptDocument }[] = [];
    const toRepair: { docType: PromptDocumentType; doc: PromptDocument }[] = [];
    const toRefresh: { docType: PromptDocumentType; doc: PromptDocument }[] = [];
    const staleBootstrapIdsToDelete: string[] = [];

    for (const docType of PROMPT_DOCUMENT_ORDER) {
      const existingDoc = existing.get(docType);
      if (existingDoc) {
        if (docType === "BOOTSTRAP" && skipBootstrap) {
          staleBootstrapIdsToDelete.push(existingDoc.id);
          continue;
        }
        const repair = shouldRepairDocumentData(docType, existingDoc.data);
        if (repair || isLockedTemplateStale(docType, existingDoc.data)) {
          (repair ? toRepair : toRefresh).push({
            docType,
            doc: {
              ...existingDoc,
              data: DEFAULT_TEMPLATES[docType] as PromptDataMap[typeof docType],
              version: (existingDoc.version ?? 0) + 1,
              updatedAt: now,
              createdAt: existingDoc.createdAt ?? now,
            },
          });
        }
        continue;
      }

      // Never seed BOOTSTRAP when onboarding is completed or disabled
      if (docType === "BOOTSTRAP" && skipBootstrap) continue;

      const template = DEFAULT_TEMPLATES[docType];
      const id = this.buildDocumentId(userId, agentId, docType);

      toSeed.push({
        docType,
        doc: {
          id,
          userId,
          agentId,
          documentType: docType,
          data: template,
          version: 1,
          updatedAt: now,
          createdAt: now,
        },
      });
    }

    if (
      toSeed.length === 0 &&
      toRepair.length === 0 &&
      toRefresh.length === 0 &&
      staleBootstrapIdsToDelete.length === 0
    ) {
      return [];
    }

    // Upsert all repaired + refreshed + missing documents in parallel (same
    // partition key)
    await Promise.all([
      ...staleBootstrapIdsToDelete.map((id) =>
        this.promptContainer.delete(id, userId),
      ),
      ...toRepair.map(({ doc }) => this.promptContainer.upsert(doc)),
      ...toRefresh.map(({ doc }) => this.promptContainer.upsert(doc)),
      ...toSeed.map(({ doc }) => this.promptContainer.upsert(doc)),
    ]);

    const seeded = toSeed.map(({ docType }) => docType);
    this.invalidateCache(userId, agentId);
    if (toRepair.length > 0) {
      console.warn(
        `${LOG_PREFIX} Repaired ${toRepair.length} malformed defaults for ${redactId(userId)}:${agentId}: ${toRepair
          .map(({ docType }) => docType)
          .join(", ")}`,
      );
    }
    if (toRefresh.length > 0) {
      console.log(
        `${LOG_PREFIX} Refreshed ${toRefresh.length} locked documents to current templates for ${redactId(userId)}:${agentId}: ${toRefresh
          .map(({ docType }) => docType)
          .join(", ")}`,
      );
    }
    if (staleBootstrapIdsToDelete.length > 0) {
      console.warn(
        `${LOG_PREFIX} Removed stale BOOTSTRAP for completed onboarding ${redactId(userId)}:${agentId}`,
      );
    }
    console.log(
      `${LOG_PREFIX} Seeded ${seeded.length} defaults for ${redactId(userId)}:${agentId}: ${seeded.join(", ")}`,
    );

    return seeded;
  }

  /**
   * Get the onboarding state for a user+agent.
   *
   * Onboarding state ID format: `{userId}:{agentId}` (no documentType suffix,
   * since there is exactly one onboarding record per user+agent pair — unlike
   * prompt documents which use `{userId}:{agentId}:{documentType}`).
   */
  async getOnboardingState(
    userId: string,
    agentId: string,
  ): Promise<OnboardingState | null> {
    this.ensureInitialized();

    const id = `${userId}:${agentId}`;
    return this.onboardingContainer.read(id, userId);
  }

  /**
   * Mark onboarding as completed for a user+agent.
   * Also deletes the BOOTSTRAP document (no longer needed).
   */
  async completeOnboarding(userId: string, agentId: string): Promise<void> {
    this.ensureInitialized();

    const now = new Date().toISOString();
    const id = `${userId}:${agentId}`;

    const existing = await this.onboardingContainer.read(id, userId);

    const state: OnboardingState = {
      id,
      userId,
      agentId,
      completed: true,
      completedAt: now,
      createdAt: existing?.createdAt ?? now,
    };

    await this.onboardingContainer.upsert(state);

    // Remove BOOTSTRAP document — it's only for onboarding
    await this.deleteDocument(userId, agentId, "BOOTSTRAP");
    console.log(`${LOG_PREFIX} Onboarding completed for ${redactId(userId)}:${agentId}`);
  }

  /**
   * Check if onboarding is still pending (not completed and BOOTSTRAP exists).
   */
  async isOnboardingPending(userId: string, agentId: string): Promise<boolean> {
    this.ensureInitialized();

    const state = await this.getOnboardingState(userId, agentId);
    if (state?.completed) return false;

    const bootstrap = await this.load(userId, agentId, "BOOTSTRAP");
    return bootstrap !== null;
  }

  // --------------------------------------------------------------------------
  // Cache Management
  // --------------------------------------------------------------------------

  /** Invalidate the in-memory cache for a specific user+agent. */
  invalidateCache(userId: string, agentId: string): void {
    const key = this.buildCacheKey(userId, agentId);
    this.cache.delete(key);
  }

  /** Clear the entire in-memory cache. */
  clearCache(): void {
    this.cache.clear();
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "PromptDocumentStore: not initialized. Call initialize() first.",
      );
    }
  }
}

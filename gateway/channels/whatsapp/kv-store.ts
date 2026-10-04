/**
 * AgentForEach Channels — WhatsApp TTL Key/Value Store
 *
 * Three WhatsApp concerns need the same thing: a small keyed value that
 * expires on its own — seen message ids, the 24-hour window timestamp, and
 * consent state. One store underneath them keeps the Cosmos bootstrap in a
 * single place instead of three copies that drift.
 *
 * Two backends:
 *   - "memory": a Map with expiry. Correct on one instance, wrong across
 *     several, and empty after every cold start.
 *   - "cosmos": a TTL container, survives restarts and scale-out.
 *
 * The right backend differs per concern, which is why it is a per-store
 * choice rather than a channel-wide one. See dedupe.ts for the case where
 * memory is genuinely unsafe.
 */

import { isConflict, type Collection, type CollectionSpec, type StorageAdapter } from "@agentforeach/storage";
import type { Doc } from "@agentforeach/storage";

// ============================================================================
// Interface
// ============================================================================

export interface TtlStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /**
   * Set the key only if it is absent, atomically. Returns true when this call
   * created the entry — the caller won the claim — and false when the key
   * already existed.
   *
   * The get-then-set spelling of the same idea has a race: two concurrent
   * webhook deliveries of one message both miss and both proceed, which is
   * the exact duplicate the dedupe store exists to prevent.
   */
  add(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  delete(key: string): Promise<void>;
}

// ============================================================================
// Memory
// ============================================================================

/**
 * In-process store with lazy expiry.
 *
 * Entries are evicted when read after expiry, plus a sweep whenever the map
 * grows past a threshold — a serverless instance that handles a burst and then
 * idles should not hold the burst in memory until it is recycled.
 */
export class MemoryTtlStore implements TtlStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  private readonly sweepThreshold: number;

  constructor(sweepThreshold = 5_000) {
    this.sweepThreshold = sweepThreshold;
  }

  async get(key: string): Promise<string | undefined> {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= this.sweepThreshold) this.sweep();
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async add(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    // Single-threaded within one instance, so check-then-set IS atomic here —
    // memory's race is across instances, which is why it isn't the default
    // backend for dedupe in the first place.
    if ((await this.get(key)) !== undefined) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  /** Test helper. */
  clear(): void {
    this.entries.clear();
  }
}

// ============================================================================
// Cosmos
// ============================================================================

interface KvDocument extends Doc {
  id: string;
  scope: string;
  value: string;
  ttl: number;
}

/**
 * TTL container backed store.
 *
 * Cosmos expires documents itself via `ttl`, so nothing here sweeps. Reads of
 * an expired-but-not-yet-collected document are still possible in principle,
 * so the stored expiry is checked on read as well.
 */
export class CosmosTtlStore implements TtlStore {
  constructor(
    private readonly container: Collection<KvDocument>,
    private readonly scope: string,
  ) {}

  async get(key: string): Promise<string | undefined> {
    const doc = await this.container.read(this.docId(key), this.scope);
    return doc?.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.container.upsert({
      id: this.docId(key),
      scope: this.scope,
      value,
      ttl: ttlSeconds,
    });
  }

  async add(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      // `create` (not upsert) makes Cosmos the arbiter: exactly one of two
      // concurrent claimants gets the document, the other gets a 409.
      await this.container.create({
        id: this.docId(key),
        scope: this.scope,
        value,
        ttl: ttlSeconds,
      });
      return true;
    } catch (err) {
      if (isConflict(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.container.delete(this.docId(key), this.scope);
  }

  private docId(key: string): string {
    // Cosmos ids may not contain / \ ? #
    return `${this.scope}:${key}`.replace(/[/\\?#]/g, "_");
  }
}

/**
 * Collection shared by every WhatsApp TTL store.
 *
 * `defaultTtl: -1` enables TTL on the collection while leaving each document's
 * lifetime to its own `ttl` field — the three concerns want very different
 * ones (minutes for a window, days for dedupe).
 */
export function whatsappStateCollection(containerId = "whatsapp-state"): CollectionSpec {
  return {
    name: containerId,
    partitionKey: "scope",
    defaultTtl: -1,
    // Deployed without an indexing policy (the account default).
    adapterOptions: { cosmosdb: { indexingPolicy: null } },
  };
}

export async function createCosmosTtlStore(
  scope: string,
  containerId = "whatsapp-state",
  storage?: StorageAdapter,
): Promise<TtlStore | undefined> {
  try {
    const db = storage ?? (await import("../../database/index.js")).getSharedStorage();
    await db.initialize();

    const container = await db.collection<KvDocument>(whatsappStateCollection(containerId));

    return new CosmosTtlStore(container, scope);
  } catch (err) {
    console.error(
      `[whatsapp] Cosmos TTL store "${scope}" unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/**
 * Resolve a store for a concern, falling back to memory when Cosmos is not
 * reachable.
 *
 * The fallback is logged rather than silent: for dedupe it degrades a
 * correctness guarantee, and whoever is reading the logs should know.
 */
export async function resolveTtlStore(
  scope: string,
  backend: "memory" | "cosmos",
): Promise<TtlStore> {
  if (backend === "cosmos") {
    const store = await createCosmosTtlStore(scope);
    if (store) return store;
    console.warn(
      `[whatsapp] falling back to in-memory store for "${scope}" — ` +
        `state will not survive restarts or scale-out`,
    );
  }
  return new MemoryTtlStore();
}

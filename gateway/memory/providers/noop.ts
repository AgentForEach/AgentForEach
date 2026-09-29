/**
 * AgentForEach Memory Layer — No-op Store Provider
 *
 * A silent fallback used when the memory subsystem is disabled.
 * All reads return empty results; writes are silently dropped.
 */

import type {
  MemoryEntry,
  MemorySearchResult,
  MemoryStoreProvider,
} from "../types.js";

// ============================================================================
// No-op Memory Store
// ============================================================================

export class NoopMemoryStore implements MemoryStoreProvider {
  readonly name = "noop";

  async initialize(): Promise<void> {
    /* nothing to set up */
  }

  // -- Write -----------------------------------------------------------------

  async store(
    _text: string,
    _vector: number[],
    _userId: string,
    _category: string,
    _importance: number,
    _source?: string,
    _tags?: string[],
  ): Promise<MemoryEntry> {
    throw new Error(
      "memory: store() called on noop provider — memory is disabled",
    );
  }

  // -- Read / Search ---------------------------------------------------------

  async hybridSearch(
    _queryText: string,
    _queryVector: number[],
    _userId: string,
    _limit: number,
    _categories?: string[],
  ): Promise<MemorySearchResult[]> {
    return [];
  }

  async vectorSearch(
    _queryVector: number[],
    _userId: string,
    _limit: number,
    _categories?: string[],
  ): Promise<MemorySearchResult[]> {
    return [];
  }

  async findDuplicate(
    _vector: number[],
    _userId: string,
  ): Promise<MemoryEntry | null> {
    return null;
  }

  async findByContentHash(
    _text: string,
    _userId: string,
  ): Promise<MemoryEntry | null> {
    return null;
  }

  // -- Delete ----------------------------------------------------------------

  async delete(_id: string, _userId: string): Promise<boolean> {
    return false;
  }

  async deleteBySearch(
    _queryVector: number[],
    _userId: string,
    _limit?: number,
  ): Promise<number> {
    return 0;
  }

  // -- Counts ----------------------------------------------------------------

  async count(_userId: string): Promise<number> {
    return 0;
  }

  async countBySource(_userId: string, _source: string, _since?: string): Promise<number> {
    return 0;
  }

  // -- Maintenance -----------------------------------------------------------

  async touchMemory(_id: string, _userId: string): Promise<void> {
    /* no-op */
  }
}

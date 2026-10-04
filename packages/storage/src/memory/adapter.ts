/**
 * AgentForEach Storage SDK — In-memory adapter
 *
 * A complete adapter held in process memory: every rule of the contract,
 * including TTL, etags, atomic increments, vector and hybrid search. It
 * backs unit tests (with an injectable clock and fault-injection hooks) and
 * single-process local development; data is lost when the process exits.
 *
 * Each operation yields once before taking effect, so concurrent callers
 * interleave as they would against a real database, then applies its check
 * and write without yielding again, so every single-document operation is
 * atomic.
 */

import { randomUUID } from "node:crypto";
import { StorageError } from "../errors.js";
import { bm25Scores, cosineSimilarity, fuseRanks } from "../ranking.js";
import {
  checkCollectionSpec,
  checkPatch,
  checkPatchTargets,
  checkHybridSearch,
  checkQuery,
  checkVectorSearch,
  clone,
  expiresAtMs,
  matches,
  patchDocument,
  prepareReplace,
  prepareWrite,
  project,
  readField,
  sortDocuments,
} from "../semantics.js";
import type {
  Collection,
  CollectionSpec,
  CountQuery,
  Doc,
  HybridSearchQuery,
  PatchOperation,
  Query,
  Selection,
  StorageAdapter,
  StorageCapabilities,
  Stored,
  VectorSearchQuery,
  VectorSearchResult,
  WriteCondition,
} from "../types.js";

/** What an operation hook sees; throw from the hook to inject a fault. */
export type OperationContext = {
  collection: string;
  op: "read" | "create" | "upsert" | "replace" | "patch" | "delete" | "find" | "count" | "vectorSearch" | "hybridSearch";
  id?: string;
  partitionKey?: string;
};

export type OperationHook = (context: OperationContext) => void | Promise<void>;

type Entry = {
  doc: Record<string, unknown>;
  etag: string;
  expiresAt?: number;
};

export class InMemoryCollection<T extends Doc = Doc> implements Collection<T> {
  readonly spec: CollectionSpec;
  private readonly now: () => number;
  /** partition key -> id -> entry. */
  private readonly partitions = new Map<string, Map<string, Entry>>();
  private readonly hooks = new Set<OperationHook>();

  constructor(spec: CollectionSpec, now: () => number) {
    this.spec = clone(spec);
    this.now = now;
  }

  // -- Contract --------------------------------------------------------------

  async read(id: string, partitionKey: string): Promise<Stored<T> | null> {
    await this.runHooks({ op: "read", id, partitionKey });
    const entry = this.live(id, partitionKey);
    return entry ? this.output(entry) : null;
  }

  async create(document: T): Promise<Stored<T>> {
    const { doc, partitionKey } = prepareWrite(this.spec, document);
    const id = doc.id as string;
    await this.runHooks({ op: "create", id, partitionKey });
    if (this.live(id, partitionKey)) {
      throw new StorageError("Conflict", `document "${id}" already exists in partition "${partitionKey}"`);
    }
    return this.output(this.write(doc, partitionKey));
  }

  async upsert(document: T): Promise<Stored<T>> {
    const { doc, partitionKey } = prepareWrite(this.spec, document);
    await this.runHooks({ op: "upsert", id: doc.id as string, partitionKey });
    return this.output(this.write(doc, partitionKey));
  }

  async replace(id: string, partitionKey: string, document: T, condition?: WriteCondition): Promise<Stored<T>> {
    const prepared = prepareReplace(this.spec, id, partitionKey, document);
    await this.runHooks({ op: "replace", id, partitionKey });
    const existing = this.live(id, partitionKey);
    if (!existing) throw new StorageError("NotFound", `document "${id}" not found`);
    this.checkCondition(existing, condition);
    return this.output(this.write(prepared.doc, partitionKey));
  }

  async patch(
    id: string,
    partitionKey: string,
    operations: PatchOperation[],
    condition?: WriteCondition,
  ): Promise<Stored<T>> {
    checkPatch(operations);
    checkPatchTargets(this.spec, operations);
    await this.runHooks({ op: "patch", id, partitionKey });
    const existing = this.live(id, partitionKey);
    if (!existing) throw new StorageError("NotFound", `document "${id}" not found`);
    this.checkCondition(existing, condition);
    const prepared = patchDocument(this.spec, existing.doc, operations);
    return this.output(this.write(prepared.doc, partitionKey));
  }

  async delete(id: string, partitionKey: string, condition?: WriteCondition): Promise<boolean> {
    await this.runHooks({ op: "delete", id, partitionKey });
    const existing = this.live(id, partitionKey);
    if (!existing) return false;
    this.checkCondition(existing, condition);
    this.partitions.get(partitionKey)?.delete(id);
    return true;
  }

  async find<R = Stored<T>>(query: Query = {}): Promise<R[]> {
    checkQuery(query);
    await this.runHooks({ op: "find", partitionKey: query.partitionKey });
    let entries = this.scan(query);
    entries = sortDocuments(entries, query.orderBy, (entry) => entry.doc);
    if (query.limit !== undefined) entries = entries.slice(0, query.limit);
    return entries.map((entry) => this.shape(entry, query.select) as R);
  }

  async count(query: CountQuery = {}): Promise<number> {
    checkQuery(query);
    await this.runHooks({ op: "count", partitionKey: query.partitionKey });
    return this.scan(query).length;
  }

  async vectorSearch<R = Stored<T>>(query: VectorSearchQuery): Promise<VectorSearchResult<R>[]> {
    checkQuery({ partitionKey: query.partitionKey, where: query.where, select: query.select });
    checkVectorSearch(this.spec, query);
    await this.runHooks({ op: "vectorSearch", partitionKey: query.partitionKey });
    const scored: Array<{ entry: Entry; score: number | null }> = [];
    const unscored: Array<{ entry: Entry; score: null }> = [];
    for (const entry of this.scan(query)) {
      const vector = this.vectorOf(entry);
      if (vector) scored.push({ entry, score: cosineSimilarity(query.vector, vector) });
      else unscored.push({ entry, score: null });
    }
    scored.sort((a, b) => (b.score as number) - (a.score as number));
    // Documents without a vector come last, unscored, as on Cosmos.
    return [...scored, ...unscored].slice(0, query.limit).map(({ entry, score }) => ({
      document: this.shape(entry, query.select) as R,
      score,
    }));
  }

  async hybridSearch<R = Stored<T>>(query: HybridSearchQuery): Promise<R[]> {
    checkQuery({ partitionKey: query.partitionKey, where: query.where, select: query.select });
    const weights = checkHybridSearch(this.spec, query);
    await this.runHooks({ op: "hybridSearch", partitionKey: query.partitionKey });
    const candidates = this.scan(query);
    const componentScores = query.rank.map((component) =>
        component.kind === "fullText"
          ? bm25Scores(
              candidates.map((entry) => {
                const text = readField(entry.doc, component.field);
                return typeof text === "string" ? text : "";
              }),
              component.terms,
            )
          : candidates.map((entry) => {
              const vector = this.vectorOf(entry);
              return vector ? cosineSimilarity(component.vector, vector) : -Infinity;
            }),
    );
    return fuseRanks(componentScores, weights)
      .slice(0, query.limit)
      .map((i) => this.shape(candidates[i], query.select) as R);
  }

  // -- Test helpers ----------------------------------------------------------

  /**
   * Run `hook` before every operation on this collection (after it is
   * called, before it takes effect). Throw to inject a fault; write to the
   * collection to simulate a concurrent writer. Returns a remover.
   */
  beforeOperation(hook: OperationHook): () => void {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
  }

  /** A copy of one live document, without running hooks. */
  peek<R = Stored<T>>(id: string, partitionKey: string): R | undefined {
    const entry = this.live(id, partitionKey);
    return entry ? (this.output(entry) as R) : undefined;
  }

  /** Copies of every live document, across partitions. */
  all<R = Stored<T>>(): R[] {
    return this.scan({}).map((entry) => this.output(entry) as R);
  }

  /** Remove every document. */
  clear(): void {
    this.partitions.clear();
  }

  // -- Implementation --------------------------------------------------------

  private async runHooks(context: Omit<OperationContext, "collection">): Promise<void> {
    // Always yield once so concurrent callers interleave as with real I/O.
    await Promise.resolve();
    for (const hook of [...this.hooks]) {
      await hook({ collection: this.spec.name, ...context });
    }
  }

  private isLive(entry: Entry): boolean {
    return entry.expiresAt === undefined || this.now() < entry.expiresAt;
  }

  private live(id: string, partitionKey: string): Entry | undefined {
    const partition = this.partitions.get(partitionKey);
    const entry = partition?.get(id);
    if (!entry) return undefined;
    if (this.isLive(entry)) return entry;
    partition!.delete(id); // expired: collect it
    return undefined;
  }

  private checkCondition(existing: Entry, condition?: WriteCondition): void {
    if (condition?.ifMatch !== undefined && condition.ifMatch !== existing.etag) {
      throw new StorageError("PreconditionFailed", "the document changed since it was read (etag mismatch)");
    }
  }

  private write(doc: Record<string, unknown>, partitionKey: string): Entry {
    const writtenAt = this.now();
    const entry: Entry = {
      doc,
      etag: `"${randomUUID()}"`,
      expiresAt: expiresAtMs(this.spec, doc, writtenAt),
    };
    let partition = this.partitions.get(partitionKey);
    if (!partition) {
      partition = new Map();
      this.partitions.set(partitionKey, partition);
    }
    partition.set(doc.id as string, entry);
    return entry;
  }

  /** Live entries in scope that pass the filter. */
  private scan(query: Pick<Query, "partitionKey" | "where">): Entry[] {
    const partitions =
      query.partitionKey !== undefined
        ? [this.partitions.get(query.partitionKey)].filter((p): p is Map<string, Entry> => p !== undefined)
        : [...this.partitions.values()];
    const out: Entry[] = [];
    for (const partition of partitions) {
      for (const [id, entry] of partition) {
        if (!this.isLive(entry)) {
          partition.delete(id); // expired: collect it
          continue;
        }
        if (matches(query.where, entry.doc)) out.push(entry);
      }
    }
    return out;
  }

  private vectorOf(entry: Entry): number[] | undefined {
    const policy = this.spec.vector;
    if (!policy) return undefined;
    const vector = readField(entry.doc, policy.field);
    return Array.isArray(vector) &&
      vector.length === policy.dimensions &&
      vector.every((x) => typeof x === "number")
      ? (vector as number[])
      : undefined;
  }

  private output(entry: Entry): Stored<T> {
    return { ...clone(entry.doc), _etag: entry.etag } as Stored<T>;
  }

  private shape(entry: Entry, select: Selection[] | undefined): unknown {
    return select ? project(this.output(entry), select) : this.output(entry);
  }
}

export type InMemoryStorageOptions = {
  /** Clock in epoch milliseconds (TTL). Default: `Date.now()` at each call. */
  now?: () => number;
};

/**
 * In-memory `StorageAdapter`. Collections are created on first use (the
 * first definition wins) and shared by every caller of the same name.
 */
export class InMemoryStorage implements StorageAdapter {
  readonly name = "memory";
  readonly capabilities: StorageCapabilities = { vectorSearch: true, hybridSearch: true };
  private readonly now: () => number;
  private readonly collections = new Map<string, InMemoryCollection>();

  constructor(options: InMemoryStorageOptions = {}) {
    // Late-bound, so a mocked clock (node:test mock.timers) also drives TTL.
    this.now = options.now ?? (() => Date.now());
  }

  async initialize(): Promise<void> {}

  async collection<T extends Doc = Doc>(spec: CollectionSpec): Promise<InMemoryCollection<T>> {
    checkCollectionSpec(spec);
    let collection = this.collections.get(spec.name);
    if (!collection) {
      collection = new InMemoryCollection(spec, this.now);
      this.collections.set(spec.name, collection);
    }
    return collection as unknown as InMemoryCollection<T>;
  }

  /** A collection created so far, for test inspection; throws if missing. */
  getCollection<T extends Doc = Doc>(name: string): InMemoryCollection<T> {
    const collection = this.collections.get(name);
    if (!collection) throw new Error(`in-memory storage: no collection "${name}" (not created yet?)`);
    return collection as unknown as InMemoryCollection<T>;
  }
}

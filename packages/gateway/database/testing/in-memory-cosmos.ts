/**
 * AgentForEach Database Layer — In-Memory Cosmos Fake (test support)
 *
 * An in-memory `DatabaseProvider` whose containers behave like Cosmos DB
 * closely enough to test code that goes below `ContainerHandle` to the raw
 * `@azure/cosmos` Container (optimistic concurrency, partition-scoped
 * queries). `getRawContainer()` returns a fake of the Container subset the
 * repo uses:
 *
 *   raw.item(id, pk).read() / .replace(doc, opts) / .patch(ops, opts) / .delete(opts)
 *   raw.items.create(doc) / .upsert(doc, opts)
 *   raw.items.query(spec, { partitionKey? }).fetchAll() / .fetchNext()
 *
 * Cosmos behaviour kept:
 *   - documents live per partition (key path from the container definition);
 *     one id may exist in two partitions;
 *   - every write stores a JSON copy (undefined fields vanish) and assigns a
 *     new `_etag` and `_ts`;
 *   - `accessCondition: { type: "IfMatch" | "IfNoneMatch", condition }`,
 *     failing with 412;
 *   - errors carry `code` and `statusCode`: 404 (missing item on
 *     replace/patch/delete), 409 (create of an existing id), 412
 *     (precondition), 400 (partition key or id mismatch);
 *   - `item.read()` of a missing item resolves with `resource: undefined`
 *     (the SDK swallows the 404 there);
 *   - TTL: with a container `defaultTtl` set, documents older than their
 *     `ttl` (or the default; -1 = never) are invisible, measured with
 *     `Date.now()`, so mocked clocks expire them.
 *
 * Queries: a small evaluator for the SQL the stores issue, not a general
 * engine. Supported:
 *
 *   SELECT [TOP n|@p] { * | VALUE COUNT(1) | VALUE expr | expr [AS a], ... }
 *   FROM <alias> [WHERE expr] [ORDER BY <path> [ASC|DESC]]
 *
 *   expr: AND / OR / NOT, = != <> < <= > >=, + - * / %, parentheses,
 *         literals (numbers, 'strings', "strings", true, false, null),
 *         @parameters, property paths (c.a.b, c["a"]), and the functions
 *         IS_DEFINED, IS_NULL, IS_NUMBER, IS_STRING, IS_BOOL, ARRAY_CONTAINS.
 *
 * Semantics follow Cosmos' three-valued logic: comparisons involving an
 * undefined value are undefined, `<`-style comparisons across types are
 * undefined, and WHERE keeps only rows that evaluate to exactly `true`.
 * Equality across types is false (so `5 != null` is true): the stores rely
 * on `c.nextRunAtMs != null`-style filters. ORDER BY keeps rows whose
 * property is undefined and sorts types undefined < null < boolean <
 * number < string < array < object.
 *
 * Anything else (JOIN, OFFSET/LIMIT, DISTINCT, GROUP BY, IN, other
 * functions, multi-field ORDER BY) throws `UnsupportedQueryError`, so a test
 * fails loudly rather than silently returning the wrong rows.
 */

import { randomUUID } from "node:crypto";
import type {
  BaseDocument,
  ContainerHandle,
  ContainerOptions,
  DatabaseProvider,
  PatchOperation,
  QueryOptions,
  QueryParameter,
  SqlQuerySpec,
} from "../types.js";

// ============================================================================
// Errors
// ============================================================================

/** An error shaped like an @azure/cosmos ErrorResponse. */
export class CosmosLikeError extends Error {
  readonly code: number;
  readonly statusCode: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "CosmosLikeError";
    this.code = code;
    this.statusCode = code;
  }
}

/** Thrown for SQL the in-memory evaluator doesn't implement. */
export class UnsupportedQueryError extends Error {
  constructor(message: string, query: string) {
    super(`in-memory cosmos: unsupported query (${message}): ${query}`);
    this.name = "UnsupportedQueryError";
  }
}

// ============================================================================
// Types
// ============================================================================

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type StoredDoc = Record<string, Json>;

export type AccessCondition = { type: "IfMatch" | "IfNoneMatch"; condition: string };
export type RequestOptions = { accessCondition?: AccessCondition };
export type FeedOptions = { partitionKey?: unknown };

/** What an operation hook sees; throw from the hook to inject a fault. */
export type OperationContext = {
  container: string;
  op: "read" | "create" | "upsert" | "replace" | "patch" | "delete" | "query";
  id?: string;
  partitionKey?: unknown;
};
export type OperationHook = (ctx: OperationContext) => void | Promise<void>;

type ItemResponse<T> = {
  resource: T | undefined;
  statusCode: number;
  etag?: string;
};

// ============================================================================
// Raw container fake (the @azure/cosmos Container subset)
// ============================================================================

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function pkKey(value: unknown): string {
  // Cosmos distinguishes "1" from 1; undefined is the "none" partition.
  return value === undefined ? "<none>" : JSON.stringify(value);
}

function readPath(doc: unknown, segments: string[]): unknown {
  let cursor: unknown = doc;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export class FakeCosmosContainer {
  readonly id: string;
  private readonly pkPath: string[];
  private readonly defaultTtl?: number;
  /** partition key -> id -> document (with system properties). */
  private readonly partitions = new Map<string, Map<string, StoredDoc>>();
  private readonly hooks = new Set<OperationHook>();

  constructor(options: ContainerOptions) {
    this.id = options.id ?? "container";
    const path = options.partitionKey?.paths?.[0] ?? "/id";
    this.pkPath = path.replace(/^\//, "").split("/").filter(Boolean);
    this.defaultTtl = options.defaultTtl;
  }

  // -- The SDK surface -------------------------------------------------------

  item(id: string, partitionKey: unknown) {
    return {
      read: <T>(): Promise<ItemResponse<T>> => this.readItem<T>(id, partitionKey),
      replace: <T>(body: T, options?: RequestOptions): Promise<ItemResponse<T>> =>
        this.replaceItem<T>(id, partitionKey, body, options),
      patch: <T>(
        operations: PatchOperation[] | { operations: PatchOperation[] },
        options?: RequestOptions,
      ): Promise<ItemResponse<T>> => {
        if (!Array.isArray(operations) && (operations as { condition?: string }).condition) {
          // Conditional patch (a SQL filter) isn't modelled; fail loudly
          // rather than apply the patch unconditionally.
          throw new CosmosLikeError(400, "Bad Request: patch conditions are not supported by the in-memory harness");
        }
        return this.patchItem<T>(
          id,
          partitionKey,
          Array.isArray(operations) ? operations : operations.operations,
          options,
        );
      },
      delete: <T>(options?: RequestOptions): Promise<ItemResponse<T>> =>
        this.deleteItem<T>(id, partitionKey, options),
    };
  }

  get items() {
    return {
      create: <T>(body: T): Promise<ItemResponse<T>> => this.createItem<T>(body),
      upsert: <T>(body: T, options?: RequestOptions): Promise<ItemResponse<T>> =>
        this.upsertItem<T>(body, options),
      query: <T>(spec: string | SqlQuerySpec, options?: FeedOptions) =>
        this.queryIterator<T>(typeof spec === "string" ? { query: spec } : spec, options),
    };
  }

  // -- Test helpers ----------------------------------------------------------

  /**
   * Run `hook` before every operation on this container (after it is
   * called, before it takes effect). Throw to inject a fault; write to the
   * container to simulate a concurrent writer. Returns a remover.
   */
  beforeOperation(hook: OperationHook): () => void {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
  }

  /** A copy of one live document (with system properties), or undefined. */
  peek<T = StoredDoc>(id: string, partitionKey: unknown): T | undefined {
    const doc = this.live(this.partitions.get(pkKey(partitionKey))?.get(id));
    return clone(doc) as T | undefined;
  }

  /** Copies of all live documents, across partitions. */
  all<T = StoredDoc>(): T[] {
    const out: T[] = [];
    for (const partition of this.partitions.values()) {
      for (const doc of partition.values()) {
        if (this.live(doc)) out.push(clone(doc) as T);
      }
    }
    return out;
  }

  /** Remove every document. */
  clear(): void {
    this.partitions.clear();
  }

  // -- Implementation --------------------------------------------------------

  private async runHooks(ctx: Omit<OperationContext, "container">): Promise<void> {
    // Always yield once so concurrent callers interleave as with real I/O.
    await Promise.resolve();
    for (const hook of [...this.hooks]) {
      await hook({ container: this.id, ...ctx });
    }
  }

  private partitionKeyOf(body: unknown): unknown {
    return readPath(body, this.pkPath);
  }

  private live(doc: StoredDoc | undefined): StoredDoc | undefined {
    // No container TTL: item ttl values are ignored, as in Cosmos.
    if (!doc || this.defaultTtl === undefined || this.defaultTtl === null) return doc;
    const ttl = typeof doc.ttl === "number" ? doc.ttl : this.defaultTtl;
    if (ttl === -1) return doc;
    const ts = typeof doc._ts === "number" ? doc._ts : 0;
    return Date.now() / 1000 >= ts + ttl ? undefined : doc;
  }

  private getLive(id: string, partitionKey: unknown): StoredDoc | undefined {
    return this.live(this.partitions.get(pkKey(partitionKey))?.get(id));
  }

  private checkCondition(existing: StoredDoc | undefined, options?: RequestOptions): void {
    const condition = options?.accessCondition;
    if (!condition) return;
    const etag = existing?._etag;
    if (condition.type === "IfMatch") {
      if (!existing || etag !== condition.condition) {
        throw new CosmosLikeError(412, "Precondition Failed: etag mismatch");
      }
    } else if (condition.type === "IfNoneMatch") {
      if (existing && (condition.condition === "*" || etag === condition.condition)) {
        throw new CosmosLikeError(412, "Precondition Failed: item matches IfNoneMatch");
      }
    } else {
      throw new Error(`in-memory cosmos: unsupported access condition ${JSON.stringify(condition)}`);
    }
  }

  private store(body: unknown): StoredDoc {
    const doc = clone(body) as StoredDoc;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new CosmosLikeError(400, "Bad Request: document must be an object");
    }
    if (typeof doc.id !== "string" || doc.id.length === 0) {
      throw new CosmosLikeError(400, "Bad Request: document id is required");
    }
    doc._etag = `"${randomUUID()}"`;
    doc._ts = Math.floor(Date.now() / 1000);
    const key = pkKey(this.partitionKeyOf(doc));
    let partition = this.partitions.get(key);
    if (!partition) {
      partition = new Map();
      this.partitions.set(key, partition);
    }
    partition.set(doc.id, doc);
    return doc;
  }

  private remove(id: string, partitionKey: unknown): void {
    this.partitions.get(pkKey(partitionKey))?.delete(id);
  }

  private response<T>(doc: StoredDoc | undefined, statusCode: number): ItemResponse<T> {
    return {
      resource: clone(doc) as T | undefined,
      statusCode,
      etag: doc?._etag as string | undefined,
    };
  }

  private async readItem<T>(id: string, partitionKey: unknown): Promise<ItemResponse<T>> {
    await this.runHooks({ op: "read", id, partitionKey });
    const doc = this.getLive(id, partitionKey);
    return doc ? this.response<T>(doc, 200) : { resource: undefined, statusCode: 404 };
  }

  private async createItem<T>(body: T): Promise<ItemResponse<T>> {
    const id = (body as { id?: string }).id;
    const partitionKey = this.partitionKeyOf(body);
    await this.runHooks({ op: "create", id, partitionKey });
    if (typeof id === "string" && this.getLive(id, partitionKey)) {
      throw new CosmosLikeError(409, "Conflict: an item with this id already exists");
    }
    return this.response<T>(this.store(body), 201);
  }

  private async upsertItem<T>(body: T, options?: RequestOptions): Promise<ItemResponse<T>> {
    const id = (body as { id?: string }).id;
    const partitionKey = this.partitionKeyOf(body);
    await this.runHooks({ op: "upsert", id, partitionKey });
    const existing = typeof id === "string" ? this.getLive(id, partitionKey) : undefined;
    this.checkCondition(existing, options);
    return this.response<T>(this.store(body), existing ? 200 : 201);
  }

  private async replaceItem<T>(
    id: string,
    partitionKey: unknown,
    body: T,
    options?: RequestOptions,
  ): Promise<ItemResponse<T>> {
    await this.runHooks({ op: "replace", id, partitionKey });
    const existing = this.getLive(id, partitionKey);
    if (!existing) throw new CosmosLikeError(404, "Not Found");
    this.checkCondition(existing, options);
    if ((body as { id?: unknown }).id !== id) {
      throw new CosmosLikeError(400, "Bad Request: body id does not match the item id");
    }
    if (pkKey(this.partitionKeyOf(body)) !== pkKey(partitionKey)) {
      throw new CosmosLikeError(400, "Bad Request: partition key in body does not match the request");
    }
    return this.response<T>(this.store(body), 200);
  }

  private async patchItem<T>(
    id: string,
    partitionKey: unknown,
    operations: PatchOperation[],
    options?: RequestOptions,
  ): Promise<ItemResponse<T>> {
    await this.runHooks({ op: "patch", id, partitionKey });
    const existing = this.getLive(id, partitionKey);
    if (!existing) throw new CosmosLikeError(404, "Not Found");
    this.checkCondition(existing, options);
    const doc = clone(existing);
    for (const operation of operations) applyPatch(doc, operation);
    if (pkKey(this.partitionKeyOf(doc)) !== pkKey(partitionKey)) {
      throw new CosmosLikeError(400, "Bad Request: patch may not change the partition key");
    }
    return this.response<T>(this.store(doc), 200);
  }

  private async deleteItem<T>(
    id: string,
    partitionKey: unknown,
    options?: RequestOptions,
  ): Promise<ItemResponse<T>> {
    await this.runHooks({ op: "delete", id, partitionKey });
    const existing = this.getLive(id, partitionKey);
    if (!existing) throw new CosmosLikeError(404, "Not Found");
    this.checkCondition(existing, options);
    this.remove(id, partitionKey);
    return { resource: undefined, statusCode: 204 };
  }

  private queryIterator<T>(spec: SqlQuerySpec, options?: FeedOptions) {
    let done = false;
    const run = async (): Promise<T[]> => {
      await this.runHooks({ op: "query", partitionKey: options?.partitionKey });
      const hasPk = options !== undefined && "partitionKey" in options && options.partitionKey !== undefined;
      const docs: StoredDoc[] = [];
      const partitions = hasPk
        ? [this.partitions.get(pkKey(options!.partitionKey))].filter(
            (p): p is Map<string, StoredDoc> => p !== undefined,
          )
        : [...this.partitions.values()];
      for (const partition of partitions) {
        for (const doc of partition.values()) {
          if (this.live(doc)) docs.push(doc);
        }
      }
      return runQuery(spec, docs) as T[];
    };
    return {
      fetchAll: async () => {
        const resources = await run();
        done = true;
        return { resources, hasMoreResults: false };
      },
      fetchNext: async () => {
        if (done) return { resources: [] as T[], hasMoreResults: false };
        const resources = await run();
        done = true;
        return { resources, hasMoreResults: false };
      },
      hasMoreResults: () => !done,
    };
  }
}

function applyPatch(doc: StoredDoc, operation: PatchOperation): void {
  const segments = operation.path.replace(/^\//, "").split("/").filter(Boolean);
  if (segments.length === 0) throw new CosmosLikeError(400, "Bad Request: empty patch path");
  const last = segments[segments.length - 1];
  let parent: Record<string, Json> = doc;
  for (const segment of segments.slice(0, -1)) {
    const next = parent[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      throw new CosmosLikeError(400, `Bad Request: patch path ${operation.path} not found`);
    }
    parent = next as Record<string, Json>;
  }
  const value = "value" in operation ? (clone(operation.value) as Json) : undefined;
  switch (operation.op) {
    case "add":
    case "set":
      parent[last] = value as Json;
      return;
    case "replace":
      if (!(last in parent)) throw new CosmosLikeError(400, `Bad Request: ${operation.path} not found`);
      parent[last] = value as Json;
      return;
    case "remove":
      if (!(last in parent)) throw new CosmosLikeError(400, `Bad Request: ${operation.path} not found`);
      delete parent[last];
      return;
    case "incr": {
      const current = parent[last] ?? 0;
      if (typeof current !== "number" || typeof value !== "number") {
        throw new CosmosLikeError(400, `Bad Request: incr on a non-number at ${operation.path}`);
      }
      parent[last] = current + value;
      return;
    }
    default:
      throw new Error(`in-memory cosmos: unsupported patch op "${(operation as { op: string }).op}"`);
  }
}

// ============================================================================
// SQL subset
// ============================================================================

type Token =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "param"; value: string }
  | { type: "ident"; value: string }
  | { type: "op"; value: string };

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?/.exec(sql.slice(i))!;
      tokens.push({ type: "num", value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let value = "";
      while (j < sql.length && sql[j] !== ch) {
        if (sql[j] === "\\" && j + 1 < sql.length) {
          value += sql[j + 1];
          j += 2;
        } else {
          value += sql[j++];
        }
      }
      if (j >= sql.length) throw new UnsupportedQueryError("unterminated string", sql);
      tokens.push({ type: "str", value });
      i = j + 1;
      continue;
    }
    if (ch === "@") {
      const match = /^@[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
      if (!match) throw new UnsupportedQueryError("bad parameter name", sql);
      tokens.push({ type: "param", value: match[0] });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))!;
      tokens.push({ type: "ident", value: match[0] });
      i += match[0].length;
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (["!=", "<>", "<=", ">="].includes(two)) {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if ("()[],.*=<>%+-/".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    throw new UnsupportedQueryError(`unexpected character "${ch}"`, sql);
  }
  return tokens;
}

type Expr =
  | { kind: "literal"; value: unknown }
  | { kind: "param"; name: string }
  | { kind: "path"; segments: string[] }
  | { kind: "not"; operand: Expr }
  | { kind: "neg"; operand: Expr }
  | { kind: "logic"; op: "AND" | "OR"; left: Expr; right: Expr }
  | { kind: "compare"; op: string; left: Expr; right: Expr }
  | { kind: "arith"; op: string; left: Expr; right: Expr }
  | { kind: "call"; name: string; args: Expr[] };

type Projection =
  | { kind: "star" }
  | { kind: "count" }
  | { kind: "value"; expr: Expr }
  | { kind: "fields"; fields: Array<{ expr: Expr; alias: string }> };

type ParsedQuery = {
  top?: Expr;
  projection: Projection;
  alias: string;
  where?: Expr;
  orderBy?: { path: string[]; descending: boolean };
};

const UNSUPPORTED_KEYWORDS = new Set([
  "JOIN",
  "OFFSET",
  "LIMIT",
  "DISTINCT",
  "GROUP",
  "IN",
  "BETWEEN",
  "LIKE",
  "EXISTS",
  "HAVING",
]);
const SUPPORTED_FUNCTIONS = new Set([
  "IS_DEFINED",
  "IS_NULL",
  "IS_NUMBER",
  "IS_STRING",
  "IS_BOOL",
  "ARRAY_CONTAINS",
]);

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly sql: string,
  ) {}

  private fail(message: string): never {
    throw new UnsupportedQueryError(message, this.sql);
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private isKeyword(word: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.type === "ident" && token.value.toUpperCase() === word;
  }

  private isOp(value: string): boolean {
    const token = this.peek();
    return token?.type === "op" && token.value === value;
  }

  private takeKeyword(word: string): boolean {
    if (this.isKeyword(word)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectKeyword(word: string): void {
    if (!this.takeKeyword(word)) this.fail(`expected ${word}`);
  }

  private takeOp(value: string): boolean {
    if (this.isOp(value)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectOp(value: string): void {
    if (!this.takeOp(value)) this.fail(`expected "${value}"`);
  }

  private identifier(): string {
    const token = this.peek();
    if (token?.type !== "ident") this.fail("expected an identifier");
    this.pos++;
    return token.value;
  }

  parseQuery(): ParsedQuery {
    for (const token of this.tokens) {
      if (token.type === "ident" && UNSUPPORTED_KEYWORDS.has(token.value.toUpperCase())) {
        this.fail(`${token.value.toUpperCase()} is not implemented`);
      }
    }
    this.expectKeyword("SELECT");
    let top: Expr | undefined;
    if (this.takeKeyword("TOP")) {
      const token = this.peek();
      if (token?.type === "num") top = { kind: "literal", value: token.value };
      else if (token?.type === "param") top = { kind: "param", name: token.value };
      else this.fail("TOP needs a number or parameter");
      this.pos++;
    }

    let projection: Projection;
    if (this.takeOp("*")) {
      projection = { kind: "star" };
    } else if (this.takeKeyword("VALUE")) {
      if (this.isKeyword("COUNT") && this.peek(1)?.type === "op") {
        this.pos++;
        this.expectOp("(");
        const arg = this.peek();
        if (arg?.type !== "num" || arg.value !== 1) this.fail("only COUNT(1) is implemented");
        this.pos++;
        this.expectOp(")");
        projection = { kind: "count" };
      } else {
        projection = { kind: "value", expr: this.expression() };
      }
    } else {
      const fields: Array<{ expr: Expr; alias: string }> = [];
      do {
        const expr = this.expression();
        let alias: string | undefined;
        if (this.takeKeyword("AS")) alias = this.identifier();
        if (!alias && expr.kind === "path" && expr.segments.length > 0) {
          alias = expr.segments[expr.segments.length - 1];
        }
        fields.push({ expr, alias: alias ?? `$${fields.length + 1}` });
      } while (this.takeOp(","));
      projection = { kind: "fields", fields };
    }

    this.expectKeyword("FROM");
    const alias = this.identifier();

    let where: Expr | undefined;
    if (this.takeKeyword("WHERE")) where = this.expression();

    let orderBy: ParsedQuery["orderBy"];
    if (this.takeKeyword("ORDER")) {
      this.expectKeyword("BY");
      const expr = this.expression();
      if (expr.kind !== "path") this.fail("ORDER BY needs a property path");
      let descending = false;
      if (this.takeKeyword("DESC")) descending = true;
      else this.takeKeyword("ASC");
      if (this.isOp(",")) this.fail("multi-field ORDER BY is not implemented");
      orderBy = { path: expr.segments, descending };
    }

    if (this.pos < this.tokens.length) this.fail("unexpected trailing tokens");

    const rebase = (expr: Expr): Expr => rebaseAlias(expr, alias, this.sql);
    return {
      top,
      alias,
      projection:
        projection.kind === "value"
          ? { kind: "value", expr: rebase(projection.expr) }
          : projection.kind === "fields"
            ? {
                kind: "fields",
                fields: projection.fields.map((f) => ({ expr: rebase(f.expr), alias: f.alias })),
              }
            : projection,
      where: where ? rebase(where) : undefined,
      orderBy: orderBy
        ? {
            path: (rebase({ kind: "path", segments: orderBy.path }) as { segments: string[] }).segments,
            descending: orderBy.descending,
          }
        : undefined,
    };
  }

  // expression := or
  expression(): Expr {
    return this.or();
  }

  private or(): Expr {
    let left = this.and();
    while (this.takeKeyword("OR")) left = { kind: "logic", op: "OR", left, right: this.and() };
    return left;
  }

  private and(): Expr {
    let left = this.not();
    while (this.takeKeyword("AND")) left = { kind: "logic", op: "AND", left, right: this.not() };
    return left;
  }

  private not(): Expr {
    if (this.takeKeyword("NOT")) return { kind: "not", operand: this.not() };
    return this.comparison();
  }

  private comparison(): Expr {
    const left = this.additive();
    const token = this.peek();
    if (token?.type === "op" && ["=", "!=", "<>", "<", "<=", ">", ">="].includes(token.value)) {
      this.pos++;
      const op = token.value === "<>" ? "!=" : token.value;
      return { kind: "compare", op, left, right: this.additive() };
    }
    return left;
  }

  private additive(): Expr {
    let left = this.multiplicative();
    for (;;) {
      const token = this.peek();
      if (token?.type === "op" && (token.value === "+" || token.value === "-")) {
        this.pos++;
        left = { kind: "arith", op: token.value, left, right: this.multiplicative() };
      } else {
        return left;
      }
    }
  }

  private multiplicative(): Expr {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (token?.type === "op" && ["*", "/", "%"].includes(token.value)) {
        this.pos++;
        left = { kind: "arith", op: token.value, left, right: this.unary() };
      } else {
        return left;
      }
    }
  }

  private unary(): Expr {
    if (this.takeOp("-")) return { kind: "neg", operand: this.unary() };
    return this.primary();
  }

  private primary(): Expr {
    const token = this.peek();
    if (!token) this.fail("unexpected end of query");
    if (token.type === "num") {
      this.pos++;
      return { kind: "literal", value: token.value };
    }
    if (token.type === "str") {
      this.pos++;
      return { kind: "literal", value: token.value };
    }
    if (token.type === "param") {
      this.pos++;
      return { kind: "param", name: token.value };
    }
    if (token.type === "op" && token.value === "(") {
      this.pos++;
      const inner = this.expression();
      this.expectOp(")");
      return inner;
    }
    if (token.type === "ident") {
      const upper = token.value.toUpperCase();
      if (upper === "TRUE" || upper === "FALSE") {
        this.pos++;
        return { kind: "literal", value: upper === "TRUE" };
      }
      if (upper === "NULL") {
        this.pos++;
        return { kind: "literal", value: null };
      }
      if (upper === "UNDEFINED") {
        this.pos++;
        return { kind: "literal", value: undefined };
      }
      const next = this.peek(1);
      if (next?.type === "op" && next.value === "(") {
        if (!SUPPORTED_FUNCTIONS.has(upper)) this.fail(`function ${token.value} is not implemented`);
        this.pos += 2;
        const args: Expr[] = [];
        if (!this.isOp(")")) {
          do args.push(this.expression());
          while (this.takeOp(","));
        }
        this.expectOp(")");
        return { kind: "call", name: upper, args };
      }
      this.pos++;
      const segments = [token.value];
      for (;;) {
        if (this.takeOp(".")) {
          segments.push(this.identifier());
        } else if (this.isOp("[")) {
          this.pos++;
          const key = this.peek();
          if (key?.type === "str") segments.push(key.value);
          else if (key?.type === "num") segments.push(String(key.value));
          else this.fail("only literal [\"property\"] / [index] access is implemented");
          this.pos++;
          this.expectOp("]");
        } else {
          break;
        }
      }
      return { kind: "path", segments };
    }
    this.fail(`unexpected token "${token.value}"`);
  }
}

/** Strip the FROM alias off property paths (c.userId -> ["userId"]). */
function rebaseAlias(expr: Expr, alias: string, sql: string): Expr {
  switch (expr.kind) {
    case "path":
      if (expr.segments[0] !== alias) {
        throw new UnsupportedQueryError(`"${expr.segments.join(".")}" is not rooted at ${alias}`, sql);
      }
      return { kind: "path", segments: expr.segments.slice(1) };
    case "not":
    case "neg":
      return { ...expr, operand: rebaseAlias(expr.operand, alias, sql) };
    case "logic":
    case "compare":
    case "arith":
      return {
        ...expr,
        left: rebaseAlias(expr.left, alias, sql),
        right: rebaseAlias(expr.right, alias, sql),
      };
    case "call":
      return { ...expr, args: expr.args.map((arg) => rebaseAlias(arg, alias, sql)) };
    default:
      return expr;
  }
}

function typeRank(value: unknown): number {
  if (value === undefined) return 0;
  if (value === null) return 1;
  if (typeof value === "boolean") return 2;
  if (typeof value === "number") return 3;
  if (typeof value === "string") return 4;
  if (Array.isArray(value)) return 5;
  return 6;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function evaluate(expr: Expr, doc: StoredDoc, params: Map<string, unknown>, sql: string): unknown {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "param":
      if (!params.has(expr.name)) throw new UnsupportedQueryError(`missing parameter ${expr.name}`, sql);
      return params.get(expr.name);
    case "path":
      return readPath(doc, expr.segments);
    case "not": {
      const value = evaluate(expr.operand, doc, params, sql);
      return typeof value === "boolean" ? !value : undefined;
    }
    case "neg": {
      const value = evaluate(expr.operand, doc, params, sql);
      return typeof value === "number" ? -value : undefined;
    }
    case "logic": {
      const left = evaluate(expr.left, doc, params, sql);
      const right = evaluate(expr.right, doc, params, sql);
      if (expr.op === "AND") {
        if (left === false || right === false) return false;
        return left === true && right === true ? true : undefined;
      }
      if (left === true || right === true) return true;
      return left === false && right === false ? false : undefined;
    }
    case "compare": {
      const left = evaluate(expr.left, doc, params, sql);
      const right = evaluate(expr.right, doc, params, sql);
      if (left === undefined || right === undefined) return undefined;
      if (expr.op === "=") return typeRank(left) === typeRank(right) && deepEqual(left, right);
      if (expr.op === "!=") return !(typeRank(left) === typeRank(right) && deepEqual(left, right));
      const comparable =
        typeRank(left) === typeRank(right) &&
        (typeof left === "number" || typeof left === "string" || typeof left === "boolean");
      if (!comparable) return undefined;
      const a = left as number | string | boolean;
      const b = right as number | string | boolean;
      switch (expr.op) {
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
      }
      throw new UnsupportedQueryError(`operator ${expr.op}`, sql);
    }
    case "arith": {
      const left = evaluate(expr.left, doc, params, sql);
      const right = evaluate(expr.right, doc, params, sql);
      if (typeof left !== "number" || typeof right !== "number") return undefined;
      switch (expr.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
        case "%":
          return left % right;
      }
      throw new UnsupportedQueryError(`operator ${expr.op}`, sql);
    }
    case "call": {
      const args = expr.args.map((arg) => evaluate(arg, doc, params, sql));
      switch (expr.name) {
        case "IS_DEFINED":
          return args[0] !== undefined;
        case "IS_NULL":
          return args[0] === null;
        case "IS_NUMBER":
          return typeof args[0] === "number";
        case "IS_STRING":
          return typeof args[0] === "string";
        case "IS_BOOL":
          return typeof args[0] === "boolean";
        case "ARRAY_CONTAINS": {
          const [array, needle, partial] = args;
          if (!Array.isArray(array)) return undefined;
          if (partial === true && needle && typeof needle === "object") {
            return array.some(
              (item) =>
                item !== null &&
                typeof item === "object" &&
                Object.entries(needle as Record<string, unknown>).every(([k, v]) =>
                  deepEqual((item as Record<string, unknown>)[k], v),
                ),
            );
          }
          return array.some((item) => typeRank(item) === typeRank(needle) && deepEqual(item, needle));
        }
      }
      throw new UnsupportedQueryError(`function ${expr.name}`, sql);
    }
  }
}

function compareForOrder(a: unknown, b: unknown): number {
  const rankDiff = typeRank(a) - typeRank(b);
  if (rankDiff !== 0) return rankDiff;
  if (typeof a === "number" || typeof a === "string" || typeof a === "boolean") {
    return a < (b as typeof a) ? -1 : a > (b as typeof a) ? 1 : 0;
  }
  return 0;
}

const parsedCache = new Map<string, ParsedQuery>();

function parse(sql: string): ParsedQuery {
  let parsed = parsedCache.get(sql);
  if (!parsed) {
    parsed = new Parser(tokenize(sql), sql).parseQuery();
    parsedCache.set(sql, parsed);
  }
  return parsed;
}

/**
 * Evaluate a query over documents. Exported so tests can check the
 * evaluator directly; containers call it for `items.query()`.
 */
export function runQuery(spec: SqlQuerySpec, docs: readonly Record<string, unknown>[]): unknown[] {
  const sql = spec.query;
  const query = parse(sql);
  const params = new Map<string, unknown>(
    (spec.parameters ?? []).map((p) => [p.name, p.value as unknown]),
  );

  let rows = docs.filter(
    (doc) => !query.where || evaluate(query.where, doc as StoredDoc, params, sql) === true,
  );

  if (query.projection.kind === "count") return [rows.length];

  if (query.orderBy) {
    const { path, descending } = query.orderBy;
    rows = [...rows].sort((a, b) => {
      const order = compareForOrder(readPath(a, path), readPath(b, path));
      return descending ? -order : order;
    });
  }

  if (query.top) {
    const top = evaluate(query.top, {}, params, sql);
    if (typeof top !== "number" || !Number.isInteger(top) || top < 0) {
      throw new UnsupportedQueryError("TOP must be a non-negative integer", sql);
    }
    rows = rows.slice(0, top);
  }

  const projection = query.projection;
  switch (projection.kind) {
    case "star":
      return rows.map((row) => clone(row));
    case "value":
      return rows
        .map((row) => evaluate(projection.expr, row as StoredDoc, params, sql))
        .filter((value) => value !== undefined)
        .map((value) => clone(value));
    case "fields":
      return rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const field of projection.fields) {
          const value = evaluate(field.expr, row as StoredDoc, params, sql);
          if (value !== undefined) out[field.alias] = clone(value);
        }
        return out;
      });
  }
}

// ============================================================================
// ContainerHandle + DatabaseProvider
// ============================================================================

/**
 * `ContainerHandle` over a `FakeCosmosContainer`, mirroring
 * `CosmosContainerHandle` call for call so high-level and raw access see
 * the same data.
 */
export class InMemoryContainerHandle<T extends BaseDocument = BaseDocument>
  implements ContainerHandle<T>
{
  readonly raw: FakeCosmosContainer;

  constructor(raw: FakeCosmosContainer) {
    this.raw = raw;
  }

  async create(document: T): Promise<T> {
    return (await this.raw.items.create<T>(document)).resource as T;
  }

  async upsert(document: T): Promise<T> {
    return (await this.raw.items.upsert<T>(document)).resource as T;
  }

  async read(id: string, partitionKey: string): Promise<T | null> {
    return (await this.raw.item(id, partitionKey).read<T>()).resource ?? null;
  }

  async replace(id: string, partitionKey: string, document: T): Promise<T> {
    return (await this.raw.item(id, partitionKey).replace<T>(document)).resource as T;
  }

  async patch(id: string, partitionKey: string, operations: PatchOperation[]): Promise<T> {
    return (await this.raw.item(id, partitionKey).patch<T>(operations)).resource as T;
  }

  async delete(id: string, partitionKey: string): Promise<boolean> {
    try {
      await this.raw.item(id, partitionKey).delete();
      return true;
    } catch (err) {
      if (err instanceof CosmosLikeError && err.code === 404) return false;
      throw err;
    }
  }

  async query<R = T>(querySpec: SqlQuerySpec, options: QueryOptions = {}): Promise<R[]> {
    const iterator =
      options.partitionKey !== undefined
        ? this.raw.items.query<R>(querySpec, { partitionKey: options.partitionKey })
        : this.raw.items.query<R>(querySpec);
    return (await iterator.fetchAll()).resources;
  }

  async queryWithParams<R = T>(
    sql: string,
    parameters: QueryParameter[] = [],
    options: QueryOptions = {},
  ): Promise<R[]> {
    return this.query<R>({ query: sql, parameters }, options);
  }

  async count(
    whereClause?: string,
    parameters?: QueryParameter[],
    options: QueryOptions = {},
  ): Promise<number> {
    const sql = whereClause
      ? `SELECT VALUE COUNT(1) FROM c WHERE ${whereClause}`
      : "SELECT VALUE COUNT(1) FROM c";
    const results = await this.queryWithParams<number>(sql, parameters, options);
    return results[0] ?? 0;
  }

  getRawContainer(): FakeCosmosContainer {
    return this.raw;
  }
}

/**
 * In-memory `DatabaseProvider`. Containers are created on first
 * `getOrCreateContainer` (the first definition wins, as with
 * createIfNotExists) and shared by every caller of the same id.
 */
export class InMemoryCosmosDatabase implements DatabaseProvider {
  readonly name = "in-memory-cosmos";
  private readonly databaseId: string;
  private readonly containers = new Map<string, InMemoryContainerHandle>();

  constructor(databaseId = "agentforeach-test") {
    this.databaseId = databaseId;
  }

  async initialize(): Promise<void> {}

  async getOrCreateContainer<T extends BaseDocument = BaseDocument>(
    options: ContainerOptions,
  ): Promise<InMemoryContainerHandle<T>> {
    const id = options.id;
    if (!id) throw new Error("in-memory cosmos: container id is required");
    let handle = this.containers.get(id);
    if (!handle) {
      handle = new InMemoryContainerHandle(new FakeCosmosContainer(options));
      this.containers.set(id, handle);
    }
    return handle as unknown as InMemoryContainerHandle<T>;
  }

  getDatabaseId(): string {
    return this.databaseId;
  }

  /** A container created so far, for test inspection; throws if missing. */
  container<T extends BaseDocument = BaseDocument>(id: string): InMemoryContainerHandle<T> {
    const handle = this.containers.get(id);
    if (!handle) throw new Error(`in-memory cosmos: no container "${id}" (not created yet?)`);
    return handle as unknown as InMemoryContainerHandle<T>;
  }
}

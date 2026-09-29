import test from "node:test";
import assert from "node:assert/strict";

import type {
  BaseDocument,
  ContainerHandle,
  ContainerOptions,
  DatabaseProvider,
  PatchOperation,
  QueryOptions,
  QueryParameter,
} from "../database/index.js";
import {
  IdentityConflictError,
  IdentityStore,
  TooManyPairingCodesError,
  resetIdentityConfigCache,
} from "./index.js";
import { resolveChannelIdentity, tryPairChannel } from "./resolver.js";
import type { IdentityLink, PairingCode } from "./types.js";
import type { IdentityConfig } from "./config.js";

// ============================================================================
// In-Memory Database Mock
// ============================================================================

/**
 * In-memory container that is partition-key aware and supports the subset
 * of Cosmos SQL used by IdentityStore:
 *
 *   - Equality:   c.id = @id, c.userId = @userId
 *   - TOP @limit
 *
 * Two containers are created by IdentityStore.initialize():
 *   - "identity-links"   partition key: /userId
 *   - "identity-pairing" partition key: /code
 */
class InMemoryContainer<T extends BaseDocument> implements ContainerHandle<T> {
  /** Keyed by partition key + id, like Cosmos: one id may exist in two partitions. */
  private docs = new Map<string, T>();
  private partitionKeyPath: string;

  constructor(partitionKeyPath = "/userId") {
    this.partitionKeyPath = partitionKeyPath.replace(/^\//, "");
  }

  private pkOf(doc: T): string {
    return String((doc as Record<string, unknown>)[this.partitionKeyPath]);
  }

  private key(id: string, partitionKey: string): string {
    return `${partitionKey}\u0000${id}`;
  }

  async create(document: T): Promise<T> {
    const key = this.key(document.id, this.pkOf(document));
    if (this.docs.has(key)) {
      const err: Record<string, unknown> = new Error(
        "Conflict",
      ) as unknown as Record<string, unknown>;
      err.code = 409;
      throw err;
    }
    this.docs.set(key, structuredClone(document));
    return structuredClone(document);
  }

  async upsert(document: T): Promise<T> {
    this.docs.set(this.key(document.id, this.pkOf(document)), structuredClone(document));
    return structuredClone(document);
  }

  async read(id: string, partitionKey: string): Promise<T | null> {
    const doc = this.docs.get(this.key(id, partitionKey));
    return doc ? structuredClone(doc) : null;
  }

  async replace(id: string, partitionKey: string, document: T): Promise<T> {
    const existing = await this.read(id, partitionKey);
    if (!existing) throw new Error("not found");
    this.docs.set(this.key(id, partitionKey), structuredClone(document));
    return structuredClone(document);
  }

  async patch(
    id: string,
    partitionKey: string,
    operations: PatchOperation[],
  ): Promise<T> {
    const existing = await this.read(id, partitionKey);
    if (!existing) throw new Error("not found");
    const target = existing as unknown as Record<string, unknown>;

    for (const op of operations) {
      const path = op.path.replace(/^\//, "").split("/");
      if (path.length === 0) continue;
      if (op.op === "set") {
        const key = path[path.length - 1]!;
        let ptr = target;
        for (let i = 0; i < path.length - 1; i += 1) {
          if (!ptr[path[i]!] || typeof ptr[path[i]!] !== "object") {
            ptr[path[i]!] = {};
          }
          ptr = ptr[path[i]!] as Record<string, unknown>;
        }
        ptr[key] = op.value;
      }
    }

    this.docs.set(this.key(id, partitionKey), structuredClone(existing));
    return structuredClone(existing);
  }

  /** Synchronous check-and-delete, so concurrent deletes behave like Cosmos (one wins). */
  async delete(id: string, partitionKey: string): Promise<boolean> {
    return this.docs.delete(this.key(id, partitionKey));
  }

  async query<R = T>(
    _querySpec: unknown,
    options: QueryOptions = {},
  ): Promise<R[]> {
    const partitionKey = options.partitionKey;
    const out: unknown[] = [];
    for (const doc of this.docs.values()) {
      if (
        partitionKey !== undefined &&
        (doc as Record<string, unknown>)[this.partitionKeyPath] !== partitionKey
      ) {
        continue;
      }
      out.push(structuredClone(doc));
    }
    return out as R[];
  }

  async queryWithParams<R = T>(
    sql: string,
    parameters: QueryParameter[] = [],
    options: QueryOptions = {},
  ): Promise<R[]> {
    const paramMap = new Map<string, unknown>();
    for (const p of parameters) {
      paramMap.set(p.name, p.value);
    }

    let candidates: T[] = [];
    for (const doc of this.docs.values()) {
      if (
        options.partitionKey !== undefined &&
        (doc as Record<string, unknown>)[this.partitionKeyPath] !==
          options.partitionKey
      ) {
        continue;
      }
      candidates.push(structuredClone(doc));
    }

    // Apply WHERE conditions
    candidates = candidates.filter((doc) => {
      const obj = doc as Record<string, unknown>;
      const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s*$)/i);
      if (!whereMatch) return true;

      const whereClause = whereMatch[1]!;
      const conditions = whereClause.split(/\s+AND\s+/i);

      for (const cond of conditions) {
        const trimmed = cond.trim();

        // c.field = @param
        const eqMatch = trimmed.match(/c\.(\w+)\s*=\s*(@\w+)/);
        if (eqMatch) {
          const val = obj[eqMatch[1]!];
          const paramVal = paramMap.get(eqMatch[2]!);
          if (val !== paramVal) return false;
          continue;
        }

        // c.field = 'literal'
        const literalMatch = trimmed.match(/c\.(\w+)\s*=\s*'([^']*)'/);
        if (literalMatch) {
          if (obj[literalMatch[1]!] !== literalMatch[2]) return false;
          continue;
        }
      }

      return true;
    });

    // Apply maxResults
    if (options.maxResults !== undefined) {
      candidates = candidates.slice(0, options.maxResults);
    }

    return candidates as unknown as R[];
  }

  async count(
    _whereClause?: string,
    _parameters?: QueryParameter[],
    _options?: QueryOptions,
  ): Promise<number> {
    return this.docs.size;
  }

  getRawContainer(): unknown {
    return {};
  }
}

// ============================================================================
// In-Memory Database Provider
// ============================================================================

class InMemoryDatabaseProvider implements DatabaseProvider {
  readonly name = "memory";
  private containers = new Map<string, InMemoryContainer<BaseDocument>>();

  async initialize(): Promise<void> {
    return;
  }

  async getOrCreateContainer<T extends BaseDocument = BaseDocument>(
    options: ContainerOptions,
  ): Promise<ContainerHandle<T>> {
    const id = options.id;
    if (!id) throw new Error("container id required");

    const existing = this.containers.get(id);
    if (existing) return existing as unknown as ContainerHandle<T>;

    const pkPath = options.partitionKey?.paths?.[0] ?? "/id";

    const container = new InMemoryContainer<BaseDocument>(pkPath);
    this.containers.set(id, container);
    return container as unknown as ContainerHandle<T>;
  }

  getDatabaseId(): string {
    return "memory";
  }
}

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides?: Partial<IdentityConfig>): IdentityConfig {
  return {
    enabled: true,
    containerId: "identity-links",
    pairingContainerId: "identity-pairing",
    channelIndexContainerId: "identity-channel-index",
    legacyLinkLookup: false,
    pairingCodeTtlSeconds: 300,
    pairingCodeLength: 6,
    pairingMaxFailedAttempts: 10,
    pairingAttemptWindowSeconds: 900,
    maxActivePairingCodes: 5,
    fallbackMode: "config-default",
    ...overrides,
  };
}

async function setupStore(
  configOverrides?: Partial<IdentityConfig>,
): Promise<IdentityStore> {
  resetIdentityConfigCache();
  const db = new InMemoryDatabaseProvider();
  const config = makeConfig(configOverrides);
  const store = new IdentityStore(db, config);
  await store.initialize();
  return store;
}

function makeLink(overrides?: Partial<IdentityLink>): IdentityLink {
  return {
    id: "telegram:12345",
    userId: "alice",
    channel: "telegram",
    channelUserId: "12345",
    linkedVia: "admin",
    linkedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// Tests — Link CRUD
// ============================================================================

test("upsertLink creates a new identity link", async () => {
  const store = await setupStore();
  const link = makeLink();

  const created = await store.upsertLink(link);

  assert.equal(created.id, "telegram:12345");
  assert.equal(created.userId, "alice");
  assert.equal(created.channel, "telegram");
  assert.equal(created.channelUserId, "12345");
});

test("upsertLink + resolveByChannel round-trips", async () => {
  const store = await setupStore();
  await store.upsertLink(makeLink());

  const resolved = await store.resolveByChannel("telegram", "12345");

  assert.ok(resolved);
  assert.equal(resolved.userId, "alice");
  assert.equal(resolved.channel, "telegram");
  assert.equal(resolved.channelUserId, "12345");
});

test("upsertLink updates existing link (reassign user)", async () => {
  const store = await setupStore();
  await store.upsertLink(makeLink({ userId: "alice" }));
  await store.upsertLink(makeLink({ userId: "priya" }));

  const resolved = await store.resolveByChannel("telegram", "12345");

  assert.ok(resolved);
  assert.equal(resolved.userId, "priya");
});

test("resolveByChannel returns null for non-existent link", async () => {
  const store = await setupStore();

  const resolved = await store.resolveByChannel("telegram", "99999");

  assert.equal(resolved, null);
});

test("buildLinkId normalizes channel to lowercase", () => {
  assert.equal(IdentityStore.buildLinkId("Telegram", "12345"), "telegram:12345");
  assert.equal(IdentityStore.buildLinkId("DISCORD", "abc"), "discord:abc");
});

test("buildLinkId preserves channelUserId case", () => {
  assert.equal(IdentityStore.buildLinkId("discord", "ABC123"), "discord:ABC123");
});

test("getLinksForUser returns all links for one user", async () => {
  const store = await setupStore();
  await store.upsertLink(makeLink({
    id: "telegram:12345",
    userId: "alice",
    channel: "telegram",
    channelUserId: "12345",
  }));
  await store.upsertLink(makeLink({
    id: "whatsapp:+15551234567",
    userId: "alice",
    channel: "whatsapp",
    channelUserId: "+15551234567",
  }));

  const links = await store.getLinksForUser("alice");

  assert.equal(links.length, 2);
  const channels = links.map((l) => l.channel).sort();
  assert.deepEqual(channels, ["telegram", "whatsapp"]);
});

test("getLinksForUser isolates between users", async () => {
  const store = await setupStore();
  await store.upsertLink(makeLink({
    id: "telegram:12345",
    userId: "alice",
    channel: "telegram",
    channelUserId: "12345",
  }));
  await store.upsertLink(makeLink({
    id: "telegram:67890",
    userId: "priya",
    channel: "telegram",
    channelUserId: "67890",
  }));

  const aliceLinks = await store.getLinksForUser("alice");
  const priyaLinks = await store.getLinksForUser("priya");

  assert.equal(aliceLinks.length, 1);
  assert.equal(aliceLinks[0]!.channelUserId, "12345");
  assert.equal(priyaLinks.length, 1);
  assert.equal(priyaLinks[0]!.channelUserId, "67890");
});

test("deleteLink removes a link", async () => {
  const store = await setupStore();
  await store.upsertLink(makeLink());

  const deleted = await store.deleteLink("telegram", "12345", "alice");
  assert.equal(deleted, true);

  const resolved = await store.resolveByChannel("telegram", "12345");
  assert.equal(resolved, null);
});

test("deleteLink returns false for non-existent link", async () => {
  const store = await setupStore();

  const deleted = await store.deleteLink("telegram", "99999", "alice");
  assert.equal(deleted, false);
});

// ============================================================================
// Tests — Pairing Codes
// ============================================================================

test("createPairingCode generates a valid code", async () => {
  const store = await setupStore();

  const pairing = await store.createPairingCode("alice");

  assert.ok(pairing.code);
  assert.equal(pairing.code.length, 6);
  assert.match(pairing.code, /^[A-Z0-9]+$/);
  assert.equal(pairing.userId, "alice");
  assert.equal(pairing.consumed, false);
  assert.ok(pairing.expiresAt);
});

test("consumePairingCode returns userId for valid code", async () => {
  const store = await setupStore();
  const pairing = await store.createPairingCode("alice");

  const result = await store.consumePairingCode(pairing.code);

  assert.equal(result, "alice");
});

test("consumePairingCode returns null for non-existent code", async () => {
  const store = await setupStore();

  const result = await store.consumePairingCode("ZZZZZZ");

  assert.equal(result, null);
});

test("consumePairingCode returns null for already-consumed code", async () => {
  const store = await setupStore();
  const pairing = await store.createPairingCode("alice");

  await store.consumePairingCode(pairing.code);
  const secondAttempt = await store.consumePairingCode(pairing.code);

  assert.equal(secondAttempt, null);
});

test("consumePairingCode returns null for expired code", async () => {
  // Use very short TTL and create code manually
  const store = await setupStore({ pairingCodeTtlSeconds: 1 });
  const pairing = await store.createPairingCode("alice");

  // Manually set expiresAt to the past by consuming and recreating
  // We'll directly test the expiry logic by creating a code with past expiry
  // Since the in-memory mock doesn't support Cosmos TTL auto-delete,
  // we test that consumePairingCode checks expiresAt
  const db = new InMemoryDatabaseProvider();
  const config = makeConfig({ pairingCodeTtlSeconds: -1 }); // already expired
  const expiredStore = new IdentityStore(db, config);
  await expiredStore.initialize();

  const expiredPairing = await expiredStore.createPairingCode("alice");
  // The code was created with TTL=-1, so expiresAt is in the past
  const result = await expiredStore.consumePairingCode(expiredPairing.code);

  assert.equal(result, null);
});

test("consumePairingCode handles case-insensitive input", async () => {
  const store = await setupStore();
  const pairing = await store.createPairingCode("alice");

  // Codes are uppercase, try lowercase input
  const result = await store.consumePairingCode(pairing.code.toLowerCase());

  assert.equal(result, "alice");
});

// ============================================================================
// Tests — resolveChannelIdentity
// ============================================================================

test("resolveChannelIdentity returns identity-link when found", async () => {
  const store = await setupStore();
  await store.upsertLink(makeLink());

  resetIdentityConfigCache();
  const result = await resolveChannelIdentity(
    store, "telegram", "12345", "default-user",
  );

  assert.equal(result.resolved, true);
  assert.equal(result.resolved && result.userId, "alice");
  assert.equal(result.source, "identity-link");
});

test("resolveChannelIdentity falls back to config-default when no link", async () => {
  const store = await setupStore();

  resetIdentityConfigCache();
  const result = await resolveChannelIdentity(
    store, "telegram", "99999", "telegram-user",
  );

  assert.equal(result.resolved, true);
  assert.equal(result.resolved && result.userId, "telegram-user");
  assert.equal(result.source, "config-default");
});

test("resolveChannelIdentity uses sender-passthrough when fallbackMode is sender-passthrough", async () => {
  const store = await setupStore({ fallbackMode: "sender-passthrough" });

  resetIdentityConfigCache();
  const result = await resolveChannelIdentity(
    store, "telegram", "99999", undefined,
  );

  assert.equal(result.resolved, false);
  assert.equal(result.source === "sender-id-passthrough" && result.fallbackUserId, "telegram:99999");
  assert.equal(result.source, "sender-id-passthrough");
});

test("resolveChannelIdentity works with null store (identity disabled)", async () => {
  resetIdentityConfigCache();
  const result = await resolveChannelIdentity(
    null, "telegram", "12345", "telegram-user",
  );

  assert.equal(result.resolved, true);
  assert.equal(result.resolved && result.userId, "telegram-user");
  assert.equal(result.source, "config-default");
});

test("resolveChannelIdentity identity-link takes priority over config-default", async () => {
  const store = await setupStore();
  await store.upsertLink(makeLink());

  resetIdentityConfigCache();
  const result = await resolveChannelIdentity(
    store, "telegram", "12345", "telegram-user",
  );

  // identity-link should win over config-default
  assert.equal(result.resolved, true);
  assert.equal(result.resolved && result.userId, "alice");
  assert.equal(result.source, "identity-link");
});

// ============================================================================
// Tests — tryPairChannel
// ============================================================================

test("tryPairChannel creates link when valid code is sent", async () => {
  const store = await setupStore();
  const pairing = await store.createPairingCode("alice");

  const result = await tryPairChannel(
    store, "telegram", "12345", pairing.code,
  );

  assert.equal(result, "alice");

  // Verify the link was created
  const link = await store.resolveByChannel("telegram", "12345");
  assert.ok(link);
  assert.equal(link.userId, "alice");
  assert.equal(link.linkedVia, "pairing-code");
});

test("tryPairChannel ignores non-code messages", async () => {
  const store = await setupStore();

  // Too long
  const r1 = await tryPairChannel(
    store, "telegram", "12345", "Hello how are you?",
  );
  assert.equal(r1, null);

  // Too short
  const r2 = await tryPairChannel(
    store, "telegram", "12345", "HI",
  );
  assert.equal(r2, null);

  // Has non-alphanumeric chars
  const r3 = await tryPairChannel(
    store, "telegram", "12345", "AB-C12",
  );
  assert.equal(r3, null);
});

test("tryPairChannel ignores invalid/non-existent codes", async () => {
  const store = await setupStore();

  const result = await tryPairChannel(
    store, "telegram", "12345", "ZZZZZZ",
  );

  assert.equal(result, null);
});

test("tryPairChannel preserves sender metadata on link", async () => {
  const store = await setupStore();
  const pairing = await store.createPairingCode("alice");

  await tryPairChannel(
    store, "telegram", "12345", pairing.code,
    "Alice Example", "aliceexample",
  );

  const links = await store.getLinksForUser("alice");
  assert.equal(links.length, 1);
  assert.equal(links[0]!.displayName, "Alice Example");
  assert.equal(links[0]!.channelUsername, "aliceexample");
});

// ============================================================================
// Tests — IdentityStore not initialized
// ============================================================================

test("IdentityStore throws when not initialized", async () => {
  resetIdentityConfigCache();
  const db = new InMemoryDatabaseProvider();
  const store = new IdentityStore(db, makeConfig());

  await assert.rejects(
    () => store.resolveByChannel("telegram", "12345"),
    { message: "IdentityStore: not initialized. Call initialize() first." },
  );
});

test("IdentityStore.initialize is idempotent", async () => {
  const store = await setupStore();
  // Should not throw
  await store.initialize();
  await store.initialize();

  // Should still work
  await store.upsertLink(makeLink());
  const resolved = await store.resolveByChannel("telegram", "12345");
  assert.ok(resolved);
});

// ============================================================================
// Tests — security hardening
// ============================================================================

test("re-linking a channel account to another user leaves exactly one link", async () => {
  const store = await setupStore();
  await store.upsertLink(makeLink({ userId: "alice" }));
  await store.upsertLink(makeLink({ userId: "bob" }));

  assert.equal((await store.resolveByChannel("telegram", "12345"))?.userId, "bob");
  assert.equal((await store.getLinksForUser("alice")).length, 0);
  assert.equal((await store.getLinksForUser("bob")).length, 1);
});

async function setupStoreAndDb(configOverrides?: Partial<IdentityConfig>) {
  resetIdentityConfigCache();
  const db = new InMemoryDatabaseProvider();
  const store = new IdentityStore(db, makeConfig(configOverrides));
  await store.initialize();
  const links = await db.getOrCreateContainer<IdentityLink>({ id: "identity-links" });
  return { store, db, links };
}

test("legacy links that disagree on the owner are a conflict, and the turn is refused", async () => {
  const { store, links } = await setupStoreAndDb({ legacyLinkLookup: true });
  // Duplicates left from before the channel index existed.
  await links.upsert(makeLink({ userId: "victim" }));
  await links.upsert(makeLink({ userId: "attacker" }));

  await assert.rejects(store.resolveByChannel("telegram", "12345"), IdentityConflictError);
  const resolution = await resolveChannelIdentity(store, "telegram", "12345", "owner");
  assert.equal(resolution.source, "conflict");
});

test("a single legacy link is found once and backfilled into the index", async () => {
  const { store, links } = await setupStoreAndDb({ legacyLinkLookup: true });
  await links.upsert(makeLink({ userId: "alice" }));

  assert.equal((await store.resolveByChannel("telegram", "12345"))?.userId, "alice");
  assert.equal(await store.isChannelLinked("telegram", "12345"), true);
});

test("backfillChannelIndex indexes legacy links once and skips conflicts", async () => {
  const { store, links } = await setupStoreAndDb();
  await links.upsert(makeLink({ userId: "alice" }));
  await links.upsert(makeLink({ userId: "carol", channelUserId: "777", id: "telegram:777" }));
  await links.upsert(makeLink({ userId: "dave", channelUserId: "777", id: "telegram:777" }));

  assert.deepEqual(await store.backfillChannelIndex(), { indexed: 1, alreadyIndexed: 0, conflicts: 1 });
  assert.equal((await store.resolveByChannel("telegram", "12345"))?.userId, "alice");
  assert.equal(await store.resolveByChannel("telegram", "777"), null);
  assert.deepEqual(await store.backfillChannelIndex(), { indexed: 0, alreadyIndexed: 1, conflicts: 1 });
});

test("a legacy-lookup miss is remembered, so unlinked senders don't query every message", async () => {
  const { store, links } = await setupStoreAndDb({ legacyLinkLookup: true });
  let queries = 0;
  const original = links.queryWithParams.bind(links);
  links.queryWithParams = (async (...args: Parameters<typeof original>) => {
    queries++;
    return original(...args);
  }) as typeof links.queryWithParams;

  assert.equal(await store.resolveByChannel("telegram", "999"), null);
  assert.equal(await store.resolveByChannel("telegram", "999"), null);
  assert.equal(queries, 1);
});

test("without legacy lookup, only the channel index resolves a sender", async () => {
  const { store, links } = await setupStoreAndDb();
  await links.upsert(makeLink({ userId: "alice" })); // no index entry
  assert.equal(await store.resolveByChannel("telegram", "12345"), null);
});

test("a stale link doc left by a re-link isn't listed for its old user", async () => {
  const { store, links } = await setupStoreAndDb();
  await store.upsertLink(makeLink({ userId: "bob" }));
  // A concurrent re-link could leave alice's old doc behind.
  await links.upsert(makeLink({ userId: "alice" }));
  assert.deepEqual(await store.getLinksForUser("alice"), []);
  assert.equal((await store.getLinksForUser("bob")).length, 1);
});

test("deleting a link frees the channel account; another user's delete doesn't", async () => {
  const store = await setupStore();
  await store.upsertLink(makeLink({ userId: "bob" }));
  assert.equal(await store.deleteLink("telegram", "12345", "alice"), false);
  assert.equal(await store.isChannelLinked("telegram", "12345"), true);
  assert.equal(await store.deleteLink("telegram", "12345", "bob"), true);
  assert.equal(await store.resolveByChannel("telegram", "12345"), null);
});

test("pairing codes use only the unambiguous alphabet", async () => {
  const store = await setupStore({ maxActivePairingCodes: 1000 });
  for (let i = 0; i < 200; i++) {
    const { code } = await store.createPairingCode(`u${i}`);
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  }
});

test("concurrent consumption of one code succeeds exactly once", async () => {
  const store = await setupStore();
  const { code } = await store.createPairingCode("alice");
  const results = await Promise.all([
    store.consumePairingCode(code),
    store.consumePairingCode(code),
    store.consumePairingCode(code),
  ]);
  assert.deepEqual(results.filter(Boolean), ["alice"]);
});

test("a user can hold only a limited number of active pairing codes", async () => {
  const store = await setupStore({ maxActivePairingCodes: 2 });
  await store.createPairingCode("alice");
  await store.createPairingCode("alice");
  await assert.rejects(store.createPairingCode("alice"), TooManyPairingCodesError);
  await store.createPairingCode("bob"); // other users are unaffected
});

test("too many failed pairing attempts lock the sender, even for a valid code", async () => {
  const store = await setupStore({ pairingMaxFailedAttempts: 3 });
  for (let i = 0; i < 3; i++) {
    assert.equal(await tryPairChannel(store, "telegram", "666", "ZZZZZ2"), null);
  }
  const { code } = await store.createPairingCode("victim");
  assert.equal(await tryPairChannel(store, "telegram", "666", code), null);
  // Another sender can still pair.
  assert.equal(await tryPairChannel(store, "telegram", "777", code), "victim");
});

test("words outside the code alphabet are never pairing attempts", async () => {
  const store = await setupStore({ pairingMaxFailedAttempts: 1 });
  // "HELLO1" has an L-O-1: 1 and O aren't in the code alphabet.
  for (const word of ["HELLO1", "THANKS", "COOL10"]) {
    await tryPairChannel(store, "telegram", "555", word);
  }
  // THANKS is all-alphabet, so exactly one failure: now locked at limit 1.
  assert.equal(await store.isPairingLocked("telegram", "555"), true);

  const other = await setupStore({ pairingMaxFailedAttempts: 1 });
  await tryPairChannel(other, "telegram", "556", "HELLO1");
  assert.equal(await other.isPairingLocked("telegram", "556"), false);
});

test("linked senders' wrong codes count too: a correct guess would relink them to another account", async () => {
  const store = await setupStore({ pairingMaxFailedAttempts: 1 });
  await store.upsertLink(makeLink({ channelUserId: "777", id: "telegram:777", userId: "alice" }));
  await tryPairChannel(store, "telegram", "777", "THANKS");
  assert.equal(await store.isPairingLocked("telegram", "777"), true);
});

/**
 * AgentForEach Identity Module — Identity Store
 *
 * Cosmos DB-backed store for channel identity links and pairing codes.
 * Follows the same pattern as SessionStore.
 *
 * Three containers:
 *   "identity-links"         — IdentityLink documents (partition key: /userId)
 *   "identity-channel-index" — one owner doc per channel account (partition key: /id)
 *   "identity-pairing"       — PairingCode + attempt docs (partition key: /code)
 *
 * The channel index is authoritative for "who owns this channel account":
 * one document per `channel:channelUserId`, so ownership is unique and the
 * per-message lookup is a point read, not a cross-partition query.
 *
 * All identity mappings live exclusively in Cosmos DB (no static config).
 */

import { randomInt } from "node:crypto";
import { PartitionKeyKind } from "@azure/cosmos";
import type {
  DatabaseProvider,
  ContainerHandle,
} from "../database/index.js";
import type { IdentityLink, PairingCode } from "./types.js";
import { loadIdentityConfig, type IdentityConfig } from "./config.js";

// ============================================================================
// Code Generation
// ============================================================================

/** Ambiguity-safe alphabet: no 0/O, 1/I. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(length: number): string {
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    chars.push(CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!);
  }
  return chars.join("");
}

/**
 * Failed pairing attempts per channel sender, kept in the pairing container
 * (partition /code) so the limit holds across Function instances.
 */
type PairingAttempts = {
  id: string;
  code: string;
  failures: number;
  ttl: number;
};

/** Owner of one channel account (identity-channel-index, partition /id). */
type ChannelOwner = {
  id: string;
  userId: string;
  updatedAt: string;
};

/**
 * Thrown when legacy links (from before the channel index) disagree on who
 * owns a channel account. The caller must refuse the turn, not fall back.
 */
export class IdentityConflictError extends Error {
  override name = "IdentityConflictError";
}

/** Thrown when a user already has the maximum number of active codes. */
export class TooManyPairingCodesError extends Error {
  override name = "TooManyPairingCodesError";
}

// ============================================================================
// Identity Store
// ============================================================================

/** How long a legacy-lookup miss is remembered per channel account. */
const LEGACY_MISS_TTL_MS = 10 * 60_000;
const LEGACY_MISS_MAX_ENTRIES = 10_000;

export class IdentityStore {
  private db: DatabaseProvider;
  private linksContainer!: ContainerHandle<IdentityLink>;
  private indexContainer!: ContainerHandle<ChannelOwner>;
  /** Holds pairing codes and per-sender attempt counters. */
  private pairingContainer!: ContainerHandle<PairingCode | PairingAttempts>;
  private initialized = false;
  private config: IdentityConfig;
  /** Legacy-lookup misses, so an unlinked sender costs one cross-partition query per window, not per message. */
  private legacyMisses = new Map<string, number>();

  constructor(db: DatabaseProvider, config?: IdentityConfig) {
    this.db = db;
    this.config = config ?? loadIdentityConfig();
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const [links, index, pairing] = await Promise.all([
      this.db.getOrCreateContainer<IdentityLink>({
        id: this.config.containerId,
        partitionKey: {
          paths: ["/userId"],
          kind: PartitionKeyKind.Hash,
          version: 2,
        },
        indexingPolicy: {
          automatic: true,
          indexingMode: "consistent",
          includedPaths: [{ path: "/*" }],
          excludedPaths: [{ path: '/"_etag"/?' }],
        },
      }),
      this.db.getOrCreateContainer<ChannelOwner>({
        id: this.config.channelIndexContainerId,
        partitionKey: {
          paths: ["/id"],
          kind: PartitionKeyKind.Hash,
          version: 2,
        },
      }),
      this.db.getOrCreateContainer<PairingCode | PairingAttempts>({
        id: this.config.pairingContainerId,
        partitionKey: {
          paths: ["/code"],
          kind: PartitionKeyKind.Hash,
          version: 2,
        },
        defaultTtl: this.config.pairingCodeTtlSeconds,
      }),
    ]);

    this.linksContainer = links;
    this.indexContainer = index;
    this.pairingContainer = pairing;
    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // Identity Link CRUD
  // --------------------------------------------------------------------------

  /**
   * Build the document ID for an identity link.
   * Format: `{channel}:{channelUserId}` — channel is lowercased.
   */
  static buildLinkId(channel: string, channelUserId: string): string {
    return `${channel.toLowerCase()}:${channelUserId}`;
  }

  /**
   * Create or update an identity link.
   *
   * The channel index records the owner first (one doc per channel
   * account, so ownership is unique); the link doc in the owner's partition
   * follows. A previous owner's link doc is removed.
   */
  async upsertLink(link: IdentityLink): Promise<IdentityLink> {
    this.ensureInitialized();
    const previous = await this.indexContainer.read(link.id, link.id);
    await this.indexContainer.upsert({
      id: link.id,
      userId: link.userId,
      updatedAt: new Date().toISOString(),
    });
    if (previous && previous.userId !== link.userId) {
      await this.linksContainer.delete(link.id, previous.userId);
    }
    return this.linksContainer.upsert(link);
  }

  /**
   * Look up the AgentForEach user who owns a channel account.
   *
   * Called on every inbound channel message: a point read on the channel
   * index plus one on the owner's link doc.
   *
   * With `identity.legacyLinkLookup` on (for deployments with links created
   * before the index), a miss falls back to a cross-partition query once and
   * backfills the index. Legacy links that disagree on the owner throw
   * IdentityConflictError, so the caller refuses the turn.
   */
  async resolveByChannel(
    channel: string,
    channelUserId: string,
  ): Promise<IdentityLink | null> {
    this.ensureInitialized();
    const docId = IdentityStore.buildLinkId(channel, channelUserId);

    const owner = await this.indexContainer.read(docId, docId);
    if (owner) {
      const link = await this.linksContainer.read(docId, owner.userId);
      if (!link) {
        console.error(`[identity] channel index points at a missing link doc for a ${channel} account`);
      }
      return link;
    }

    if (!this.config.legacyLinkLookup) return null;
    const missedAt = this.legacyMisses.get(docId);
    if (missedAt !== undefined && Date.now() - missedAt < LEGACY_MISS_TTL_MS) return null;

    const legacy = await this.linksContainer.queryWithParams<IdentityLink>(
      "SELECT * FROM c WHERE c.id = @id",
      [{ name: "@id", value: docId }],
    );
    if (legacy.length === 0) {
      if (this.legacyMisses.size >= LEGACY_MISS_MAX_ENTRIES) this.legacyMisses.clear();
      this.legacyMisses.set(docId, Date.now());
      return null;
    }
    const owners = new Set(legacy.map((l) => l.userId));
    if (owners.size > 1) {
      console.error(
        `[identity] ${owners.size} users linked to one ${channel} account; turns refused until an admin re-links it`,
      );
      throw new IdentityConflictError(`Conflicting identity links for a ${channel} account`);
    }
    await this.indexContainer.upsert({
      id: docId,
      userId: legacy[0]!.userId,
      updatedAt: new Date().toISOString(),
    });
    return legacy[0]!;
  }

  /**
   * Fill the channel index from every existing link doc (one cross-partition
   * scan). Run once after upgrading, via POST /api/identity/backfill-index;
   * after that `legacyLinkLookup` can stay off. Accounts whose link docs
   * disagree on the owner are not indexed and are counted as conflicts.
   */
  async backfillChannelIndex(): Promise<{ indexed: number; alreadyIndexed: number; conflicts: number }> {
    this.ensureInitialized();
    const links = await this.linksContainer.queryWithParams<IdentityLink>(
      "SELECT c.id, c.userId FROM c",
    );
    const owners = new Map<string, Set<string>>();
    for (const l of links) {
      if (!l.id || !l.userId) continue;
      let set = owners.get(l.id);
      if (!set) owners.set(l.id, (set = new Set()));
      set.add(l.userId);
    }
    let indexed = 0;
    let alreadyIndexed = 0;
    let conflicts = 0;
    for (const [id, users] of owners) {
      if (users.size > 1) {
        conflicts++;
        continue;
      }
      const userId = [...users][0]!;
      const existing = await this.indexContainer.read(id, id);
      if (existing?.userId === userId) {
        alreadyIndexed++;
        continue;
      }
      if (existing) {
        // The index is authoritative (written by every link since the upgrade).
        conflicts++;
        continue;
      }
      await this.indexContainer.upsert({ id, userId, updatedAt: new Date().toISOString() });
      indexed++;
    }
    this.legacyMisses.clear();
    return { indexed, alreadyIndexed, conflicts };
  }

  /**
   * Get all identity links a AgentForEach user currently owns. A link doc left
   * behind by a concurrent re-link is excluded: the channel index decides.
   */
  async getLinksForUser(userId: string): Promise<IdentityLink[]> {
    this.ensureInitialized();
    const links = await this.linksContainer.queryWithParams<IdentityLink>(
      "SELECT * FROM c WHERE c.userId = @userId",
      [{ name: "@userId", value: userId }],
      { partitionKey: userId },
    );
    const owned = await Promise.all(
      links.map(async (l) => {
        const owner = await this.indexContainer.read(l.id, l.id);
        // Links from before the index count as owned until backfilled.
        return !owner || owner.userId === userId;
      }),
    );
    return links.filter((_, i) => owned[i]);
  }

  /**
   * Delete one of a user's identity links. The channel index entry goes
   * too, but only if this user still owns the account.
   */
  async deleteLink(
    channel: string,
    channelUserId: string,
    userId: string,
  ): Promise<boolean> {
    this.ensureInitialized();
    const docId = IdentityStore.buildLinkId(channel, channelUserId);
    const owner = await this.indexContainer.read(docId, docId);
    if (owner?.userId === userId) {
      await this.indexContainer.delete(docId, docId);
    }
    return this.linksContainer.delete(docId, userId);
  }

  /** Whether a channel account is linked to any user (index only, no fallback). */
  async isChannelLinked(channel: string, channelUserId: string): Promise<boolean> {
    this.ensureInitialized();
    const docId = IdentityStore.buildLinkId(channel, channelUserId);
    return !!(await this.indexContainer.read(docId, docId));
  }

  // --------------------------------------------------------------------------
  // Pairing Codes
  // --------------------------------------------------------------------------

  /**
   * Generate a pairing code for a user.
   */
  async createPairingCode(userId: string): Promise<PairingCode> {
    this.ensureInitialized();
    const now = new Date();
    // ISO-8601 strings compare correctly as text.
    const active = await this.pairingContainer.queryWithParams<PairingCode>(
      "SELECT * FROM c WHERE c.userId = @userId AND c.expiresAt > @now",
      [
        { name: "@userId", value: userId },
        { name: "@now", value: now.toISOString() },
      ],
    );
    if (active.length >= this.config.maxActivePairingCodes) {
      throw new TooManyPairingCodesError(
        `At most ${this.config.maxActivePairingCodes} active pairing codes per user`,
      );
    }

    const code = generateCode(this.config.pairingCodeLength);
    const expiresAt = new Date(
      now.getTime() + this.config.pairingCodeTtlSeconds * 1000,
    );

    const doc: PairingCode = {
      id: code,
      code,
      userId,
      expiresAt: expiresAt.toISOString(),
      consumed: false,
      ttl: this.config.pairingCodeTtlSeconds,
    };

    await this.pairingContainer.create(doc);
    return doc;
  }

  /**
   * Consume a pairing code: look up by code, validate expiry, then delete it.
   * Returns the userId if valid, null if invalid/expired/consumed.
   *
   * Consumption is the delete: `delete` returns false when the document is
   * already gone, so of two concurrent consumers exactly one wins.
   */
  async consumePairingCode(code: string): Promise<string | null> {
    this.ensureInitialized();
    const normalizedCode = code.trim().toUpperCase();

    const doc = (await this.pairingContainer.read(normalizedCode, normalizedCode)) as PairingCode | null;
    if (!doc || !("userId" in doc)) return null;
    if (doc.consumed) return null; // legacy docs only; codes are now deleted on use
    if (new Date(doc.expiresAt) < new Date()) return null;

    const won = await this.pairingContainer.delete(normalizedCode, normalizedCode);
    return won ? doc.userId : null;
  }

  // --------------------------------------------------------------------------
  // Pairing attempt limit
  // --------------------------------------------------------------------------

  private attemptsId(channel: string, channelUserId: string): string {
    return `attempts:${channel.toLowerCase()}:${channelUserId}`;
  }

  /** Whether this sender has used up their failed pairing attempts. */
  async isPairingLocked(channel: string, channelUserId: string): Promise<boolean> {
    this.ensureInitialized();
    const id = this.attemptsId(channel, channelUserId);
    const doc = (await this.pairingContainer.read(id, id)) as PairingAttempts | null;
    return (doc?.failures ?? 0) >= this.config.pairingMaxFailedAttempts;
  }

  /**
   * Count a failed attempt. The window restarts with each failure (the doc's
   * TTL is rewritten), which is stricter than a fixed window. Read-then-
   * upsert can undercount under concurrency; that's acceptable for a limit.
   */
  async recordPairingFailure(channel: string, channelUserId: string): Promise<void> {
    this.ensureInitialized();
    const id = this.attemptsId(channel, channelUserId);
    const doc = (await this.pairingContainer.read(id, id)) as PairingAttempts | null;
    await this.pairingContainer.upsert({
      id,
      code: id,
      failures: (doc?.failures ?? 0) + 1,
      ttl: this.config.pairingAttemptWindowSeconds,
    });
  }

  // --------------------------------------------------------------------------
  // Config Access
  // --------------------------------------------------------------------------

  getConfig(): IdentityConfig {
    return this.config;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "IdentityStore: not initialized. Call initialize() first.",
      );
    }
  }
}

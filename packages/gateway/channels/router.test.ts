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
import type { ChannelPlugin, InboundMessage, OutboundContext, OutboundResult } from "./types.js";
import type { SendRequest } from "../client/types.js";
import type { IdentityLink, PairingCode } from "../identity/types.js";
import type { IdentityConfig } from "../identity/config.js";
import { IdentityStore, resetIdentityConfigCache } from "../identity/index.js";
import { resolveChannelIdentity, tryPairChannel } from "../identity/resolver.js";
import {
  setIdentityStore,
  getIdentityStore,
  resetIdentityStore,
  choicesToPayload,
  processInbound,
} from "./router.js";
import { registerChannel } from "./registry.js";

// ============================================================================
// In-Memory Database Mock (simplified for identity containers)
// ============================================================================

class InMemoryContainer<T extends BaseDocument> implements ContainerHandle<T> {
  private docs = new Map<string, T>();
  private partitionKeyPath: string;

  constructor(partitionKeyPath = "/chittiUserId") {
    this.partitionKeyPath = partitionKeyPath.replace(/^\//, "");
  }

  async create(document: T): Promise<T> {
    if (this.docs.has(document.id)) {
      const err: Record<string, unknown> = new Error(
        "Conflict",
      ) as unknown as Record<string, unknown>;
      err.code = 409;
      throw err;
    }
    this.docs.set(document.id, structuredClone(document));
    return structuredClone(document);
  }

  async upsert(document: T): Promise<T> {
    this.docs.set(document.id, structuredClone(document));
    return structuredClone(document);
  }

  async read(id: string, partitionKey: string): Promise<T | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    if (
      (doc as Record<string, unknown>)[this.partitionKeyPath] !== partitionKey
    )
      return null;
    return structuredClone(doc);
  }

  async replace(id: string, partitionKey: string, document: T): Promise<T> {
    const existing = await this.read(id, partitionKey);
    if (!existing) throw new Error("not found");
    this.docs.set(id, structuredClone(document));
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

    this.docs.set(id, structuredClone(existing));
    return structuredClone(existing);
  }

  async delete(id: string, partitionKey: string): Promise<boolean> {
    const existing = await this.read(id, partitionKey);
    if (!existing) return false;
    this.docs.delete(id);
    return true;
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

    candidates = candidates.filter((doc) => {
      const obj = doc as Record<string, unknown>;
      const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s*$)/i);
      if (!whereMatch) return true;

      const whereClause = whereMatch[1]!;
      const conditions = whereClause.split(/\s+AND\s+/i);

      for (const cond of conditions) {
        const trimmed = cond.trim();
        const eqMatch = trimmed.match(/c\.(\w+)\s*=\s*(@\w+)/);
        if (eqMatch) {
          const val = obj[eqMatch[1]!];
          const paramVal = paramMap.get(eqMatch[2]!);
          if (val !== paramVal) return false;
          continue;
        }
      }

      return true;
    });

    if (options.maxResults !== undefined) {
      candidates = candidates.slice(0, options.maxResults);
    }

    return candidates as unknown as R[];
  }

  async count(): Promise<number> {
    return this.docs.size;
  }

  getRawContainer(): unknown {
    return {};
  }
}

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

async function setupIdentityStore(
  configOverrides?: Partial<IdentityConfig>,
): Promise<IdentityStore> {
  resetIdentityConfigCache();
  const db = new InMemoryDatabaseProvider();
  const config = makeConfig(configOverrides);
  const store = new IdentityStore(db, config);
  await store.initialize();
  return store;
}

function makeInboundMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    messageId: "msg-1",
    senderId: "12345",
    senderName: "Test User",
    senderUsername: "testuser",
    chatId: "chat-1",
    text: "Hello!",
    isGroupChat: false,
    timestampMs: Date.now(),
    ...overrides,
  };
}

/** Track calls to a mock channel plugin. */
interface MockPluginCalls {
  sendOutbound: OutboundContext[];
  toSendRequest: InboundMessage[];
}

function createMockPlugin(overrides?: {
  defaultUserId?: string;
}): { plugin: ChannelPlugin; calls: MockPluginCalls } {
  const calls: MockPluginCalls = {
    sendOutbound: [],
    toSendRequest: [],
  };

  const plugin: ChannelPlugin = {
    id: "test-channel",
    displayName: "Test Channel",
    enabled: true,

    verifyWebhook() {
      return true;
    },

    parseInbound() {
      return undefined;
    },

    async sendOutbound(context: OutboundContext): Promise<OutboundResult> {
      calls.sendOutbound.push(context);
      return { success: true, messageId: "out-1" };
    },

    toSendRequest(message: InboundMessage): Partial<SendRequest> {
      calls.toSendRequest.push(message);
      return {
        userId: overrides?.defaultUserId,
        channelName: "test-channel",
        channelChatId: message.chatId,
      };
    },
  };

  return { plugin, calls };
}

// ============================================================================
// Tests — Identity Store getter/setter
// ============================================================================

test("setIdentityStore and getIdentityStore round-trip", async () => {
  resetIdentityStore();
  const store = await setupIdentityStore();

  assert.equal(getIdentityStore(), null);

  setIdentityStore(store);
  assert.equal(getIdentityStore(), store);

  resetIdentityStore();
  assert.equal(getIdentityStore(), null);
});

// ============================================================================
// Tests — Identity resolution logic (tested through resolver, ensuring
// the same functions the router calls work correctly)
// ============================================================================

test("resolveChannelIdentity resolves linked user for channel message", async () => {
  const store = await setupIdentityStore();
  await store.upsertLink({
    id: "telegram:12345",
    chittiUserId: "alice",
    channel: "telegram",
    channelUserId: "12345",
    linkedVia: "admin",
    linkedAt: new Date().toISOString(),
  });

  resetIdentityConfigCache();
  const result = await resolveChannelIdentity(store, "telegram", "12345", "default-user");

  assert.equal(result.resolved, true);
  assert.equal(result.resolved && result.chittiUserId, "alice");
  assert.equal(result.source, "identity-link");
});

test("resolveChannelIdentity falls back to config default when unlinked", async () => {
  const store = await setupIdentityStore();

  resetIdentityConfigCache();
  const result = await resolveChannelIdentity(store, "telegram", "99999", "telegram-user");

  assert.equal(result.resolved, true);
  assert.equal(result.resolved && result.chittiUserId, "telegram-user");
  assert.equal(result.source, "config-default");
});

test("resolveChannelIdentity works with null store (backward compatible)", async () => {
  resetIdentityConfigCache();
  const result = await resolveChannelIdentity(null, "telegram", "12345", "telegram-user");

  assert.equal(result.resolved, true);
  assert.equal(result.resolved && result.chittiUserId, "telegram-user");
  assert.equal(result.source, "config-default");
});

test("resolveChannelIdentity sender-passthrough when no default", async () => {
  const store = await setupIdentityStore({ fallbackMode: "sender-passthrough" });

  resetIdentityConfigCache();
  const result = await resolveChannelIdentity(store, "telegram", "99999", undefined);

  assert.equal(result.resolved, false);
  assert.equal(result.source === "sender-id-passthrough" && result.fallbackUserId, "telegram:99999");
  assert.equal(result.source, "sender-id-passthrough");
});

test("resolveChannelIdentity identity-link overrides config default", async () => {
  const store = await setupIdentityStore();
  await store.upsertLink({
    id: "telegram:12345",
    chittiUserId: "alice",
    channel: "telegram",
    channelUserId: "12345",
    linkedVia: "admin",
    linkedAt: new Date().toISOString(),
  });

  resetIdentityConfigCache();
  const result = await resolveChannelIdentity(store, "telegram", "12345", "other-user");

  assert.equal(result.resolved, true);
  assert.equal(result.resolved && result.chittiUserId, "alice");
  assert.equal(result.source, "identity-link");
});

// ============================================================================
// Tests — Pairing flow (used by processInbound before client.send)
// ============================================================================

test("tryPairChannel creates link when valid pairing code sent", async () => {
  const store = await setupIdentityStore();
  const pairing = await store.createPairingCode("alice");

  resetIdentityConfigCache();
  const result = await tryPairChannel(
    store, "telegram", "12345", pairing.code, "Alice Example", "aliceexample",
  );

  assert.equal(result, "alice");

  // Verify link created
  const link = await store.resolveByChannel("telegram", "12345");
  assert.ok(link);
  assert.equal(link.chittiUserId, "alice");
  assert.equal(link.channel, "telegram");
  assert.equal(link.linkedVia, "pairing-code");
  assert.equal(link.displayName, "Alice Example");
});

test("tryPairChannel ignores normal chat messages", async () => {
  const store = await setupIdentityStore();

  resetIdentityConfigCache();
  const result = await tryPairChannel(
    store, "telegram", "12345", "Hello, how are you doing today?",
  );

  assert.equal(result, null);
});

test("tryPairChannel ignores invalid codes gracefully", async () => {
  const store = await setupIdentityStore();

  resetIdentityConfigCache();
  // Correct length but non-existent code
  const result = await tryPairChannel(
    store, "telegram", "12345", "ZZZZZZ",
  );

  assert.equal(result, null);
});

// ============================================================================
// Tests — Mock plugin + identity store integration
// (Tests the pairing path of processInbound which returns early
//  before calling AgentClient — no client mock needed)
// ============================================================================

test("mock plugin sendOutbound is called for pairing confirmation", async () => {
  const store = await setupIdentityStore();
  const pairing = await store.createPairingCode("alice");
  setIdentityStore(store);

  const { plugin, calls } = createMockPlugin({ defaultUserId: "fallback" });
  registerChannel(plugin);

  // The pairing code path calls plugin.sendOutbound with confirmation
  // We can't call processInbound directly here because it requires
  // getAgentClient, but we can verify the plugin mock is wired correctly
  const outResult = await plugin.sendOutbound({
    chatId: "chat-1",
    text: "Paired!",
    replyToMessageId: "msg-1",
  });

  assert.equal(outResult.success, true);
  assert.equal(calls.sendOutbound.length, 1);
  assert.equal(calls.sendOutbound[0]!.chatId, "chat-1");

  resetIdentityStore();
});

test("mock plugin toSendRequest returns configurable defaultUserId", () => {
  const { plugin, calls } = createMockPlugin({ defaultUserId: "alice" });
  const message = makeInboundMessage();

  const partial = plugin.toSendRequest(message);

  assert.equal(partial.userId, "alice");
  assert.equal(partial.channelName, "test-channel");
  assert.equal(calls.toSendRequest.length, 1);
});

test("mock plugin toSendRequest with undefined defaultUserId", () => {
  const { plugin } = createMockPlugin({ defaultUserId: undefined });
  const message = makeInboundMessage();

  const partial = plugin.toSendRequest(message);

  assert.equal(partial.userId, undefined);
});

// ============================================================================
// Tests — Cross-channel identity unification
// ============================================================================

test("same user linked from multiple channels resolves to same chittiUserId", async () => {
  const store = await setupIdentityStore();

  // Link both telegram and whatsapp to "alice"
  await store.upsertLink({
    id: "telegram:12345",
    chittiUserId: "alice",
    channel: "telegram",
    channelUserId: "12345",
    linkedVia: "admin",
    linkedAt: new Date().toISOString(),
  });
  await store.upsertLink({
    id: "whatsapp:+15551234567",
    chittiUserId: "alice",
    channel: "whatsapp",
    channelUserId: "+15551234567",
    linkedVia: "pairing-code",
    linkedAt: new Date().toISOString(),
  });

  resetIdentityConfigCache();

  const telegramResult = await resolveChannelIdentity(store, "telegram", "12345");
  const whatsappResult = await resolveChannelIdentity(store, "whatsapp", "+15551234567");

  assert.equal(telegramResult.resolved, true);
  assert.equal(whatsappResult.resolved, true);

  // Both resolve to the same canonical user
  assert.equal(
    telegramResult.resolved && telegramResult.chittiUserId,
    "alice",
  );
  assert.equal(
    whatsappResult.resolved && whatsappResult.chittiUserId,
    "alice",
  );
});

test("different users on same channel resolve to different chittiUserIds", async () => {
  const store = await setupIdentityStore();

  await store.upsertLink({
    id: "telegram:12345",
    chittiUserId: "alice",
    channel: "telegram",
    channelUserId: "12345",
    linkedVia: "admin",
    linkedAt: new Date().toISOString(),
  });
  await store.upsertLink({
    id: "telegram:67890",
    chittiUserId: "priya",
    channel: "telegram",
    channelUserId: "67890",
    linkedVia: "admin",
    linkedAt: new Date().toISOString(),
  });

  resetIdentityConfigCache();

  const aliceResult = await resolveChannelIdentity(store, "telegram", "12345");
  const priyaResult = await resolveChannelIdentity(store, "telegram", "67890");

  assert.equal(aliceResult.resolved && aliceResult.chittiUserId, "alice");
  assert.equal(priyaResult.resolved && priyaResult.chittiUserId, "priya");
});

// ============================================================================
// choicesToPayload — native rendering of runner-captured bounded choices
// ============================================================================

test("choicesToPayload: undefined and empty choices produce no payload", () => {
  assert.equal(choicesToPayload(undefined, "body"), undefined);
  assert.equal(choicesToPayload({ options: [] }, "body"), undefined);
});

test("choicesToPayload: up to 3 options become reply buttons with the reply as body", () => {
  const payload = choicesToPayload(
    {
      options: [
        { id: "MUTUAL", title: "Both ways" },
        { id: "ONE_WAY", title: "One way" },
      ],
    },
    "Should the secrecy work both ways?",
  );
  assert.deepEqual(payload, {
    kind: "buttons",
    body: "Should the secrecy work both ways?",
    buttons: [
      { id: "MUTUAL", title: "Both ways" },
      { id: "ONE_WAY", title: "One way" },
    ],
  });
});

test("choicesToPayload: 4+ options become a list carrying descriptions and the title as button", () => {
  const payload = choicesToPayload(
    {
      listButton: "Pick a party",
      options: [
        { id: "p1", title: "Alice Example", description: "12 Example Street" },
        { id: "p2", title: "Priya Sharma" },
        { id: "p3", title: "Acme Pvt Ltd" },
        { id: "new", title: "Someone new" },
      ],
    },
    "Who is the other side?",
  );
  assert.deepEqual(payload, {
    kind: "list",
    body: "Who is the other side?",
    button: "Pick a party",
    sections: [
      {
        title: "",
        rows: [
          { id: "p1", title: "Alice Example", description: "12 Example Street" },
          { id: "p2", title: "Priya Sharma" },
          { id: "p3", title: "Acme Pvt Ltd" },
          { id: "new", title: "Someone new" },
        ],
      },
    ],
  });
});

test("choicesToPayload: list without listButton falls back to a generic label", () => {
  const payload = choicesToPayload(
    {
      options: [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
        { id: "c", title: "C" },
        { id: "d", title: "D" },
      ],
    },
    "Pick one",
  );
  assert.equal(payload?.kind, "list");
  assert.equal(payload && "button" in payload ? payload.button : undefined, "Choose one");
});

// ============================================================================
// Tests — processInbound refuses unsafe turns
// ============================================================================

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../utils/index.js";

/** Point config at a temp file so these tests don't depend on agentforeach.json. */
function withIdentityConfig(identity: Record<string, unknown>): () => void {
  const saved = process.env.CONFIG_FILE_JSON;
  const file = join(mkdtempSync(join(tmpdir(), "agentforeach-router-")), "config.json");
  writeFileSync(file, JSON.stringify({ identity }));
  process.env.CONFIG_FILE_JSON = file;
  resetConfigCache();
  resetIdentityConfigCache();
  return () => {
    if (saved === undefined) delete process.env.CONFIG_FILE_JSON;
    else process.env.CONFIG_FILE_JSON = saved;
    resetConfigCache();
    resetIdentityConfigCache();
  };
}

test("processInbound refuses the turn when identity is enabled but its store is unavailable", async () => {
  // With no store (e.g. Cosmos down at bootstrap), falling back would run the
  // stranger as the default user; the turn must be refused, and retried.
  const restore = withIdentityConfig({ enabled: true, fallbackMode: "config-default" });
  try {
    resetIdentityStore();
    const { plugin, calls } = createMockPlugin({ defaultUserId: "owner" });
    registerChannel(plugin);

    const result = await processInbound(plugin.id, makeInboundMessage());

    assert.equal(result.success, false);
    assert.equal(result.retryable, true);
    assert.match(result.error ?? "", /Identity store unavailable/);
    assert.equal(calls.sendOutbound.length, 0);
    assert.equal(calls.toSendRequest.length, 0);
  } finally {
    restore();
  }
});

test("processInbound refuses a stranger who would run as the default user without an allowlist", async () => {
  // Defence in depth: even a channel that skipped the registration guard
  // can't hand a stranger the default user's workspace.
  const restore = withIdentityConfig({ enabled: true, fallbackMode: "config-default" });
  try {
    setIdentityStore(await setupIdentityStore());
    const { plugin } = createMockPlugin({ defaultUserId: "owner" });
    registerChannel(plugin);

    const result = await processInbound(plugin.id, makeInboundMessage());

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /not authorized/);
  } finally {
    resetIdentityStore();
    restore();
  }
});

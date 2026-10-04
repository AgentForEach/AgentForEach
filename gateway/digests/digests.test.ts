/**
 * AgentForEach Digests Module — End-to-End Tests
 *
 * Comprehensive tests for the digests subsystem:
 *   - DigestStore (save, getRecent, searchByKeyword)
 *   - DigestToolHandler (session_search tool)
 *   - buildRecencySection (prompt section)
 *   - Tool definitions and guards
 *
 * Uses the storage SDK's in-memory adapter — no external APIs required.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { DigestStore } from "./store.js";
import { DigestToolHandler, getDigestToolDefinitions, isDigestTool, SESSION_SEARCH_TOOL_NAME } from "./tools.js";
import type { DigestDocument } from "./types.js";
import type { DigestConfig } from "./config.js";
import { buildRecencySection } from "../prompt/sections/recency.js";
import { InMemoryStorage } from "@agentforeach/storage";
import type {
  MemoryLayer,
  MemoryEntry,
  MemorySearchResult,
  ToolDefinition,
} from "../memory/types.js";

// ============================================================================
// Mock Memory Layer (for DigestToolHandler tests)
// ============================================================================

class MockMemoryLayer implements MemoryLayer {
  private entries: MemoryEntry[] = [];

  async store(text: string, options: { userId: string; category?: string; importance?: number; source?: string; tags?: string[] }): Promise<MemoryEntry | null> {
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: `mem_${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
      userId: options.userId,
      text,
      vector: [],
      category: (options.category ?? "fact") as MemoryEntry["category"],
      importance: options.importance ?? 0.5,
      createdAt: now,
      lastAccessedAt: now,
      contentHash: createHash("sha256").update(text).digest("hex"),
      accessCount: 0,
      source: options.source,
      tags: options.tags,
    };
    this.entries.push(entry);
    return entry;
  }

  async search(query: string, options: { userId: string; limit?: number }): Promise<MemorySearchResult[]> {
    const lowerQuery = query.toLowerCase();
    const limit = options.limit ?? 5;
    return this.entries
      .filter((e) => e.userId === options.userId && e.text.toLowerCase().includes(lowerQuery))
      .slice(0, limit)
      .map((entry) => ({ entry: structuredClone(entry), score: 0.8, finalScore: 0.8 }));
  }

  async delete(_id: string, _userId: string): Promise<boolean> { return false; }
  async forget(_query: string, _userId: string): Promise<number> { return 0; }
  async count(_userId: string): Promise<number> { return this.entries.length; }
  async recall(_userMessage: string, _userId: string): Promise<string> { return ""; }
  async capture(_userMessage: string, _userId: string, _source?: string): Promise<MemoryEntry | null> { return null; }
  getToolDefinitions(): ToolDefinition[] { return []; }
  async handleToolCall(_toolName: string, _args: Record<string, unknown>, _userId: string): Promise<string> { return ""; }
  async initialize(): Promise<void> {}

  /** Test helper: seed a compaction memory. */
  seedCompactionMemory(text: string, userId: string, sessionId: string): void {
    this.entries.push({
      id: `mem_comp_${sessionId}`,
      userId,
      text,
      vector: [],
      category: "fact",
      importance: 0.8,
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      contentHash: createHash("sha256").update(text).digest("hex"),
      accessCount: 0,
      source: `compaction:${sessionId}`,
      tags: ["session-summary"],
    });
  }
}

// ============================================================================
// Test Helpers
// ============================================================================

function makeDigest(overrides?: Partial<DigestDocument>): DigestDocument {
  const defaults: DigestDocument = {
    id: `dg_${overrides?.sessionId ?? "sess_default"}`,
    userId: "user1",
    sessionId: overrides?.sessionId ?? "sess_default",
    agentId: "default",
    summary: "Discussed project architecture and deployment strategy",
    topics: [],
    createdAt: new Date().toISOString(),
    ttl: 604800,
  };
  return { ...defaults, ...overrides };
}

function makeDigestConfig(overrides?: Partial<DigestConfig>): DigestConfig {
  return {
    enabled: true,
    containerId: "session-digests",
    ttlSeconds: 604800,
    recallLimit: 5,
    maxSummaryChars: 300,
    ...overrides,
  };
}

// ============================================================================
// 1. DigestStore — Core CRUD & Queries
// ============================================================================

test("DigestStore", async (t) => {
  await t.test("save — upserts a digest document", async () => {
    const db = new InMemoryStorage();
    const store = new DigestStore(db, "test-digests");
    await store.initialize();

    const digest = makeDigest({ sessionId: "sess_001" });
    const saved = await store.save(digest);

    assert.equal(saved.id, "dg_sess_001");
    assert.equal(saved.userId, "user1");
    assert.equal(saved.sessionId, "sess_001");
  });

  await t.test("save — updates existing digest on re-save", async () => {
    const db = new InMemoryStorage();
    const store = new DigestStore(db, "test-digests");
    await store.initialize();

    const digest1 = makeDigest({ sessionId: "sess_002", summary: "First summary" });
    await store.save(digest1);

    const digest2 = makeDigest({ sessionId: "sess_002", summary: "Updated summary" });
    const updated = await store.save(digest2);

    assert.equal(updated.summary, "Updated summary");

    // Only one document should exist
    const recent = await store.getRecent("user1", 10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].summary, "Updated summary");
  });

  await t.test("getRecent — returns digests ordered by createdAt DESC", async () => {
    const db = new InMemoryStorage();
    const store = new DigestStore(db, "test-digests");
    await store.initialize();

    await store.save(
      makeDigest({ sessionId: "sess_a", createdAt: "2024-01-01T00:00:00Z", summary: "Oldest" }),
    );
    await store.save(
      makeDigest({ sessionId: "sess_b", createdAt: "2024-01-02T00:00:00Z", summary: "Middle" }),
    );
    await store.save(
      makeDigest({ sessionId: "sess_c", createdAt: "2024-01-03T00:00:00Z", summary: "Newest" }),
    );

    const recent = await store.getRecent("user1", 3);

    assert.equal(recent.length, 3);
    assert.equal(recent[0].summary, "Newest");
    assert.equal(recent[1].summary, "Middle");
    assert.equal(recent[2].summary, "Oldest");
  });

  await t.test("getRecent — respects limit", async () => {
    const db = new InMemoryStorage();
    const store = new DigestStore(db, "test-digests");
    await store.initialize();

    for (let i = 0; i < 5; i++) {
      await store.save(
        makeDigest({
          sessionId: `sess_${i}`,
          createdAt: `2024-01-0${i + 1}T00:00:00Z`,
        }),
      );
    }

    const recent = await store.getRecent("user1", 2);
    assert.equal(recent.length, 2);
  });

  await t.test("getRecent — isolates by userId", async () => {
    const db = new InMemoryStorage();
    const store = new DigestStore(db, "test-digests");
    await store.initialize();

    await store.save(makeDigest({ userId: "user1", sessionId: "sess_u1" }));
    await store.save(makeDigest({ userId: "user2", sessionId: "sess_u2" }));

    const user1Digests = await store.getRecent("user1", 10);
    const user2Digests = await store.getRecent("user2", 10);

    assert.equal(user1Digests.length, 1);
    assert.equal(user2Digests.length, 1);
    assert.equal(user1Digests[0].sessionId, "sess_u1");
    assert.equal(user2Digests[0].sessionId, "sess_u2");
  });

  await t.test("searchByKeyword — finds matching digests", async () => {
    const db = new InMemoryStorage();
    const store = new DigestStore(db, "test-digests");
    await store.initialize();

    await store.save(
      makeDigest({
        sessionId: "sess_api",
        summary: "Discussed REST API design and authentication flow",
        createdAt: "2024-01-03T00:00:00Z",
      }),
    );
    await store.save(
      makeDigest({
        sessionId: "sess_db",
        summary: "Reviewed database schema and migration plan",
        createdAt: "2024-01-02T00:00:00Z",
      }),
    );
    await store.save(
      makeDigest({
        sessionId: "sess_ui",
        summary: "Built React components for the dashboard",
        createdAt: "2024-01-01T00:00:00Z",
      }),
    );

    const results = await store.searchByKeyword("user1", "api", 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, "sess_api");
  });

  await t.test("searchByKeyword — case-insensitive", async () => {
    const db = new InMemoryStorage();
    const store = new DigestStore(db, "test-digests");
    await store.initialize();

    await store.save(
      makeDigest({ sessionId: "sess_1", summary: "Discussed PostgreSQL performance tuning" }),
    );

    const results = await store.searchByKeyword("user1", "POSTGRESQL", 5);
    assert.equal(results.length, 1);
  });

  await t.test("searchByKeyword — returns empty for no matches", async () => {
    const db = new InMemoryStorage();
    const store = new DigestStore(db, "test-digests");
    await store.initialize();

    await store.save(
      makeDigest({ sessionId: "sess_1", summary: "Discussed API design" }),
    );

    const results = await store.searchByKeyword("user1", "kubernetes", 5);
    assert.equal(results.length, 0);
  });

  await t.test("searchByKeyword — respects maxAgeDays filter", async () => {
    const db = new InMemoryStorage();
    const store = new DigestStore(db, "test-digests");
    await store.initialize();

    // Create one recent and one old digest
    const recent = new Date();
    const old = new Date();
    old.setDate(old.getDate() - 30); // 30 days ago

    await store.save(
      makeDigest({
        sessionId: "sess_new",
        summary: "Recent API discussion about endpoints",
        createdAt: recent.toISOString(),
      }),
    );
    await store.save(
      makeDigest({
        sessionId: "sess_old",
        summary: "Old API discussion about legacy endpoints",
        createdAt: old.toISOString(),
      }),
    );

    // Search with 7-day window — should only find the recent one
    const results = await store.searchByKeyword("user1", "api", 5, 7);
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, "sess_new");
  });

  await t.test("initialize is idempotent", async () => {
    const db = new InMemoryStorage();
    const store = new DigestStore(db, "test-digests");

    await store.initialize();
    await store.initialize(); // Should not throw

    const digest = makeDigest({ sessionId: "sess_idem" });
    const saved = await store.save(digest);
    assert.equal(saved.sessionId, "sess_idem");
  });
});

// ============================================================================
// 2. DigestToolHandler — session_search tool
// ============================================================================

test("DigestToolHandler — session_search", async (t) => {
  await t.test("tool definitions", () => {
    const defs = getDigestToolDefinitions();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].name, SESSION_SEARCH_TOOL_NAME);
    assert.equal(defs[0].type, "function");
    assert.ok(defs[0].parameters.properties.query);
  });

  await t.test("isDigestTool guard", () => {
    assert.ok(isDigestTool("session_search"));
    assert.ok(!isDigestTool("memory_search"));
    assert.ok(!isDigestTool("unknown"));
  });

  await t.test("searches digests by keyword", async () => {
    const db = new InMemoryStorage();
    const digestStore = new DigestStore(db, "test-digests");
    await digestStore.initialize();
    const memoryLayer = new MockMemoryLayer();
    const config = makeDigestConfig();

    // Use recent dates (within default 7-day maxAgeDays window)
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const twoDaysAgo = new Date(now);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    await digestStore.save(
      makeDigest({
        sessionId: "sess_auth",
        summary: "Implemented OAuth2 authentication flow with JWT tokens",
        createdAt: yesterday.toISOString(),
        topics: ["auth", "security"],
      }),
    );
    await digestStore.save(
      makeDigest({
        sessionId: "sess_deploy",
        summary: "Set up CI/CD pipeline with GitHub Actions for deployment",
        createdAt: twoDaysAgo.toISOString(),
      }),
    );

    const handler = new DigestToolHandler(digestStore, memoryLayer, config);
    const result = await handler.handle("session_search", { query: "authentication" }, "user1");

    assert.ok(result.includes("matching past session"));
    assert.ok(result.includes("OAuth2"));
    assert.ok(result.includes("[auth, security]"));
  });

  await t.test("searches compaction memories", async () => {
    const db = new InMemoryStorage();
    const digestStore = new DigestStore(db, "test-digests");
    await digestStore.initialize();
    const memoryLayer = new MockMemoryLayer();
    const config = makeDigestConfig();

    // Seed a compaction memory (no digest)
    memoryLayer.seedCompactionMemory(
      "Discussed database optimization with query indexing",
      "user1",
      "sess_db",
    );

    const handler = new DigestToolHandler(digestStore, memoryLayer, config);
    const result = await handler.handle("session_search", { query: "database" }, "user1");

    assert.ok(result.includes("matching past session"));
    assert.ok(result.includes("database"));
  });

  await t.test("merges and deduplicates digest + memory results", async () => {
    const db = new InMemoryStorage();
    const digestStore = new DigestStore(db, "test-digests");
    await digestStore.initialize();
    const memoryLayer = new MockMemoryLayer();
    const config = makeDigestConfig();

    // Same session in both digest and memory — should be deduplicated
    await digestStore.save(
      makeDigest({
        sessionId: "sess_shared",
        summary: "Discussed API rate limiting implementation",
        createdAt: "2024-01-05T00:00:00Z",
      }),
    );
    memoryLayer.seedCompactionMemory(
      "API rate limiting with Redis token bucket",
      "user1",
      "sess_shared",
    );

    const handler = new DigestToolHandler(digestStore, memoryLayer, config);
    const result = await handler.handle("session_search", { query: "rate limiting" }, "user1");

    // Should only appear once (digest takes priority)
    const lines = result.split("\n").filter((l) => l.match(/^\d+\./));
    assert.equal(lines.length, 1, "duplicates should be merged");
  });

  await t.test("returns no results message for no matches", async () => {
    const db = new InMemoryStorage();
    const digestStore = new DigestStore(db, "test-digests");
    await digestStore.initialize();
    const memoryLayer = new MockMemoryLayer();
    const config = makeDigestConfig();

    const handler = new DigestToolHandler(digestStore, memoryLayer, config);
    const result = await handler.handle("session_search", { query: "quantum computing" }, "user1");

    assert.ok(result.includes("No matching past sessions found"));
  });

  await t.test("validates query is required", async () => {
    const db = new InMemoryStorage();
    const digestStore = new DigestStore(db, "test-digests");
    await digestStore.initialize();
    const memoryLayer = new MockMemoryLayer();
    const config = makeDigestConfig();

    const handler = new DigestToolHandler(digestStore, memoryLayer, config);
    const result = await handler.handle("session_search", {}, "user1");

    assert.ok(result.includes("error"));
    assert.ok(result.includes("query is required"));
  });

  await t.test("rejects unknown tool name", async () => {
    const db = new InMemoryStorage();
    const digestStore = new DigestStore(db, "test-digests");
    await digestStore.initialize();
    const memoryLayer = new MockMemoryLayer();
    const config = makeDigestConfig();

    const handler = new DigestToolHandler(digestStore, memoryLayer, config);
    const result = await handler.handle("wrong_tool", { query: "test" }, "user1");

    assert.ok(result.includes("Unknown digest tool"));
  });

  await t.test("respects limit parameter", async () => {
    const db = new InMemoryStorage();
    const digestStore = new DigestStore(db, "test-digests");
    await digestStore.initialize();
    const memoryLayer = new MockMemoryLayer();
    const config = makeDigestConfig();

    for (let i = 0; i < 5; i++) {
      await digestStore.save(
        makeDigest({
          sessionId: `sess_api_${i}`,
          summary: `API session ${i} with design discussion`,
          createdAt: `2024-01-0${i + 1}T00:00:00Z`,
        }),
      );
    }

    const handler = new DigestToolHandler(digestStore, memoryLayer, config);
    const result = await handler.handle("session_search", { query: "api", limit: 2 }, "user1");

    const lines = result.split("\n").filter((l) => l.match(/^\d+\./));
    assert.ok(lines.length <= 2, `expected at most 2 results, got ${lines.length}`);
  });

  await t.test("user isolation — user2 cannot see user1 digests", async () => {
    const db = new InMemoryStorage();
    const digestStore = new DigestStore(db, "test-digests");
    await digestStore.initialize();
    const memoryLayer = new MockMemoryLayer();
    const config = makeDigestConfig();

    await digestStore.save(
      makeDigest({
        userId: "user1",
        sessionId: "sess_secret",
        summary: "Confidential API design discussion with secret tokens",
      }),
    );

    const handler = new DigestToolHandler(digestStore, memoryLayer, config);
    const result = await handler.handle("session_search", { query: "secret" }, "user2");

    assert.ok(result.includes("No matching past sessions found"));
  });
});

// ============================================================================
// 3. buildRecencySection — Prompt Section
// ============================================================================

test("buildRecencySection", async (t) => {
  await t.test("renders digest summaries in XML block", () => {
    const digests: DigestDocument[] = [
      makeDigest({
        sessionId: "sess_1",
        summary: "Discussed API gateway architecture",
        createdAt: "2024-01-15T10:30:00Z",
        topics: ["architecture", "API"],
      }),
      makeDigest({
        sessionId: "sess_2",
        summary: "Reviewed database migration plan",
        createdAt: "2024-01-14T14:00:00Z",
        topics: [],
      }),
    ];

    const lines = buildRecencySection({ isMinimal: false, recentDigests: digests });
    const text = lines.join("\n");

    assert.ok(text.includes("## Recent Activity"));
    assert.ok(text.includes("<recent-activity>"));
    assert.ok(text.includes("</recent-activity>"));
    assert.ok(text.includes("2024-01-15 [architecture, API]: Discussed API gateway architecture"));
    assert.ok(text.includes("2024-01-14: Reviewed database migration plan"));
  });

  await t.test("returns empty for minimal sessions", () => {
    const lines = buildRecencySection({
      isMinimal: true,
      recentDigests: [makeDigest()],
    });
    assert.equal(lines.length, 0);
  });

  await t.test("returns empty when no digests", () => {
    const lines1 = buildRecencySection({ isMinimal: false, recentDigests: [] });
    assert.equal(lines1.length, 0);

    const lines2 = buildRecencySection({ isMinimal: false });
    assert.equal(lines2.length, 0);
  });

  await t.test("handles multiple topics", () => {
    const digests: DigestDocument[] = [
      makeDigest({
        sessionId: "sess_t",
        summary: "Multi-topic discussion",
        createdAt: "2024-01-10T00:00:00Z",
        topics: ["React", "TypeScript", "testing"],
      }),
    ];

    const lines = buildRecencySection({ isMinimal: false, recentDigests: digests });
    const text = lines.join("\n");
    assert.ok(text.includes("[React, TypeScript, testing]"));
  });
});

// ============================================================================
// 4. End-to-End — Digest Lifecycle (Compaction → Digest → Recency → Search)
// ============================================================================

test("Digest lifecycle — end-to-end flow", async (t) => {
  await t.test("compaction creates digest → recency section renders → search finds it", async () => {
    const db = new InMemoryStorage();
    const digestStore = new DigestStore(db, "test-digests");
    await digestStore.initialize();
    const memoryLayer = new MockMemoryLayer();
    const digestConfig = makeDigestConfig();

    // Step 1: Simulate compaction creating a digest (what after_compaction hook does)
    const sessionId = "sess_lifecycle";
    const userId = "user1";
    const compactionSummary =
      "User discussed migrating from Express to Fastify. Decided to use PostgreSQL for the database layer. Pending: deploy to staging environment.";

    const digest: DigestDocument = {
      id: `dg_${sessionId}`,
      userId,
      sessionId,
      agentId: "default",
      summary: compactionSummary.slice(0, digestConfig.maxSummaryChars),
      topics: [],
      createdAt: new Date().toISOString(),
      ttl: digestConfig.ttlSeconds,
    };
    await digestStore.save(digest);

    // Step 2: Simulate compaction also indexing into memory
    memoryLayer.seedCompactionMemory(compactionSummary, userId, sessionId);

    // Step 3: Verify recency prompt section renders the digest
    const recentDigests = await digestStore.getRecent(userId, digestConfig.recallLimit);
    const recencyLines = buildRecencySection({
      isMinimal: false,
      recentDigests,
    });
    const recencyText = recencyLines.join("\n");

    assert.ok(recencyText.includes("<recent-activity>"));
    assert.ok(recencyText.includes("migrating from Express to Fastify"));

    // Step 4: Verify session_search tool finds it
    const handler = new DigestToolHandler(digestStore, memoryLayer, digestConfig);

    const searchResult = await handler.handle(
      "session_search",
      { query: "fastify" },
      userId,
    );
    assert.ok(searchResult.includes("matching past session"));
    assert.ok(searchResult.includes("Fastify"));

    // Step 5: Also searchable via memory (compaction source)
    const memSearchResult = await handler.handle(
      "session_search",
      { query: "postgresql" },
      userId,
    );
    assert.ok(memSearchResult.includes("matching past session"));
    assert.ok(memSearchResult.includes("PostgreSQL"));
  });

  await t.test("multiple sessions create a complete recency recap", async () => {
    const db = new InMemoryStorage();
    const digestStore = new DigestStore(db, "test-digests");
    await digestStore.initialize();
    const digestConfig = makeDigestConfig({ recallLimit: 3 });

    // Simulate 3 sessions creating digests over 3 days
    const sessions = [
      {
        sessionId: "sess_day1",
        summary: "Set up project structure with monorepo using Turborepo",
        createdAt: "2024-01-01T10:00:00Z",
      },
      {
        sessionId: "sess_day2",
        summary: "Implemented authentication with OAuth2 and JWT tokens",
        createdAt: "2024-01-02T14:00:00Z",
      },
      {
        sessionId: "sess_day3",
        summary: "Added real-time notifications via WebSocket PubSub",
        createdAt: "2024-01-03T09:00:00Z",
      },
    ];

    for (const s of sessions) {
      await digestStore.save(
        makeDigest({
          sessionId: s.sessionId,
          summary: s.summary,
          createdAt: s.createdAt,
        }),
      );
    }

    // Build recency section
    const recent = await digestStore.getRecent("user1", digestConfig.recallLimit);
    const lines = buildRecencySection({ isMinimal: false, recentDigests: recent });
    const text = lines.join("\n");

    // Should show all 3 in reverse chronological order
    assert.ok(text.includes("WebSocket PubSub"));
    assert.ok(text.includes("OAuth2 and JWT"));
    assert.ok(text.includes("monorepo using Turborepo"));

    // Most recent should appear first
    const wsIdx = text.indexOf("WebSocket");
    const authIdx = text.indexOf("OAuth2");
    const monoIdx = text.indexOf("monorepo");
    assert.ok(wsIdx < authIdx, "Day 3 should appear before Day 2");
    assert.ok(authIdx < monoIdx, "Day 2 should appear before Day 1");
  });
});

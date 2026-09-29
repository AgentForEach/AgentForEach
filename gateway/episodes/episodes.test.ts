/**
 * AgentForEach Episodes Module — Tests
 *
 * Tests the pure utility functions and tool handler logic:
 *   - buildEpisodeId()          — deterministic ID generation
 *   - normalizeStringArray()    — input normalization
 *   - formatEpisodesContext()   — episode formatting for LLM context
 *   - isEpisodeTool()           — tool name guard
 *   - getEpisodeToolDefinitions() — tool definitions
 *   - EpisodeToolHandler        — create, update, recall (with mock store)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildEpisodeId, normalizeStringArray } from "./generator.js";
import { formatEpisodesContext } from "./recall.js";
import {
  isEpisodeTool,
  getEpisodeToolDefinitions,
  EpisodeToolHandler,
  EPISODE_RECALL_TOOL_NAME,
  EPISODE_CREATE_TOOL_NAME,
  EPISODE_UPDATE_TOOL_NAME,
} from "./tools.js";
import type { EpisodeDocument } from "./types.js";
import type { EpisodeConfig } from "./config.js";
import type { EpisodeStore } from "./store.js";

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal EpisodeDocument for testing. */
function makeEpisode(overrides?: Partial<EpisodeDocument>): EpisodeDocument {
  return {
    id: "ep_abc123",
    userId: "u1",
    theme: "Test Theme",
    summary: "A test episode about testing.",
    vector: [],
    topics: ["testing"],
    highlights: [
      {
        date: "2026-02-20T10:00:00.000Z",
        sessionId: "sess1",
        text: "Started writing tests.",
      },
    ],
    status: "active",
    salience: 0.5,
    decisions: ["Use node:test"],
    pending: ["Write more tests"],
    createdAt: "2026-02-20T10:00:00.000Z",
    updatedAt: "2026-02-22T10:00:00.000Z",
    ...overrides,
  };
}

/** Build a default EpisodeConfig for testing. */
function makeConfig(overrides?: Partial<EpisodeConfig>): EpisodeConfig {
  return {
    enabled: true,
    containerId: "episodes",
    recallLimit: 3,
    recallMaxAgeDays: 90,
    maxSummaryChars: 600,
    generateVectors: false,
    maxHighlightsPerEpisode: 20,
    maxActiveEpisodes: 10,
    decayEnabled: false,
    decayHalfLifeDays: 60,
    ...overrides,
  };
}

/** Tracks mock store calls. */
interface StoreCalls {
  upsert: EpisodeDocument[];
  conditionalUpdate: Array<{ userId: string; episodeId: string }>;
  getById: Array<{ userId: string; episodeId: string }>;
  getRecent: Array<{ userId: string; limit: number }>;
}

/** Build a mock EpisodeStore. */
function makeMockStore(options?: {
  getByIdResult?: EpisodeDocument | null;
  getRecentResult?: EpisodeDocument[];
}): { store: EpisodeStore; calls: StoreCalls } {
  const calls: StoreCalls = {
    upsert: [],
    conditionalUpdate: [],
    getById: [],
    getRecent: [],
  };

  const store = {
    upsert: async (ep: EpisodeDocument) => {
      calls.upsert.push(ep);
    },
    conditionalUpdate: async (
      userId: string,
      episodeId: string,
      updater: (episode: EpisodeDocument) => EpisodeDocument | Promise<EpisodeDocument>,
    ) => {
      calls.conditionalUpdate.push({ userId, episodeId });
      const existing = options?.getByIdResult ?? null;
      if (!existing) return null;
      // Clone to avoid mutating the original test fixture
      const clone = JSON.parse(JSON.stringify(existing)) as EpisodeDocument;
      const updated = await updater(clone);
      calls.upsert.push(updated); // track for test assertions
      return updated;
    },
    getById: async (userId: string, episodeId: string) => {
      calls.getById.push({ userId, episodeId });
      return options?.getByIdResult ?? null;
    },
    getRecent: async (userId: string, limit: number) => {
      calls.getRecent.push({ userId, limit });
      return options?.getRecentResult ?? [];
    },
    semanticSearch: async () => [],
    getActive: async () => [],
    hasSessionContributed: async () => false,
    initialize: async () => {},
  } as unknown as EpisodeStore;

  return { store, calls };
}

// ============================================================================
// Tests — buildEpisodeId()
// ============================================================================

test("buildEpisodeId", async (t) => {
  await t.test("returns a string starting with 'ep_'", () => {
    const id = buildEpisodeId("u1", "Wedding Planning");
    assert.ok(id.startsWith("ep_"));
  });

  await t.test("is deterministic (same input → same output)", () => {
    const id1 = buildEpisodeId("u1", "Job Search");
    const id2 = buildEpisodeId("u1", "Job Search");
    assert.equal(id1, id2);
  });

  await t.test("normalizes theme to lowercase", () => {
    const id1 = buildEpisodeId("u1", "Wedding Planning");
    const id2 = buildEpisodeId("u1", "wedding planning");
    assert.equal(id1, id2);
  });

  await t.test("trims theme whitespace", () => {
    const id1 = buildEpisodeId("u1", "Job Search");
    const id2 = buildEpisodeId("u1", "  Job Search  ");
    assert.equal(id1, id2);
  });

  await t.test("different users produce different IDs", () => {
    const id1 = buildEpisodeId("u1", "Theme");
    const id2 = buildEpisodeId("u2", "Theme");
    assert.notEqual(id1, id2);
  });

  await t.test("different themes produce different IDs", () => {
    const id1 = buildEpisodeId("u1", "Theme A");
    const id2 = buildEpisodeId("u1", "Theme B");
    assert.notEqual(id1, id2);
  });

  await t.test("ID has expected length (ep_ + 16 hex chars)", () => {
    const id = buildEpisodeId("u1", "Theme");
    assert.equal(id.length, 3 + 16); // "ep_" + 16 hex
  });
});

// ============================================================================
// Tests — normalizeStringArray()
// ============================================================================

test("normalizeStringArray", async (t) => {
  await t.test("filters non-string values", () => {
    assert.deepEqual(
      normalizeStringArray([1, true, "valid", null], 5),
      ["valid"],
    );
  });

  await t.test("filters empty strings", () => {
    assert.deepEqual(
      normalizeStringArray(["hello", "", "  ", "world"], 5),
      ["hello", "world"],
    );
  });

  await t.test("respects maxItems limit", () => {
    assert.deepEqual(
      normalizeStringArray(["a", "b", "c", "d"], 2),
      ["a", "b"],
    );
  });

  await t.test("trims whitespace", () => {
    assert.deepEqual(
      normalizeStringArray(["  hello  ", "world  "], 5),
      ["hello", "world"],
    );
  });

  await t.test("returns empty array for non-array input", () => {
    assert.deepEqual(normalizeStringArray("not-array", 5), []);
    assert.deepEqual(normalizeStringArray(null, 5), []);
    assert.deepEqual(normalizeStringArray(undefined, 5), []);
    assert.deepEqual(normalizeStringArray(42, 5), []);
  });

  await t.test("returns empty array for empty array", () => {
    assert.deepEqual(normalizeStringArray([], 5), []);
  });
});

// ============================================================================
// Tests — formatEpisodesContext()
// ============================================================================

test("formatEpisodesContext", async (t) => {
  await t.test("formats a single episode with all sections", () => {
    const ep = makeEpisode({
      updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
    });
    const text = formatEpisodesContext([ep]);

    assert.ok(text.includes("### Test Theme"));
    assert.ok(text.includes("active"));
    assert.ok(text.includes("A test episode about testing."));
    assert.ok(text.includes("Topics: testing"));
    assert.ok(text.includes("Highlights:"));
    assert.ok(text.includes("Started writing tests."));
    assert.ok(text.includes("Decisions:"));
    assert.ok(text.includes("Use node:test"));
    assert.ok(text.includes("Pending:"));
    assert.ok(text.includes("Write more tests"));
    assert.ok(text.includes("ep_abc123"));
  });

  await t.test("shows 'earlier today' for recent updates", () => {
    const ep = makeEpisode({
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    });
    const text = formatEpisodesContext([ep]);
    assert.ok(text.includes("earlier today"));
  });

  await t.test("shows 'yesterday' for 1 day old", () => {
    const ep = makeEpisode({
      updatedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), // 30 hours ago
    });
    const text = formatEpisodesContext([ep]);
    assert.ok(text.includes("yesterday"));
  });

  await t.test("shows high significance label for salience >= 0.8", () => {
    const ep = makeEpisode({ salience: 0.9 });
    const text = formatEpisodesContext([ep]);
    assert.ok(text.includes("significance: high"));
  });

  await t.test("omits significance label for normal salience", () => {
    const ep = makeEpisode({ salience: 0.5 });
    const text = formatEpisodesContext([ep]);
    assert.ok(!text.includes("significance:"));
  });

  await t.test("omits empty sections (no topics, no decisions, no pending)", () => {
    const ep = makeEpisode({ topics: [], decisions: [], pending: [] });
    const text = formatEpisodesContext([ep]);
    assert.ok(!text.includes("Topics:"));
    assert.ok(!text.includes("Decisions:"));
    assert.ok(!text.includes("Pending:"));
  });

  await t.test("formats multiple episodes", () => {
    const ep1 = makeEpisode({ theme: "Episode One", id: "ep_1" });
    const ep2 = makeEpisode({ theme: "Episode Two", id: "ep_2" });
    const text = formatEpisodesContext([ep1, ep2]);
    assert.ok(text.includes("### Episode One"));
    assert.ok(text.includes("### Episode Two"));
  });

  await t.test("returns empty string for empty array", () => {
    const text = formatEpisodesContext([]);
    assert.equal(text, "");
  });
});

// ============================================================================
// Tests — isEpisodeTool() & getEpisodeToolDefinitions()
// ============================================================================

test("isEpisodeTool", async (t) => {
  await t.test("recognizes episode_recall", () => {
    assert.equal(isEpisodeTool("episode_recall"), true);
  });

  await t.test("recognizes episode_create", () => {
    assert.equal(isEpisodeTool("episode_create"), true);
  });

  await t.test("recognizes episode_update", () => {
    assert.equal(isEpisodeTool("episode_update"), true);
  });

  await t.test("rejects unknown tool names", () => {
    assert.equal(isEpisodeTool("episode_delete"), false);
    assert.equal(isEpisodeTool("memory_recall"), false);
    assert.equal(isEpisodeTool(""), false);
  });
});

test("getEpisodeToolDefinitions returns all 3 tools", () => {
  const tools = getEpisodeToolDefinitions();
  assert.equal(tools.length, 3);

  const names = tools.map((t) => t.name);
  assert.ok(names.includes(EPISODE_RECALL_TOOL_NAME));
  assert.ok(names.includes(EPISODE_CREATE_TOOL_NAME));
  assert.ok(names.includes(EPISODE_UPDATE_TOOL_NAME));

  // Each tool should have the expected structure
  for (const tool of tools) {
    assert.equal(tool.type, "function");
    assert.ok(tool.description.length > 0);
    assert.ok(tool.parameters);
  }
});

// ============================================================================
// Tests — EpisodeToolHandler — episode_create
// ============================================================================

test("EpisodeToolHandler.handle — episode_create", async (t) => {
  await t.test("creates an episode with required fields", async () => {
    const { store, calls } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig());

    const result = await handler.handle(
      "episode_create",
      {
        theme: "Wedding Planning",
        summary: "Planning a wedding in Goa.",
        highlight: "Started researching venues.",
      },
      "u1",
      "sess1",
    );

    const parsed = JSON.parse(result);
    assert.equal(parsed.success, true);
    assert.ok(parsed.episodeId.startsWith("ep_"));
    assert.equal(parsed.theme, "Wedding Planning");

    // Verify upsert was called
    assert.equal(calls.upsert.length, 1);
    const ep = calls.upsert[0];
    assert.equal(ep.userId, "u1");
    assert.equal(ep.theme, "Wedding Planning");
    assert.equal(ep.summary, "Planning a wedding in Goa.");
    assert.equal(ep.status, "active");
    assert.equal(ep.highlights.length, 1);
    assert.equal(ep.highlights[0].text, "Started researching venues.");
    assert.equal(ep.highlights[0].sessionId, "sess1");
  });

  await t.test("includes optional fields when provided", async () => {
    const { store, calls } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig());

    await handler.handle(
      "episode_create",
      {
        theme: "Job Search",
        summary: "Looking for remote jobs.",
        highlight: "Updated resume.",
        topics: ["career", "remote"],
        decisions: ["Focus on backend roles"],
        pending: ["Apply to 3 companies"],
        salience: 0.7,
      },
      "u1",
      "sess1",
    );

    const ep = calls.upsert[0];
    assert.deepEqual(ep.topics, ["career", "remote"]);
    assert.deepEqual(ep.decisions, ["Focus on backend roles"]);
    assert.deepEqual(ep.pending, ["Apply to 3 companies"]);
    assert.equal(ep.salience, 0.7);
  });

  await t.test("clamps salience to [0, 1]", async () => {
    const { store, calls } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig());

    await handler.handle(
      "episode_create",
      { theme: "T", summary: "S", highlight: "H", salience: 5.0 },
      "u1",
    );
    assert.equal(calls.upsert[0].salience, 1.0);
  });

  await t.test("defaults salience to 0.5 for NaN", async () => {
    const { store, calls } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig());

    await handler.handle(
      "episode_create",
      { theme: "T", summary: "S", highlight: "H", salience: "not-a-number" },
      "u1",
    );
    assert.equal(calls.upsert[0].salience, 0.5);
  });

  await t.test("returns error when theme is missing", async () => {
    const { store } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig());

    const result = await handler.handle(
      "episode_create",
      { summary: "S", highlight: "H" },
      "u1",
    );

    const parsed = JSON.parse(result);
    assert.ok(parsed.error?.includes("theme"));
  });

  await t.test("returns error when summary is missing", async () => {
    const { store } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig());

    const result = await handler.handle(
      "episode_create",
      { theme: "T", highlight: "H" },
      "u1",
    );

    const parsed = JSON.parse(result);
    assert.ok(parsed.error?.includes("summary"));
  });

  await t.test("returns error when highlight is missing", async () => {
    const { store } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig());

    const result = await handler.handle(
      "episode_create",
      { theme: "T", summary: "S" },
      "u1",
    );

    const parsed = JSON.parse(result);
    assert.ok(parsed.error?.includes("highlight"));
  });

  await t.test("truncates summary to maxSummaryChars", async () => {
    const { store, calls } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig({ maxSummaryChars: 20 }));

    await handler.handle(
      "episode_create",
      {
        theme: "T",
        summary: "A very long summary that exceeds the max chars limit.",
        highlight: "H",
      },
      "u1",
    );

    assert.equal(calls.upsert[0].summary.length, 20);
  });

  await t.test("uses 'unknown' sessionId when not provided", async () => {
    const { store, calls } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig());

    await handler.handle(
      "episode_create",
      { theme: "T", summary: "S", highlight: "H" },
      "u1",
      // no sessionId
    );

    assert.equal(calls.upsert[0].highlights[0].sessionId, "unknown");
  });
});

// ============================================================================
// Tests — EpisodeToolHandler — episode_update
// ============================================================================

test("EpisodeToolHandler.handle — episode_update", async (t) => {
  await t.test("appends a new highlight to an existing episode", async () => {
    const existing = makeEpisode();
    const { store, calls } = makeMockStore({ getByIdResult: existing });
    const handler = new EpisodeToolHandler(store, makeConfig());

    const result = await handler.handle(
      "episode_update",
      { episodeId: "ep_abc123", highlight: "Continued testing." },
      "u1",
      "sess2",
    );

    const parsed = JSON.parse(result);
    assert.equal(parsed.success, true);
    assert.equal(parsed.highlightCount, 2);

    // Verify upsert with new highlight
    assert.equal(calls.upsert.length, 1);
    const updated = calls.upsert[0];
    assert.equal(updated.highlights.length, 2);
    assert.equal(updated.highlights[1].text, "Continued testing.");
    assert.equal(updated.highlights[1].sessionId, "sess2");
  });

  await t.test("skips duplicate session contribution", async () => {
    const existing = makeEpisode();
    const { store, calls } = makeMockStore({ getByIdResult: existing });
    const handler = new EpisodeToolHandler(store, makeConfig());

    // Same sessionId as existing highlight (sess1)
    const result = await handler.handle(
      "episode_update",
      { episodeId: "ep_abc123", highlight: "Duplicate" },
      "u1",
      "sess1",
    );

    const parsed = JSON.parse(result);
    assert.equal(parsed.success, true);
    assert.ok(parsed.message?.includes("already contributed"));

    // No upsert call — dedup prevented update
    assert.equal(calls.upsert.length, 0);
  });

  await t.test("updates optional fields when provided", async () => {
    const existing = makeEpisode();
    const { store, calls } = makeMockStore({ getByIdResult: existing });
    const handler = new EpisodeToolHandler(store, makeConfig());

    await handler.handle(
      "episode_update",
      {
        episodeId: "ep_abc123",
        highlight: "New highlight",
        summary: "Updated summary.",
        decisions: ["New decision A", "New decision B"],
        pending: ["New pending item"],
        status: "concluded",
        salience: 0.9,
      },
      "u1",
      "sess2",
    );

    const updated = calls.upsert[0];
    assert.equal(updated.summary, "Updated summary.");
    assert.deepEqual(updated.decisions, ["New decision A", "New decision B"]);
    assert.deepEqual(updated.pending, ["New pending item"]);
    assert.equal(updated.status, "concluded");
    assert.equal(updated.salience, 0.9);
  });

  await t.test("trims highlights when exceeding maxHighlightsPerEpisode", async () => {
    // Episode with 3 highlights already
    const existing = makeEpisode({
      highlights: [
        { date: "2026-02-20T10:00:00Z", sessionId: "s1", text: "First" },
        { date: "2026-02-21T10:00:00Z", sessionId: "s2", text: "Second" },
        { date: "2026-02-22T10:00:00Z", sessionId: "s3", text: "Third" },
      ],
    });
    const { store, calls } = makeMockStore({ getByIdResult: existing });
    // Set max to 3 — adding one more should trim the oldest
    const handler = new EpisodeToolHandler(store, makeConfig({ maxHighlightsPerEpisode: 3 }));

    await handler.handle(
      "episode_update",
      { episodeId: "ep_abc123", highlight: "Fourth" },
      "u1",
      "s4",
    );

    const updated = calls.upsert[0];
    assert.equal(updated.highlights.length, 3);
    // Oldest ("First") should be trimmed, newest 3 retained
    assert.equal(updated.highlights[0].text, "Second");
    assert.equal(updated.highlights[2].text, "Fourth");
  });

  await t.test("returns error when episode not found", async () => {
    const { store } = makeMockStore({ getByIdResult: null });
    const handler = new EpisodeToolHandler(store, makeConfig());

    const result = await handler.handle(
      "episode_update",
      { episodeId: "ep_missing", highlight: "H" },
      "u1",
    );

    const parsed = JSON.parse(result);
    assert.ok(parsed.error?.includes("not found"));
  });

  await t.test("returns error when episodeId is missing", async () => {
    const { store } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig());

    const result = await handler.handle(
      "episode_update",
      { highlight: "H" },
      "u1",
    );

    const parsed = JSON.parse(result);
    assert.ok(parsed.error?.includes("episodeId"));
  });

  await t.test("returns error when highlight is missing", async () => {
    const { store } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig());

    const result = await handler.handle(
      "episode_update",
      { episodeId: "ep_abc" },
      "u1",
    );

    const parsed = JSON.parse(result);
    assert.ok(parsed.error?.includes("highlight"));
  });

  await t.test("backfills salience to 0.5 for old episodes without it", async () => {
    const existing = makeEpisode();
    // Simulate a pre-existing episode that has no salience field
    delete (existing as any).salience;
    const { store, calls } = makeMockStore({ getByIdResult: existing });
    const handler = new EpisodeToolHandler(store, makeConfig());

    await handler.handle(
      "episode_update",
      { episodeId: "ep_abc123", highlight: "New highlight" },
      "u1",
      "sess2",
    );

    assert.equal(calls.upsert[0].salience, 0.5);
  });
});

// ============================================================================
// Tests — EpisodeToolHandler — episode_recall
// ============================================================================

test("EpisodeToolHandler.handle — episode_recall", async (t) => {
  await t.test("returns formatted episodes on temporal fallback (no embeddings)", async () => {
    const episodes = [
      makeEpisode({
        theme: "Travel Plans",
        updatedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(), // 1 hour ago
      }),
    ];
    const { store } = makeMockStore({ getRecentResult: episodes });
    const handler = new EpisodeToolHandler(store, makeConfig());

    const result = await handler.handle(
      "episode_recall",
      { query: "travel" },
      "u1",
    );

    assert.ok(result.includes("Travel Plans"));
    assert.ok(result.includes("A test episode about testing."));
  });

  await t.test("returns 'no episodes found' when store is empty", async () => {
    const { store } = makeMockStore({ getRecentResult: [] });
    const handler = new EpisodeToolHandler(store, makeConfig());

    const result = await handler.handle(
      "episode_recall",
      { query: "anything" },
      "u1",
    );

    assert.ok(result.includes("No past episodes found"));
  });

  await t.test("returns error when query is missing", async () => {
    const { store } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig());

    const result = await handler.handle("episode_recall", {}, "u1");

    const parsed = JSON.parse(result);
    assert.ok(parsed.error?.includes("query"));
  });

  await t.test("returns error when query is empty string", async () => {
    const { store } = makeMockStore();
    const handler = new EpisodeToolHandler(store, makeConfig());

    const result = await handler.handle(
      "episode_recall",
      { query: "   " },
      "u1",
    );

    const parsed = JSON.parse(result);
    assert.ok(parsed.error?.includes("query"));
  });

  await t.test("respects recallLimit config", async () => {
    const episodes = Array.from({ length: 10 }, (_, i) =>
      makeEpisode({
        id: `ep_${i}`,
        theme: `Theme ${i}`,
        updatedAt: new Date(Date.now() - i * 60 * 60 * 1000).toISOString(),
      }),
    );
    const { store } = makeMockStore({ getRecentResult: episodes });
    const handler = new EpisodeToolHandler(store, makeConfig({ recallLimit: 2 }));

    const result = await handler.handle(
      "episode_recall",
      { query: "themes" },
      "u1",
    );

    // Should contain at most 2 episode headers (### Theme X)
    const headerCount = (result.match(/### Theme/g) || []).length;
    assert.ok(headerCount <= 2, `Expected at most 2 episodes, got ${headerCount}`);
  });
});

// ============================================================================
// Tests — EpisodeToolHandler — unknown tool
// ============================================================================

test("EpisodeToolHandler returns error for unknown tool name", async () => {
  const { store } = makeMockStore();
  const handler = new EpisodeToolHandler(store, makeConfig());

  const result = await handler.handle("episode_delete", {}, "u1");

  const parsed = JSON.parse(result);
  assert.ok(parsed.error?.includes("Unknown episode tool"));
});

// ============================================================================
// Tests — EpisodeToolHandler — memory consolidation on conclusion
// ============================================================================

test("EpisodeToolHandler — memory consolidation on conclusion", async () => {
  const existing = makeEpisode({
    decisions: ["Decision A", "Decision B"],
    summary: "Final summary of the episode.",
    theme: "Completed Project",
  });
  const { store } = makeMockStore({ getByIdResult: existing });

  const memoryStoreCalls: Array<{ text: string; opts: unknown }> = [];
  const mockMemoryLayer = {
    store: async (text: string, opts: unknown) => {
      memoryStoreCalls.push({ text, opts });
    },
  } as any;

  const handler = new EpisodeToolHandler(
    store,
    makeConfig(),
    undefined, // no embeddings
    mockMemoryLayer,
  );

  await handler.handle(
    "episode_update",
    { episodeId: "ep_abc123", highlight: "Project shipped!", status: "concluded" },
    "u1",
    "sess2",
  );

  // Give fire-and-forget a tick to settle
  await new Promise((r) => setTimeout(r, 50));

  // Should have stored decisions + summary to memory
  // 2 decisions + 1 summary = 3 memory entries
  assert.equal(memoryStoreCalls.length, 3);

  // Decisions stored with importance 0.85
  const decisionCalls = memoryStoreCalls.filter((c) => c.text.includes("Decision:"));
  assert.equal(decisionCalls.length, 2);
  assert.ok(decisionCalls[0].text.includes("[Completed Project]"));
  assert.equal((decisionCalls[0].opts as any).importance, 0.85);

  // Summary stored with importance 0.9
  const summaryCalls = memoryStoreCalls.filter((c) => c.text.includes("Summary:"));
  assert.equal(summaryCalls.length, 1);
  assert.equal((summaryCalls[0].opts as any).importance, 0.9);
});

import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt } from "./builder.js";
import { DEFAULT_TEMPLATES } from "./templates.js";
import {
  resetOnboardingConfigCache,
  setOnboardingConfigForTest,
  resetPromptTextConfigCache,
  loadPromptTextConfig,
} from "./prompt-config.js";
import type {
  PromptContext,
  PromptDocument,
  PromptDocumentType,
} from "./types.js";
import type { PromptDocumentStore } from "./store.js";

function makeDoc(
  userId: string,
  agentId: string,
  documentType: PromptDocumentType,
  data: unknown,
): PromptDocument {
  return {
    id: `${userId}:${agentId}:${documentType}`,
    userId,
    agentId,
    documentType,
    data: data as PromptDocument["data"],
    version: 1,
    updatedAt: "2026-02-23T00:00:00.000Z",
    createdAt: "2026-02-23T00:00:00.000Z",
  };
}

function makeStoreMock(params: {
  docs: Map<PromptDocumentType, PromptDocument>;
  getData?: (documentType: PromptDocumentType) => Promise<unknown>;
  isOnboardingPending?: () => Promise<boolean>;
}): PromptDocumentStore {
  return {
    loadFiltered: async (
      _userId: string,
      _agentId: string,
      docTypes: readonly PromptDocumentType[],
    ) => {
      const filtered = new Map<PromptDocumentType, PromptDocument>();
      for (const dt of docTypes) {
        const doc = params.docs.get(dt);
        if (doc) filtered.set(dt, doc);
      }
      return filtered;
    },
    getData: async (
      _userId: string,
      _agentId: string,
      documentType: PromptDocumentType,
    ) => {
      if (params.getData) return params.getData(documentType);
      return params.docs.get(documentType)?.data ?? null;
    },
    isOnboardingPending: async () => {
      if (params.isOnboardingPending) return params.isOnboardingPending();
      return false;
    },
  } as unknown as PromptDocumentStore;
}

function baseContext(overrides?: Partial<PromptContext>): PromptContext {
  return {
    userId: "user-1",
    agentId: "default",
    sessionType: "interactive",
    promptMode: "full",
    currentDateTime: "2026-02-23T11:42:06.082Z",
    userTimezone: "Asia/Calcutta",
    modelId: "gpt-5-mini",
    providerId: "openai",
    toolNames: ["memory_search", "prompt_get", "prompt_update"],
    ...overrides,
  };
}

test("full interactive prompt includes core sections and prompt documents", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["SOUL", makeDoc(userId, agentId, "SOUL", DEFAULT_TEMPLATES.SOUL)],
    ["USER", makeDoc(userId, agentId, "USER", { timezone: "Asia/Calcutta" })],
    [
      "IDENTITY",
      makeDoc(userId, agentId, "IDENTITY", {
        name: "AgentForEach",
        emoji: "🤖",
        role: "Personal AI assistant",
      }),
    ],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
    [
      "HEARTBEAT",
      makeDoc(userId, agentId, "HEARTBEAT", DEFAULT_TEMPLATES.HEARTBEAT),
    ],
    [
      "BOOTSTRAP",
      makeDoc(userId, agentId, "BOOTSTRAP", DEFAULT_TEMPLATES.BOOTSTRAP),
    ],
    ["MEMORY", makeDoc(userId, agentId, "MEMORY", DEFAULT_TEMPLATES.MEMORY)],
  ]);

  const store = makeStoreMock({ docs });
  const result = await buildSystemPrompt(
    store,
    baseContext({
      recalledMemories: "<relevant-memories>\n1. [other] sample\n</relevant-memories>",
    }),
  );

  assert.equal(result.isOnboarding, true);
  assert.ok(result.includedDocuments.includes("BOOTSTRAP"));
  assert.match(result.instructions, /## Tooling/);
  assert.match(result.instructions, /## Safety/);
  assert.match(result.instructions, /## Current Date & Time/);
  assert.match(result.instructions, /# Prompt Documents/);
  assert.match(result.instructions, /## Onboarding/);
  assert.match(result.instructions, /## Recalled Memories/);
  assert.match(result.instructions, /## Runtime/);
});

test("none mode returns identity line only", async () => {
  const store = makeStoreMock({
    docs: new Map(),
    getData: async (dt) => {
      if (dt === "IDENTITY") return { name: "Astra", emoji: "✨" };
      return null;
    },
  });

  const result = await buildSystemPrompt(
    store,
    baseContext({ promptMode: "none" }),
  );

  // topContext is the static opening line from agentforeach.json
  const txt = loadPromptTextConfig();
  assert.equal(result.instructions, txt.topContext);
  assert.deepEqual(result.includedDocuments, []);
  assert.equal(result.isOnboarding, false);
  assert.doesNotMatch(result.instructions, /## Tooling/);
});

test("subagent session uses minimal gating", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({ sessionType: "subagent" }),
  );

  assert.deepEqual(result.includedDocuments.sort(), ["AGENTS", "TOOLS"]);
  assert.doesNotMatch(result.instructions, /## Reply Tags/);
  assert.doesNotMatch(result.instructions, /## Memory & Knowledge Recall/);
  assert.match(result.instructions, /Runtime: .*session=subagent/);
});

test("cron session includes heartbeat docs and signal sections", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
    [
      "HEARTBEAT",
      makeDoc(userId, agentId, "HEARTBEAT", { tasks: ["check reminders"] }),
    ],
  ]);
  const store = makeStoreMock({ docs, isOnboardingPending: async () => true });

  const result = await buildSystemPrompt(
    store,
    baseContext({ sessionType: "cron", promptMode: "minimal" }),
  );

  assert.deepEqual(result.includedDocuments.sort(), ["AGENTS", "HEARTBEAT", "TOOLS"]);
  assert.match(result.instructions, /## Silent Replies/);
  assert.match(result.instructions, /## Heartbeats/);
  assert.equal(result.isOnboarding, true);
});

test("legacy string doc is preserved in project context", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    [
      "AGENTS",
      makeDoc(
        userId,
        agentId,
        "AGENTS",
        "## Legacy Agent Instructions\nAlways be concise.",
      ),
    ],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(store, baseContext());

  assert.match(result.instructions, /# Prompt Documents/);
  assert.match(result.instructions, /## Agent Operating Guide/);
  assert.match(result.instructions, /Legacy Agent Instructions/);
});

test("onboarding remains true when BOOTSTRAP exists with malformed data", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
    ["BOOTSTRAP", makeDoc(userId, agentId, "BOOTSTRAP", 42)],
  ]);

  let pendingChecks = 0;
  const store = makeStoreMock({
    docs,
    isOnboardingPending: async () => {
      pendingChecks += 1;
      return false;
    },
  });

  const result = await buildSystemPrompt(store, baseContext());
  assert.equal(result.isOnboarding, true);
  assert.equal(pendingChecks, 0);
});

test("timezone falls back to USER doc loaded from store when runtime value missing", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);

  const store = makeStoreMock({
    docs,
    getData: async (dt) => {
      if (dt === "USER") return '{"timezone":"America/Los_Angeles"}';
      if (dt === "IDENTITY") return DEFAULT_TEMPLATES.IDENTITY;
      return null;
    },
  });

  const result = await buildSystemPrompt(
    store,
    baseContext({ userTimezone: undefined, currentDateTime: "2026-02-23T00:00:00.000Z" }),
  );

  assert.match(result.instructions, /Time zone: America\/Los_Angeles/);
});

// ============================================================================
// Blank line preservation (filter(Boolean) fix)
// ============================================================================

test("assembled prompt preserves blank lines between sections", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(store, baseContext());

  // After the identity line there should be a blank line before ## Tooling
  assert.match(result.instructions, /\.\n\n## Tooling/);
  // Between sections there should be blank lines (trailing "" from section builders)
  assert.match(result.instructions, /\n\n## Tool Call Style/);
  assert.match(result.instructions, /\n\n## Safety/);
});

// ============================================================================
// Session type: cron
// ============================================================================

test("cron session renders heartbeat tasks in project context", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
    [
      "HEARTBEAT",
      makeDoc(userId, agentId, "HEARTBEAT", {
        tasks: ["Check weather forecast", "Review pending reminders"],
      }),
    ],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({ sessionType: "cron", promptMode: "minimal" }),
  );

  // Heartbeat tasks should be rendered as numbered list in project context
  assert.match(result.instructions, /## Heartbeat Tasks/);
  assert.match(result.instructions, /1\. Check weather forecast/);
  assert.match(result.instructions, /2\. Review pending reminders/);

  // Cron includes signal tokens
  assert.match(result.instructions, /NO_REPLY/);
  assert.match(result.instructions, /HEARTBEAT_OK/);

  // Runtime shows session=cron
  assert.match(result.instructions, /session=cron/);
});

test("cron session with empty heartbeat tasks skips heartbeat document", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
    ["HEARTBEAT", makeDoc(userId, agentId, "HEARTBEAT", { tasks: [] })],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({ sessionType: "cron", promptMode: "minimal" }),
  );

  // Empty heartbeat renders to "" so the document is skipped
  assert.ok(!result.includedDocuments.includes("HEARTBEAT"));
  // But signal sections are still present
  assert.match(result.instructions, /## Silent Replies/);
  assert.match(result.instructions, /## Heartbeats/);
});

test("cron session excludes memory recall, recalled memories, and authorized senders", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
    ["HEARTBEAT", makeDoc(userId, agentId, "HEARTBEAT", { tasks: ["task1"] })],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({
      sessionType: "cron",
      promptMode: "minimal",
      recalledMemories: "should not appear",
      authorizedSenders: ["admin@test.com"],
    }),
  );

  assert.doesNotMatch(result.instructions, /## Memory & Knowledge Recall/);
  assert.doesNotMatch(result.instructions, /## Recalled Memories/);
  assert.doesNotMatch(result.instructions, /## Authorized Senders/);
  assert.doesNotMatch(result.instructions, /should not appear/);
});

test("cron session does not include SOUL, USER, IDENTITY, BOOTSTRAP, MEMORY docs", async () => {
  const userId = "user-1";
  const agentId = "default";
  // Provide all doc types — only cron-relevant ones should be loaded
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["SOUL", makeDoc(userId, agentId, "SOUL", DEFAULT_TEMPLATES.SOUL)],
    ["USER", makeDoc(userId, agentId, "USER", { name: "Alice" })],
    ["IDENTITY", makeDoc(userId, agentId, "IDENTITY", DEFAULT_TEMPLATES.IDENTITY)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
    ["HEARTBEAT", makeDoc(userId, agentId, "HEARTBEAT", { tasks: ["task1"] })],
    ["BOOTSTRAP", makeDoc(userId, agentId, "BOOTSTRAP", DEFAULT_TEMPLATES.BOOTSTRAP)],
    ["MEMORY", makeDoc(userId, agentId, "MEMORY", { keyFacts: ["fact1"] })],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({ sessionType: "cron", promptMode: "minimal" }),
  );

  assert.deepEqual(
    result.includedDocuments.sort(),
    ["AGENTS", "HEARTBEAT", "TOOLS"],
  );
  assert.doesNotMatch(result.instructions, /## Soul & Persona/);
  assert.doesNotMatch(result.instructions, /## User Profile/);
  assert.doesNotMatch(result.instructions, /## Onboarding/);
  assert.doesNotMatch(result.instructions, /## Long-term Memory/);
});

// ============================================================================
// Session type: subagent
// ============================================================================

test("subagent session excludes signal sections (silent replies, heartbeats)", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({ sessionType: "subagent" }),
  );

  assert.doesNotMatch(result.instructions, /## Silent Replies/);
  assert.doesNotMatch(result.instructions, /## Heartbeats/);
  assert.doesNotMatch(result.instructions, /NO_REPLY/);
  assert.doesNotMatch(result.instructions, /HEARTBEAT_OK/);
});

test("subagent session still includes safety and gateway reference", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({ sessionType: "subagent" }),
  );

  assert.match(result.instructions, /## Safety/);
  assert.match(result.instructions, /## Gateway/);
});

test("subagent extra context uses Subagent Context header", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({
      sessionType: "subagent",
      inboundMetaSystemPrompt: "You are a research sub-agent.",
    }),
  );

  assert.match(result.instructions, /## Subagent Context/);
  assert.match(result.instructions, /You are a research sub-agent\./);
});

test("cron extra context uses Cron Context header", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
    ["HEARTBEAT", makeDoc(userId, agentId, "HEARTBEAT", { tasks: ["task1"] })],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({
      sessionType: "cron",
      promptMode: "minimal",
      inboundMetaSystemPrompt: "Heartbeat from scheduler.",
    }),
  );

  assert.match(result.instructions, /## Cron Context/);
  assert.match(result.instructions, /Heartbeat from scheduler\./);
});

// ============================================================================
// Session type: interactive full
// ============================================================================

test("full interactive includes all 8 document types when all are present", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["SOUL", makeDoc(userId, agentId, "SOUL", DEFAULT_TEMPLATES.SOUL)],
    ["USER", makeDoc(userId, agentId, "USER", { name: "Alice", timezone: "America/New_York" })],
    ["IDENTITY", makeDoc(userId, agentId, "IDENTITY", DEFAULT_TEMPLATES.IDENTITY)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
    ["HEARTBEAT", makeDoc(userId, agentId, "HEARTBEAT", { tasks: ["daily check"] })],
    ["BOOTSTRAP", makeDoc(userId, agentId, "BOOTSTRAP", DEFAULT_TEMPLATES.BOOTSTRAP)],
    ["MEMORY", makeDoc(userId, agentId, "MEMORY", { keyFacts: ["Loves TypeScript"] })],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(store, baseContext());

  assert.equal(result.includedDocuments.length, 8);
  assert.ok(result.includedDocuments.includes("AGENTS"));
  assert.ok(result.includedDocuments.includes("SOUL"));
  assert.ok(result.includedDocuments.includes("USER"));
  assert.ok(result.includedDocuments.includes("IDENTITY"));
  assert.ok(result.includedDocuments.includes("TOOLS"));
  assert.ok(result.includedDocuments.includes("HEARTBEAT"));
  assert.ok(result.includedDocuments.includes("BOOTSTRAP"));
  assert.ok(result.includedDocuments.includes("MEMORY"));

  // All sections rendered in project context
  assert.match(result.instructions, /## Agent Operating Guide/);
  assert.match(result.instructions, /## Soul & Persona/);
  assert.match(result.instructions, /## User Profile/);
  assert.match(result.instructions, /## Identity/);
  assert.match(result.instructions, /## Tools & Environment/);
  assert.match(result.instructions, /## Heartbeat Tasks/);
  assert.match(result.instructions, /## Onboarding/);
  assert.match(result.instructions, /## Long-term Memory/);

  // Signal sections included in full mode
  assert.match(result.instructions, /## Silent Replies/);
  assert.match(result.instructions, /## Heartbeats/);

  // Soul embody instruction
  assert.match(result.instructions, /Embody the Soul & Persona/);
});

test("full interactive includes memory recall when memory tools available", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({ toolNames: ["memory_search", "memory_store"] }),
  );

  assert.match(result.instructions, /## Memory & Knowledge Recall/);
  assert.match(result.instructions, /memory_search/);
});

test("full interactive excludes memory recall when no memory tools", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({ toolNames: ["prompt_get", "prompt_update"] }),
  );

  assert.doesNotMatch(result.instructions, /## Memory & Knowledge Recall/);
});

test("full interactive includes authorized senders when provided", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({ authorizedSenders: ["admin@test.com", "bot@test.com"] }),
  );

  assert.match(result.instructions, /## Authorized Senders/);
  assert.match(result.instructions, /admin@test\.com/);
  assert.match(result.instructions, /bot@test\.com/);
});

test("full interactive includes channel context when channelName set", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({ channelName: "telegram" }),
  );

  assert.match(result.instructions, /## Channel Context/);
  assert.match(result.instructions, /Active channel: telegram/);
  assert.match(result.instructions, /channel=telegram/);
});

// ============================================================================
// Identity resolution
// ============================================================================

test("identity config overrides document identity", async () => {
  const store = makeStoreMock({
    docs: new Map(),
    getData: async (dt) => {
      if (dt === "IDENTITY") return { name: "DocName", emoji: "📚" };
      return null;
    },
  });

  const result = await buildSystemPrompt(
    store,
    baseContext({
      promptMode: "none",
      identityConfig: { name: "ConfigName", emoji: "⚡" },
    }),
  );

  // topContext is static — does not change with identity config
  const txt = loadPromptTextConfig();
  assert.equal(result.instructions, txt.topContext);
  assert.equal(result.identity.name, "ConfigName");
  assert.equal(result.identity.emoji, "⚡");
});

test("identity defaults when no document or config", async () => {
  const store = makeStoreMock({
    docs: new Map(),
    getData: async () => null,
  });

  const result = await buildSystemPrompt(
    store,
    baseContext({ promptMode: "none" }),
  );

  // topContext is static — doesn't depend on document identity
  const txt = loadPromptTextConfig();
  assert.equal(result.instructions, txt.topContext);
});

test("identity includes role suffix when present", async () => {
  const store = makeStoreMock({
    docs: new Map(),
    getData: async (dt) => {
      if (dt === "IDENTITY")
        return { name: "Aria", emoji: "✨", role: "Research assistant" };
      return null;
    },
  });

  const result = await buildSystemPrompt(
    store,
    baseContext({ promptMode: "none" }),
  );

  // topContext is static — identity fields don't change it
  const txt = loadPromptTextConfig();
  assert.equal(result.instructions, txt.topContext);
  // But identity object still captures the resolved fields
  assert.equal(result.identity.name, "Aria");
  assert.equal(result.identity.role, "Research assistant");
});

// ============================================================================
// Interactive minimal mode
// ============================================================================

test("interactive session with minimal promptMode uses AGENTS + TOOLS only", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["SOUL", makeDoc(userId, agentId, "SOUL", DEFAULT_TEMPLATES.SOUL)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
    ["MEMORY", makeDoc(userId, agentId, "MEMORY", { keyFacts: ["fact1"] })],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({ promptMode: "minimal" }),
  );

  // Only AGENTS and TOOLS loaded
  assert.deepEqual(result.includedDocuments.sort(), ["AGENTS", "TOOLS"]);
  // No signal sections (interactive minimal has showSignals=false)
  assert.doesNotMatch(result.instructions, /## Silent Replies/);
  assert.doesNotMatch(result.instructions, /## Heartbeats/);
  // No SOUL/MEMORY content
  assert.doesNotMatch(result.instructions, /## Soul & Persona/);
  assert.doesNotMatch(result.instructions, /## Long-term Memory/);
});

// ============================================================================
// Onboarding edge cases
// ============================================================================

test("onboarding detected via store.isOnboardingPending in minimal mode", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);

  const store = makeStoreMock({
    docs,
    isOnboardingPending: async () => true,
  });

  const result = await buildSystemPrompt(
    store,
    baseContext({ sessionType: "subagent" }),
  );

  // BOOTSTRAP not in filtered docs (subagent doesn't load it),
  // but isOnboardingPending returns true
  assert.equal(result.isOnboarding, true);
});

test("isOnboarding is false when store reports not pending and no BOOTSTRAP in docs", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);

  const store = makeStoreMock({
    docs,
    isOnboardingPending: async () => false,
  });

  const result = await buildSystemPrompt(store, baseContext());
  assert.equal(result.isOnboarding, false);
});

// ============================================================================
// Onboarding config (enabled/disabled via agentforeach.json "onboarding" section)
// ============================================================================

test("isOnboarding is false when onboarding is disabled in config, even with BOOTSTRAP doc", async () => {
  setOnboardingConfigForTest({ enabled: false });
  try {
    const userId = "user-1";
    const agentId = "default";
    const docs = new Map<PromptDocumentType, PromptDocument>([
      ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
      ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
      [
        "BOOTSTRAP",
        makeDoc(userId, agentId, "BOOTSTRAP", DEFAULT_TEMPLATES.BOOTSTRAP),
      ],
    ]);

    const store = makeStoreMock({
      docs,
      isOnboardingPending: async () => true,
    });

    const result = await buildSystemPrompt(store, baseContext());
    assert.equal(result.isOnboarding, false);
    // BOOTSTRAP should not appear in the rendered prompt
    assert.ok(!result.includedDocuments.includes("BOOTSTRAP"));
    assert.doesNotMatch(result.instructions, /Onboarding/);
  } finally {
    resetOnboardingConfigCache();
  }
});

test("BOOTSTRAP doc is excluded from prompt output when onboarding disabled", async () => {
  setOnboardingConfigForTest({ enabled: false });
  try {
    const userId = "user-1";
    const agentId = "default";
    const docs = new Map<PromptDocumentType, PromptDocument>([
      ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
      ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
      [
        "BOOTSTRAP",
        makeDoc(userId, agentId, "BOOTSTRAP", DEFAULT_TEMPLATES.BOOTSTRAP),
      ],
    ]);
    const store = makeStoreMock({ docs });

    const result = await buildSystemPrompt(store, baseContext());
    // BOOTSTRAP must not appear in included docs
    assert.ok(!result.includedDocuments.includes("BOOTSTRAP"));
  } finally {
    resetOnboardingConfigCache();
  }
});

// ============================================================================
// Document budget and truncation
// ============================================================================

test("documents exceeding maxDocumentChars are truncated", async () => {
  const userId = "user-1";
  const agentId = "default";
  // Create a massive AGENTS doc
  const bigGuide = "x".repeat(25_000);
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", `## Big Guide\n${bigGuide}`)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(store, baseContext(), {
    maxDocumentChars: 1000,
  });

  // Agent Operating Guide should be truncated with a marker
  assert.match(result.instructions, /\[\.\.\.truncated/);
  assert.ok(result.includedDocuments.includes("AGENTS"));
});

// ============================================================================
// Runtime line format
// ============================================================================

test("runtime line includes model, provider, and timezone", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({
      modelId: "gpt-5.2",
      providerId: "openai",
      userTimezone: "America/New_York",
    }),
  );

  assert.match(result.instructions, /model=gpt-5\.2/);
  assert.match(result.instructions, /provider=openai/);
  assert.match(result.instructions, /tz=America\/New_York/);
});

// ============================================================================
// Compaction summary section
// ============================================================================

test("compaction summary is rendered when provided in context", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(
    store,
    baseContext({
      compactionSummary:
        "User asked about TypeScript generics. Assistant explained with examples.",
    }),
  );

  assert.match(result.instructions, /## Conversation History Summary/);
  assert.match(
    result.instructions,
    /User asked about TypeScript generics/,
  );
});

test("compaction summary section is omitted when not provided", async () => {
  const userId = "user-1";
  const agentId = "default";
  const docs = new Map<PromptDocumentType, PromptDocument>([
    ["AGENTS", makeDoc(userId, agentId, "AGENTS", DEFAULT_TEMPLATES.AGENTS)],
    ["TOOLS", makeDoc(userId, agentId, "TOOLS", DEFAULT_TEMPLATES.TOOLS)],
  ]);
  const store = makeStoreMock({ docs });

  const result = await buildSystemPrompt(store, baseContext());

  assert.doesNotMatch(result.instructions, /## Conversation History Summary/);
});
test("per-turn context comes after everything static, so the prompt prefix can be cached", async () => {
  const store = makeStoreMock({ docs: new Map() });
  const tools = ["memory_search", "memory_store", "episode_recall", "episode_create", "episode_update", "prompt_get", "prompt_update"];
  const turn1 = await buildSystemPrompt(
    store,
    baseContext({
      toolNames: tools,
      recalledMemories: "<relevant-memories>\n1. [pref] likes tea\n</relevant-memories>",
      compactionSummary: "We planned a trip.",
      activeEpisodeThemes: ["trip planning"],
    }),
  );
  const turn2 = await buildSystemPrompt(
    store,
    baseContext({
      toolNames: tools,
      currentDateTime: "2026-02-23T18:03:44.000Z",
      recalledMemories: "<relevant-memories>\n1. [fact] has a dog\n</relevant-memories>",
      compactionSummary: "We talked about dogs.",
      activeEpisodeThemes: ["pets"],
    }),
  );

  let shared = 0;
  while (shared < turn1.instructions.length && turn1.instructions[shared] === turn2.instructions[shared]) shared++;
  const prefix = turn1.instructions.slice(0, shared);
  // Everything static is inside the shared prefix...
  assert.match(prefix, /## Tooling/);
  assert.match(prefix, /## Safety/);
  // ...and it is most of the prompt.
  assert.ok(shared / turn1.instructions.length > 0.8, `shared prefix is ${Math.round((100 * shared) / turn1.instructions.length)}%`);
  // The per-turn parts are after it.
  assert.ok(turn1.instructions.indexOf("likes tea") >= shared);
  assert.ok(turn1.instructions.indexOf("trip planning") >= shared);
});

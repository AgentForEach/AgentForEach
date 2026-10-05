import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldCompact,
  buildCompactionPrompt,
  compactSession,
  runCompaction,
} from "./compaction.js";
import type { MessageDocument, Session } from "./types.js";
import { messagePartitionKey } from "./store.js";
import type { SessionConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(
  seq: number,
  role: "user" | "assistant",
  content: string,
): MessageDocument {
  return {
    id: `sess:${String(seq).padStart(6, "0")}`,
    pk: messagePartitionKey({ userId: "user-1", sessionId: "sess" }),
    sessionId: "sess",
    userId: "user-1",
    seq,
    role,
    content,
    timestamp: `2026-02-23T10:${String(seq).padStart(2, "0")}:00.000Z`,
  };
}

const defaultConfig: SessionConfig = {
  containerId: "sessions",
  messagesContainerId: "session-messages",
  ttlSeconds: 86400,
  messageTtlSeconds: 7776000,
  runStatusTtlSeconds: 604800,
  maxHistoryMessages: 100,
  defaultAgentId: "default",
  compactionThreshold: 60,
  compactionRetainCount: 20,
  compactionTemperature: 0.3,
  compactionMaxOutputTokens: 4000,
  maxPreviewLength: 120,
};

// ---------------------------------------------------------------------------
// shouldCompact
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const recent = new Date(NOW - 60_000).toISOString();

test("shouldCompact returns false below the threshold", () => {
  assert.equal(shouldCompact({ messageSeq: 59, createdAt: recent }, defaultConfig, NOW), false);
});

test("shouldCompact returns true at the threshold", () => {
  assert.equal(shouldCompact({ messageSeq: 60, createdAt: recent }, defaultConfig, NOW), true);
});

test("shouldCompact counts only messages since the last compaction (not every turn past 60)", () => {
  // After compacting at seq 50 (retaining 20), seq 61 means 11 new messages.
  const compacted = { messageSeq: 61, lastCompactedSeq: 50, lastCompactedAt: recent, createdAt: recent };
  assert.equal(shouldCompact(compacted, defaultConfig, NOW), false);
  assert.equal(shouldCompact({ ...compacted, messageSeq: 110 }, defaultConfig, NOW), true);
});

test("shouldCompact compacts by age before messages expire", () => {
  // 30 uncompacted messages is below the threshold, but the session started
  // more than half the message TTL ago, so compact before they expire.
  const old = new Date(NOW - (defaultConfig.messageTtlSeconds * 1000) / 2 - 1).toISOString();
  assert.equal(shouldCompact({ messageSeq: 30, createdAt: old }, defaultConfig, NOW), true);
  // Nothing beyond the retain window: nothing to compact.
  assert.equal(shouldCompact({ messageSeq: 10, createdAt: old }, defaultConfig, NOW), false);
});

// ---------------------------------------------------------------------------
// buildCompactionPrompt
// ---------------------------------------------------------------------------

test('buildCompactionPrompt includes "## Conversation to Summarize" header when no existing summary', () => {
  const messages = [
    makeMsg(1, "user", "Hello"),
    makeMsg(2, "assistant", "Hi there"),
  ];

  const prompt = buildCompactionPrompt(messages);

  assert.ok(
    prompt.includes("## Conversation to Summarize"),
    'Expected prompt to contain "## Conversation to Summarize"',
  );
  assert.ok(
    !prompt.includes("## Previous Summary"),
    'Expected prompt NOT to contain "## Previous Summary" when no existing summary is provided',
  );
  assert.ok(
    !prompt.includes("## New Messages to Incorporate"),
    'Expected prompt NOT to contain "## New Messages to Incorporate" when no existing summary is provided',
  );
});

test('buildCompactionPrompt includes "## Previous Summary" and "## New Messages to Incorporate" when existing summary provided', () => {
  const messages = [
    makeMsg(3, "user", "What about X?"),
    makeMsg(4, "assistant", "X is great."),
  ];
  const existingSummary = "Earlier the user asked about Y.";

  const prompt = buildCompactionPrompt(messages, existingSummary);

  assert.ok(
    prompt.includes("## Previous Summary"),
    'Expected prompt to contain "## Previous Summary"',
  );
  assert.ok(
    prompt.includes(existingSummary),
    "Expected prompt to contain the existing summary text",
  );
  assert.ok(
    prompt.includes("## New Messages to Incorporate"),
    'Expected prompt to contain "## New Messages to Incorporate"',
  );
  assert.ok(
    !prompt.includes("## Conversation to Summarize"),
    'Expected prompt NOT to contain "## Conversation to Summarize" when an existing summary is provided',
  );
});

test("buildCompactionPrompt requests structured sections", () => {
  const messages = [makeMsg(1, "user", "Hello")];
  const prompt = buildCompactionPrompt(messages);

  // Verify all structured sections are requested
  assert.ok(prompt.includes("### User Requests"), "Expected '### User Requests' section");
  assert.ok(prompt.includes("### Key Decisions & Preferences"), "Expected '### Key Decisions & Preferences' section");
  assert.ok(prompt.includes("### Work Completed"), "Expected '### Work Completed' section");
  assert.ok(prompt.includes("### Current State"), "Expected '### Current State' section");
  assert.ok(prompt.includes("### Pending Tasks"), "Expected '### Pending Tasks' section");
  assert.ok(prompt.includes("### Important Context"), "Expected '### Important Context' section");
});

test("buildCompactionPrompt lists all messages with correct role labels (User/Assistant)", () => {
  const messages = [
    makeMsg(1, "user", "First user message"),
    makeMsg(2, "assistant", "First assistant reply"),
    makeMsg(3, "user", "Second user message"),
  ];

  const prompt = buildCompactionPrompt(messages);

  // Verify each message appears with the correct role label and timestamp
  assert.ok(
    prompt.includes("**User** (2026-02-23T10:01:00.000Z):"),
    "Expected first user message to have User role label",
  );
  assert.ok(
    prompt.includes("First user message"),
    "Expected first user message content to appear in prompt",
  );

  assert.ok(
    prompt.includes("**Assistant** (2026-02-23T10:02:00.000Z):"),
    "Expected assistant message to have Assistant role label",
  );
  assert.ok(
    prompt.includes("First assistant reply"),
    "Expected assistant message content to appear in prompt",
  );

  assert.ok(
    prompt.includes("**User** (2026-02-23T10:03:00.000Z):"),
    "Expected second user message to have User role label",
  );
  assert.ok(
    prompt.includes("Second user message"),
    "Expected second user message content to appear in prompt",
  );
});

// ---------------------------------------------------------------------------
// compactSession
// ---------------------------------------------------------------------------

test("compactSession calls provider.createResponse with correct parameters and returns trimmed text", async () => {
  let capturedRequest: Record<string, unknown> | undefined;

  const mockProvider = {
    id: "mock-provider",
    createResponse: async (request: unknown) => {
      capturedRequest = request as Record<string, unknown>;
      return {
        providerId: "mock-provider",
        responseId: "resp-1",
        model: "test-model",
        text: "  This is the compaction summary.  \n",
        output: [],
        status: "completed" as const,
      };
    },
    streamResponse: async function* () {
      /* not used */
    },
  };

  const messages = [
    makeMsg(1, "user", "Hello"),
    makeMsg(2, "assistant", "Hi there"),
  ];

  const result = await compactSession({
    provider: mockProvider,
    model: "test-model",
    messages,
    existingSummary: undefined,
  });

  // Verify the result is trimmed
  assert.equal(result, "This is the compaction summary.");

  // Verify createResponse was called with the expected parameters
  assert.ok(capturedRequest, "Expected createResponse to have been called");
  assert.equal(capturedRequest.model, "test-model");
  assert.equal(
    capturedRequest.instructions,
    "You are a conversation summarizer. Produce only the structured summary using the requested sections, no preamble.",
  );
  assert.equal(capturedRequest.temperature, 0.3);
  assert.equal(capturedRequest.maxOutputTokens, 4000);

  // The input should be the built compaction prompt
  const expectedPrompt = buildCompactionPrompt(messages, undefined);
  assert.equal(capturedRequest.input, expectedPrompt);
});

// ---------------------------------------------------------------------------
// runCompaction
// ---------------------------------------------------------------------------

test("runCompaction full flow: loads messages, generates summary, updates session, deletes compacted messages", async () => {
  const session: Session = {
    id: "doc-1",
    userId: "user-1",
    agentId: "agent-1",
    sessionId: "sess",
    messageSeq: 70,
    createdAt: "2026-02-23T09:00:00.000Z",
    updatedAt: "2026-02-23T10:00:00.000Z",
    compactionSummary: undefined,
    lastCompactedSeq: 0,
  };

  const config: SessionConfig = {
    ...defaultConfig,
    compactionRetainCount: 20,
  };

  // retainBoundary = 70 - 20 = 50, fromSeq = 0 => will compact range [0, 50)
  const messagesInRange = [
    makeMsg(1, "user", "Hello"),
    makeMsg(2, "assistant", "Hi there"),
    makeMsg(3, "user", "Tell me about compaction"),
  ];

  // Track calls
  const calls: string[] = [];

  const mockMessageStore = {
    getRange: async (
      sessionId: string,
      fromSeq: number,
      toSeq: number,
    ): Promise<MessageDocument[]> => {
      calls.push(`getRange(${sessionId}, ${fromSeq}, ${toSeq})`);
      return messagesInRange;
    },
    deleteBefore: async (sessionId: string, seq: number): Promise<void> => {
      calls.push(`deleteBefore(${sessionId}, ${seq})`);
    },
  };

  const mockSessionStore = {
    updateCompaction: async (
      userId: string,
      sessionId: string,
      summary: string,
      lastCompactedSeq: number,
    ): Promise<boolean> => {
      calls.push(
        `updateCompaction(${userId}, ${sessionId}, ${JSON.stringify(summary)}, ${lastCompactedSeq})`,
      );
      return true;
    },
  };

  const mockProvider = {
    id: "mock-provider",
    createResponse: async () => {
      calls.push("createResponse");
      return {
        providerId: "mock-provider",
        responseId: "resp-1",
        model: "compaction-model",
        text: "Compacted summary of the conversation.",
        output: [],
        status: "completed" as const,
      };
    },
    streamResponse: async function* () {
      /* not used */
    },
  };

  await runCompaction({
    session,
    provider: mockProvider,
    sessionStore: mockSessionStore as any,
    messageStore: mockMessageStore as any,
    config,
  });

  // Verify the full chain of calls in order
  assert.equal(calls.length, 4, "Expected exactly 4 calls in the compaction flow");
  assert.equal(calls[0], "getRange(user-1:sess:legacy, 0, 50)");
  assert.equal(calls[1], "createResponse");
  assert.equal(
    calls[2],
    'updateCompaction(user-1, sess, "Compacted summary of the conversation.", 50)',
  );
  assert.equal(calls[3], "deleteBefore(user-1:sess:legacy, 50)");
});

test("runCompaction skips when retainBoundary <= lastCompactedSeq", async () => {
  const session: Session = {
    id: "doc-1",
    userId: "user-1",
    agentId: "agent-1",
    sessionId: "sess",
    messageSeq: 30,
    createdAt: "2026-02-23T09:00:00.000Z",
    updatedAt: "2026-02-23T10:00:00.000Z",
    compactionSummary: "Previous summary",
    lastCompactedSeq: 25,
  };

  const config: SessionConfig = {
    ...defaultConfig,
    compactionRetainCount: 20,
  };

  // retainBoundary = 30 - 20 = 10, lastCompactedSeq = 25 => 10 <= 25, should skip

  const calls: string[] = [];

  const mockMessageStore = {
    getRange: async () => {
      calls.push("getRange");
      return [];
    },
    deleteBefore: async () => {
      calls.push("deleteBefore");
    },
  };

  const mockSessionStore = {
    updateCompaction: async () => {
      calls.push("updateCompaction");
      return true;
    },
  };

  const mockProvider = {
    id: "mock-provider",
    createResponse: async () => {
      calls.push("createResponse");
      return {
        providerId: "mock-provider",
        responseId: "resp-1",
        model: "m",
        text: "",
        output: [],
        status: "completed" as const,
      };
    },
    streamResponse: async function* () {
      /* not used */
    },
  };

  await runCompaction({
    session,
    provider: mockProvider,
    sessionStore: mockSessionStore as any,
    messageStore: mockMessageStore as any,
    config,
  });

  assert.equal(
    calls.length,
    0,
    "Expected no calls when retainBoundary <= lastCompactedSeq",
  );
});

test("runCompaction skips when getRange returns empty array", async () => {
  const session: Session = {
    id: "doc-1",
    userId: "user-1",
    agentId: "agent-1",
    sessionId: "sess",
    messageSeq: 70,
    createdAt: "2026-02-23T09:00:00.000Z",
    updatedAt: "2026-02-23T10:00:00.000Z",
    compactionSummary: undefined,
    lastCompactedSeq: 0,
  };

  const calls: string[] = [];

  const mockMessageStore = {
    getRange: async (
      sessionId: string,
      fromSeq: number,
      toSeq: number,
    ): Promise<MessageDocument[]> => {
      calls.push(`getRange(${sessionId}, ${fromSeq}, ${toSeq})`);
      return []; // Return empty array
    },
    deleteBefore: async () => {
      calls.push("deleteBefore");
    },
  };

  const mockSessionStore = {
    updateCompaction: async () => {
      calls.push("updateCompaction");
      return true;
    },
  };

  const mockProvider = {
    id: "mock-provider",
    createResponse: async () => {
      calls.push("createResponse");
      return {
        providerId: "mock-provider",
        responseId: "resp-1",
        model: "m",
        text: "",
        output: [],
        status: "completed" as const,
      };
    },
    streamResponse: async function* () {
      /* not used */
    },
  };

  await runCompaction({
    session,
    provider: mockProvider,
    sessionStore: mockSessionStore as any,
    messageStore: mockMessageStore as any,
    config: defaultConfig,
  });

  // Nothing to summarise: no LLM call, no deletes, and the marker advances
  // so the empty range isn't queried again every turn.
  assert.deepEqual(calls, ["getRange(user-1:sess:legacy, 0, 50)", "updateCompaction"]);
});

test("a compaction that lost to another one deletes no messages", async () => {
  const calls: string[] = [];
  const session = {
    id: "doc-1",
    userId: "user-1",
    agentId: "agent-1",
    sessionId: "sess",
    messageSeq: 70,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Session;
  await runCompaction({
    session,
    provider: {
      id: "mock-provider",
      createResponse: async () => ({
        providerId: "mock-provider",
        responseId: "r",
        model: "m",
        text: "stale summary",
        output: [],
        status: "completed" as const,
      }),
      streamResponse: async function* () {},
    } as any,
    sessionStore: {
      updateCompaction: async () => {
        calls.push("updateCompaction");
        return false; // another compaction finished first
      },
    } as any,
    messageStore: {
      getRange: async () => [{ seq: 0, role: "user", content: "hi" }],
      deleteBefore: async () => {
        calls.push("deleteBefore");
      },
    } as any,
    config: { ...defaultConfig, compactionRetainCount: 20 },
  });
  assert.deepEqual(calls, ["updateCompaction"]);
});

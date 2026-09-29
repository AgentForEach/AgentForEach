/**
 * AgentForEach Sessions Module — Compaction
 *
 * LLM-powered conversation compaction. When a session's message count
 * exceeds a configurable threshold, older messages are summarized by
 * the LLM and the summary is stored on the session document. The
 * compacted source messages are then deleted to save storage.
 *
 * Compaction is incremental: if a previous summary exists, it is
 * included in the compaction prompt so context accumulates across
 * multiple compaction cycles.
 *
 * Compaction is always fire-and-forget — it never blocks the user's
 * response pipeline.
 */

import type { Provider } from "../llms/index.js";
import type { Session, MessageDocument } from "./types.js";
import type { SessionConfig } from "./config.js";
import { messagePartitionKey, type SessionStore } from "./store.js";
import type { MessageStore } from "./messages-store.js";
import type { MemoryLayer } from "../memory/index.js";

// ============================================================================
// Threshold Check
// ============================================================================

/**
 * Check if a session should trigger compaction.
 *
 * - By count: the messages since the last compaction reach
 *   compactionThreshold. (Counting from lastCompactedSeq, not the lifetime
 *   messageSeq, which triggered on every turn once past the threshold.)
 * - By age: there is something beyond the retain window and the last
 *   compaction (or the session's start) is older than half the message TTL,
 *   so messages are summarised before they expire.
 */
export function shouldCompact(
  session: Pick<Session, "messageSeq" | "lastCompactedSeq" | "lastCompactedAt" | "createdAt">,
  config: SessionConfig,
  nowMs: number = Date.now(),
): boolean {
  const uncompacted = session.messageSeq - (session.lastCompactedSeq ?? 0);
  if (uncompacted >= config.compactionThreshold) return true;
  if (uncompacted <= config.compactionRetainCount || config.messageTtlSeconds <= 0) return false;
  const since = Date.parse(String(session.lastCompactedAt ?? session.createdAt));
  return Number.isFinite(since) && nowMs - since > (config.messageTtlSeconds * 1000) / 2;
}

// ============================================================================
// Prompt Builder
// ============================================================================

/**
 * Build the prompt for the compaction LLM call.
 *
 * Produces a structured summary with explicit sections so that critical
 * context (user requests, decisions, current work, pending tasks) is
 * never lost across compaction cycles.
 *
 * If an existing summary is provided (from a previous compaction cycle),
 * it is included so the new summary incorporates all prior context.
 */
export function buildCompactionPrompt(
  messages: MessageDocument[],
  existingSummary?: string,
): string {
  const lines: string[] = [];

  lines.push(
    "You are a conversation summarizer for an AI assistant. Your job is to produce a structured summary that preserves all context needed to seamlessly continue this conversation.",
  );
  lines.push("");

  if (existingSummary) {
    lines.push("## Previous Summary");
    lines.push(
      "The conversation had an earlier portion that was already summarized:",
    );
    lines.push(existingSummary);
    lines.push("");
    lines.push("## New Messages to Incorporate");
  } else {
    lines.push("## Conversation to Summarize");
  }

  lines.push("");
  for (const msg of messages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    lines.push(`**${role}** (${msg.timestamp}):`);
    lines.push(msg.content);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("Write a structured summary using EXACTLY these sections. Omit a section only if it has zero content.");
  lines.push("");
  lines.push("### User Requests");
  lines.push("What the user asked for — their primary intent and any specific requirements stated. Include exact quotes for precise instructions.");
  lines.push("");
  lines.push("### Key Decisions & Preferences");
  lines.push("Choices made, preferences expressed, and approaches agreed upon (e.g., tools, frameworks, naming conventions, architectural patterns).");
  lines.push("");
  lines.push("### Work Completed");
  lines.push("What was accomplished — files created/modified, features implemented, bugs fixed, with enough detail to avoid re-doing work.");
  lines.push("");
  lines.push("### Current State");
  lines.push("Where the conversation left off — what was being actively worked on or discussed when this summary was generated.");
  lines.push("");
  lines.push("### Pending Tasks");
  lines.push("Outstanding items — things the user asked for that haven't been done yet, follow-ups mentioned, or next steps agreed upon.");
  lines.push("");
  lines.push("### Important Context");
  lines.push("Facts, constraints, or background knowledge needed to continue naturally (e.g., project details, environment info, error messages encountered, relevant code patterns).");
  lines.push("");
  lines.push("Keep each section concise but complete. Preserve specific details (names, paths, values) rather than generalizing. If merging with a previous summary, integrate rather than append — remove outdated information and update sections with the latest state.");

  return lines.join("\n");
}

// ============================================================================
// LLM Summary
// ============================================================================

/**
 * Call the LLM to generate a compaction summary.
 */
export async function compactSession(params: {
  provider: Provider;
  model?: string;
  messages: MessageDocument[];
  existingSummary?: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<string> {
  const prompt = buildCompactionPrompt(
    params.messages,
    params.existingSummary,
  );

  const response = await params.provider.createResponse({
    model: params.model,
    input: prompt,
    instructions:
      "You are a conversation summarizer. Produce only the structured summary using the requested sections, no preamble.",
    temperature: params.temperature ?? 0.3,
    maxOutputTokens: params.maxOutputTokens ?? 4000,
  });

  return response.text.trim();
}

// ============================================================================
// Full Compaction Flow
// ============================================================================

/**
 * Execute the full compaction flow for a session.
 *
 * 1. Calculate the compaction window (from lastCompactedSeq to retainBoundary)
 * 2. Load messages in that window
 * 3. Call LLM to generate summary
 * 4. Update session document with summary and compaction state
 * 5. Delete compacted messages from the messages container
 *
 * This function is designed to be called fire-and-forget from the runner.
 */
/** Sessions this instance is compacting, so a burst of turns runs one summary. */
const compactionsInFlight = new Set<string>();

export async function runCompaction(params: {
  session: Session;
  provider: Provider;
  model?: string;
  sessionStore: SessionStore;
  messageStore: MessageStore;
  config: SessionConfig;
  /** Optional memory layer — if provided, the compaction summary is indexed as a searchable memory. */
  memoryLayer?: MemoryLayer;
}): Promise<void> {
  const { session, provider, model, sessionStore, messageStore, config } =
    params;
  const key = `${session.userId}:${session.sessionId}:${session.instanceId ?? ""}`;
  if (compactionsInFlight.has(key)) return;
  compactionsInFlight.add(key);
  try {
    await compact(params);
  } finally {
    compactionsInFlight.delete(key);
  }
}

async function compact(params: Parameters<typeof runCompaction>[0]): Promise<void> {
  const { session, provider, model, sessionStore, messageStore, config } =
    params;

  // Calculate compaction window
  const fromSeq = session.lastCompactedSeq ?? 0;
  const retainBoundary = session.messageSeq - config.compactionRetainCount;

  // Nothing to compact if the retain boundary hasn't moved past lastCompactedSeq
  if (retainBoundary <= fromSeq) return;

  // Load messages to compact
  const pk = messagePartitionKey(session);
  const messagesToCompact = await messageStore.getRange(pk, fromSeq, retainBoundary);

  if (messagesToCompact.length === 0) {
    // Nothing left in that range (expired, or a session from before the
    // current messages container): advance the marker so it isn't retried.
    await sessionStore.updateCompaction(
      session.userId,
      session.sessionId,
      session.compactionSummary ?? "",
      retainBoundary,
      session.instanceId,
      fromSeq,
    );
    return;
  }

  // Generate summary via LLM
  const summary = await compactSession({
    provider,
    model: model ?? config.compactionModel,
    messages: messagesToCompact,
    existingSummary: session.compactionSummary,
    temperature: config.compactionTemperature,
    maxOutputTokens: config.compactionMaxOutputTokens,
  });

  // Update session document with compaction results. If another compaction
  // got there first, this one's summary is stale: keep every message.
  const applied = await sessionStore.updateCompaction(
    session.userId,
    session.sessionId,
    summary,
    retainBoundary,
    session.instanceId,
    fromSeq,
  );
  if (!applied) return;

  // Delete compacted messages
  await messageStore.deleteBefore(pk, retainBoundary);

  // Index compaction summary as a searchable memory (fire-and-forget)
  if (params.memoryLayer) {
    params.memoryLayer
      .store(summary, {
        userId: session.userId,
        category: "fact",
        importance: 0.8,
        source: `compaction:${session.sessionId}`,
        tags: ["session-summary"],
      })
      .catch(() => {}); // Non-fatal
  }
}

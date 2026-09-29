/**
 * Test harness for runAgentTurn: a scripted provider and in-memory stores.
 */
import { type RunnerDeps } from "./runner.js";
import { HookEmitter } from "../hooks/emitter.js";
import { getToolDefinitions as getMemoryToolDefinitions } from "../memory/tools.js";
import { loadSessionConfig } from "../sessions/config.js";
import type {
  ConversationState,
  Provider,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
} from "../llms/types.js";
import type { Session } from "../sessions/types.js";
import { RunLeaseLostError } from "../sessions/store.js";

type Step = (req: ProviderRequest, round: number) => ProviderResponse | Promise<ProviderResponse>;

let responseCounter = 0;

export function textResponse(text: string, extra: Partial<ProviderResponse> = {}): ProviderResponse {
  const responseId = `resp_${++responseCounter}`;
  return {
    providerId: "openai",
    responseId,
    model: "test-model",
    text,
    output: [{ type: "message", role: "assistant", content: [{ type: "text", text }] }],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    conversationState: { previousResponseId: responseId },
    status: "completed",
    ...extra,
  };
}

export function toolCallResponse(
  calls: Array<{ name: string; args?: Record<string, unknown>; callId?: string }>,
): ProviderResponse {
  const responseId = `resp_${++responseCounter}`;
  return {
    providerId: "openai",
    responseId,
    model: "test-model",
    text: "",
    output: calls.map((c, i) => ({
      type: "function_call" as const,
      callId: c.callId ?? `call_${responseCounter}_${i}`,
      name: c.name,
      arguments: JSON.stringify(c.args ?? {}),
    })),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    conversationState: { previousResponseId: responseId },
    status: "completed",
  };
}

export function scriptedProvider(steps: Step[]): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const next = async (req: ProviderRequest) => {
    requests.push(structuredClone({ ...req, abortSignal: undefined }));
    const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
    return step(req, requests.length);
  };
  return {
    id: "openai",
    requests,
    createResponse: next,
    async *streamResponse(req: ProviderRequest): AsyncIterable<StreamEvent> {
      const response = await next(req);
      if (response.text) yield { type: "text_delta", delta: response.text } as StreamEvent;
      yield { type: "done", response } as StreamEvent;
    },
    async listModels() {
      return ["test-model"];
    },
  } as unknown as Provider & { requests: ProviderRequest[] };
}

/** A session store that keeps one session and its messages in memory. */
export function memorySessionStore() {
  const sessions = new Map<string, Session>();
  const messages: Array<{ role: string; content: unknown; idempotencyKey?: string }> = [];
  const persistedStates: Array<ConversationState | null | undefined> = [];
  const store = {
    persistedStates,
    messages,
    sessions,
    async getOrCreate(userId: string, agentId: string, sessionId?: string) {
      const id = sessionId ?? "s1";
      let s = sessions.get(id);
      if (!s) {
        s = {
          id: `${userId}:${id}`,
          userId,
          agentId,
          sessionId: id,
          instanceId: "inst1",
          messageSeq: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as Session;
        sessions.set(id, s);
      }
      return structuredClone(s);
    },
    async getProviderHistory() {
      return {
        history: messages.map((m) => ({ role: m.role, content: m.content })),
        compactionSummary: undefined,
      };
    },
    async findByRunId(_session: unknown, runId: string) {
      return messages.find((m) => m.role === "assistant" && (m as { runId?: string }).runId === runId) ?? null;
    },
    /** Like the real store: the assistant reply after the last user message with this key. */
    async findByIdempotencyKey(_session: unknown, key: string) {
      const userIndex = messages.map((m) => m.role === "user" && m.idempotencyKey === key).lastIndexOf(true);
      if (userIndex < 0) return null;
      return messages.slice(userIndex + 1).find((m) => m.role === "assistant") ?? null;
    },
    leases: new Map<string, { leaseId: string; runId: string }>(),
    async acquireRunLease(_userId: string, sessionId: string, leaseId: string, _exp: number, _now: number, runId: string) {
      if (store.leases.has(sessionId)) return false;
      store.leases.set(sessionId, { leaseId, runId });
      return true;
    },
    async renewRunLease() {
      return true;
    },
    async peekActiveRun(_userId: string, sessionId: string) {
      const l = store.leases.get(sessionId);
      return l ? { ...l, expiresAtMs: Date.now() + 60_000 } : undefined;
    },
    async releaseRunLease(_userId: string, sessionId: string, leaseId: string) {
      if (store.leases.get(sessionId)?.leaseId === leaseId) store.leases.delete(sessionId);
    },
    async appendMessages(
      _userId: string,
      sessionId: string,
      newMessages: Array<{ role: string; content: unknown }>,
      conversationState?: ConversationState | null,
      _metadata?: unknown,
      _expectedInstanceId?: string,
      expectedLeaseId?: string,
    ) {
      if (expectedLeaseId !== undefined && store.leases.get(sessionId)?.leaseId !== expectedLeaseId) {
        throw new RunLeaseLostError("Run lease lost");
      }
      const s = sessions.get(sessionId)!;
      messages.push(...newMessages);
      s.messageSeq += newMessages.length;
      if (conversationState !== undefined) {
        persistedStates.push(conversationState);
        s.conversationState = conversationState ?? undefined;
      }
      return structuredClone(s);
    },
    getConfig() {
      return loadSessionConfig();
    },
    getMessageStore() {
      return {};
    },
  };
  return store;
}

/** Anything the runner touches but a test doesn't care about. */
function inert<T>(overrides: Record<string, unknown> = {}): T {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === "then") return undefined;
      return async () => undefined;
    },
  }) as T;
}

export function makeDeps(
  provider: Provider,
  overrides: Partial<RunnerDeps> & { memoryToolHandler?: (name: string, args: unknown) => Promise<string> } = {},
) {
  const sessionStore = memorySessionStore();
  const { memoryToolHandler, ...rest } = overrides;
  const deps: RunnerDeps = {
    provider,
    memory: inert({
      getToolDefinitions: () => getMemoryToolDefinitions(),
      handleToolCall: memoryToolHandler ?? (async () => JSON.stringify({ results: [] })),
      recall: async () => "",
      capture: async () => undefined,
    }),
    cronStore: inert(),
    promptStore: inert({ getData: async () => null, loadFiltered: async () => new Map() }),
    sessionStore: sessionStore as unknown as RunnerDeps["sessionStore"],
    usageStore: inert(),
    hooks: new HookEmitter(),
    defaultModel: "test-model",
    realtimeEnabled: false,
    streamToClient: false,
    autoRecall: false,
    autoCapture: false,
    runLeaseWaitPollMs: 20,
    ...rest,
  };
  return { deps, sessionStore };
}


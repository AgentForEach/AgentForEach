/**
 * AgentForEach LLMs — tool-loop transcript
 *
 * Providers without server-side conversation state (Anthropic, Chat
 * Completions) get the whole conversation on every request. Each round's
 * response carries the transcript so far in `conversationState.messages`, so
 * the next round (which only adds tool results) still has the user's
 * question, the history and earlier tool results.
 */

import type {
  ContentBlock,
  ConversationMessage,
  FunctionCallOutput,
  ProviderRequest,
} from "./types.js";

/** Earlier rounds' transcript plus what this request adds, oldest first. */
export function transcriptThroughInput(request: ProviderRequest): ConversationMessage[] {
  const messages: ConversationMessage[] = withoutToolImages(request.conversation?.messages ?? []);
  const input = request.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input) && input.length > 0) {
    if ((input[0] as { type?: string }).type === "function_call_output") {
      const results: ContentBlock[] = (input as FunctionCallOutput[]).map((item) => ({
        type: "tool_result" as const,
        tool_use_id: item.callId,
        content: item.output,
        ...(item.images?.length ? { images: item.images } : {}),
      }));
      messages.push({ role: "user", content: results });
    } else {
      // The runner sends history oldest first, then the new message.
      messages.push(...(input as ConversationMessage[]));
    }
  }
  return messages;
}

/** What an earlier round's image becomes once the model has seen it. */
export const SEEN_IMAGE_NOTE = "[The image this tool returned was shown in an earlier round and has been removed to save space.]";

/**
 * Earlier rounds' tool results without their images. The model saw each image
 * in the round it came back; resending every screenshot on every later round
 * would multiply the turn's input tokens.
 */
export function withoutToolImages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content) || !m.content.some((b) => b.type === "tool_result" && b.images?.length)) return m;
    return {
      ...m,
      content: m.content.map((b) => {
        if (b.type !== "tool_result" || !b.images?.length) return b;
        const { images: _dropped, ...rest } = b;
        return { ...rest, content: `${b.content}\n${SEEN_IMAGE_NOTE}` };
      }),
    };
  });
}

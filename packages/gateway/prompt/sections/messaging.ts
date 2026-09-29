/**
 * Prompt Section — Messaging & Channel
 *
 * Builds reply tags, messaging routing, channel context, group chat,
 * and extra context sections.
 * All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type {
  ReplyTagsTextConfig,
  MessagingTextConfig,
  ChannelTextConfig,
  GroupChatTextConfig,
  ExtraContextTextConfig,
} from "../prompt-config.js";

/**
 * Build the "## Reply Tags" section.
 */
export function buildReplyTagsSection(params: {
  isMinimal: boolean;
  cfg?: ReplyTagsTextConfig;
}): string[] {
  if (params.isMinimal || !params.cfg) return [];
  return [params.cfg.header, ...params.cfg.rules, ""];
}

/**
 * Build the "## Messaging" section with routing guidance.
 */
export function buildMessagingSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  silentReplyToken: string;
  cfg?: MessagingTextConfig;
}): string[] {
  if (params.isMinimal || !params.cfg) return [];

  const cfg = params.cfg;
  const lines = [cfg.header, ...cfg.rules.map((r) => `- ${r}`)];

  if (params.availableTools.has("message")) {
    lines.push(
      `- ${cfg.messageToolNote.replace(/\{token\}/g, params.silentReplyToken)}`,
    );
  }

  lines.push("");
  return lines;
}

/**
 * Build the "## Channel Context" section.
 */
export function buildChannelContextSection(params: {
  isMinimal: boolean;
  channelName?: string;
  cfg?: ChannelTextConfig;
}): string[] {
  if (params.isMinimal || !params.cfg) return [];

  const channel = params.channelName?.trim();
  if (!channel) return [];

  const cfg = params.cfg;
  return [
    cfg.header,
    cfg.activeTemplate.replace("{channel}", channel),
    cfg.formatting,
    "",
  ];
}

/**
 * Build the "## Group Chat Context" section.
 */
export function buildGroupChatSection(params: {
  isMinimal: boolean;
  isGroupChat?: boolean;
  groupName?: string;
  groupMembers?: string[];
  cfg?: GroupChatTextConfig;
}): string[] {
  if (params.isMinimal) return [];
  if (!params.isGroupChat) return [];

  const lines = ["## Group Chat Context"];

  if (params.groupName?.trim()) {
    lines.push(`Group: ${params.groupName.trim()}`);
  }

  if (params.groupMembers && params.groupMembers.length > 0) {
    const members = params.groupMembers.map((m) => m.trim()).filter(Boolean);
    if (members.length > 0) {
      lines.push(`Members: ${members.join(", ")}`);
    }
  }

  if (params.cfg) {
    lines.push(params.cfg.respondRule, params.cfg.avoidRule);
  }
  lines.push("");

  return lines;
}

/**
 * Build extra context section from group/channel/inbound system prompts.
 */
export function buildExtraContextSection(params: {
  isMinimal: boolean;
  isCron?: boolean;
  isGroupChat?: boolean;
  groupSystemPrompt?: string;
  channelSystemPrompt?: string;
  inboundMetaSystemPrompt?: string;
  cfg?: ExtraContextTextConfig;
}): string[] {
  const chunks: string[] = [];

  if (params.groupSystemPrompt?.trim()) {
    chunks.push(params.groupSystemPrompt.trim());
  }
  if (params.channelSystemPrompt?.trim()) {
    chunks.push(params.channelSystemPrompt.trim());
  }
  if (params.inboundMetaSystemPrompt?.trim()) {
    chunks.push(params.inboundMetaSystemPrompt.trim());
  }

  if (chunks.length === 0 || !params.cfg) return [];

  const cfg = params.cfg;
  const header = params.isMinimal
    ? params.isCron
      ? cfg.cronHeader
      : cfg.subagentHeader
    : params.isGroupChat
      ? cfg.groupHeader
      : cfg.defaultHeader;

  return [header, chunks.join("\n\n"), ""];
}

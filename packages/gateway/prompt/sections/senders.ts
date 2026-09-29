/**
 * Prompt Section — Authorized Senders
 *
 * Builds the "## Authorized Senders" section.
 * All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type { AuthorizedSendersTextConfig } from "../prompt-config.js";

/**
 * Build the "## Authorized Senders" section.
 */
export function buildAuthorizedSendersSection(params: {
  isMinimal: boolean;
  authorizedSenders?: string[];
  cfg?: AuthorizedSendersTextConfig;
}): string[] {
  if (params.isMinimal || !params.cfg) return [];
  if (!params.authorizedSenders || params.authorizedSenders.length === 0) {
    return [];
  }

  const senders = params.authorizedSenders.map((s) => s.trim()).filter(Boolean);
  if (senders.length === 0) return [];

  const cfg = params.cfg;
  return [
    cfg.header,
    cfg.template.replace("{senders}", senders.join(", ")),

    "",
  ];
}

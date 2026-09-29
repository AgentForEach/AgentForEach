/**
 * AgentForEach Channels — Approved Template Send
 *
 * The only legal way to message someone once the 24-hour service window has
 * closed. This is the send side only: authoring, categorisation and approval
 * all happen in Meta Business Manager, and a template that is not approved
 * there cannot be rescued from here.
 *
 * Projects that never message outside the window configure no templates and
 * get an explicit error instead — which is the point. A closed window with no
 * template is a real problem (a cron reminder that will never arrive), and the
 * failure mode has to be loud enough to notice.
 */

import type { OutboundContext, OutboundResult } from "../types.js";
import type {
  WhatsAppConfig,
  ResolvedTemplateRef,
  WhatsAppOutboundMessage,
} from "./types.js";
import { postMessage, describeFailure } from "./transport.js";
import { stripFormatting } from "./format.js";
import { redactId } from "../../utils/redact.js";

/**
 * The conventional key for "reach someone whose window has closed".
 *
 * Named rather than positional so the config reads as intent, and so a project
 * with several templates does not silently pick the wrong one.
 */
export const REENGAGE_TEMPLATE_KEY = "reengage";

/** Meta rejects template variables containing newlines or 4+ spaces. */
const MAX_PARAM_LENGTH = 1024;

/**
 * Send the window-closed fallback for a message that could not go free-form.
 */
export async function sendTemplateFallback(
  cfg: WhatsAppConfig,
  context: OutboundContext,
): Promise<OutboundResult> {
  const template = pickTemplate(cfg);

  if (!template) {
    return {
      success: false,
      error:
        `The 24-hour customer service window for ${redactId(context.chatId)} has closed ` +
        `and no "${REENGAGE_TEMPLATE_KEY}" template is configured, so this ` +
        `message cannot be delivered. Configure channels.whatsapp.templates.` +
        `${REENGAGE_TEMPLATE_KEY} with an approved template, or have the user ` +
        `message first.`,
    };
  }

  const message: WhatsAppOutboundMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: context.chatId,
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      ...(template.bodyParams.length > 0
        ? {
            components: [
              {
                type: "body" as const,
                parameters: template.bodyParams.map((param) => ({
                  type: "text" as const,
                  text: sanitiseParam(substitute(param, context.text)),
                })),
              },
            ],
          }
        : {}),
    },
  };

  const result = await postMessage(cfg, message);
  return result.ok
    ? { success: true, messageId: result.value }
    : { success: false, error: describeFailure(result.failure) };
}

/**
 * Choose the template to re-engage with.
 *
 * The named key wins. Failing that, a project with exactly one configured
 * template clearly meant that one; a project with several has to say which,
 * because guessing would put the wrong approved copy in front of a customer.
 */
function pickTemplate(cfg: WhatsAppConfig): ResolvedTemplateRef | undefined {
  const named = cfg.templates[REENGAGE_TEMPLATE_KEY];
  if (named) return named;

  const all = Object.values(cfg.templates);
  return all.length === 1 ? all[0] : undefined;
}

/** `{{text}}` in a configured parameter is replaced with the message body. */
function substitute(param: string, text: string): string {
  return param.replace(/\{\{\s*text\s*\}\}/g, text);
}

/**
 * Squash a template variable into something Meta will accept.
 *
 * Newlines and runs of four or more spaces are rejected outright (131008), and
 * the failure looks like a malformed template rather than a bad variable.
 */
function sanitiseParam(value: string): string {
  const cleaned = stripFormatting(value).replace(/\s+/g, " ").trim();
  if (cleaned.length <= MAX_PARAM_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_PARAM_LENGTH - 1)}…`;
}

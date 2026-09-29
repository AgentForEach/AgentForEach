/**
 * AgentForEach Channels — WhatsApp Transport
 *
 * The single POST that every outbound path goes through, with retry on the
 * failures where waiting helps.
 *
 * Separate from outbound.ts so that templates.ts can send without importing
 * the module that imports it — the window-closed fallback would otherwise
 * close a cycle between the two.
 */

import type { WhatsAppConfig, WhatsAppOutboundMessage } from "./types.js";
import type { WhatsAppSendResponse, WhatsAppErrorResponse } from "./types.js";
import { phoneNumberUrl } from "./config.js";
import { classifyError, withRetry, type WhatsAppFailure } from "./errors.js";

export const SEND_TIMEOUT_MS = 15_000;

export type SendOutcome =
  | { ok: true; value: string | undefined }
  | { ok: false; failure: WhatsAppFailure };

/**
 * POST a message to the Cloud API, retrying throughput failures.
 *
 * API-level errors are returned as a classified failure rather than thrown, so
 * every caller handles one shape.
 */
export async function postMessage(
  cfg: WhatsAppConfig,
  message: WhatsAppOutboundMessage,
): Promise<SendOutcome> {
  return withRetry(async () => {
    try {
      const res = await fetch(`${phoneNumberUrl(cfg)}/messages`, {
        method: "POST",
        headers: authHeaders(cfg),
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      const body = (await res.json().catch(() => ({}))) as
        | WhatsAppSendResponse
        | WhatsAppErrorResponse;

      if (!res.ok || "error" in body) {
        const err = "error" in body ? body.error : undefined;
        return {
          ok: false as const,
          failure: classifyError(
            err?.code,
            err?.message ?? `${res.status} ${res.statusText}`,
            res.status,
          ),
        };
      }

      return {
        ok: true as const,
        value: (body as WhatsAppSendResponse).messages?.[0]?.id,
      };
    } catch (err) {
      // Network failures and timeouts are transient by nature.
      return {
        ok: false as const,
        failure: classifyError(
          undefined,
          err instanceof Error ? err.message : String(err),
          503,
        ),
      };
    }
  });
}

export function authHeaders(cfg: WhatsAppConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.accessToken}`,
    "Content-Type": "application/json",
  };
}

/** Render a classified failure as an operator-readable message. */
export function describeFailure(failure: WhatsAppFailure): string {
  const code = failure.code !== undefined ? ` (${failure.code})` : "";
  return `WhatsApp send failed${code}: ${failure.message}`;
}

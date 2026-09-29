/**
 * AgentForEach Utils — log redaction
 *
 * Channel identifiers (phone numbers, chat ids) and message text are
 * personal data; logs keep only what's needed to correlate lines.
 */

import { createHmac, randomBytes } from "node:crypto";

let processKey: Buffer | undefined;

/**
 * HMAC key: LOG_REDACTION_KEY (the same on every instance, so lines
 * correlate across instances and restarts). Without it, a random key per
 * process: still unguessable, but tokens differ between instances.
 */
function redactionKey(): string | Buffer {
  return process.env.LOG_REDACTION_KEY?.trim() || (processKey ??= randomBytes(32));
}

/**
 * Stable short token for an identifier. Keyed, because an unkeyed hash of a
 * phone number is reversible by trying every number.
 */
export function redactId(id: string | undefined | null): string {
  if (!id) return "none";
  return `#${createHmac("sha256", redactionKey()).update(String(id)).digest("hex").slice(0, 12)}`;
}

/** Describe message text without its content. */
export function describeText(text: string | undefined | null): string {
  return `${text?.length ?? 0} chars`;
}

/**
 * AgentForEach Utils — control tokens in model replies
 *
 * The prompt lets the model answer with NO_REPLY (stay silent) or
 * HEARTBEAT_OK (heartbeat acknowledged). Those are instructions to us, never
 * text for the user.
 */

const CONTROL_TOKEN_LINE = /^\s*[*_`]*(NO_REPLY|HEARTBEAT_OK)[*_`.!]*\s*$/i;

/**
 * Remove lines that consist only of a control token. Returns "" when nothing
 * else is left, meaning: send nothing.
 */
export function stripControlTokens(text: string | undefined | null): string {
  if (!text) return "";
  return text
    .split("\n")
    .filter((line) => !CONTROL_TOKEN_LINE.test(line))
    .join("\n")
    .trim();
}

/**
 * AgentForEach Channels — Telegram Formatting
 *
 * Converts Markdown-formatted LLM output to Telegram-compatible HTML.
 *
 * Telegram supports a limited HTML subset:
 *   <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">, <tg-spoiler>
 *
 * LLM output typically uses standard Markdown:
 *   **bold**, *italic*, `code`, ```code blocks```, [link](url), ~~strikethrough~~
 *
 * @see https://core.telegram.org/bots/api#html-style
 */

// ============================================================================
// Markdown → Telegram HTML
// ============================================================================

/**
 * Convert Markdown text to Telegram HTML.
 *
 * Best-effort conversion — complex Markdown (nested formatting, tables)
 * may not render perfectly in Telegram's limited HTML parser.
 *
 * @param text - Markdown-formatted text from LLM response.
 * @returns Telegram HTML-formatted text.
 */
export function markdownToTelegramHtml(text: string): string {
  let result = text;

  // 1. Escape HTML entities first (before we add our own HTML tags)
  result = escapeHtml(result);

  // 2. Code blocks (```lang\n...\n```) → <pre>...</pre>
  //    Must be processed before inline patterns to protect code content
  result = result.replace(
    /```(\w*)\n?([\s\S]*?)```/g,
    (_match, _lang, code) => `<pre>${code.trimEnd()}</pre>`,
  );

  // 3. Inline code (`...`) → <code>...</code>
  result = result.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // 4. Bold (**...**) → <b>...</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 5. Italic (*...*) → <i>...</i>
  //    Negative lookbehind/ahead for * to avoid matching ** already processed
  result = result.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");

  // 6. Strikethrough (~~...~~) → <s>...</s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 7. Links [text](url) → <a href="url">text</a>
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>',
  );

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Escape HTML special characters.
 *
 * Must be called BEFORE adding any HTML tags, since those tags
 * should not be escaped.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Strip all Markdown formatting (fallback for when HTML parsing fails).
 *
 * Removes code blocks, inline code, bold, italic, strikethrough, and
 * link syntax, leaving only the plain text content.
 *
 * @param text - Markdown text.
 * @returns Plain text with formatting removed.
 */
export function stripFormatting(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.slice(3, -3).replace(/^\w*\n/, "").trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

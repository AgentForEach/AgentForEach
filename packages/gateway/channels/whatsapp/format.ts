/**
 * AgentForEach Channels — WhatsApp Formatting
 *
 * WhatsApp is neither Markdown nor HTML. Its whole formatting vocabulary is:
 *
 *   *bold*   _italic_   ~strikethrough~   `inline code`
 *   triple-backtick monospace blocks
 *   - bulleted and 1. numbered lists, and > quote lines
 *
 * There are no headings, no tables, and no link syntax (URLs autolink on
 * their own). An agent that emits a Markdown table produces a wall of pipes
 * and dashes, which is the most common way a WhatsApp bot looks broken.
 *
 * So this module DEGRADES rather than translates: every Markdown construct
 * with no WhatsApp equivalent is rewritten into something readable, and
 * anything left over is stripped. Telling the model about the dialect via
 * `prompt.channel` is the plan; this is the safety net.
 *
 * @see channels/telegram/format.ts — same seam, HTML target
 */

/** Triple backtick, built rather than typed so the fence rules stay readable. */
const FENCE = "`".repeat(3);

/**
 * Convert assistant Markdown into WhatsApp's dialect.
 */
export function markdownToWhatsApp(text: string): string {
  if (!text) return "";

  let out = text.replace(/\r\n/g, "\n");

  // Code is protected from every rule below — a table inside a fence is a
  // table on purpose, and `snake__case__` inside inline code is not emphasis.
  // Both survive verbatim: WhatsApp natively renders ``` blocks as monospace
  // and single-backtick spans as inline code. The control-byte (0x01)
  // delimiters keep the placeholder collision-proof: no model output can
  // contain that byte, unlike a word-shaped token.
  const fences: string[] = [];
  const shelter = (block: string): string => {
    fences.push(block);
    return ` FENCE${fences.length - 1} `;
  };
  out = out.replace(/```[\s\S]*?```/g, shelter);
  out = out.replace(/`[^`\n]+`/g, shelter);

  out = convertTables(out);
  out = convertLinks(out);
  // Emphasis runs before headings: a heading emits *bold*, and the italic
  // rule would otherwise read those two asterisks as an italic pair.
  out = convertEmphasis(out);
  out = convertHeadings(out);
  out = convertLists(out);
  out = convertBlockquotes(out);
  out = convertRules(out);

  // Collapse the blank-line runs the rewrites leave behind.
  out = out.replace(/\n{3,}/g, "\n\n").trim();

  out = out.replace(/ ?FENCE(\d+) ?/g, (_m, i) => fences[Number(i)] ?? "");

  return out;
}

/**
 * Markdown tables become one `key: value` line per cell, grouped by row.
 *
 * A table is the construct with the widest gap between Markdown and WhatsApp,
 * and the least forgiving failure. Rows are separated by a blank line so a
 * three-row table reads as three small blocks rather than one long list.
 */
function convertTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    const divider = lines[i + 1];

    const looksLikeTable =
      header?.includes("|") &&
      divider !== undefined &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(divider) &&
      divider.includes("-");

    if (!looksLikeTable) {
      out.push(header);
      continue;
    }

    const headers = splitRow(header);
    i += 2;

    const blocks: string[] = [];
    while (i < lines.length && lines[i]?.includes("|")) {
      const cells = splitRow(lines[i]);
      const pairs: string[] = [];
      for (let c = 0; c < cells.length; c++) {
        const label = headers[c]?.trim();
        const value = cells[c]?.trim();
        if (!value) continue;
        pairs.push(label ? `${label}: ${value}` : value);
      }
      if (pairs.length > 0) blocks.push(pairs.join("\n"));
      i++;
    }
    i--;

    out.push(blocks.join("\n\n"));
  }

  return out.join("\n");
}

function splitRow(row: string): string[] {
  return row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|");
}

/** `## Heading` becomes a bold line. */
function convertHeadings(text: string): string {
  return text.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, (_m, body: string) => {
    const clean = body.replace(/[*_~]/g, "").trim();
    return clean ? `*${clean}*` : "";
  });
}

/**
 * `[text](url)` becomes `text: url`, and bare `<url>` becomes `url`.
 *
 * WhatsApp autolinks a bare URL, so keeping both halves is the only way the
 * destination stays reachable.
 */
function convertLinks(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) =>
      alt ? `${alt}: ${url}` : url,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label: string, url: string) => {
      const clean = label.trim();
      if (!clean) return url;
      // A link whose text is already the URL should not be printed twice.
      return clean === url ? url : `${clean}: ${url}`;
    })
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1");
}

/**
 * Markdown emphasis becomes WhatsApp emphasis.
 *
 * Order matters: `**bold**` must be consumed before single-asterisk italics,
 * or the outer pair is read as an empty italic wrapping a bold.
 */
function convertEmphasis(text: string): string {
  let out = text;

  /*
   * Italics FIRST, and only for a genuinely lone asterisk pair.
   *
   * Converting bold first produces `*bold*`, which the italic rule then reads
   * as an italic pair and turns into `_bold_` — the emphasis is silently
   * downgraded on every bold span. The lookarounds below make the italic rule
   * skip anything adjacent to a second asterisk, so the bold rules that follow
   * still find their input intact.
   */
  out = out.replace(
    /(^|[\s(])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?!\*)(?=[\s).,;:!?]|$)/g,
    "$1_$2_",
  );
  // ***both*** — WhatsApp has no nested emphasis, so bold wins.
  out = out.replace(/\*\*\*(?!\s)([^*]+?)(?<!\s)\*\*\*/g, "*$1*");
  // **bold**
  out = out.replace(/\*\*(?!\s)([^*]+?)(?<!\s)\*\*/g, "*$1*");
  // __bold__
  out = out.replace(/__(?!\s)([^_]+?)(?<!\s)__/g, "*$1*");
  // ~~strike~~
  out = out.replace(/~~(?!\s)([^~]+?)(?<!\s)~~/g, "~$1~");
  // Inline `code` needs no rewrite — WhatsApp renders single backticks
  // natively — and never reaches here anyway: it is sheltered with the
  // fences before any conversion runs.

  return out;
}

/** Normalise list bullets; WhatsApp renders `- ` and `1. ` as native lists. */
function convertLists(text: string): string {
  return text
    .replace(/^(\s*)[*+]\s+/gm, "$1- ")
    .replace(/^(\s*)(\d+)[.)]\s+/gm, "$1$2. ");
}

/** `> quoted` keeps its marker — WhatsApp renders it as a quote block. */
function convertBlockquotes(text: string): string {
  return text.replace(/^\s{0,3}>\s?/gm, "> ");
}

/** Horizontal rules have no rendering; a blank line reads better than dashes. */
function convertRules(text: string): string {
  return text.replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, "");
}

/**
 * Strip every formatting marker, for contexts that take plain text only —
 * list row titles, button labels, template body parameters.
 */
export function stripFormatting(text: string): string {
  return text
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Truncate to a hard limit WITHOUT stripping formatting or newlines.
 *
 * For fields that allow WhatsApp's formatting vocabulary — above all the
 * 1024-character interactive body, where `fit`'s flattening of paragraphs
 * into one line would cost more readability than any overrun.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const cut = text.slice(0, maxLength - 1);
  const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  const body = lastBreak > maxLength * 0.6 ? cut.slice(0, lastBreak) : cut;
  return `${body}…`;
}

/**
 * Truncate to a hard limit, on a word boundary where one is close enough.
 *
 * Used for the several short fields WhatsApp caps tightly (button titles at
 * 20 characters, list row titles at 24).
 */
export function fit(text: string, maxLength: number): string {
  const clean = stripFormatting(text);
  if (clean.length <= maxLength) return clean;

  const cut = clean.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body}…`;
}

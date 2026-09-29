/**
 * AgentForEach Attachments — PDF Layout Complexity
 *
 * Scores how much a PDF's meaning depends on visual layout, so we can decide
 * whether flattening it to text is safe.
 *
 * Why this exists: text extraction on a complex PDF fails *silently*. Merged
 * table headers collapse, and out-of-flow content — stamps, marginal notes —
 * is emitted wherever it happens to sit in the content stream, stripped of
 * any spatial relationship. The output reads plausibly and is subtly wrong,
 * which is worse than an error. Nothing in the text reveals this; the
 * evidence is in the geometry.
 *
 * The signal, established by measuring real documents: PDF.js emits text in
 * content-stream order, so an out-of-flow element shows up as a large jump
 * back *up* the page. Magnitude is what separates the benign case from the
 * damaging one — a two-column break jumps back by about one column height
 * (~20% of the page), while a floating stamp or sidebar jumps back most of
 * the page (~60%+). Counting jumps doesn't discriminate; measuring them does.
 */

import type { PdfLayoutSignals } from "./types.js";

/** A positioned text run, as PDF.js reports it (origin: bottom-left). */
interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Upward jump, as a fraction of page height, below which flow is normal.
 * Column breaks land under this.
 */
const BENIGN_JUMP = 0.35;

/** Upward jump at or above which reading order is unreliable. */
const SEVERE_JUMP = 0.65;

/** Jumps above this fraction count toward the "how many" signal. */
const COUNTED_JUMP = 0.2;

/** Items are treated as sharing a column when their left edges are this close. */
const COLUMN_TOLERANCE = 12;

/**
 * Compute layout signals for one document from its per-page text items.
 *
 * @param pages - Text items grouped by page.
 */
export function analyzeLayout(pages: TextItem[][]): PdfLayoutSignals {
  let maxBackJump = 0;
  let backJumpCount = 0;
  let maxColumns = 1;

  for (const rawItems of pages) {
    const items = rawItems.filter((item) => item.str.trim().length > 0);
    if (items.length < 2) continue;

    // Page height from the content itself — PDF.js gives us positions, not
    // the MediaBox, and content extent is the meaningful denominator anyway.
    let minY = Infinity;
    let maxY = -Infinity;
    for (const item of items) {
      if (item.y < minY) minY = item.y;
      if (item.y > maxY) maxY = item.y;
    }
    const pageHeight = maxY - minY;
    if (pageHeight <= 0) continue;

    for (let i = 1; i < items.length; i++) {
      // y grows upward, so a positive delta means we jumped back up the page.
      const delta = items[i]!.y - items[i - 1]!.y;
      if (delta <= 0) continue;
      const fraction = delta / pageHeight;
      if (fraction > maxBackJump) maxBackJump = fraction;
      if (fraction >= COUNTED_JUMP) backJumpCount++;
    }

    maxColumns = Math.max(maxColumns, countColumns(items));
  }

  return {
    maxBackJump,
    backJumpCount,
    columnCount: maxColumns,
    score: scoreOf(maxBackJump, backJumpCount),
  };
}

/**
 * Combine the signals into a 0–1 complexity score.
 *
 * Dominated by the largest jump, because one displaced stamp is enough to
 * corrupt a document's meaning — severity matters far more than frequency.
 * Repeated large jumps add a little on top, since a document with several is
 * more likely to be genuinely non-linear than one with a single column break.
 *
 * Column count is reported for observability but deliberately not scored:
 * measured against real documents it tracked table columns rather than text
 * columns, and plain multi-column prose extracts correctly in practice.
 */
function scoreOf(maxBackJump: number, backJumpCount: number): number {
  const severity =
    clamp01((maxBackJump - BENIGN_JUMP) / (SEVERE_JUMP - BENIGN_JUMP)) * 0.8;
  const frequency = clamp01((backJumpCount - 1) / 3) * 0.2;
  return Math.min(severity + frequency, 1);
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Count distinct left-edge clusters, ignoring ones too sparse to be columns.
 */
function countColumns(items: TextItem[]): number {
  const origins = items.map((item) => item.x).sort((a, b) => a - b);
  const clusters: Array<{ x: number; count: number }> = [];

  for (const x of origins) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.x <= COLUMN_TOLERANCE) {
      last.count++;
    } else {
      clusters.push({ x, count: 1 });
    }
  }

  const minimum = Math.max(items.length * 0.08, 3);
  return Math.max(clusters.filter((c) => c.count >= minimum).length, 1);
}

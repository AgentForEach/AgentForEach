/**
 * AgentForEach Attachments — Document Extraction
 *
 * Turns document bytes into plain text/markdown so the model receives the
 * same input regardless of which provider is serving the turn.
 *
 * This is what makes documents model-agnostic: a PDF becomes text *before*
 * it reaches the provider layer, so every provider sees identical content.
 *
 * PDFs also carry layout signals out of here (see `layout.ts`), because
 * flattening is not always safe — the caller uses those to decide whether to
 * send the original document to the provider instead.
 *
 * Extractors are registered per format, so adding a new one — an OCR strategy,
 * a new file type — is a registration rather than a rewrite.
 */

import { analyzeLayout } from "./layout.js";
import { assertZipWithinLimits, ZipLimitError } from "../utils/zip.js";
import type {
  AttachmentConfig,
  DocumentFormat,
  ExtractedDocument,
  PdfLayoutSignals,
} from "./types.js";

// ============================================================================
// Errors
// ============================================================================

/** A document that can't be extracted, with a message safe to show the user. */
export class DocumentExtractionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

// ============================================================================
// Strategy Registry
// ============================================================================

interface ExtractionOutput {
  text: string;
  pageCount?: number;
  warnings: string[];
  /** Layout signals, when the format exposes geometry (PDF only). */
  signals?: PdfLayoutSignals;
}

type ExtractionStrategy = (
  buffer: Buffer,
  config: AttachmentConfig,
) => Promise<ExtractionOutput>;

const DEFAULT_STRATEGIES: Record<DocumentFormat, ExtractionStrategy> = {
  pdf: extractPdf,
  docx: extractDocx,
  markdown: extractPlainText,
  text: extractPlainText,
};

const STRATEGIES: Record<DocumentFormat, ExtractionStrategy> = {
  ...DEFAULT_STRATEGIES,
};

/**
 * Register or replace the extractor for a format.
 *
 * The seam for alternative extraction: an OCR strategy that renders scanned
 * pages, or a different parser for a format, drops in here without touching
 * the pipeline.
 */
export function registerExtractionStrategy(
  format: DocumentFormat,
  strategy: ExtractionStrategy,
): void {
  STRATEGIES[format] = strategy;
}

/** Restore the built-in extractors (for testing). */
export function resetExtractionStrategies(): void {
  Object.assign(STRATEGIES, DEFAULT_STRATEGIES);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Extract text from a single document.
 *
 * @throws {DocumentExtractionError} When the document can't be read.
 */
export async function extractDocument(
  buffer: Buffer,
  format: DocumentFormat,
  fileName: string,
  config: AttachmentConfig,
): Promise<ExtractedDocument> {
  const strategy = STRATEGIES[format];
  if (!strategy) {
    throw new DocumentExtractionError(
      `No extractor is registered for ${format} files.`,
      "no_strategy",
    );
  }

  const output = await strategy(buffer, config);
  const normalised = output.text.replace(/\n{3,}/g, "\n\n").trim();

  if (normalised.length === 0) {
    throw new DocumentExtractionError(
      `No readable text was found in ${fileName}.`,
      "empty_document",
    );
  }

  const truncated = normalised.length > config.maxDocumentChars;
  const text = truncated
    ? normalised.slice(0, config.maxDocumentChars)
    : normalised;

  return {
    fileName,
    format,
    text,
    charCount: text.length,
    ...(output.pageCount !== undefined ? { pageCount: output.pageCount } : {}),
    truncated,
    warnings: output.warnings,
    ...(output.signals ? { signals: output.signals } : {}),
  };
}

// ============================================================================
// PDF
// ============================================================================

/** PDF magic bytes: %PDF */
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]);

/**
 * unpdf is loaded lazily so a PDF-parsing problem can never take down cold
 * start for turns that don't involve a PDF.
 */
let _unpdf: typeof import("unpdf") | null = null;

async function loadUnpdf(): Promise<typeof import("unpdf")> {
  if (!_unpdf) {
    _unpdf = await import("unpdf");
  }
  return _unpdf;
}

async function extractPdf(
  buffer: Buffer,
  config: AttachmentConfig,
): Promise<ExtractionOutput> {
  if (buffer.length < 16 || buffer.subarray(0, 4).compare(PDF_MAGIC) !== 0) {
    throw new DocumentExtractionError(
      "That file is named as a PDF but doesn't contain a valid PDF header.",
      "invalid_pdf",
    );
  }

  const { extractText, extractTextItems, getDocumentProxy } = await loadUnpdf();

  let totalPages: number;
  let text: string;
  let signals: PdfLayoutSignals | undefined;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: true });
    totalPages = result.totalPages;
    text = result.text;

    // Geometry is the only place the risk of silent misordering shows up —
    // the extracted text always looks fine. Read it while the document is
    // already open.
    try {
      const positioned = await extractTextItems(pdf);
      signals = analyzeLayout(positioned.items);
    } catch {
      // Layout analysis is advisory; extraction still stands without it.
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password|encrypt/i.test(message)) {
      throw new DocumentExtractionError(
        "That PDF is password-protected. Please attach an unprotected copy.",
        "encrypted_pdf",
      );
    }
    throw new DocumentExtractionError(
      "That PDF couldn't be read. It may be corrupted.",
      "unreadable_pdf",
    );
  }

  // A PDF that yields almost nothing is a scan with no text layer. Never
  // hand the model a blank document — either the caller escalates it to the
  // provider's native path, or the user gets a clear rejection.
  if (text.trim().length < config.minExtractableChars) {
    throw new DocumentExtractionError(
      "That PDF has little or no selectable text, which usually means it's a " +
        "scan. Please attach a digital PDF.",
      "scanned_pdf",
    );
  }

  return {
    text,
    pageCount: totalPages,
    warnings: [],
    ...(signals ? { signals } : {}),
  };
}

// ============================================================================
// DOCX
// ============================================================================

/** ZIP magic bytes: PK — .docx is a zip archive. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b]);

/** Far more parts than any real Word document has. */
const MAX_DOCX_ENTRIES = 5_000;

async function extractDocx(
  buffer: Buffer,
  config: AttachmentConfig,
): Promise<ExtractionOutput> {
  if (buffer.subarray(0, 2).compare(ZIP_MAGIC) !== 0) {
    throw new DocumentExtractionError(
      "That file is named as a Word document but isn't a valid .docx archive.",
      "invalid_docx",
    );
  }

  // Mammoth inflates the whole archive into memory, so measure it first.
  try {
    assertZipWithinLimits(buffer, {
      maxExpandedBytes: config.maxDocxExpandedBytes,
      maxEntries: MAX_DOCX_ENTRIES,
    });
  } catch (err) {
    if (!(err instanceof ZipLimitError)) throw err;
    throw err.code === "invalid"
      ? new DocumentExtractionError(
          "That Word document couldn't be read. It may be corrupted.",
          "unreadable_docx",
        )
      : new DocumentExtractionError(
          "That Word document is too large to read once unpacked.",
          "docx_too_large",
        );
  }

  const [{ default: mammoth }, { NodeHtmlMarkdown }] = await Promise.all([
    import("mammoth"),
    import("node-html-markdown"),
  ]);

  let html: string;
  let messages: Array<{ message: string }>;
  try {
    // Convert via HTML rather than raw text so headings, lists and tables
    // survive as markdown — structure the model can actually reason about.
    const result = await mammoth.convertToHtml({ buffer });
    html = result.value;
    messages = result.messages;
  } catch {
    throw new DocumentExtractionError(
      "That Word document couldn't be read. It may be corrupted.",
      "unreadable_docx",
    );
  }

  const text = NodeHtmlMarkdown.translate(html, { bulletMarker: "-" }).trim();

  return {
    text,
    // Mammoth is chatty about unsupported styles; a few are useful signal,
    // the rest is noise.
    warnings: messages.slice(0, 5).map((m) => m.message),
  };
}

// ============================================================================
// Markdown / Plain Text
// ============================================================================

async function extractPlainText(buffer: Buffer): Promise<ExtractionOutput> {
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  return { text, warnings: [] };
}

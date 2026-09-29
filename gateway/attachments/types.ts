/**
 * AgentForEach Attachments — Types
 *
 * Type definitions for inbound attachment validation, classification,
 * and document text extraction.
 */

// ============================================================================
// Configuration
// ============================================================================

export interface AttachmentConfig {
  /** Enable document attachments. Images are always accepted. Default: true. */
  enabled: boolean;
  /** Maximum number of attachments per message. Default: 4. */
  maxAttachments: number;
  /** Maximum size of a single image in bytes. Default: 5 MiB. */
  maxImageBytes: number;
  /** Maximum size of a single document in bytes. Default: 8 MiB. */
  maxDocumentBytes: number;
  /** Maximum combined size of all attachments in bytes. Default: 20 MiB. */
  maxTotalBytes: number;
  /**
   * Maximum size a .docx may expand to once unzipped, measured by inflating
   * it (the zip's own headers can lie). Stops a small "zip bomb" from
   * exhausting the worker's memory. Default: 40 MiB.
   */
  maxDocxExpandedBytes: number;
  /** Maximum extracted characters kept per document. Default: 20000. */
  maxDocumentChars: number;
  /** Maximum extracted characters kept across all documents. Default: 60000. */
  maxTotalDocumentChars: number;
  /**
   * Minimum characters a PDF must yield to count as machine-readable.
   *
   * Below this the PDF is almost certainly a scan with no text layer. What
   * happens next depends on `pdfStrategy`: either a clear rejection, or
   * escalation to the provider's native document path.
   */
  minExtractableChars: number;
  /** How PDFs are delivered to the model. Default: "auto". */
  pdfStrategy: PdfStrategy;
  /**
   * Layout-complexity score (0–1) at or above which "auto" sends the PDF
   * natively instead of as extracted text. Default: 0.5.
   */
  pdfLayoutThreshold: number;
}

/**
 * How a PDF reaches the model.
 *
 * - `text`   — always flatten to text. Cheapest and fully portable, but
 *              loses layout silently on complex documents.
 * - `native` — always send the PDF itself when the provider supports it.
 *              Best fidelity; Anthropic measures this at roughly 7× the
 *              tokens of text-only for the same pages.
 * - `auto`   — flatten by default, escalate when the layout looks like it
 *              carries meaning, or when there's no text layer to extract.
 */
export type PdfStrategy = "text" | "native" | "auto";

/** Geometry-derived signals describing how layout-dependent a PDF is. */
export interface PdfLayoutSignals {
  /**
   * Largest jump back up the page, as a fraction of page height.
   *
   * The primary signal. A two-column break lands near 0.2; out-of-flow
   * content such as a stamp or sidebar lands near 0.6 or above.
   */
  maxBackJump: number;
  /** How many upward jumps exceeded 20% of page height. */
  backJumpCount: number;
  /** Distinct column origins detected. Reported only; not scored. */
  columnCount: number;
  /** Combined 0–1 complexity score. */
  score: number;
}

// ============================================================================
// Classification
// ============================================================================

/** How an attachment is routed through the pipeline. */
export type AttachmentKind = "image" | "document";

/** Document formats we can extract text from. */
export type DocumentFormat = "pdf" | "docx" | "markdown" | "text";

/** Result of classifying an inbound attachment by MIME type / file name. */
export interface AttachmentClassification {
  kind: AttachmentKind;
  /** Set only when `kind` is "document". */
  format?: DocumentFormat;
  /** Normalised MIME type. */
  mimeType: string;
}

// ============================================================================
// Inbound Attachments
// ============================================================================

/**
 * An attachment as it arrives on the wire.
 *
 * `fileName` is optional — older clients don't send it — but it materially
 * improves both classification and the prompt context block, so clients
 * should include it.
 */
export interface InboundAttachment {
  mimeType: string;
  base64: string;
  fileName?: string;
}

// ============================================================================
// Extraction
// ============================================================================

export interface ExtractedDocument {
  /** File name as supplied by the client, or a synthesised fallback. */
  fileName: string;
  /** Format the text was extracted from. */
  format: DocumentFormat;
  /** Extracted text, truncated to the configured budget. */
  text: string;
  /** Length of `text` after truncation. */
  charCount: number;
  /** Page count, when the format reports one (PDF only). */
  pageCount?: number;
  /** Whether `text` was cut short by the character budget. */
  truncated: boolean;
  /** Non-fatal notes raised during extraction. */
  warnings: string[];
  /** Layout signals, for PDFs where geometry could be read. */
  signals?: PdfLayoutSignals;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * A validation failure, shaped so handlers can turn it straight into an
 * HTTP response without re-deriving the status code.
 */
export interface AttachmentValidationError {
  code: string;
  message: string;
  statusCode: number;
}

export interface AttachmentValidationResult {
  /** Present when validation passed. */
  attachments?: ClassifiedAttachment[];
  /** Present when validation failed. */
  error?: AttachmentValidationError;
}

/** An inbound attachment paired with its classification. */
export interface ClassifiedAttachment extends InboundAttachment {
  classification: AttachmentClassification;
  /** Decoded byte length (derived from the base64 payload). */
  byteLength: number;
}

// ============================================================================
// Resolution Result
// ============================================================================

export interface AttachmentResolution {
  /**
   * Image attachments, passed through untouched for the vision path.
   *
   * These stay as base64 because every provider takes images natively —
   * the runner turns them into provider-agnostic image content blocks.
   */
  images: InboundAttachment[];
  /** Documents that were successfully extracted to text. */
  documents: ExtractedDocument[];
  /**
   * PDFs being sent to the provider as documents rather than as text.
   *
   * Always base64 — never a provider file handle, so a mid-turn failover to
   * a different provider still works.
   */
  nativeDocuments: NativeDocument[];
  /** Formatted context block for prompt injection. Empty when no documents. */
  contextBlock: string;
  /** Non-fatal notes accumulated across all attachments. */
  warnings: string[];
}

/** A PDF routed to the provider's native document input. */
export interface NativeDocument {
  fileName: string;
  mimeType: string;
  base64: string;
  /** Why this document was escalated — surfaced for observability. */
  reason: "layout" | "no-text-layer" | "policy";
  /** Layout signals, when they were the deciding factor. */
  signals?: PdfLayoutSignals;
  /**
   * Extracted text, when we had it anyway.
   *
   * Escalating for layout means we already extracted successfully and simply
   * chose not to use the result as prompt context. Keeping it lets session
   * history hold something a later turn can read, even though this turn saw
   * the rendered document. Absent when there was no text layer to extract.
   */
  extractedText?: string;
}

/** What the caller knows about the provider serving this turn. */
export interface ResolveOptions {
  /**
   * Whether the active provider accepts native PDF input.
   *
   * When false, escalation is impossible and PDFs fall back to text — or to
   * a clear rejection if there was no text layer to extract.
   */
  supportsNativeDocuments: boolean;
}

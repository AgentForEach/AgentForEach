/**
 * AgentForEach Attachments — Barrel Exports
 *
 * Public API for the attachment subsystem. Validates inbound attachments,
 * splits them by kind, extracts document text, and formats a context block
 * for prompt injection.
 *
 * Images pass through untouched for the provider-native vision path;
 * documents are flattened to text so every provider sees the same input.
 */

// Types
export type {
  AttachmentClassification,
  AttachmentConfig,
  AttachmentKind,
  AttachmentResolution,
  AttachmentValidationError,
  AttachmentValidationResult,
  ClassifiedAttachment,
  DocumentFormat,
  ExtractedDocument,
  InboundAttachment,
  NativeDocument,
  PdfLayoutSignals,
  PdfStrategy,
  ResolveOptions,
} from "./types.js";

// Config
export { loadAttachmentConfig, resetAttachmentConfig } from "./config.js";

// Detection
export {
  classifyAttachment,
  IMAGE_MIME_TYPES,
  supportedFormatsLabel,
} from "./detect.js";

// Validation
export { base64ByteLength, validateAttachments } from "./validate.js";

// Extraction
export {
  DocumentExtractionError,
  extractDocument,
  registerExtractionStrategy,
  resetExtractionStrategies,
} from "./extract.js";

// Layout analysis
export { analyzeLayout } from "./layout.js";

// ============================================================================
// High-level API — resolveAttachments()
// ============================================================================

import { DocumentExtractionError, extractDocument } from "./extract.js";
import type {
  AttachmentConfig,
  AttachmentResolution,
  ClassifiedAttachment,
  ExtractedDocument,
  InboundAttachment,
  NativeDocument,
  ResolveOptions,
} from "./types.js";

/**
 * Resolve validated attachments into images and extracted document text.
 *
 * This is the main entry point used by the runner pipeline. Extraction
 * failures are non-fatal: the offending document becomes a warning and the
 * turn proceeds, matching how link resolution degrades.
 *
 * @param attachments - Attachments already through `validateAttachments`.
 * @param config - Attachment configuration.
 */
export async function resolveAttachments(
  attachments: ClassifiedAttachment[],
  config: AttachmentConfig,
  options: ResolveOptions = { supportsNativeDocuments: false },
): Promise<AttachmentResolution> {
  const images: InboundAttachment[] = [];
  const documents: ExtractedDocument[] = [];
  const nativeDocuments: NativeDocument[] = [];
  const warnings: string[] = [];

  const canGoNative =
    options.supportsNativeDocuments && config.pdfStrategy !== "text";

  // Budget shared across every document in the message, so four large PDFs
  // can't crowd out the rest of the prompt.
  let remainingChars = config.maxTotalDocumentChars;

  for (const attachment of attachments) {
    if (attachment.classification.kind === "image") {
      images.push({
        mimeType: attachment.mimeType,
        base64: attachment.base64,
        ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      });
      continue;
    }

    const format = attachment.classification.format;
    if (!format) continue;

    const fileName = attachment.fileName ?? `document.${format}`;

    // `native` sends every PDF to the provider without extracting first —
    // no point paying for extraction we're going to discard.
    if (format === "pdf" && canGoNative && config.pdfStrategy === "native") {
      nativeDocuments.push({
        fileName,
        mimeType: "application/pdf",
        base64: attachment.base64,
        reason: "policy",
      });
      continue;
    }

    if (remainingChars <= 0) {
      warnings.push(`${fileName} was skipped — the document budget was full.`);
      continue;
    }

    try {
      const extracted = await extractDocument(
        Buffer.from(attachment.base64, "base64"),
        format,
        fileName,
        { ...config, maxDocumentChars: Math.min(config.maxDocumentChars, remainingChars) },
      );

      // Extraction succeeded — but succeeding isn't the same as being safe.
      // A layout-heavy PDF produces text that reads plausibly while having
      // lost the spatial relationships that carried the meaning.
      const score = extracted.signals?.score ?? 0;
      if (
        format === "pdf" &&
        canGoNative &&
        score >= config.pdfLayoutThreshold
      ) {
        nativeDocuments.push({
          fileName,
          mimeType: "application/pdf",
          base64: attachment.base64,
          reason: "layout",
          ...(extracted.signals ? { signals: extracted.signals } : {}),
          extractedText: extracted.text,
        });
        continue;
      }

      remainingChars -= extracted.charCount;
      documents.push(extracted);
      warnings.push(...extracted.warnings);
    } catch (error) {
      // A scan has no text to extract. If the provider can render pages, that
      // is exactly the case native input exists for.
      if (
        error instanceof DocumentExtractionError &&
        error.code === "scanned_pdf" &&
        canGoNative
      ) {
        nativeDocuments.push({
          fileName,
          mimeType: "application/pdf",
          base64: attachment.base64,
          reason: "no-text-layer",
        });
        continue;
      }

      // Otherwise a document we can't read shouldn't sink the turn — the user
      // may have asked something answerable without it.
      const message =
        error instanceof DocumentExtractionError
          ? error.message
          : `${fileName} couldn't be read.`;
      warnings.push(message);
    }
  }

  return {
    images,
    documents,
    nativeDocuments,
    contextBlock: documents.length > 0 ? formatContextBlock(documents) : "",
    warnings,
  };
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format extracted documents into a context block for prompt injection.
 *
 * Mirrors the shape of the link-understanding context block so the system
 * prompt stays consistent about how external content is presented.
 */
function formatContextBlock(documents: ExtractedDocument[]): string {
  const entries = documents.map((doc, i) => {
    const parts = [`[${i + 1}] ${doc.fileName}`];
    const meta = [`Format: ${doc.format}`];
    if (doc.pageCount !== undefined) meta.push(`Pages: ${doc.pageCount}`);
    parts.push(meta.join(" · "));
    if (doc.truncated) {
      parts.push(
        `Note: only the first ${doc.charCount} characters are shown; the document continues beyond this point.`,
      );
    }
    parts.push("---");
    parts.push(doc.text);
    return parts.join("\n");
  });

  const noun = documents.length === 1 ? "document" : "documents";

  return [
    "<document-context>",
    `The user attached the following ${noun}. This is the full text available to you —`,
    "answer from it directly, and say so if the answer isn't in it.",
    "",
    entries.join("\n\n"),
    "</document-context>",
  ].join("\n");
}

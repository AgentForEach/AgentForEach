/**
 * AgentForEach Attachments — Classification
 *
 * Decides whether an inbound attachment travels the vision path (image)
 * or the extraction path (document), and which extractor a document needs.
 */

import type { AttachmentClassification, DocumentFormat } from "./types.js";

// ============================================================================
// Known Types
// ============================================================================

/**
 * Image MIME types every supported provider accepts natively.
 *
 * Deliberately conservative — this is the intersection of what OpenAI,
 * Anthropic and Gemini all take, so an image accepted here works regardless
 * of which provider the user has selected.
 */
export const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const DOCUMENT_MIME_TYPES: ReadonlyMap<string, DocumentFormat> = new Map([
  ["application/pdf", "pdf"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "docx",
  ],
  ["text/markdown", "markdown"],
  ["text/x-markdown", "markdown"],
  ["text/plain", "text"],
]);

const DOCUMENT_EXTENSIONS: ReadonlyMap<string, DocumentFormat> = new Map([
  ["pdf", "pdf"],
  ["docx", "docx"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["txt", "text"],
  ["text", "text"],
]);

// ============================================================================
// Classification
// ============================================================================

/**
 * Classify an attachment by MIME type, falling back to the file extension.
 *
 * The fallback matters more than it looks: browsers and mobile pickers
 * routinely report `.md` as `text/plain` and `.docx` as
 * `application/octet-stream`, so trusting the MIME type alone would send
 * markdown through the plain-text path and reject Word documents outright.
 *
 * @returns The classification, or null when the type isn't supported.
 */
export function classifyAttachment(
  mimeType: string | undefined,
  fileName?: string,
): AttachmentClassification | null {
  const normalised = (mimeType ?? "").trim().toLowerCase();
  const extensionFormat = documentFormatFromFileName(fileName);

  if (IMAGE_MIME_TYPES.has(normalised)) {
    return { kind: "image", mimeType: normalised };
  }

  // An explicit extension beats a vague MIME type. `text/plain` is the
  // common case: it's correct for .txt but wrong for .md, and the two want
  // different extractors.
  if (extensionFormat) {
    return {
      kind: "document",
      format: extensionFormat,
      mimeType: normalised || mimeTypeForFormat(extensionFormat),
    };
  }

  const mimeFormat = DOCUMENT_MIME_TYPES.get(normalised);
  if (mimeFormat) {
    return { kind: "document", format: mimeFormat, mimeType: normalised };
  }

  return null;
}

/** Extract a document format from a file name's extension, if recognised. */
function documentFormatFromFileName(
  fileName?: string,
): DocumentFormat | undefined {
  if (!fileName) return undefined;
  const dot = fileName.lastIndexOf(".");
  if (dot === -1 || dot === fileName.length - 1) return undefined;
  return DOCUMENT_EXTENSIONS.get(fileName.slice(dot + 1).toLowerCase());
}

/** Canonical MIME type for a format, used when the client sent none. */
function mimeTypeForFormat(format: DocumentFormat): string {
  switch (format) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "markdown":
      return "text/markdown";
    case "text":
      return "text/plain";
  }
}

/** Human-readable list of accepted formats, for error messages. */
export function supportedFormatsLabel(): string {
  return "JPEG, PNG, GIF, WebP, PDF, Word (.docx), Markdown, or plain text";
}

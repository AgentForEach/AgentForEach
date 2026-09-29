/**
 * AgentForEach Attachments — Validation
 *
 * Shared entry validation for both transports (REST `POST /api/chat` and the
 * WebSocket `ws-message` handler), so the two can't drift apart on what they
 * accept.
 */

import { classifyAttachment, supportedFormatsLabel } from "./detect.js";
import type {
  AttachmentConfig,
  AttachmentValidationResult,
  ClassifiedAttachment,
  InboundAttachment,
} from "./types.js";

/** Standard base64 alphabet with optional padding, no line breaks. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decoded byte length of a base64 string, without decoding it.
 *
 * Lets us reject an oversized payload before allocating a buffer for it.
 */
export function base64ByteLength(base64: string): number {
  if (base64.length === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** Render a byte count as MB for user-facing messages. */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate and classify a raw `attachments` array from a client request.
 *
 * Returns either the classified attachments or a single error describing the
 * first problem found. Nothing is decoded here beyond measuring sizes.
 */
export function validateAttachments(
  raw: unknown,
  config: AttachmentConfig,
): AttachmentValidationResult {
  if (raw === undefined || raw === null) {
    return { attachments: [] };
  }

  if (!Array.isArray(raw)) {
    return {
      error: {
        code: "attachments_not_array",
        message: "attachments must be an array",
        statusCode: 400,
      },
    };
  }

  if (raw.length > config.maxAttachments) {
    return {
      error: {
        code: "attachments_too_many",
        message: `You can attach at most ${config.maxAttachments} files to a message.`,
        statusCode: 400,
      },
    };
  }

  const classified: ClassifiedAttachment[] = [];
  let totalBytes = 0;

  for (const entry of raw as InboundAttachment[]) {
    if (!entry || typeof entry !== "object") {
      return {
        error: {
          code: "attachment_malformed",
          message: "Each attachment must be an object with mimeType and base64",
          statusCode: 400,
        },
      };
    }

    const { mimeType, base64, fileName } = entry;

    if (typeof base64 !== "string" || base64.length === 0) {
      return {
        error: {
          code: "attachment_missing_data",
          message: "Each attachment must include base64 data.",
          statusCode: 400,
        },
      };
    }

    if (base64.length % 4 !== 0 || !BASE64_RE.test(base64)) {
      return {
        error: {
          code: "attachment_invalid_base64",
          message: "Invalid base64 encoding",
          statusCode: 400,
        },
      };
    }

    const classification = classifyAttachment(mimeType, fileName);
    if (!classification) {
      return {
        error: {
          code: "attachment_unsupported_type",
          message: `That file type isn't supported. Please attach a ${supportedFormatsLabel()} file.`,
          statusCode: 400,
        },
      };
    }

    if (classification.kind === "document" && !config.enabled) {
      return {
        error: {
          code: "attachment_documents_disabled",
          message: "Document attachments are not enabled.",
          statusCode: 400,
        },
      };
    }

    const byteLength = base64ByteLength(base64);
    if (byteLength === 0) {
      return {
        error: {
          code: "attachment_empty",
          message: "That file is empty. Please choose another one.",
          statusCode: 400,
        },
      };
    }

    const limit =
      classification.kind === "image"
        ? config.maxImageBytes
        : config.maxDocumentBytes;
    if (byteLength > limit) {
      const label = classification.kind === "image" ? "Image" : "Document";
      return {
        error: {
          code: "attachment_too_large",
          message: `${label} is ${mb(byteLength)}. The limit is ${mb(limit)}.`,
          statusCode: 413,
        },
      };
    }

    totalBytes += byteLength;
    if (totalBytes > config.maxTotalBytes) {
      return {
        error: {
          code: "attachments_total_too_large",
          message: `Those attachments total more than ${mb(config.maxTotalBytes)}. Please send fewer or smaller files.`,
          statusCode: 413,
        },
      };
    }

    classified.push({
      mimeType: classification.mimeType,
      base64,
      ...(fileName ? { fileName } : {}),
      classification,
      byteLength,
    });
  }

  return { attachments: classified };
}

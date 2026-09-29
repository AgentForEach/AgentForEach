/**
 * AgentForEach Attachments — Configuration
 *
 * Loads attachment config from agentforeach.json ("attachments" section).
 */

import { loadConfigSection } from "../utils/index.js";
import type { AttachmentConfig } from "./types.js";

// ============================================================================
// Defaults
// ============================================================================

const MIB = 1024 * 1024;

const DEFAULT_CONFIG: AttachmentConfig = {
  enabled: true,
  maxAttachments: 4,
  maxImageBytes: 5 * MIB,
  maxDocumentBytes: 8 * MIB,
  maxTotalBytes: 20 * MIB,
  maxDocumentChars: 20_000,
  maxTotalDocumentChars: 60_000,
  minExtractableChars: 200,
  pdfStrategy: "auto",
  pdfLayoutThreshold: 0.5,
};

// ============================================================================
// Loader
// ============================================================================

let _config: AttachmentConfig | undefined;

/**
 * Load the attachment config from agentforeach.json.
 * Merges with defaults for any missing fields.
 */
export function loadAttachmentConfig(): AttachmentConfig {
  if (_config) return _config;

  const section = loadConfigSection<Partial<AttachmentConfig>>("attachments");

  _config = {
    enabled: section?.enabled ?? DEFAULT_CONFIG.enabled,
    maxAttachments: section?.maxAttachments ?? DEFAULT_CONFIG.maxAttachments,
    maxImageBytes: section?.maxImageBytes ?? DEFAULT_CONFIG.maxImageBytes,
    maxDocumentBytes:
      section?.maxDocumentBytes ?? DEFAULT_CONFIG.maxDocumentBytes,
    maxTotalBytes: section?.maxTotalBytes ?? DEFAULT_CONFIG.maxTotalBytes,
    maxDocumentChars:
      section?.maxDocumentChars ?? DEFAULT_CONFIG.maxDocumentChars,
    maxTotalDocumentChars:
      section?.maxTotalDocumentChars ?? DEFAULT_CONFIG.maxTotalDocumentChars,
    minExtractableChars:
      section?.minExtractableChars ?? DEFAULT_CONFIG.minExtractableChars,
    pdfStrategy: section?.pdfStrategy ?? DEFAULT_CONFIG.pdfStrategy,
    pdfLayoutThreshold:
      section?.pdfLayoutThreshold ?? DEFAULT_CONFIG.pdfLayoutThreshold,
  };

  return _config;
}

/**
 * Reset the cached config (for testing).
 */
export function resetAttachmentConfig(): void {
  _config = undefined;
}

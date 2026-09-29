/**
 * AgentForEach Channels — Telegram Media Download
 *
 * Downloads photos and documents from Telegram's file API.
 * Files are fetched into memory as base64 — no disk I/O
 * (required for serverless Azure Functions).
 *
 * Flow:
 *   1. getFile(file_id) → file_path
 *   2. Download file from https://api.telegram.org/file/bot{token}/{file_path}
 *   3. Convert to base64
 *
 * @see https://core.telegram.org/bots/api#getfile
 */

import { loadTelegramConfig } from "./config.js";
import type { TelegramGetFileResponse, TelegramPhotoSize } from "./types.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Maximum file size to download (20MB — Telegram's own limit). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Image MIME types we accept for vision. */
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// ============================================================================
// Download
// ============================================================================

/**
 * Download a Telegram file by file_id and return it as base64.
 *
 * Returns undefined if the download fails or the file is too large.
 */
export async function downloadTelegramFile(
  fileId: string,
): Promise<{ base64: string; mimeType: string; sizeBytes: number } | undefined> {
  const config = loadTelegramConfig();
  if (!config.botToken) return undefined;

  try {
    // Step 1: Get the file path from Telegram
    const getFileUrl = `${TELEGRAM_API_BASE}/bot${config.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const getFileRes = await fetch(getFileUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    const getFileData = (await getFileRes.json()) as TelegramGetFileResponse;

    if (!getFileData.ok || !getFileData.result?.file_path) {
      return undefined;
    }

    const filePath = getFileData.result.file_path;
    const fileSize = getFileData.result.file_size ?? 0;

    // Guard: reject path traversal or absolute paths (defense-in-depth)
    if (filePath.includes("..") || filePath.startsWith("/")) {
      return undefined;
    }

    // Skip files that are too large (metadata check)
    if (fileSize > MAX_FILE_SIZE) {
      return undefined;
    }

    // Step 2: Download the file (with timeout to prevent hangs)
    const downloadUrl = `${TELEGRAM_API_BASE}/file/bot${config.botToken}/${filePath}`;
    const downloadRes = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!downloadRes.ok) {
      return undefined;
    }

    // Guard: verify content-length against our limit before buffering
    const contentLength = parseInt(downloadRes.headers.get("content-length") ?? "0", 10);
    if (contentLength > MAX_FILE_SIZE) {
      return undefined;
    }

    // Step 3: Convert to base64
    const arrayBuffer = await downloadRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Guard: actual size check (content-length can be spoofed)
    if (buffer.length > MAX_FILE_SIZE) {
      return undefined;
    }

    const base64 = buffer.toString("base64");

    // Determine MIME type — prefer magic bytes, fall back to file extension
    const mimeType = detectMimeType(buffer) ?? guessMimeType(filePath);

    return {
      base64,
      mimeType,
      sizeBytes: buffer.length,
    };
  } catch {
    // Download failure is non-fatal — the message will be processed without the image
    return undefined;
  }
}

// ============================================================================
// Photo Selection
// ============================================================================

/**
 * Select the best photo size from Telegram's photo array.
 *
 * Strategy: Pick the largest photo that's under the size limit.
 * Telegram provides sizes in ascending order (smallest first, largest last).
 */
export function selectBestPhoto(
  photos: TelegramPhotoSize[],
): TelegramPhotoSize | undefined {
  if (photos.length === 0) return undefined;

  // Walk from largest to smallest, pick the first that fits
  for (let i = photos.length - 1; i >= 0; i--) {
    const photo = photos[i]!;
    if (!photo.file_size || photo.file_size <= MAX_FILE_SIZE) {
      return photo;
    }
  }

  // Fallback: smallest available
  return photos[0];
}

// ============================================================================
// MIME Helpers
// ============================================================================

/**
 * Check if a MIME type is a supported image type for vision.
 */
export function isSupportedImageType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

/**
 * Detect MIME type from file magic bytes.
 *
 * Returns undefined if the buffer doesn't match any known image signature,
 * which lets callers fall back to extension-based guessing.
 */
function detectMimeType(buffer: Buffer): string | undefined {
  if (buffer.length < 4) return undefined;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return "image/gif";
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  return undefined;
}

/**
 * Guess MIME type from a Telegram file path (extension-based fallback).
 */
function guessMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/jpeg"; // Telegram photos are JPEG by default
  }
}

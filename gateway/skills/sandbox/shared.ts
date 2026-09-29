/**
 * AgentForEach Skills Layer — helpers shared by the sandbox backends.
 */

/** Where sandbox tools read and write files, in every backend. */
export const DATA_DIR = "/mnt/data";

export const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

export const DEFAULT_MAX_EXPORT_BYTES = 50 * 1024 * 1024;

/**
 * How much of a sandbox file the gateway reads into memory: text for the
 * model stops at the output limit (UTF-8 needs at most 4 bytes a character),
 * an export at the export limit. Nothing past these is downloaded.
 */
export function sandboxReadLimits(config: { maxOutputChars?: number; maxExportBytes?: number }): {
  maxChars: number;
  maxTextBytes: number;
  maxExportBytes: number;
} {
  const maxChars = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  return {
    maxChars,
    maxTextBytes: maxChars * 4,
    maxExportBytes: config.maxExportBytes ?? DEFAULT_MAX_EXPORT_BYTES,
  };
}

/** Error for a file bigger than the export limit. */
export function exportTooLargeError(maxBytes: number): Error {
  return new Error(`File too large for export (max ${maxBytes} bytes / ${maxBytes / 1024 / 1024} MB)`);
}

/**
 * Turn a tool-supplied filename into a path relative to /mnt/data: strips
 * null bytes, every "..", leading slashes and a leading "mnt/data/".
 */
export function safeRelativePath(filename: string): string {
  let safe = filename.replace(/\0/g, "");
  let prev = "";
  while (safe !== prev) {
    prev = safe;
    safe = safe.replace(/\.\./g, "");
  }
  return safe.replace(/^\/+/, "").replace(/^mnt\/data\/+/, "");
}

/** Absolute path inside /mnt/data for a tool-supplied filename. */
export function dataPath(filename: string): string {
  return `${DATA_DIR}/${safeRelativePath(filename)}`;
}

/** Quote a string for a POSIX shell single-quoted context. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

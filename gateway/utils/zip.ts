/**
 * Zip archive limits, checked before a parser inflates the archive.
 *
 * A zip's headers state each entry's uncompressed size, but nothing makes
 * them true: a few hundred kilobytes can inflate to gigabytes. So this walks
 * the central directory and inflates every entry with a hard output cap,
 * measuring the real expanded size. It keeps nothing it inflates.
 *
 * Supports what documents use: stored and deflated entries, no zip64, no
 * encryption. Anything else is refused as invalid.
 */

import { inflateRawSync } from "node:zlib";

export interface ZipLimits {
  /** Maximum total size of all entries once inflated. */
  maxExpandedBytes: number;
  /** Maximum number of entries. */
  maxEntries: number;
}

export class ZipLimitError extends Error {
  constructor(
    message: string,
    readonly code: "too_large" | "too_many_entries" | "invalid",
  ) {
    super(message);
    this.name = "ZipLimitError";
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const CENTRAL_MIN_SIZE = 46;
const LOCAL_MIN_SIZE = 30;
const MAX_COMMENT = 0xffff;

/**
 * Throw a ZipLimitError unless the archive is well formed and within the
 * limits. Returns the entry count and the real expanded size.
 */
export function assertZipWithinLimits(
  buffer: Buffer,
  limits: ZipLimits,
): { entries: number; expandedBytes: number } {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === -1) throw invalid("no end of central directory");

  const entries = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || centralOffset === 0xffffffff) throw invalid("zip64 is not supported");
  if (entries > limits.maxEntries) {
    throw new ZipLimitError(`${entries} entries (limit ${limits.maxEntries})`, "too_many_entries");
  }

  let expandedBytes = 0;
  let p = centralOffset;
  for (let n = 0; n < entries; n++) {
    if (p + CENTRAL_MIN_SIZE > buffer.length || buffer.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
      throw invalid("bad central directory entry");
    }
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    if (flags & 0x1) throw invalid("encrypted entries are not supported");

    if (localOffset + LOCAL_MIN_SIZE > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw invalid("bad local header");
    }
    const dataStart =
      localOffset + LOCAL_MIN_SIZE + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw invalid("entry runs past the end of the archive");

    const remaining = limits.maxExpandedBytes - expandedBytes;
    if (method === 0) {
      expandedBytes += compressedSize;
    } else if (method === 8) {
      let inflated: Buffer;
      try {
        // One byte over the budget is enough to know it's too large.
        inflated = inflateRawSync(buffer.subarray(dataStart, dataEnd), { maxOutputLength: remaining + 1 });
      } catch (err) {
        if (err instanceof RangeError) throw tooLarge(limits);
        throw invalid("corrupt deflate data");
      }
      expandedBytes += inflated.length;
    } else {
      throw invalid(`compression method ${method} is not supported`);
    }
    if (expandedBytes > limits.maxExpandedBytes) throw tooLarge(limits);

    p += CENTRAL_MIN_SIZE + nameLength + extraLength + commentLength;
  }

  return { entries, expandedBytes };
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function invalid(reason: string): ZipLimitError {
  return new ZipLimitError(`Invalid zip archive: ${reason}`, "invalid");
}

function tooLarge(limits: ZipLimits): ZipLimitError {
  return new ZipLimitError(`Expands to more than ${limits.maxExpandedBytes} bytes`, "too_large");
}

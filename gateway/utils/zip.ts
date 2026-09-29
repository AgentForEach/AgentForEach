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
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const CENTRAL_MIN_SIZE = 46;
const LOCAL_MIN_SIZE = 30;
const MAX_COMMENT = 0xffff;

/**
 * Throw a ZipLimitError unless the archive is well formed and within the
 * limits. Returns the entry count and the real expanded size.
 *
 * Parsers disagree on malformed archives (JSZip, under Mammoth, reads every
 * central-directory record whatever the entry count says, and shifts offsets
 * when the directory doesn't end at the end record), so anything a strict
 * reading can't account for exactly is refused rather than measured.
 */
export function assertZipWithinLimits(
  buffer: Buffer,
  limits: ZipLimits,
): { entries: number; expandedBytes: number } {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === -1) throw invalid("no end of central directory");

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (
    [diskNumber, centralDisk, entriesOnDisk, entries].includes(0xffff) ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE)
  ) {
    throw invalid("zip64 is not supported");
  }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) throw invalid("multi-disk archive");
  // The directory must end exactly where the end record starts: no prepended
  // data, gaps or overlap for another parser to interpret differently.
  if (centralOffset + centralSize !== eocd) throw invalid("central directory doesn't end at the end record");
  if (entries > limits.maxEntries) {
    throw new ZipLimitError(`${entries} entries (limit ${limits.maxEntries})`, "too_many_entries");
  }

  // Walk every record in the directory, not just `entries` of them.
  const ranges: Array<[number, number]> = [];
  let walked = 0;
  let p = centralOffset;
  while (p < eocd) {
    if (walked >= entries) throw invalid("more central directory records than the entry count");
    if (p + CENTRAL_MIN_SIZE > eocd || buffer.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
      throw invalid("bad central directory entry");
    }
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    if (flags & 0x1) throw invalid("encrypted entries are not supported");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw invalid("zip64 is not supported");
    }
    if (method !== 0 && method !== 8) throw invalid(`compression method ${method} is not supported`);

    if (localOffset + LOCAL_MIN_SIZE > centralOffset || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw invalid("bad local header");
    }
    const dataStart =
      localOffset + LOCAL_MIN_SIZE + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) throw invalid("entry runs into the central directory");
    ranges.push([localOffset, dataEnd]);

    p += CENTRAL_MIN_SIZE + nameLength + extraLength + commentLength;
    walked++;
  }
  if (p !== eocd || walked !== entries) throw invalid("central directory doesn't match the entry count");

  // Entries may not share bytes: otherwise thousands of records could point
  // at one stream and make the inflation below cost far more than the file.
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]![0] < ranges[i - 1]![1]) throw invalid("overlapping entries");
  }

  // Now inflate each entry with a hard cap: the headers' sizes can lie.
  let expandedBytes = 0;
  p = centralOffset;
  for (let n = 0; n < entries; n++) {
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const localOffset = buffer.readUInt32LE(p + 42);
    const dataStart =
      localOffset + LOCAL_MIN_SIZE + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const remaining = limits.maxExpandedBytes - expandedBytes;
    if (method === 0) {
      expandedBytes += compressedSize;
    } else {
      let inflated: Buffer;
      try {
        // One byte over the budget is enough to know it's too large.
        inflated = inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize), {
          maxOutputLength: remaining + 1,
        });
      } catch (err) {
        if (err instanceof RangeError) throw tooLarge(limits);
        throw invalid("corrupt deflate data");
      }
      expandedBytes += inflated.length;
    }
    if (expandedBytes > limits.maxExpandedBytes) throw tooLarge(limits);
    p += CENTRAL_MIN_SIZE + buffer.readUInt16LE(p + 28) + buffer.readUInt16LE(p + 30) + buffer.readUInt16LE(p + 32);
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

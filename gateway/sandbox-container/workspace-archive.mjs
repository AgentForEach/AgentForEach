/**
 * Bounded archives of /mnt/data, for persistence that keeps the files
 * outside the sandbox (an AWS checkpoint in S3): server.mjs serves them on
 * /archive when SANDBOX_ARCHIVE_MAX_BYTES / SANDBOX_ARCHIVE_MAX_FILES are set.
 * Without them, /archive streams plain `tar` as before.
 *
 * The format is still a gzipped tar (POSIX ustar, with pax headers for long
 * names), so any `tar` reads it, but both directions are done here, in Node,
 * so that every bound and check holds whatever the archive came from:
 *
 *   - packing reads only what lstat sees under the root: regular files,
 *     directories and symlinks (never followed; a file is opened with
 *     O_NOFOLLOW, so a swap to a link mid-read can't read outside). Sockets,
 *     FIFOs and devices are left out. Over either bound, or when the
 *     compressed archive itself is larger than maxBytes (plus 1 MiB for
 *     headers), it fails with ArchiveLimitError; nothing is ever cut short.
 *   - unpacking decompresses with a cap, then checks the whole archive
 *     before it touches the disk: paths (relative, no "." or "..", no
 *     backslashes or NULs, every parent a directory in the archive, no
 *     duplicates), entry types (no hard links, sockets, FIFOs or devices),
 *     symlink targets, permissions, and both bounds. Only then does it
 *     replace the root's contents; symlinks are created last and never
 *     followed while unpacking.
 *
 * Hard links become independent copies; ownership, extended attributes and
 * directory times are not kept. Chromium's caches under .browser/ are left
 * out: they rebuild themselves, and would use most of the budget.
 */

import { chmod, lstat, mkdir, open, readdir, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCallback, gzip as gzipCallback } from "node:zlib";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

const BLOCK = 512;
const MAX_PATH = 4096;
/** Room for each entry's headers (a pax header with a long path, then the entry's own). */
const HEADER_ROOM = 12 * BLOCK;
/** Directories under .browser/ that Chromium rebuilds itself. */
const BROWSER_CACHES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
]);

/** /mnt/data is over a bound: the archive was not made (or not unpacked). */
export class ArchiveLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArchiveLimitError";
    this.code = "archive_limit";
  }
}

/** The archive is not one this module accepts; nothing was changed. */
export class ArchiveInvalidError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArchiveInvalidError";
    this.code = "archive_invalid";
  }
}

/** The bounds from the environment, or undefined when neither is set (unbounded /archive). */
export function archiveLimitsFromEnv(env = process.env) {
  const bytes = env.SANDBOX_ARCHIVE_MAX_BYTES?.trim();
  const files = env.SANDBOX_ARCHIVE_MAX_FILES?.trim();
  if (!bytes && !files) return undefined;
  const parse = (name, value, fallback) => {
    if (!value) return fallback;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, not "${value}"`);
    return n;
  };
  return {
    maxBytes: parse("SANDBOX_ARCHIVE_MAX_BYTES", bytes, 64 * 1024 * 1024),
    maxFiles: parse("SANDBOX_ARCHIVE_MAX_FILES", files, 10_000),
  };
}

/** The most bytes a bounded archive unpacks to: the files plus their headers (the decompression cap). */
export function maxArchiveBytes({ maxBytes, maxFiles }) {
  return maxBytes + (maxFiles + 2) * HEADER_ROOM + 1024 * 1024;
}

/** The largest bounded archive, compressed: maxBytes and 1 MiB for headers. */
export function maxCompressedBytes({ maxBytes }) {
  return maxBytes + 1024 * 1024;
}

function validPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    Buffer.byteLength(path) <= MAX_PATH &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function sizeOf(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${bytes} bytes`;
}

// =============================================================================
// Packing
// =============================================================================

/**
 * /mnt/data (`root`) as a gzipped tar, within `limits`. Returns the archive
 * and what it holds; throws ArchiveLimitError over a bound.
 */
export async function packWorkspace(root, limits) {
  const blocks = [];
  let bytes = 0;
  let entries = 0;
  let skipped = 0;

  const count = () => {
    if (++entries > limits.maxFiles) {
      throw new ArchiveLimitError(
        `/mnt/data has more than ${limits.maxFiles} files, directories and links, the most that is kept`,
      );
    }
  };

  async function walk(dir, prefix) {
    for (const name of (await readdir(dir)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(dir, name);
      if (!validPath(path)) throw new ArchiveInvalidError(`cannot keep ${JSON.stringify(path)}: the name is not allowed`);
      const info = await lstat(full);
      const mode = info.mode & 0o777;
      if (info.isSymbolicLink()) {
        count();
        blocks.push(...entryHeader({ path, type: "2", mode: 0o777, size: 0, mtime: info.mtime, linkpath: await readlink(full) }));
      } else if (info.isDirectory()) {
        if (path.startsWith(".browser/") && BROWSER_CACHES.has(name)) continue;
        count();
        blocks.push(...entryHeader({ path: `${path}/`, type: "5", mode, size: 0, mtime: info.mtime }));
        await walk(full, path);
      } else if (info.isFile()) {
        count();
        bytes += info.size;
        if (bytes > limits.maxBytes) {
          throw new ArchiveLimitError(`/mnt/data holds more than ${sizeOf(limits.maxBytes)} of files, the most that is kept`);
        }
        const data = await readExactly(full, info.size);
        blocks.push(...entryHeader({ path, type: "0", mode, size: data.length, mtime: info.mtime }), data, padding(data.length));
      } else {
        skipped++; // a socket, FIFO or device: nothing to keep
      }
    }
  }

  await walk(root, "");
  blocks.push(Buffer.alloc(2 * BLOCK));
  const archive = await gzip(Buffer.concat(blocks));
  if (archive.length > maxCompressedBytes(limits)) {
    throw new ArchiveLimitError(`/mnt/data compresses to more than ${sizeOf(maxCompressedBytes(limits))}, the most that is kept`);
  }
  return { archive, files: entries, bytes, skipped };
}

/** A regular file's bytes, refusing one that changes size or type while it is read. */
async function readExactly(path, size) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== size) throw new ArchiveInvalidError(`${path} changed while it was archived`);
    const data = Buffer.alloc(size + 1);
    let read = 0;
    while (read < data.length) {
      const { bytesRead } = await file.read(data, read, data.length - read, null);
      if (!bytesRead) break;
      read += bytesRead;
    }
    if (read !== size) throw new ArchiveInvalidError(`${path} changed while it was archived`);
    return data.subarray(0, size);
  } finally {
    await file.close();
  }
}

function padding(size) {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** One entry's header blocks: a pax header first when the name or link target doesn't fit ustar. */
function entryHeader({ path, type, mode, size, mtime, linkpath = "" }) {
  const out = [];
  const pax = [];
  if (Buffer.byteLength(path) > 100) pax.push(paxRecord("path", path));
  if (Buffer.byteLength(linkpath) > 100) pax.push(paxRecord("linkpath", linkpath));
  if (pax.length) {
    const body = Buffer.concat(pax);
    out.push(ustarHeader({ name: "PaxHeader", type: "x", mode: 0o644, size: body.length, mtime }), body, padding(body.length));
  }
  out.push(ustarHeader({ name: truncateUtf8(path, 100), type, mode, size, mtime, linkpath: truncateUtf8(linkpath, 100) }));
  return out;
}

/** A pax record: "<length> <key>=<value>\n", where the length counts itself. */
function paxRecord(key, value) {
  const rest = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(rest) + 1;
  while (String(length).length + Buffer.byteLength(rest) !== length) length++;
  return Buffer.from(`${length}${rest}`);
}

function truncateUtf8(text, max) {
  const bytes = Buffer.from(text);
  return bytes.length <= max ? text : bytes.subarray(0, max).toString("utf8").replace(/�$/, "");
}

function ustarHeader({ name, type, mode, size, mtime, linkpath = "" }) {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8");
  header.write(octal(mode, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(size, 12), 124, "ascii");
  header.write(octal(Math.max(0, Math.floor(mtime.getTime() / 1000)), 12), 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write(type, 156, "ascii");
  header.write(linkpath, 157, 100, "utf8");
  header.write("ustar\u000000", 257, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, "ascii");
  return header;
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\u0000`;
}

// =============================================================================
// Unpacking
// =============================================================================

/**
 * Replace the contents of /mnt/data (`root`) with a gzipped tar, within
 * `limits`. `archive` null empties it. The whole archive is checked first:
 * an invalid one (ArchiveInvalidError) or one over a bound
 * (ArchiveLimitError) changes nothing.
 */
export async function unpackWorkspace(root, archive, limits) {
  const entries = archive === null ? [] : await readEntries(archive, limits);
  for (const name of await readdir(root)) await rm(join(root, name), { recursive: true, force: true });
  const depth = (e) => e.path.split("/").length;
  const dirs = entries.filter((e) => e.kind === "dir");
  for (const e of [...dirs].sort((a, b) => depth(a) - depth(b))) await mkdir(join(root, e.path), { mode: 0o700 });
  for (const e of entries.filter((e) => e.kind === "file")) {
    const path = join(root, e.path);
    await writeFile(path, e.data, { mode: e.mode, flag: "wx" });
    await chmod(path, e.mode);
    await utimes(path, e.mtime, e.mtime);
  }
  for (const e of entries.filter((e) => e.kind === "link")) await symlink(e.target, join(root, e.path));
  for (const e of [...dirs].sort((a, b) => depth(b) - depth(a))) await chmod(join(root, e.path), e.mode);
  const bytes = entries.reduce((n, e) => n + (e.data?.length ?? 0), 0);
  return { files: entries.length, bytes };
}

/** Every entry of a gzipped tar, checked, or a throw. */
async function readEntries(archive, limits) {
  const cap = maxArchiveBytes(limits);
  if (!Buffer.isBuffer(archive)) throw new ArchiveInvalidError("the archive must be bytes");
  if (archive.length > maxCompressedBytes(limits)) {
    throw new ArchiveLimitError(`the archive is larger than ${sizeOf(maxCompressedBytes(limits))}`);
  }
  let tar;
  try {
    tar = await gunzip(archive, { maxOutputLength: cap });
  } catch (err) {
    if (err?.code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
      throw new ArchiveLimitError(`the archive unpacks to more than ${sizeOf(cap)}`);
    }
    throw new ArchiveInvalidError(`the archive is not gzip: ${err?.message ?? err}`);
  }

  const entries = [];
  const byPath = new Map();
  let bytes = 0;
  let pax = {};
  let longName;
  let longLink;
  for (let offset = 0; ; ) {
    if (offset + BLOCK > tar.length) throw new ArchiveInvalidError("the archive ends early");
    const header = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header.every((b) => b === 0)) break;
    checkChecksum(header);
    const type = String.fromCharCode(header[156] || 0x30);
    const size = readOctal(header, 124, 12);
    if (offset + size > tar.length) throw new ArchiveInvalidError("the archive ends early");
    const data = tar.subarray(offset, offset + size);
    offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);

    // Headers that describe the next entry.
    if (type === "x") {
      pax = { ...pax, ...parsePax(data) };
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = cString(data);
      continue;
    }
    if (type === "K") {
      longLink = cString(data);
      continue;
    }

    let name = pax.path ?? longName ?? headerName(header);
    const linkTarget = pax.linkpath ?? longLink ?? cString(header.subarray(157, 257));
    pax = {};
    longName = longLink = undefined;
    name = name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (name === "" || name === ".") continue; // the root itself

    const kind = { "0": "file", "7": "file", "5": "dir", "2": "link" }[type];
    if (!kind) {
      const what = { "1": "a hard link", "3": "a character device", "4": "a block device", "6": "a FIFO" }[type] ?? `type ${JSON.stringify(type)}`;
      throw new ArchiveInvalidError(`${JSON.stringify(name)} is ${what}, which is not kept`);
    }
    if (!validPath(name) || byPath.has(name)) throw new ArchiveInvalidError(`the archive has an invalid or repeated path: ${JSON.stringify(name)}`);
    if (entries.length + 1 > limits.maxFiles) {
      throw new ArchiveLimitError(`the archive has more than ${limits.maxFiles} files, directories and links`);
    }
    const mode = readOctal(header, 100, 8) & 0o777;
    const entry = { path: name, kind, mode, mtime: new Date(readOctal(header, 136, 12) * 1000) };
    if (kind === "link") {
      if (!linkTarget || linkTarget.includes("\0") || Buffer.byteLength(linkTarget) > MAX_PATH) {
        throw new ArchiveInvalidError(`${JSON.stringify(name)} links to an invalid target`);
      }
      entry.target = linkTarget;
    } else if (kind === "file") {
      bytes += size;
      if (bytes > limits.maxBytes) throw new ArchiveLimitError(`the archive holds more than ${sizeOf(limits.maxBytes)} of files`);
      entry.data = data;
    }
    entries.push(entry);
    byPath.set(name, entry);
  }

  // Every parent must be a directory in the archive, so nothing is written through a link.
  for (const e of entries) {
    for (let parent = dirname(e.path); parent !== "."; parent = dirname(parent)) {
      if (byPath.get(parent)?.kind !== "dir") {
        throw new ArchiveInvalidError(`the parent of ${JSON.stringify(e.path)} is not a directory in the archive`);
      }
    }
  }
  return entries;
}

function checkChecksum(header) {
  const stored = readOctal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  if (sum !== stored) throw new ArchiveInvalidError("the archive has a corrupt header");
}

function headerName(header) {
  const name = cString(header.subarray(0, 100));
  const ustar = header.subarray(257, 262).toString("ascii") === "ustar";
  const prefix = ustar ? cString(header.subarray(345, 500)) : "";
  return prefix ? `${prefix}/${name}` : name;
}

function cString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function readOctal(header, offset, width) {
  const field = header.subarray(offset, offset + width);
  // GNU base-256 for large numbers: the first byte has its high bit set.
  if (field[0] & 0x80) throw new ArchiveInvalidError("the archive has a number too large to keep");
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveInvalidError("the archive has a corrupt header");
  return parseInt(text, 8);
}

function parsePax(data) {
  const out = {};
  for (let at = 0; at < data.length; ) {
    const space = data.indexOf(0x20, at);
    const length = Number(data.subarray(at, space).toString("ascii"));
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0 || at + length > data.length) {
      throw new ArchiveInvalidError("the archive has a corrupt pax header");
    }
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return out;
}

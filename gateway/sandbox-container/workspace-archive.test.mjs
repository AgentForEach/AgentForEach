/**
 * Bounded archives of /mnt/data (workspace-archive.mjs): what survives a
 * round trip, and that an archive over a bound or with anything unsafe in it
 * is refused whole, before the disk is touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  ArchiveInvalidError,
  ArchiveLimitError,
  archiveLimitsFromEnv,
  packWorkspace,
  unpackWorkspace,
} from "./workspace-archive.mjs";

const LIMITS = { maxBytes: 1024 * 1024, maxFiles: 100 };

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), "afe-archive-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** A gzipped tar of hand-made entries: [{name, type, data?, linkname?, mode?}]. */
function tarOf(entries) {
  const blocks = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    const header = Buffer.alloc(512);
    header.write(e.name, 0, 100);
    header.write(`${(e.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(e.type ?? "0", 156);
    header.write(e.linkname ?? "", 157, 100);
    header.write("ustar\u000000", 257);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test("a round trip keeps binary files, permissions, empty directories, symlinks, long and unicode names", async (t) => {
  const a = await dir(t);
  const b = await dir(t);
  const long = `${"deep/".repeat(30)}név-${"x".repeat(120)}.txt`;
  await mkdir(join(a, "empty"));
  await mkdir(join(a, "deep/".repeat(30)), { recursive: true });
  await writeFile(join(a, long), "long name");
  await writeFile(join(a, "run"), Buffer.from([0, 1, 255, 13]), { mode: 0o751 });
  await writeFile(join(a, "shared"), "data");
  await chmod(join(a, "shared"), 0o666);
  await symlink("run", join(a, "link"));
  await symlink("/etc/hosts", join(a, "outside"));

  const made = await packWorkspace(a, LIMITS);
  assert.equal(made.bytes, 4 + 4 + Buffer.byteLength("long name"));
  await writeFile(join(b, "stale.txt"), "replaced");
  await unpackWorkspace(b, made.archive, LIMITS);

  assert.deepEqual(await readFile(join(b, "run")), Buffer.from([0, 1, 255, 13]));
  assert.equal((await stat(join(b, "run"))).mode & 0o777, 0o751);
  assert.equal((await stat(join(b, "shared"))).mode & 0o777, 0o666);
  assert.ok((await stat(join(b, "empty"))).isDirectory());
  assert.equal(await readlink(join(b, "link")), "run");
  assert.equal(await readlink(join(b, "outside")), "/etc/hosts", "a link is kept as it was, never followed");
  assert.equal(await readFile(join(b, long), "utf8"), "long name");
  assert.ok(!(await readdir(b)).includes("stale.txt"), "unpacking replaces the folder's contents");
});

test("the archive is a tar any tar reads, and an archive made by tar unpacks", { skip: spawnSync("tar", ["--version"]).status !== 0 && "no tar" }, async (t) => {
  const a = await dir(t);
  const b = await dir(t);
  const c = await dir(t);
  await mkdir(join(a, "sub"));
  await writeFile(join(a, "sub", `${"n".repeat(150)}.txt`), "via pax");
  const made = await packWorkspace(a, LIMITS);
  const extracted = spawnSync("tar", ["-xzf", "-", "-C", b], { input: made.archive });
  assert.equal(extracted.status, 0, String(extracted.stderr));
  assert.equal(await readFile(join(b, "sub", `${"n".repeat(150)}.txt`), "utf8"), "via pax");

  const byTar = spawnSync("tar", ["-czf", "-", "-C", a, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  assert.equal(byTar.status, 0, String(byTar.stderr));
  await unpackWorkspace(c, byTar.stdout, LIMITS);
  assert.equal(await readFile(join(c, "sub", `${"n".repeat(150)}.txt`), "utf8"), "via pax");
});

test("packing over a bound fails whole: too many bytes, too many entries", async (t) => {
  const root = await dir(t);
  await writeFile(join(root, "big"), Buffer.alloc(2048));
  await assert.rejects(packWorkspace(root, { maxBytes: 2047, maxFiles: 10 }), ArchiveLimitError);
  await writeFile(join(root, "a"), "1");
  await writeFile(join(root, "b"), "2");
  await assert.rejects(packWorkspace(root, { maxBytes: 1e6, maxFiles: 2 }), (err) => err instanceof ArchiveLimitError && err.code === "archive_limit");
  assert.equal((await packWorkspace(root, { maxBytes: 2050, maxFiles: 3 })).files, 3);
});

test("sockets and FIFOs are left out of an archive; Chromium's caches too", { skip: process.platform === "win32" }, async (t) => {
  const root = await dir(t);
  await writeFile(join(root, "kept.txt"), "kept");
  assert.equal(spawnSync("mkfifo", [join(root, "pipe")]).status, 0);
  await mkdir(join(root, ".browser", "profile", "Default", "Cache"), { recursive: true });
  await writeFile(join(root, ".browser", "profile", "Default", "Cache", "blob"), Buffer.alloc(4096));
  await writeFile(join(root, ".browser", "profile", "Default", "Cookies"), "cookies");
  const made = await packWorkspace(root, LIMITS);
  assert.equal(made.skipped, 1);
  const out = await dir(t);
  await unpackWorkspace(out, made.archive, LIMITS);
  assert.deepEqual((await readdir(out)).sort(), [".browser", "kept.txt"]);
  assert.equal(await readFile(join(out, ".browser", "profile", "Default", "Cookies"), "utf8"), "cookies");
  assert.ok(!(await readdir(join(out, ".browser", "profile", "Default"))).includes("Cache"));
});

test("unpacking refuses unsafe archives before touching the folder", async (t) => {
  const root = await dir(t);
  await writeFile(join(root, "safe"), "keep");
  const unsafe = {
    traversal: [{ name: "../escape", data: "x" }],
    absolute: [{ name: "/etc/escape", data: "x" }],
    "through a link": [
      { name: "link", type: "2", linkname: "/tmp" },
      { name: "link/escape", data: "x" },
    ],
    "no parent directory": [{ name: "missing/child", data: "x" }],
    repeated: [
      { name: "same/", type: "5" },
      { name: "same", data: "x" },
    ],
    "hard link": [{ name: "a", data: "x" }, { name: "b", type: "1", linkname: "a" }],
    FIFO: [{ name: "pipe", type: "6" }],
    device: [{ name: "dev", type: "3" }],
    backslash: [{ name: "a\\b", data: "x" }],
    "empty link target": [{ name: "nowhere", type: "2", linkname: "" }],
  };
  for (const [what, entries] of Object.entries(unsafe)) {
    await assert.rejects(unpackWorkspace(root, tarOf(entries), LIMITS), ArchiveInvalidError, what);
  }
  await assert.rejects(unpackWorkspace(root, Buffer.from("not gzip"), LIMITS), ArchiveInvalidError);
  assert.deepEqual(await readdir(root), ["safe"]);
  assert.equal(await readFile(join(root, "safe"), "utf8"), "keep");
});

test("unpacking over a bound is refused: bytes, entries, and a decompression bomb", async (t) => {
  const root = await dir(t);
  await writeFile(join(root, "safe"), "keep");
  const small = { maxBytes: 100, maxFiles: 2 };
  await assert.rejects(unpackWorkspace(root, tarOf([{ name: "big", data: "x".repeat(101) }]), small), ArchiveLimitError);
  await assert.rejects(
    unpackWorkspace(root, tarOf([{ name: "a", data: "1" }, { name: "b", data: "2" }, { name: "c", data: "3" }]), small),
    ArchiveLimitError,
  );
  // 64 MiB of zeros gzips to about 64 KiB: the cap stops it while decompressing.
  const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
  await assert.rejects(unpackWorkspace(root, bomb, small), ArchiveLimitError);
  assert.equal(await readFile(join(root, "safe"), "utf8"), "keep");
});

test("null empties the folder; limits come from the environment, unset means unbounded", async (t) => {
  const root = await dir(t);
  await writeFile(join(root, "gone"), "x");
  await unpackWorkspace(root, null, LIMITS);
  assert.deepEqual(await readdir(root), []);

  assert.equal(archiveLimitsFromEnv({}), undefined);
  assert.deepEqual(archiveLimitsFromEnv({ SANDBOX_ARCHIVE_MAX_BYTES: "1000", SANDBOX_ARCHIVE_MAX_FILES: "5" }), { maxBytes: 1000, maxFiles: 5 });
  assert.deepEqual(archiveLimitsFromEnv({ SANDBOX_ARCHIVE_MAX_FILES: "5" }), { maxBytes: 64 * 1024 * 1024, maxFiles: 5 });
  assert.throws(() => archiveLimitsFromEnv({ SANDBOX_ARCHIVE_MAX_BYTES: "lots" }), /positive integer/);
});

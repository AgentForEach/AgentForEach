/**
 * The browser's side of archiving /mnt/data (server.mjs's /archive), so a
 * sandbox restored from an archive keeps the user's logins:
 *
 *   - before an archive is made, the running browser driver saves its
 *     storage through Playwright (cookies, localStorage and IndexedDB, in
 *     /mnt/data/.browser/storage-state.json; POST /checkpoint on the driver),
 *     then Chromium's process tree is stopped (SIGSTOP) while the archive is
 *     read, so its profile, write-ahead logs included, is read in one
 *     consistent state, and resumed after (SIGCONT, always);
 *   - before an archive replaces /mnt/data, a running browser is stopped,
 *     since its profile is about to change under it;
 *   - after, a flag tells the driver's next start to load the saved storage.
 *
 * It is not a checkpoint of the page's JavaScript memory: open tabs reload.
 * Only the authenticated driver's own process tree (its pid from
 * daemon.json, checked against /proc and the driver's /ping) is signalled.
 * Without a running driver, or off Linux, each step does nothing.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A process from /proc/<pid>/stat: its state, parent and start time (so a reused pid isn't mistaken for it). */
async function processInfo(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { pid, state: fields[0], ppid: Number(fields[1]), started: fields[19] };
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ESRCH") return undefined;
    throw err;
  }
}

/** Signal `p` if it is still the same process; false when it is gone. */
async function signal(p, sig) {
  const current = await processInfo(p.pid);
  if (!current || current.started !== p.started || current.state === "Z") return false;
  try {
    process.kill(p.pid, sig);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    throw err;
  }
}

export function createBrowserCheckpoint({
  dataDir = "/mnt/data",
  runDir = process.env.AFE_BROWSER_RUN_DIR ?? "/tmp/afe-browser",
} = {}) {
  /** The running driver, checked three ways (state file, /proc, its /ping), or undefined. */
  async function driver() {
    let state;
    try {
      state = JSON.parse(await readFile(join(runDir, "daemon.json"), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return undefined;
      throw new Error("The browser's state file is unreadable");
    }
    const { pid, port, token } = state ?? {};
    if (!Number.isInteger(pid) || pid <= 1 || !Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== "string") {
      throw new Error("The browser's state file is invalid");
    }
    const p = await processInfo(pid);
    if (!p || p.state === "Z") return undefined;
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    if (!cmdline.split("\0").some((arg) => arg.endsWith("/browser/driver.mjs"))) return undefined;
    const response = await fetch(`http://127.0.0.1:${port}/ping`, {
      headers: { "x-afe-token": token },
      signal: AbortSignal.timeout(3000),
    });
    const pong = await response.json().catch(() => ({}));
    if (!response.ok || !pong.ok || pong.pid !== pid) throw new Error("The browser driver did not answer as expected");
    return { process: p, port, token };
  }

  async function children(parents) {
    const all = await Promise.all(
      (await readdir("/proc")).filter((name) => /^\d+$/.test(name)).map((name) => processInfo(Number(name))),
    );
    return all.filter((p) => p && parents.has(p.ppid) && !parents.has(p.pid));
  }

  /** Run `take` (which reads /mnt/data) with the browser's storage saved and its processes stopped. */
  async function snapshot(take) {
    const d = await driver();
    if (!d) return take();
    const saved = await fetch(`http://127.0.0.1:${d.port}/checkpoint`, {
      method: "POST",
      headers: { "x-afe-token": d.token },
      signal: AbortSignal.timeout(30_000),
    });
    if (!saved.ok || !(await saved.json().catch(() => ({}))).ok) throw new Error("The browser could not save its storage");
    const stopped = new Map();
    try {
      // Parents first, then their children: a stopped process can't fork.
      let next = [d.process];
      for (let depth = 0; next.length; depth++) {
        if (depth > 32 || stopped.size > 512) throw new Error("The browser has too many processes to stop");
        for (const p of next) if (await signal(p, "SIGSTOP")) stopped.set(p.pid, p);
        for (let attempt = 0; ; attempt++) {
          const states = await Promise.all([...stopped.values()].map((p) => processInfo(p.pid)));
          if (states.every((p) => !p || ["T", "t", "Z"].includes(p.state))) break;
          if (attempt === 99) throw new Error("The browser did not stop");
          await sleep(10);
        }
        next = await children(new Set(stopped.keys()));
      }
      return await take();
    } finally {
      for (const p of [...stopped.values()].reverse()) await signal(p, "SIGCONT");
    }
  }

  /** Stop a running browser before its profile is replaced. */
  async function beforeRestore() {
    const d = await driver().catch(() => undefined);
    if (!d) return;
    await signal(d.process, "SIGTERM");
    for (let i = 0; i < 100; i++) {
      const p = await processInfo(d.process.pid);
      if (!p || p.started !== d.process.started || p.state === "Z") return;
      await sleep(50);
    }
    throw new Error("The browser must stop before its profile is replaced");
  }

  /** Tell the driver's next start to load the storage saved in the archive, if it has any. */
  async function afterRestore() {
    if (!existsSync(join(dataDir, ".browser", "storage-state.json"))) return;
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await writeFile(join(runDir, "restore-storage"), "v1", { mode: 0o600 });
  }

  return { snapshot, beforeRestore, afterRestore };
}

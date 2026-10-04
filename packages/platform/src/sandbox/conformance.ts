/**
 * Sandbox conformance suite: what every `SandboxBackend` must do, run with
 * node:test against a real backend (ACA Sandboxes, Cloudflare Containers, the
 * sandbox server run locally...).
 *
 * ```ts
 * import { runSandboxConformance } from "@agentforeach/platform/sandbox/conformance";
 *
 * runSandboxConformance({
 *   name: "aca-sandboxes (live)",
 *   createBackend: () => new AcaSandboxesClient(config),
 *   sleep: (backend, identifier) => stopSandbox(identifier),
 *   egress: { echoHost: "postman-echo.com" },
 * });
 * ```
 *
 * Checks that need something only the caller can provide are skipped without
 * it: `sleep` (put a sandbox to sleep, for persistence) and `egress` (an
 * echo host the sandbox may reach, for egress and credential injection).
 * Checks gated by a capability run only when the backend declares it.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { SandboxBackend } from "./types.js";

export type SandboxConformanceOptions = {
  /** Shown in the suite name. */
  name: string;
  createBackend: () => SandboxBackend | Promise<SandboxBackend>;
  /**
   * Put the sandbox `identifier` to sleep the way the backend does when idle
   * (suspend, or snapshot and stop), so the next call wakes it. Without it
   * the persistence check is skipped.
   */
  sleep?: (backend: SandboxBackend, identifier: string) => Promise<void>;
  /**
   * Egress checks. `echoHost` must answer `GET https://<host>/headers` with
   * the request headers it received (postman-echo.com does) and must not be
   * reachable until a credential names it; `blockedUrl` must never be
   * reachable. Without it the egress checks are skipped.
   */
  egress?: { echoHost: string; blockedUrl?: string };
  /** Per-test timeout in ms. Default 300000 (cold starts can be slow). */
  timeoutMs?: number;
  /**
   * The directory commands start in, for a sandbox identifier. Default
   * "/mnt/data", as every real backend has; only a sandbox server run
   * outside a container differs.
   */
  dataDir?: (identifier: string) => string;
};

export function runSandboxConformance(options: SandboxConformanceOptions): void {
  const timeout = options.timeoutMs ?? 300_000;
  const userId = `conformance-${randomUUID().slice(0, 12)}`;

  describe(`sandbox conformance: ${options.name}`, { timeout: timeout * 20 }, () => {
    let backend: SandboxBackend;
    let id: string;

    before(async () => {
      backend = await options.createBackend();
      id = backend.resolveIdentifier(userId);
    });

    after(async () => {
      if (backend && backend.capabilities.persistence !== "none") {
        await backend.deleteUserSandboxes(userId).catch(() => undefined);
      }
    });

    it("is ready and declares its capabilities", { timeout }, () => {
      assert.equal(backend.isReady(), true);
      const { browser, egressCredentials, persistence } = backend.capabilities;
      assert.equal(typeof browser, "boolean");
      assert.equal(typeof egressCredentials, "boolean");
      assert.ok(["none", "disk", "memory"].includes(persistence), `persistence: ${persistence}`);
      assert.equal(typeof id, "string");
      assert.ok(id.length > 0);
    });

    it("exec: exit codes, stdout and stderr apart, quoting intact", { timeout }, async () => {
      const ok = await backend.exec({ command: "echo out; echo err >&2" }, id);
      assert.equal(ok.exitCode, 0);
      assert.equal(ok.stdout.trim(), "out");
      assert.equal(ok.stderr.trim(), "err");
      assert.equal(ok.timedOut, false);
      assert.equal(ok.sessionId, id);
      assert.equal((await backend.exec({ command: "exit 3" }, id)).exitCode, 3);
      const tricky = `printf '%s|' "a'b" 'c"d' '$HOME' '\`x\`' 'back\\slash'`;
      assert.equal((await backend.exec({ command: tricky }, id)).stdout, `a'b|c"d|$HOME|\`x\`|back\\slash|`);
    });

    it("exec: runs in /mnt/data, and a command past its timeout reports timedOut", { timeout }, async () => {
      assert.equal((await backend.exec({ command: "pwd -P" }, id)).stdout.trim(), options.dataDir?.(id) ?? "/mnt/data");
      const slow = await backend.exec({ command: "sleep 30", timeout: 3 }, id);
      assert.equal(slow.timedOut, true);
      assert.ok(slow.durationMs < 25_000, `took ${slow.durationMs} ms`);
    });

    it("files: write, list, read, read as binary; exec sees them; a missing file fails", { timeout }, async () => {
      await backend.fileWrite({ filename: "notes.txt", content: "héllo sandbox" }, id);
      await backend.fileWrite({ filename: "sub/dir/deep.txt", content: "deep" }, id);
      const list = await backend.fileList(id);
      const notes = list.find((f) => f.filename === "notes.txt");
      assert.ok(notes, `list: ${JSON.stringify(list)}`);
      assert.equal(notes.size, Buffer.byteLength("héllo sandbox"));
      assert.ok(!Number.isNaN(Date.parse(notes.lastModified)), `lastModified: ${notes.lastModified}`);
      assert.ok(!list.some((f) => f.filename === "sub"), "directories are not files");
      assert.equal((await backend.fileRead({ filename: "notes.txt" }, id)).content, "héllo sandbox");
      const binary = await backend.fileReadBinary({ filename: "notes.txt" }, id);
      assert.equal(Buffer.from(binary.contentBase64, "base64").toString(), "héllo sandbox");
      assert.equal(binary.sizeBytes, Buffer.byteLength("héllo sandbox"));
      assert.equal((await backend.exec({ command: "cat notes.txt sub/dir/deep.txt" }, id)).stdout, "héllo sandboxdeep");
      await assert.rejects(backend.fileRead({ filename: "nope.txt" }, id), /404|not found/i);
    });

    it("env: setEnv reaches commands and replaces the whole set", { timeout }, async () => {
      await backend.setEnv({ API_KEY: "s3cr'et value", OTHER: "x" }, id);
      assert.equal((await backend.exec({ command: 'printf %s "$API_KEY"' }, id)).stdout, "s3cr'et value");
      await backend.setEnv({ OTHER: "y" }, id);
      const after = await backend.exec({ command: 'printf %s "${API_KEY:-unset}/$OTHER"' }, id);
      assert.equal(after.stdout, "unset/y", "a var left out of the new set is gone");
    });

    it("egress credentials: refused without the capability", { timeout }, async (t) => {
      if (backend.capabilities.egressCredentials) return t.skip("backend injects credentials");
      await assert.rejects(backend.setEgressCredentials([], id));
    });

    it("egress: deny by default; a credential is added outside the sandbox and can be cleared", { timeout }, async (t) => {
      if (!options.egress) return t.skip("no egress options");
      if (!backend.capabilities.egressCredentials) return t.skip("backend has no egress proxy");
      const { echoHost, blockedUrl } = options.egress;
      const status = async (url: string) =>
        (await backend.exec({ command: `curl -sS -m 15 -o /dev/null -w '%{http_code}' ${url} || echo blocked` }, id)).stdout;
      if (blockedUrl) assert.notEqual((await status(blockedUrl)).slice(0, 1), "2", `${blockedUrl} is reachable`);

      const secret = `secret-${randomUUID().slice(0, 8)}`;
      await backend.setEgressCredentials(
        [{ key: "ECHO_TOKEN", hosts: [echoHost], header: "Authorization", value: `Bearer ${secret}` }],
        id,
      );
      await backend.setEnv({ ECHO_TOKEN: "placeholder" }, id);
      const echo = await backend.exec(
        {
          command:
            `curl -sS -m 20 -H "Authorization: Bearer $ECHO_TOKEN" https://${echoHost}/headers; echo; ` +
            `grep -rsl "${secret}" /root /home /tmp /mnt /etc /var/tmp 2>/dev/null | head -1 || true`,
        },
        id,
      );
      assert.ok(echo.stdout.toLowerCase().includes(`bearer ${secret}`), `upstream did not get the credential: ${echo.stdout}`);
      assert.ok(!echo.stdout.trim().split("\n").at(-1)?.startsWith("/"), "the secret is on the sandbox's disk");

      await backend.setEgressCredentials([], id);
      assert.notEqual((await status(`https://${echoHost}/headers`)).slice(0, 1), "2", "host still reachable after clearing");
    });

    it("persistence: files and env survive sleep", { timeout }, async (t) => {
      if (backend.capabilities.persistence === "none") return t.skip("sandboxes keep nothing");
      if (!options.sleep) return t.skip("no sleep() given");
      await backend.fileWrite({ filename: "kept.txt", content: "still here" }, id);
      await backend.setEnv({ KEPT: "env too" }, id);
      await options.sleep(backend, id);
      assert.equal((await backend.fileRead({ filename: "kept.txt" }, id)).content, "still here");
      assert.equal((await backend.exec({ command: 'printf %s "$KEPT"' }, id)).stdout, "env too");
    });

    it("deleteUserSandboxes removes the user's sandboxes and their files", { timeout }, async (t) => {
      if (backend.capabilities.persistence === "none") {
        assert.equal(await backend.deleteUserSandboxes(userId), 0);
        return;
      }
      await backend.fileWrite({ filename: "doomed.txt", content: "x" }, id);
      assert.ok((await backend.deleteUserSandboxes(userId)) >= 1);
      // The next call gets a new, empty sandbox.
      const fresh = await backend.exec({ command: "ls doomed.txt 2>/dev/null || echo gone" }, id);
      assert.equal(fresh.stdout.trim(), "gone");
      t.diagnostic("a new sandbox was created after deletion");
    });
  });
}

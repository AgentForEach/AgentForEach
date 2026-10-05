import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("the documented AWS image command pushes one ARM64 image and prints only its digest", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afe-aws-image-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls");
  const digest = `sha256:${"a".repeat(64)}`;
  // Exercise the real shell entry; the fake CLIs prevent any Docker or AWS operation.
  writeFileSync(join(dir, "aws"), `#!/bin/sh
printf 'aws %s\\n' "$*" >> "$IMAGE_CALLS"
case "$2" in
  get-login-password) echo fixture-password ;;
  describe-images) echo "${digest}" ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$IMAGE_CALLS"
[ "$1" != login ] || cat >/dev/null
echo fixture-build-output
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, IMAGE_CALLS: log, IMAGE_PLATFORMS: "linux/arm64" };
  const script = fileURLToPath(new URL("../build-aws-sandbox.sh", import.meta.url));
  const args = [script, "123456789012.dkr.ecr.us-west-2.amazonaws.com/sandbox", "fixture"];
  assert.equal(execFileSync("bash", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(), digest);
  const calls = readFileSync(log, "utf8");
  assert.match(calls, /docker buildx build --platform linux\/arm64 /);
  assert.match(calls, /--provenance=false/);
  const invalid = spawnSync("bash", args, { env: { ...env, IMAGE_PLATFORMS: "linux/arm64,linux/amd64" }, encoding: "utf8" });
  assert.notEqual(invalid.status, 0, "a multi-arch index must be refused before pushing to AgentCore");
  assert.equal(readFileSync(log, "utf8"), calls, "invalid image settings make no AWS or Docker calls");
});

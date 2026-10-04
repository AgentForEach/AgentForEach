/**
 * Trusting the sandbox egress proxy's CA in Chromium.
 *
 * A backend whose egress proxy re-signs TLS (ACA Sandboxes, Cloudflare
 * Containers) writes its CA into the sandbox at boot, so it can rotate.
 * Chromium on Linux trusts its NSS store, not the system bundle, so the
 * driver imports the CA there on every start. The backend says where its CA
 * is with SANDBOX_EGRESS_CA (one path, or several separated by ":"); without
 * it, ACA Sandboxes' path is used, as before.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where ACA Sandboxes' egress proxy writes its CA (the default). */
export const ACA_EGRESS_CA = "/etc/ssl/certs/adc-egress-proxy-ca.crt";

/** The CA files the backend declared (SANDBOX_EGRESS_CA), or ACA Sandboxes' path. */
export function egressCaPaths(setting = process.env.SANDBOX_EGRESS_CA) {
  const declared = String(setting ?? "")
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean);
  return declared.length ? declared : [ACA_EGRESS_CA];
}

/**
 * Import every certificate in the CA files that exist into the NSS store
 * under `home` (~/.pki/nssdb), replacing earlier copies. Returns how many
 * were imported. `run` runs certutil (injectable for tests).
 */
export function trustEgressCa({
  paths = egressCaPaths(),
  home = homedir(),
  workDir,
  run = (args) => execFileSync("certutil", args, { stdio: "ignore" }),
} = {}) {
  const pems = paths
    .filter((path) => existsSync(path))
    .flatMap((path) => readFileSync(path, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []);
  if (pems.length === 0) return 0;
  const dir = join(home, ".pki", "nssdb");
  const db = `sql:${dir}`;
  mkdirSync(dir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  if (!existsSync(join(dir, "cert9.db"))) run(["-d", db, "-N", "--empty-password"]);
  pems.forEach((pem, i) => {
    const nick = `sandbox-egress-ca-${i}`;
    const file = join(workDir, `${nick}.pem`);
    writeFileSync(file, `${pem}\n`);
    try {
      run(["-d", db, "-D", "-n", nick]);
    } catch {
      // not there yet
    }
    run(["-d", db, "-A", "-t", "C,,", "-n", nick, "-i", file]);
  });
  return pems.length;
}

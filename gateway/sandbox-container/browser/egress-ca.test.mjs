/**
 * The driver trusts the egress CA wherever the backend declares it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ACA_EGRESS_CA, egressCaPaths, trustEgressCa } from "./egress-ca.mjs";

const PEM = (n) => `-----BEGIN CERTIFICATE-----\nMIIB${n}\n-----END CERTIFICATE-----`;

test("the CA path comes from SANDBOX_EGRESS_CA; without it, ACA Sandboxes' path", () => {
  assert.deepEqual(egressCaPaths("/etc/cloudflare/certs/cloudflare-containers-ca.crt"), ["/etc/cloudflare/certs/cloudflare-containers-ca.crt"]);
  assert.deepEqual(egressCaPaths("/a.crt: /b.crt"), ["/a.crt", "/b.crt"]);
  assert.deepEqual(egressCaPaths(undefined), [ACA_EGRESS_CA]);
  assert.deepEqual(egressCaPaths(""), [ACA_EGRESS_CA]);
});

test("every certificate in the declared CA file is imported into Chromium's NSS store (live run)", () => {
  const root = mkdtempSync(join(tmpdir(), "afe-ca-"));
  try {
    const ca = join(root, "cloudflare-containers-ca.crt");
    writeFileSync(ca, `${PEM("A")}\n${PEM("B")}\n`);
    const calls = [];
    const imported = trustEgressCa({ paths: [ca, join(root, "missing.crt")], home: root, workDir: join(root, "run"), run: (args) => calls.push(args) });
    assert.equal(imported, 2);
    const db = `sql:${join(root, ".pki", "nssdb")}`;
    assert.deepEqual(calls[0], ["-d", db, "-N", "--empty-password"], "the store is created first");
    const adds = calls.filter((args) => args.includes("-A"));
    assert.deepEqual(adds.map((args) => args[args.indexOf("-n") + 1]), ["sandbox-egress-ca-0", "sandbox-egress-ca-1"]);
    assert.ok(adds.every((args) => args.includes("C,,")), "trusted to sign server certificates");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no CA file, no store and no certutil calls", () => {
  const calls = [];
  assert.equal(trustEgressCa({ paths: ["/nonexistent/ca.crt"], home: tmpdir(), workDir: tmpdir(), run: (args) => calls.push(args) }), 0);
  assert.equal(calls.length, 0);
});

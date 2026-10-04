import test from "node:test";
import assert from "node:assert/strict";

import { allowEntryMatches, egressDecision, hostMatches, localTarget, type SandboxEgressProps } from "./egress-policy.js";

const closed: SandboxEgressProps = { allowHosts: ["pypi.org", "*.pythonhosted.org"], internet: false, credentials: [] };

test("hosts match exactly, or as subdomains of a *. pattern", () => {
  assert.equal(hostMatches("pypi.org", "pypi.org"), true);
  assert.equal(hostMatches("PyPI.org.", "pypi.org"), true);
  assert.equal(hostMatches("evilpypi.org", "pypi.org"), false);
  assert.equal(hostMatches("files.pythonhosted.org", "*.pythonhosted.org"), true);
  assert.equal(hostMatches("pythonhosted.org", "*.pythonhosted.org"), false, "the bare domain is not a subdomain");
  assert.equal(hostMatches("evilpythonhosted.org", "*.pythonhosted.org"), false);
});

test("deny by default; listed hosts allowed; open egress allows everything", () => {
  assert.equal(egressDecision(new URL("https://pypi.org/simple"), closed).allowed, true);
  assert.equal(egressDecision(new URL("https://files.pythonhosted.org/x"), closed).allowed, true);
  const denied = egressDecision(new URL("https://example.com/"), closed);
  assert.equal(denied.allowed, false);
  assert.match(denied.allowed ? "" : denied.reason, /example\.com\/ is not allowed/);
  assert.equal(egressDecision(new URL("http://example.com/"), { ...closed, internet: true }).allowed, true);
});

test("a credential adds its header for its hosts only, and opens those hosts", () => {
  const props: SandboxEgressProps = {
    ...closed,
    credentials: [{ key: "GH", hosts: ["api.github.com"], header: "Authorization", value: "Bearer s3cret" }],
  };
  assert.deepEqual(egressDecision(new URL("https://api.github.com/user"), props), {
    allowed: true,
    headers: [["Authorization", "Bearer s3cret"]],
  });
  assert.deepEqual(egressDecision(new URL("https://pypi.org/"), props), { allowed: true, headers: [] }, "no header elsewhere");
  assert.equal(egressDecision(new URL("https://api.github.com.evil.example/"), props).allowed, false);
});

test("credentials go only over https to port 443 (review S-L2)", () => {
  const props: SandboxEgressProps = {
    allowHosts: [],
    internet: false,
    credentials: [{ key: "GH", hosts: ["api.github.com"], header: "Authorization", value: "Bearer s3cret" }],
  };
  assert.deepEqual(egressDecision(new URL("https://api.github.com/user"), props), {
    allowed: true,
    headers: [["Authorization", "Bearer s3cret"]],
  });
  assert.equal(egressDecision(new URL("http://api.github.com/user"), props).allowed, false, "plain http: no credential, not opened");
  assert.equal(egressDecision(new URL("https://api.github.com:8443/user"), props).allowed, false, "another port: no credential");
  const open: SandboxEgressProps = { ...props, internet: true };
  assert.deepEqual(egressDecision(new URL("http://api.github.com/"), open), { allowed: true, headers: [] }, "open egress, but no credential over http");
});

test("allowlisted hosts only on ports 80 and 443", () => {
  const props: SandboxEgressProps = { allowHosts: ["pypi.org"], internet: false, credentials: [] };
  assert.equal(egressDecision(new URL("https://pypi.org/simple"), props).allowed, true);
  assert.equal(egressDecision(new URL("http://pypi.org:80/simple"), props).allowed, true);
  assert.equal(egressDecision(new URL("https://pypi.org:8443/"), props).allowed, false);
});

test("a host/path entry allows only that path on the host: the relay, not the rest of the gateway (review S-L3)", () => {
  const props: SandboxEgressProps = { allowHosts: ["gw.example.workers.dev/realtime/relay"], internet: false, credentials: [] };
  assert.equal(egressDecision(new URL("https://gw.example.workers.dev/realtime/relay?hub=x"), props).allowed, true);
  assert.equal(egressDecision(new URL("https://gw.example.workers.dev/realtime/relay/abc"), props).allowed, true);
  assert.equal(egressDecision(new URL("https://gw.example.workers.dev/api/chat"), props).allowed, false);
  assert.equal(egressDecision(new URL("https://gw.example.workers.dev/realtime/relayish"), props).allowed, false);
  assert.equal(allowEntryMatches(new URL("https://other.dev/realtime/relay"), "gw.example.workers.dev/realtime/relay"), false);
});

test("a WebSocket upgrade never carries credentials, and a credential doesn't open its host to one (independent review)", () => {
  const props: SandboxEgressProps = {
    allowHosts: ["gw.example.workers.dev/realtime/relay"],
    internet: false,
    credentials: [{ key: "GH", hosts: ["api.github.com"], header: "Authorization", value: "Bearer s3cret" }],
  };
  const socket = { websocket: true };
  assert.equal(egressDecision(new URL("https://api.github.com/socket"), props, socket).allowed, false, "opened only by its credential: refused");
  assert.deepEqual(egressDecision(new URL("https://gw.example.workers.dev/realtime/relay"), props, socket), { allowed: true, headers: [] }, "the relay needs none");
  const open: SandboxEgressProps = { ...props, internet: true };
  assert.deepEqual(egressDecision(new URL("https://api.github.com/socket"), open, socket), { allowed: true, headers: [] }, "open egress, but no credential");
  assert.deepEqual(
    egressDecision(new URL("https://api.github.com/user"), props),
    { allowed: true, headers: [["Authorization", "Bearer s3cret"]] },
    "plain requests still get it",
  );
});

test("local and private targets are refused even with open egress or an allowlist entry (live run)", () => {
  const open: SandboxEgressProps = { allowHosts: ["10.0.0.5", "printer.local"], internet: true, credentials: [] };
  for (const url of [
    "http://127.0.0.1:8080/",
    "http://10.0.0.5/",
    "http://172.16.3.4/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/",
    "http://2130706433/", // 127.0.0.1 as one number, normalised by URL parsing
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::119:1]/",
    "http://[fe80::1]/",
    "http://localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/",
  ]) {
    const decision = egressDecision(new URL(url), open);
    assert.equal(decision.allowed, false, url);
    assert.match(decision.allowed ? "" : decision.reason, /local name|local or private address/, url);
  }
  assert.equal(egressDecision(new URL("https://93.184.215.14/"), open).allowed, true, "a public literal is fine");
  assert.equal(egressDecision(new URL("http://[2606:4700::1111]/"), open).allowed, true);
  assert.equal(localTarget("example.com"), null);
});

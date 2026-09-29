import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { blockedAddressReason, checkUrl, readBodyText, safeFetch, SsrfBlockedError } from "./safe-fetch.js";

// ============================================================================
// Classification
// ============================================================================

test("private, loopback, link-local, CGNAT and reserved addresses are blocked", () => {
  for (const ip of [
    "127.0.0.2",
    "10.1.2.3",
    "100.64.0.1",
    "0.1.2.3",
    "169.254.169.254",
    "172.20.0.1",
    "192.168.1.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:7f00:1", // IPv4-mapped 127.0.0.1
    "::ffff:a9fe:a9fe", // IPv4-mapped 169.254.169.254
    "::7f00:1", // IPv4-compatible 127.0.0.1
    "2002:7f00:1::", // 6to4 of 127.0.0.1
    "2001:0:4136:e378::1", // Teredo
    "168.63.129.16", // Azure platform
  ]) {
    assert.ok(blockedAddressReason(ip), ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(blockedAddressReason(ip), null, ip);
  }
});

test("URL checks catch the forms that fooled the old guards", () => {
  for (const url of [
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://2130706433/", // decimal 127.0.0.1
    "http://0x7f.1/", // hex/short form
    "http://[fe80::1]/",
    "http://metadata.google.internal/",
    "http://printer.local/",
    "http://user:pass@example.com/",
    "file:///etc/passwd",
    "ftp://example.com/",
  ]) {
    assert.equal(checkUrl(url).ok, false, url);
  }
  assert.equal(checkUrl("https://example.com/page").ok, true);
});

// ============================================================================
// Connect-time DNS guard
// ============================================================================

test("a hostname that resolves to an internal address is refused", async () => {
  await assert.rejects(
    safeFetch("http://evil.test/", { resolver: async () => [{ address: "127.0.0.1", family: 4 }] }),
    (err: Error) => err instanceof SsrfBlockedError || (err.cause as Error) instanceof SsrfBlockedError,
  );
});

test("a mix of public and private answers (DNS rebinding) is refused", async () => {
  await assert.rejects(
    safeFetch("http://rebind.test/", {
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    }),
    (err: Error) => err instanceof SsrfBlockedError || (err.cause as Error) instanceof SsrfBlockedError,
  );
});

// ============================================================================
// Redirects (real local servers; only loopback is let through for the test)
// ============================================================================

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const allowLoopback = (ip: string) => (ip === "127.0.0.1" ? null : blockedAddressReason(ip));

test("each redirect hop is re-validated", async () => {
  const origin = await serve((_req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
  });
  await assert.rejects(safeFetch(`${origin}/`, { isBlockedAddress: allowLoopback }), SsrfBlockedError);
});

test("caller headers are dropped when a redirect changes origin", async () => {
  const target = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.headers));
  });
  const origin = await serve((_req, res) => res.writeHead(302, { location: `${target}/echo` }).end());

  const res = await safeFetch(`${origin}/`, {
    headers: { "x-api-key": "secret" },
    isBlockedAddress: allowLoopback,
  });
  const received = (await res.json()) as Record<string, string>;
  assert.equal(received["x-api-key"], undefined);
});

test("303 turns a POST into a GET without a body", async () => {
  let seen = "";
  const target = await serve((req, res) => {
    seen = req.method ?? "";
    res.end("ok");
  });
  const origin = await serve((_req, res) => res.writeHead(303, { location: `${target}/done` }).end());
  await safeFetch(`${origin}/`, { method: "POST", body: "x", isBlockedAddress: allowLoopback });
  assert.equal(seen, "GET");
});

test("redirect loops stop at maxRedirects", async () => {
  const origin = await serve((_req, res) => res.writeHead(302, { location: "/again" }).end());
  await assert.rejects(
    safeFetch(`${origin}/`, { maxRedirects: 3, isBlockedAddress: allowLoopback }),
    /Too many redirects/,
  );
});

test("a request body is never re-sent to another origin (307/308)", async () => {
  let reached = false;
  const target = await serve((_req, res) => {
    reached = true;
    res.end("ok");
  });
  const origin = await serve((_req, res) => res.writeHead(307, { location: `${target}/collect` }).end());
  await assert.rejects(
    safeFetch(`${origin}/`, { method: "POST", body: "token=secret", isBlockedAddress: allowLoopback }),
    SsrfBlockedError,
  );
  assert.equal(reached, false);
});

test("readBodyText stops at the byte cap without buffering the rest", async () => {
  let sent = 0;
  const big = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    const chunk = "x".repeat(64 * 1024);
    const write = () => {
      while (sent < 50 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once("drain", write);
      }
      res.end();
    };
    write();
  });
  const res = await safeFetch(`${big}/`, { isBlockedAddress: allowLoopback });
  const { text, truncated } = await readBodyText(res, 100_000);
  assert.equal(truncated, true);
  assert.equal(text.length, 100_000);
  assert.ok(sent < 50 * 1024 * 1024, "the server was not read to the end");
});

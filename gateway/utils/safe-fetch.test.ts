import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { blockedAddressReason, checkUrl, fetchTransport, installSafeFetchTransport, readBodyText, safeFetch, safeFetchTransport, SsrfBlockedError, mappedIPv4 } from "./safe-fetch.js";
// As the Node entry point does: the tests below run on the undici transport,
// and the fetch transport (Cloudflare Workers) has its own tests at the end.
import { nodeTransport } from "./safe-fetch-node.js";

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

// ============================================================================
// Transports
// ============================================================================

test("importing the Node transport installs it, as the Azure entry point does", () => {
  assert.equal(safeFetchTransport().name, "node");
});

test("a Node caller that never imports the Node transport still gets it, on first use", async () => {
  // A fresh process, importing safe-fetch.ts the way an embedder's createAgentClient does.
  const { execFile } = await import("node:child_process");
  const server = (await import("node:http")).createServer((_req, res) => res.end("reached"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const script = `
    const m = await import(${JSON.stringify(new URL("./safe-fetch.js", import.meta.url).href)});
    const before = m.safeFetchTransport().name;
    // Only the undici transport connects through this resolver; plain fetch would ask the system DNS.
    const res = await m.safeFetch("http://app.invalid:${port}/", {
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      isBlockedAddress: () => null,
    });
    console.log(JSON.stringify({ before, body: await res.text() }));`;
  try {
    const out = await new Promise<string>((resolve, reject) =>
      execFile(process.execPath, ["--input-type=module", "-e", script], (err, stdout, stderr) =>
        err ? reject(new Error(stderr || err.message)) : resolve(stdout),
      ),
    );
    assert.deepEqual(JSON.parse(out), { before: "node", body: "reached" });
  } finally {
    server.close();
  }
});

/** Run `body` on the fetch-only transport (Cloudflare Workers), then go back. */
async function onFetchTransport(body: () => Promise<void>): Promise<void> {
  installSafeFetchTransport(fetchTransport);
  try {
    await body();
  } finally {
    installSafeFetchTransport(nodeTransport);
  }
}

const blocked = (err: Error) => err instanceof SsrfBlockedError || (err.cause as Error) instanceof SsrfBlockedError;

test("fetch transport: a hostname resolving to an internal address is refused before any request", async () => {
  await onFetchTransport(async () => {
    let asked = 0;
    await assert.rejects(
      safeFetch("http://evil.test/", {
        resolver: async () => {
          asked++;
          return [{ address: "127.0.0.1", family: 4 }];
        },
      }),
      blocked,
    );
    assert.equal(asked, 1, "the guard's resolver was consulted");
  });
});

test("fetch transport: a mix of public and private answers (DNS rebinding) is refused", async () => {
  await onFetchTransport(async () => {
    await assert.rejects(
      safeFetch("http://rebind.test/", {
        resolver: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
      }),
      blocked,
    );
  });
});

test("fetch transport: a hostname with no answers fails as not found, not as allowed", async () => {
  await onFetchTransport(async () => {
    await assert.rejects(safeFetch("http://nowhere.test/", { resolver: async () => [] }), /no addresses for nowhere\.test/);
  });
});

test("fetch transport: requests go out, redirects are still followed by hand and re-validated", async () => {
  await onFetchTransport(async () => {
    let hits = 0;
    const target = await serve((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/plain" }).end("landed");
    });
    const hop = await serve((_req, res) => res.writeHead(302, { location: `${target}/next` }).end());
    const res = await safeFetch(`${hop}/`, { isBlockedAddress: allowLoopback });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "landed");
    assert.equal(hits, 1);

    const toMetadata = await serve((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    });
    await assert.rejects(safeFetch(`${toMetadata}/`, { isBlockedAddress: allowLoopback }), SsrfBlockedError);
  });
});

test("an IPv4-mapped address is checked as the IPv4 address it maps, in any spelling", () => {
  // workerd's BlockList lets the expanded spellings through, so the guard doesn't rely on it.
  for (const ip of ["::ffff:10.0.0.1", "::ffff:a00:1", "0:0:0:0:0:ffff:a00:1", "0000:0000:0000:0000:0000:ffff:0a00:0001", "0:0:0:0:0:ffff:10.0.0.1"]) {
    assert.equal(mappedIPv4(ip), "10.0.0.1", ip);
    assert.match(blockedAddressReason(ip) ?? "", /private IP/, ip);
  }
  assert.equal(mappedIPv4("0:0:0:0:0:FFFF:7f00:1"), "127.0.0.1");
  assert.match(blockedAddressReason("0:0:0:0:0:ffff:a9fe:a9fe") ?? "", /metadata/);
  assert.equal(blockedAddressReason("0:0:0:0:0:ffff:808:808"), null, "a public IPv4 stays allowed");
  for (const ip of ["::1", "2606:4700::1111", "::ffff:0:a00:1", "1:0:0:0:0:ffff:a00:1", "10.0.0.1", "fe80::1%eth0"]) {
    assert.equal(mappedIPv4(ip), undefined, ip);
  }
});

test("a SIIT-translated address is refused in any spelling, without reaching the BlockList", () => {
  for (const ip of ["::ffff:0:7f00:1", "::ffff:0:a9fe:a9fe", "::ffff:0:127.0.0.1", "0:0:0:0:ffff:0:a00:1", "0000:0000:0000:0000:FFFF:0000:0a00:0001"]) {
    assert.match(blockedAddressReason(ip) ?? "", /SIIT/, ip);
  }
});

test("an address the lists can't check is refused with a reason, never thrown", () => {
  // As workerd's BlockList does on some IPv6 spellings.
  const throwing = { check: () => { throw new TypeError("Invalid IP address: Invalid IPv4 address"); } };
  const reason = blockedAddressReason("2606:4700::1111", { metadata: throwing, blocked: throwing });
  assert.match(reason ?? "", /couldn't be checked \(Invalid IP address/);
});

test("where the Node transport can't be loaded (a single-file bundle), requests fall back to fetch, with a warning", async () => {
  const { loadNodeTransport } = await import("./safe-fetch.js");
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    assert.equal(await loadNodeTransport("./not-bundled.js"), fetchTransport);
  } finally {
    console.warn = original;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0]!, /couldn't be loaded, so requests use the fetch transport/);
  assert.equal((await loadNodeTransport()).name, "node", "where it exists, it loads");
});

test("Bun and Deno get the fetch transport, which checks before every hop", async () => {
  const { execFile } = await import("node:child_process");
  const url = new URL("./safe-fetch.js", import.meta.url).href;
  const transportUnder = (runtime: string) =>
    new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        ["--input-type=module", "-e", `Object.defineProperty(process.versions, ${JSON.stringify(runtime)}, { value: "1.0.0" });
          const m = await import(${JSON.stringify(url)}); console.log(m.safeFetchTransport().name);`],
        (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())),
      ),
    );
  assert.equal(await transportUnder("bun"), "fetch");
  assert.equal(await transportUnder("deno"), "fetch");
});

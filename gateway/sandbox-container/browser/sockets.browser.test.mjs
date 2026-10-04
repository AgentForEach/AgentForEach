/**
 * guardPageSockets in a real Chromium: a page's WebSocket to a credential
 * host is closed before its handshake, as is one to a local host, while
 * other sockets work. Playwright's context.route never sees WebSockets.
 *
 * Needs playwright-core and its Chromium (skipped otherwise). The driver's
 * own node_modules is used when installed; PLAYWRIGHT_CORE points at another
 * copy, e.g. PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.mjs.
 * CI's browser-guard job sets BROWSER_TEST_REQUIRED=1, so a missing browser
 * fails there instead of skipping.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";

import { guardPageSockets } from "./guard.mjs";

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core"));
} catch {
  chromium = undefined;
}
const missing = !chromium ? "playwright-core is not installed" : !existsSync(chromium.executablePath()) ? "Chromium is not installed" : false;
if (missing && process.env.BROWSER_TEST_REQUIRED) throw new Error(`BROWSER_TEST_REQUIRED is set, but ${missing}`);
const skip = missing;

/** A minimal WebSocket server: completes the handshake and sends "hello". */
async function helloSocketServer() {
  const handshakes = [];
  const sockets = new Set();
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<p>test page</p>"));
  server.on("upgrade", (req, socket) => {
    handshakes.push(req.headers.host);
    sockets.add(socket);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.from([0x81, 5, ...Buffer.from("hello")])); // one unmasked text frame
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return { port: server.address().port, handshakes, close };
}

/** What a page's `new WebSocket(url)` ends with: the first message, or how it closed. */
function openSocket(page, url) {
  return page.evaluate(
    (target) =>
      new Promise((resolve) => {
        const ws = new WebSocket(target);
        ws.onmessage = (event) => resolve(`message:${event.data}`);
        ws.onclose = (event) => resolve(`closed:${event.code}`);
        setTimeout(() => resolve("timeout"), 5000);
      }),
    url,
  );
}

test("a page can't open a WebSocket to a credential host or a local host (independent review)", { skip }, async () => {
  const server = await helloSocketServer();
  // Both names resolve to the local server, so the guard is what tells them apart.
  const browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP credentialed.example.test 127.0.0.1, MAP open.example.test 127.0.0.1`],
  });
  try {
    const context = await browser.newContext();
    await guardPageSockets(context, { protectedHosts: () => ["credentialed.example.test"] });
    const page = await context.newPage();
    // An http page: with a WebSocket route installed, Playwright can't pass an
    // unmatched socket through from about:blank or data: pages (they fail closed).
    await page.goto(`http://open.example.test:${server.port}/`);

    assert.equal(await openSocket(page, `ws://open.example.test:${server.port}/`), "message:hello", "an ordinary socket works");
    assert.equal(server.handshakes.length, 1);

    assert.match(await openSocket(page, `ws://credentialed.example.test:${server.port}/`), /^closed:/);
    assert.match(await openSocket(page, `ws://127.0.0.1:${server.port}/`), /^closed:/);
    assert.equal(server.handshakes.length, 1, "neither blocked socket reached the server");
  } finally {
    await browser.close();
    await server.close();
  }
});

test(
  "a WebSocket from a page's Web Worker to a credential host is closed",
  {
    skip,
    todo: "known gap: Playwright's WebSocket route isn't injected into workers (docs/Browser.md, Security); closed on Cloudflare by the egress handler",
  },
  async () => {
    const server = await helloSocketServer();
    const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP credentialed.example.test 127.0.0.1, MAP open.example.test 127.0.0.1`] });
    try {
      const context = await browser.newContext();
      await guardPageSockets(context, { protectedHosts: () => ["credentialed.example.test"] });
      const page = await context.newPage();
      await page.goto(`http://open.example.test:${server.port}/`);
      const fromWorker = await page.evaluate(
        (target) =>
          new Promise((resolve) => {
            const source = `const ws = new WebSocket(${JSON.stringify(target)}); ws.onmessage = (e) => postMessage("message:" + e.data); ws.onclose = (e) => postMessage("closed:" + e.code);`;
            const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
            worker.onmessage = (event) => resolve(event.data);
            setTimeout(() => resolve("timeout"), 5000);
          }),
        `ws://credentialed.example.test:${server.port}/`,
      );
      assert.match(fromWorker, /^closed:/);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

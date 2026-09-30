/**
 * The browser driver's URL guard and bot-wall detection (no browser needed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { blockedAddress, checkUrl, checkUrlResolved, explainError, hostMatches, isCardNumber, isTransientNetError, looksBlocked, maskCardNumbers, parseViewerInput, truncate } from "./guard.mjs";

test("checkUrl allows public http and https URLs", () => {
  for (const url of ["https://example.com/a?b=c", "http://en.wikipedia.org/wiki/Azure", "https://93.184.215.14/"]) {
    assert.equal(checkUrl(url).ok, true, url);
  }
});

test("checkUrl refuses other schemes, credentials and local hosts", () => {
  for (const url of [
    "file:///etc/passwd",
    "chrome://settings",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:pw@example.com/",
    "http://localhost:9333/action",
    "http://LOCALHOST./",
    "http://printer.local/",
    "http://metadata.google.internal/",
    "not a url",
  ]) {
    assert.equal(checkUrl(url).ok, false, url);
  }
});

test("checkUrl refuses loopback, private, link-local and CGNAT literals in every spelling", () => {
  for (const url of [
    "http://127.0.0.1:9333/ping",
    "http://2130706433/", // 127.0.0.1 as one number
    "http://0x7f.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://10.0.0.4/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/metadata",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
  ]) {
    assert.equal(checkUrl(url).ok, false, url);
  }
});

test("blockedAddress lets public addresses through", () => {
  assert.equal(blockedAddress("93.184.215.14"), null);
  assert.equal(blockedAddress("2606:2800:220:1:248:1893:25c8:1946"), null);
  assert.equal(blockedAddress("168.63.129.16"), null, "public; the sandbox egress already blocks it");
});

test("checkUrlResolved refuses a public name that resolves to a private address", async () => {
  const toLoopback = async () => [{ address: "127.0.0.1", family: 4 }];
  const r = await checkUrlResolved("https://localtest.me/", toLoopback);
  assert.equal(r.ok, false);
  assert.match(r.reason, /localtest\.me resolves to 127\.0\.0\.1/);

  const mixed = async () => [{ address: "93.184.215.14", family: 4 }, { address: "10.1.2.3", family: 4 }];
  assert.equal((await checkUrlResolved("https://example.com/", mixed)).ok, false);
});

test("checkUrlResolved leaves DNS failures for the browser to report", async () => {
  const fails = async () => {
    throw new Error("ENOTFOUND");
  };
  assert.equal((await checkUrlResolved("https://no-such-host.example/", fails)).ok, true);
});

test("looksBlocked spots bot walls seen on real sites", () => {
  assert.equal(looksBlocked({ status: 403, title: "", text: "" }), true, "empty 403");
  assert.equal(looksBlocked({ status: 200, title: "Just a moment..." }), true, "Cloudflare");
  assert.equal(looksBlocked({ status: 403, title: "Access Denied" }), true, "Akamai");
  assert.equal(looksBlocked({ status: 429, title: "Too Many Requests" }), true);
  assert.equal(
    looksBlocked({ status: 200, title: "", text: "You've been blocked by network security. To continue, log in" }),
    true,
    "Reddit answers 200",
  );
  assert.equal(
    looksBlocked({ status: undefined, title: "DuckDuckGo", text: "Unfortunately, bots use DuckDuckGo too. Please complete the following challenge" }),
    true,
    "DuckDuckGo after a form submit",
  );
});

test("looksBlocked leaves ordinary pages alone", () => {
  assert.equal(looksBlocked({ status: 200, title: "Hacker News", text: "Hacker News new | past | comments" }), false);
  assert.equal(looksBlocked({ status: 503, title: "Service Unavailable", text: "" }), false);
  assert.equal(looksBlocked({ status: undefined, title: "Search - Microsoft Bing" }), false);
  assert.equal(
    looksBlocked({ status: 403, title: "Sign in", text: "x".repeat(1000) }),
    false,
    "a 403 that is a real page (a login form) isn't a wall",
  );
});

test("isTransientNetError matches only errors worth one retry", () => {
  assert.equal(isTransientNetError("page.goto: net::ERR_CONNECTION_CLOSED at https://x/"), true);
  assert.equal(isTransientNetError("net::ERR_CERT_AUTHORITY_INVALID"), false);
  assert.equal(isTransientNetError("net::ERR_NAME_NOT_RESOLVED"), false);
});

test("truncate says how much it cut, and cuts at a line break when it can", () => {
  assert.deepEqual(truncate("abc", 5), { text: "abc", truncated: false });
  assert.match(truncate("abcdefgh", 3).text, /^abc\n… \[truncated, 5 more characters\]$/);
  const lines = "line one\nline two\nline three";
  const cut = truncate(lines, 20, "use query");
  assert.match(cut.text, /^line one\nline two\n… \[truncated, 11 more characters: use query\]$/);
});

test("hostMatches follows the skills' host patterns", () => {
  assert.equal(hostMatches("api.github.com", "api.github.com"), true);
  assert.equal(hostMatches("API.GitHub.com.", "api.github.com"), true);
  assert.equal(hostMatches("raw.githubusercontent.com", "*.githubusercontent.com"), true);
  assert.equal(hostMatches("githubusercontent.com", "*.githubusercontent.com"), false);
  assert.equal(hostMatches("evilgithubusercontent.com", "*.githubusercontent.com"), false);
  assert.equal(hostMatches("github.com", "api.github.com"), false);
});

test("explainError keeps the reason Playwright gives", () => {
  const covered =
    "locator.click: Timeout 15000ms exceeded.\nCall log:\n  - <div class=\"consent\">…</div> intercepts pointer events\n";
  assert.match(explainError(covered), /^Timeout 15000ms exceeded\. Something on the page covers this element/);
  assert.match(explainError("locator.fill: Malformed value\n"), /HH:MM/);
  assert.match(explainError("locator.click: Timeout 1ms exceeded."), /Take a snapshot/);
  assert.equal(explainError("page.goto: net::ERR_NAME_NOT_RESOLVED at https://x/"), "net::ERR_NAME_NOT_RESOLVED at https://x/");
});

test("parseViewerInput accepts only the handoff's user", () => {
  const msg = (fromUserId, data) => ({ type: "message", from: "group", group: "bh-x", fromUserId, dataType: "json", data });
  assert.deepEqual(parseViewerInput(msg("alice", { kind: "hello" }), "alice"), { kind: "hello" });
  assert.equal(parseViewerInput(msg("mallory", { kind: "text", text: "hi" }), "alice"), null, "another user");
  assert.equal(parseViewerInput(msg(undefined, { kind: "text", text: "hi" }), "alice"), null, "anonymous");
  assert.equal(parseViewerInput({ type: "message", from: "server", fromUserId: "alice", data: { kind: "done" } }, "alice"), null);
  assert.equal(parseViewerInput(msg("alice", { kind: "hello" }), ""), null, "no viewer configured");
});

test("parseViewerInput narrows mouse, key and text input", () => {
  const msg = (data) => ({ type: "message", from: "group", fromUserId: "alice", data });
  assert.deepEqual(parseViewerInput(msg({ kind: "mouse", type: "down", x: 10, y: 20, button: "right" }), "alice"),
    { kind: "mouse", type: "down", x: 10, y: 20, button: "right" });
  assert.deepEqual(parseViewerInput(msg({ kind: "mouse", type: "wheel", x: 1, y: 1, deltaY: 120, extra: "x" }), "alice"),
    { kind: "mouse", type: "wheel", x: 1, y: 1, button: "left", deltaX: 0, deltaY: 120 });
  assert.equal(parseViewerInput(msg({ kind: "mouse", type: "down", x: -5, y: 1 }), "alice"), null);
  assert.equal(parseViewerInput(msg({ kind: "mouse", type: "teleport", x: 1, y: 1 }), "alice"), null);
  assert.deepEqual(parseViewerInput(msg({ kind: "key", type: "down", key: "Enter" }), "alice"), { kind: "key", type: "down", key: "Enter" });
  assert.deepEqual(parseViewerInput(msg({ kind: "key", type: "down", key: "é" }), "alice"), { kind: "key", type: "down", key: "é" });
  assert.deepEqual(parseViewerInput(msg({ kind: "key", type: "up", key: " " }), "alice"), { kind: "key", type: "up", key: "Space" });
  assert.equal(parseViewerInput(msg({ kind: "key", type: "down", key: "Control+Shift+I" }), "alice"), null, "no chords");
  assert.equal(parseViewerInput(msg({ kind: "text", text: "x".repeat(2001) }), "alice"), null);
  assert.equal(parseViewerInput(msg({ kind: "eval", js: "1" }), "alice"), null);
});

test("parseViewerInput takes the viewer's heartbeat and dialog answers", () => {
  const msg = (data) => ({ type: "message", from: "group", fromUserId: "alice", data });
  assert.deepEqual(parseViewerInput(msg({ kind: "ping" }), "alice"), { kind: "ping" });
  assert.deepEqual(parseViewerInput(msg({ kind: "dialog", accept: true, text: "x".repeat(600) }), "alice"),
    { kind: "dialog", accept: true, text: "x".repeat(500) });
  assert.deepEqual(parseViewerInput(msg({ kind: "dialog", accept: false }), "alice"), { kind: "dialog", accept: false, text: "" });
  assert.equal(parseViewerInput(msg({ kind: "dialog", accept: "yes" }), "alice"), null);
});

test("card numbers are recognised by Luhn and hidden from text", () => {
  assert.equal(isCardNumber("4111 1111 1111 1111"), true);
  assert.equal(isCardNumber("4242-4242-4242-4242"), true);
  assert.equal(isCardNumber("4111111111111112"), false, "fails Luhn");
  assert.equal(isCardNumber("12345"), false);
  assert.equal(maskCardNumbers('textbox "Card" value="4111 1111 1111 1111"'), 'textbox "Card" value="••••"');
  assert.equal(maskCardNumbers("Order 1234567890123 and card 5555555555554444."), "Order 1234567890123 and card ••••.",
    "an order number that fails Luhn stays");
  assert.equal(maskCardNumbers("Call +91 98765 43210"), "Call +91 98765 43210");
});

/**
 * AgentForEach Link Understanding — Tests
 *
 * Tests the pure-function portions of the link understanding subsystem:
 *   - detectUrls()     — URL detection in message text
 *   - extractContent()  — HTML/text/JSON content extraction
 *   - validateUrl()     — SSRF guard (synchronous URL checks)
 *
 * These are all pure functions with no external dependencies,
 * so no mocking is needed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { detectUrls } from "./detect.js";
import { extractContent } from "./extract.js";
import { validateUrl } from "./ssrf-guard.js";
import type { FetchResult } from "./types.js";

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal FetchResult for extractContent() testing. */
function makeFetchResult(overrides?: Partial<FetchResult>): FetchResult {
  return {
    url: "https://example.com",
    status: 200,
    contentType: "text/html",
    body: "<html><body>Hello</body></html>",
    ok: true,
    ...overrides,
  };
}

// ============================================================================
// Tests — detectUrls()
// ============================================================================

test("detectUrls", async (t) => {
  await t.test("detects a single URL in a message", () => {
    const urls = detectUrls("Check this out https://example.com/article", 3);
    assert.deepEqual(urls, ["https://example.com/article"]);
  });

  await t.test("detects multiple URLs", () => {
    const urls = detectUrls(
      "See https://foo.com and https://bar.com/page for details",
      5,
    );
    assert.deepEqual(urls, ["https://foo.com", "https://bar.com/page"]);
  });

  await t.test("respects maxUrls limit", () => {
    const urls = detectUrls(
      "https://a.com https://b.com https://c.com https://d.com",
      2,
    );
    assert.equal(urls.length, 2);
    assert.deepEqual(urls, ["https://a.com", "https://b.com"]);
  });

  await t.test("deduplicates URLs (case-insensitive)", () => {
    const urls = detectUrls(
      "https://example.com and https://EXAMPLE.COM again",
      5,
    );
    assert.equal(urls.length, 1);
  });

  await t.test("returns empty array when no URLs found", () => {
    assert.deepEqual(detectUrls("No links here!", 3), []);
    assert.deepEqual(detectUrls("", 3), []);
  });

  await t.test("detects http:// URLs (not just https)", () => {
    const urls = detectUrls("Visit http://insecure.site/path", 3);
    assert.deepEqual(urls, ["http://insecure.site/path"]);
  });

  await t.test("skips media URLs (images)", () => {
    const urls = detectUrls(
      "Here is https://example.com/photo.jpg and https://example.com/article",
      5,
    );
    assert.deepEqual(urls, ["https://example.com/article"]);
  });

  await t.test("skips media URLs (video)", () => {
    const urls = detectUrls("Watch https://example.com/video.mp4", 5);
    assert.deepEqual(urls, []);
  });

  await t.test("skips media URLs (audio)", () => {
    const urls = detectUrls("Listen https://example.com/song.mp3", 5);
    assert.deepEqual(urls, []);
  });

  await t.test("cleans trailing punctuation", () => {
    const urls = detectUrls("Visit https://example.com/page.", 3);
    assert.deepEqual(urls, ["https://example.com/page"]);
  });

  await t.test("cleans trailing comma", () => {
    const urls = detectUrls("Go to https://example.com/page, then continue", 3);
    assert.deepEqual(urls, ["https://example.com/page"]);
  });

  await t.test("handles markdown-style link with trailing paren", () => {
    const urls = detectUrls(
      "Check [this](https://example.com/article) out",
      3,
    );
    assert.deepEqual(urls, ["https://example.com/article"]);
  });

  await t.test("stops at closing paren in URL (regex limitation)", () => {
    // The URL regex uses ) as a stop character, so Wikipedia-style
    // URLs with parens get truncated. This is expected behavior.
    const urls = detectUrls(
      "See https://en.wikipedia.org/wiki/Fish_(disambiguation)",
      3,
    );
    assert.equal(urls.length, 1);
    assert.ok(urls[0].startsWith("https://en.wikipedia.org/wiki/Fish_"));
  });

  await t.test("handles URL with query parameters", () => {
    const urls = detectUrls(
      "https://example.com/search?q=hello&lang=en",
      3,
    );
    assert.deepEqual(urls, ["https://example.com/search?q=hello&lang=en"]);
  });

  await t.test("handles URL with fragment", () => {
    const urls = detectUrls("https://example.com/page#section2", 3);
    assert.deepEqual(urls, ["https://example.com/page#section2"]);
  });
});

// ============================================================================
// Tests — extractContent() — Plain Text
// ============================================================================

test("extractContent — plain text", async (t) => {
  await t.test("returns text as-is for text/plain", () => {
    const result = extractContent(
      makeFetchResult({
        contentType: "text/plain",
        body: "Hello, this is plain text content.",
      }),
      6000,
    );
    assert.equal(result.text, "Hello, this is plain text content.");
    assert.equal(result.url, "https://example.com");
    assert.equal(result.title, "example.com"); // domain fallback
    assert.equal(result.description, "");
  });

  await t.test("truncates plain text beyond maxContentChars", () => {
    const longText = "A".repeat(100);
    const result = extractContent(
      makeFetchResult({
        contentType: "text/plain",
        body: longText,
      }),
      50,
    );
    assert.equal(result.text.length, 50);
    assert.ok(result.text.endsWith("..."));
  });

  await t.test("trims whitespace from plain text", () => {
    const result = extractContent(
      makeFetchResult({
        contentType: "text/plain",
        body: "  spaced content  ",
      }),
      6000,
    );
    assert.equal(result.text, "spaced content");
  });
});

// ============================================================================
// Tests — extractContent() — JSON/XML
// ============================================================================

test("extractContent — JSON/XML", async (t) => {
  await t.test("returns JSON body as-is", () => {
    const result = extractContent(
      makeFetchResult({
        contentType: "application/json",
        body: '{"key": "value"}',
      }),
      6000,
    );
    assert.equal(result.text, '{"key": "value"}');
    assert.equal(result.title, "example.com");
  });

  await t.test("returns XML body as-is", () => {
    const result = extractContent(
      makeFetchResult({
        contentType: "application/xml",
        body: "<root><item>data</item></root>",
      }),
      6000,
    );
    assert.equal(result.text, "<root><item>data</item></root>");
  });

  await t.test("handles text/xml content type", () => {
    const result = extractContent(
      makeFetchResult({
        contentType: "text/xml",
        body: "<data>test</data>",
      }),
      6000,
    );
    assert.equal(result.text, "<data>test</data>");
  });
});

// ============================================================================
// Tests — extractContent() — HTML
// ============================================================================

test("extractContent — HTML metadata", async (t) => {
  await t.test("extracts og:title", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><head>
          <meta property="og:title" content="OG Title Here">
        </head><body>Content</body></html>`,
      }),
      6000,
    );
    assert.equal(result.title, "OG Title Here");
  });

  await t.test("falls back to <title> tag when no og:title", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><head><title>Page Title</title></head><body>Content</body></html>`,
      }),
      6000,
    );
    assert.equal(result.title, "Page Title");
  });

  await t.test("falls back to domain when no title at all", () => {
    const result = extractContent(
      makeFetchResult({
        url: "https://example.org/path",
        body: `<html><body>Content</body></html>`,
      }),
      6000,
    );
    assert.equal(result.title, "example.org");
  });

  await t.test("extracts og:description", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><head>
          <meta property="og:description" content="OG description text">
        </head><body>Content</body></html>`,
      }),
      6000,
    );
    assert.equal(result.description, "OG description text");
  });

  await t.test("extracts meta description when no og:description", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><head>
          <meta name="description" content="Meta desc here">
        </head><body>Content</body></html>`,
      }),
      6000,
    );
    assert.equal(result.description, "Meta desc here");
  });

  await t.test("handles reversed attribute order in meta description", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><head>
          <meta content="Reversed desc" name="description">
        </head><body>Content</body></html>`,
      }),
      6000,
    );
    assert.equal(result.description, "Reversed desc");
  });
});

test("extractContent — HTML text extraction", async (t) => {
  await t.test("strips HTML tags", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><body><p>Hello <strong>world</strong></p></body></html>`,
      }),
      6000,
    );
    assert.ok(result.text.includes("Hello"));
    assert.ok(result.text.includes("world"));
    assert.ok(!result.text.includes("<strong>"));
    assert.ok(!result.text.includes("<p>"));
  });

  await t.test("removes script and style elements entirely", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><body>
          <script>alert("evil")</script>
          <style>.foo { color: red; }</style>
          <p>Visible content</p>
        </body></html>`,
      }),
      6000,
    );
    assert.ok(result.text.includes("Visible content"));
    assert.ok(!result.text.includes("alert"));
    assert.ok(!result.text.includes("color"));
  });

  await t.test("removes nav, footer, header, form elements", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><body>
          <nav><a href="/">Home</a></nav>
          <main><p>Main content here</p></main>
          <footer>Footer stuff</footer>
        </body></html>`,
      }),
      6000,
    );
    assert.ok(result.text.includes("Main content here"));
    assert.ok(!result.text.includes("Footer stuff"));
  });

  await t.test("removes HTML comments", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><body><!-- This is a comment --><p>Content</p></body></html>`,
      }),
      6000,
    );
    assert.ok(!result.text.includes("comment"));
    assert.ok(result.text.includes("Content"));
  });

  await t.test("decodes HTML entities", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><body><p>Tom &amp; Jerry &lt;3 &quot;cartoons&quot;</p></body></html>`,
      }),
      6000,
    );
    assert.ok(result.text.includes('Tom & Jerry <3 "cartoons"'));
  });

  await t.test("hostile pages extract in linear time", () => {
    const hostile = [
      "<meta" + ' property="og:title" content="'.repeat(20_000),
      "<meta" + ' name="description" content="'.repeat(20_000),
      "<script>".repeat(50_000),
      "<p".repeat(200_000),
      "<!--".repeat(100_000),
      "<title>".repeat(50_000),
      "<meta ".repeat(100_000),
    ];
    for (const body of hostile) {
      const started = Date.now();
      extractContent(makeFetchResult({ body }), 6000);
      const ms = Date.now() - started;
      assert.ok(ms < 1000, `${body.slice(0, 20)}… (${body.length} chars) took ${ms} ms`);
    }
  });

  await t.test("keeps text around doctypes, stray < and > inside attributes", () => {
    const result = extractContent(
      makeFetchResult({
        body:
          `<!DOCTYPE html><html><head><meta property="og:title" content="A > B"></head>` +
          `<body><p>1 < 2 and 3 > 2</p><SCRIPT>bad()</SCRIPT><p>after</p></body></html>`,
      }),
      6000,
    );
    assert.equal(result.title, "A > B");
    assert.ok(!result.text.includes("DOCTYPE"));
    assert.ok(result.text.includes("1 < 2 and 3 > 2"));
    assert.ok(!result.text.includes("bad()"));
    assert.ok(result.text.includes("after"));
  });

  await t.test("decodes each entity once", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><body><p>Write &amp;lt;b&amp;gt; for bold</p></body></html>`,
      }),
      6000,
    );
    assert.ok(result.text.includes("Write &lt;b&gt; for bold"));
  });

  await t.test("decodes numeric HTML entities", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><body><p>&#39;single&#39; and &#x27;hex&#x27;</p></body></html>`,
      }),
      6000,
    );
    assert.ok(result.text.includes("'single' and 'hex'"));
  });

  await t.test("normalizes excessive whitespace", () => {
    const result = extractContent(
      makeFetchResult({
        body: `<html><body><p>  Lots   of    spaces  </p></body></html>`,
      }),
      6000,
    );
    assert.ok(result.text.includes("Lots of spaces"));
  });

  await t.test("truncates HTML content beyond maxContentChars", () => {
    const bigBody = `<html><body><p>${"Word ".repeat(2000)}</p></body></html>`;
    const result = extractContent(makeFetchResult({ body: bigBody }), 100);
    assert.equal(result.text.length, 100);
    assert.ok(result.text.endsWith("..."));
  });
});

// ============================================================================
// Tests — validateUrl() — SSRF Guard
// ============================================================================

test("validateUrl", async (t) => {
  await t.test("allows valid HTTPS URLs", () => {
    const result = validateUrl("https://example.com/page");
    assert.equal(result.valid, true);
  });

  await t.test("allows valid HTTP URLs", () => {
    const result = validateUrl("http://example.com");
    assert.equal(result.valid, true);
  });

  await t.test("blocks non-HTTP schemes — file://", () => {
    const result = validateUrl("file:///etc/passwd");
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("scheme"));
  });

  await t.test("blocks non-HTTP schemes — ftp://", () => {
    const result = validateUrl("ftp://ftp.example.com");
    assert.equal(result.valid, false);
  });

  await t.test("blocks non-HTTP schemes — javascript:", () => {
    const result = validateUrl("javascript:alert(1)");
    assert.equal(result.valid, false);
  });

  await t.test("blocks invalid URLs", () => {
    const result = validateUrl("not-a-url");
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("Invalid URL"));
  });

  await t.test("blocks localhost", () => {
    const result = validateUrl("https://localhost/admin");
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("localhost"));
  });

  await t.test("blocks localhost.localdomain", () => {
    const result = validateUrl("https://localhost.localdomain/");
    assert.equal(result.valid, false);
  });

  await t.test("blocks cloud metadata endpoint (169.254.169.254)", () => {
    const result = validateUrl("http://169.254.169.254/latest/meta-data/");
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("cloud metadata"));
  });

  await t.test("blocks cloud metadata endpoint (metadata.google.internal)", () => {
    const result = validateUrl(
      "http://metadata.google.internal/computeMetadata/v1/",
    );
    assert.equal(result.valid, false);
  });

  await t.test("blocks private IP — 10.x.x.x", () => {
    const result = validateUrl("http://10.0.0.1/internal");
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes("private IP"));
  });

  await t.test("blocks private IP — 172.16.x.x", () => {
    const result = validateUrl("http://172.16.0.1/");
    assert.equal(result.valid, false);
  });

  await t.test("blocks private IP — 172.31.x.x", () => {
    const result = validateUrl("http://172.31.255.255/");
    assert.equal(result.valid, false);
  });

  await t.test("allows non-private 172.x — 172.15.0.1", () => {
    const result = validateUrl("http://172.15.0.1/");
    assert.equal(result.valid, true);
  });

  await t.test("allows non-private 172.x — 172.32.0.1", () => {
    const result = validateUrl("http://172.32.0.1/");
    assert.equal(result.valid, true);
  });

  await t.test("blocks private IP — 192.168.x.x", () => {
    const result = validateUrl("http://192.168.1.1/");
    assert.equal(result.valid, false);
  });

  await t.test("blocks loopback — 127.0.0.1", () => {
    const result = validateUrl("http://127.0.0.1/");
    assert.equal(result.valid, false);
  });

  await t.test("blocks loopback — 127.x.x.x range", () => {
    const result = validateUrl("http://127.255.0.1/");
    assert.equal(result.valid, false);
  });

  await t.test("blocks link-local — 169.254.x.x", () => {
    const result = validateUrl("http://169.254.1.1/");
    assert.equal(result.valid, false);
  });

  await t.test("blocks 0.0.0.0", () => {
    const result = validateUrl("http://0.0.0.0/");
    assert.equal(result.valid, false);
  });

  await t.test("allows public IP addresses", () => {
    const result = validateUrl("http://8.8.8.8/");
    assert.equal(result.valid, true);
  });

  await t.test("allows public domain names", () => {
    const result = validateUrl("https://www.google.com/search?q=test");
    assert.equal(result.valid, true);
  });
});

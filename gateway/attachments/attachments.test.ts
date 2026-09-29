/**
 * AgentForEach Attachments — Tests
 *
 * Covers classification, validation limits, extraction of each supported
 * format, and the resolution split between images and documents.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { classifyAttachment } from "./detect.js";
import { base64ByteLength, validateAttachments } from "./validate.js";
import {
  extractDocument,
  DocumentExtractionError,
  registerExtractionStrategy,
  resetExtractionStrategies,
} from "./extract.js";
import { analyzeLayout } from "./layout.js";
import { resolveAttachments } from "./index.js";
import { loadAttachmentConfig, resetAttachmentConfig } from "./config.js";
import type { AttachmentConfig, ClassifiedAttachment } from "./types.js";

// ============================================================================
// Fixtures
// ============================================================================

const CONFIG: AttachmentConfig = {
  enabled: true,
  maxAttachments: 4,
  maxImageBytes: 5 * 1024 * 1024,
  maxDocumentBytes: 8 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxDocxExpandedBytes: 40 * 1024 * 1024,
  maxDocumentChars: 20_000,
  maxTotalDocumentChars: 60_000,
  minExtractableChars: 200,
  pdfStrategy: "auto",
  pdfLayoutThreshold: 0.5,
};

/** A 1x1 transparent PNG. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" +
  "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function classified(
  overrides: Partial<ClassifiedAttachment> & { base64: string; mimeType: string },
): ClassifiedAttachment {
  const classification = classifyAttachment(
    overrides.mimeType,
    overrides.fileName,
  );
  assert.ok(classification, "fixture should classify");
  return {
    ...overrides,
    classification,
    byteLength: base64ByteLength(overrides.base64),
  };
}

// ============================================================================
// Classification
// ============================================================================

test("classifies the four provider-safe image types", () => {
  for (const mime of [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]) {
    assert.equal(classifyAttachment(mime)?.kind, "image", mime);
  }
});

test("classifies documents by MIME type", () => {
  assert.equal(classifyAttachment("application/pdf")?.format, "pdf");
  assert.equal(
    classifyAttachment(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )?.format,
    "docx",
  );
  assert.equal(classifyAttachment("text/plain")?.format, "text");
});

test("file extension wins over a vague MIME type", () => {
  // Pickers routinely report .md as text/plain; markdown and plain text want
  // different extractors, so the extension has to win.
  assert.equal(
    classifyAttachment("text/plain", "notes.md")?.format,
    "markdown",
  );
  // .docx arriving as octet-stream must still be recognised.
  assert.equal(
    classifyAttachment("application/octet-stream", "contract.docx")?.format,
    "docx",
  );
});

test("rejects unsupported types", () => {
  assert.equal(classifyAttachment("image/heic", "photo.heic"), null);
  assert.equal(classifyAttachment("application/zip", "bundle.zip"), null);
  assert.equal(classifyAttachment(undefined, undefined), null);
});

// ============================================================================
// Validation
// ============================================================================

test("base64ByteLength matches the real decoded size", () => {
  for (const sample of ["a", "ab", "abc", "abcd", "hello world", "x".repeat(1000)]) {
    const encoded = Buffer.from(sample, "utf8").toString("base64");
    assert.equal(
      base64ByteLength(encoded),
      Buffer.byteLength(sample, "utf8"),
      sample.slice(0, 12),
    );
  }
});

test("accepts a well-formed attachment list", () => {
  const result = validateAttachments(
    [{ mimeType: "image/png", base64: TINY_PNG_BASE64 }],
    CONFIG,
  );
  assert.equal(result.error, undefined);
  assert.equal(result.attachments?.length, 1);
  assert.equal(result.attachments?.[0]?.classification.kind, "image");
});

test("treats a missing attachments field as empty", () => {
  assert.deepEqual(validateAttachments(undefined, CONFIG).attachments, []);
  assert.deepEqual(validateAttachments(null, CONFIG).attachments, []);
});

test("rejects more attachments than the limit", () => {
  const one = { mimeType: "image/png", base64: TINY_PNG_BASE64 };
  const result = validateAttachments(Array(5).fill(one), CONFIG);
  assert.equal(result.error?.code, "attachments_too_many");
  assert.equal(result.error?.statusCode, 400);
});

test("rejects malformed base64", () => {
  const result = validateAttachments(
    [{ mimeType: "image/png", base64: "not!valid!base64" }],
    CONFIG,
  );
  assert.equal(result.error?.code, "attachment_invalid_base64");
});

test("applies a different size limit per kind", () => {
  // 6 MiB of payload: over the 5 MiB image limit, under the 8 MiB doc limit.
  const big = Buffer.alloc(6 * 1024 * 1024, 0x41).toString("base64");

  const asImage = validateAttachments(
    [{ mimeType: "image/png", base64: big }],
    CONFIG,
  );
  assert.equal(asImage.error?.code, "attachment_too_large");
  assert.equal(asImage.error?.statusCode, 413);

  const asDocument = validateAttachments(
    [{ mimeType: "text/plain", base64: big, fileName: "big.txt" }],
    CONFIG,
  );
  assert.equal(asDocument.error, undefined);
});

test("rejects a combined payload over the total cap", () => {
  const seven = Buffer.alloc(7 * 1024 * 1024, 0x41).toString("base64");
  const entry = {
    mimeType: "text/plain",
    base64: seven,
    fileName: "big.txt",
  };
  const result = validateAttachments([entry, entry, entry], CONFIG);
  assert.equal(result.error?.code, "attachments_total_too_large");
});

test("rejects documents when they are disabled", () => {
  const disabled = { ...CONFIG, enabled: false };
  const doc = validateAttachments(
    [{ mimeType: "text/plain", base64: b64("hello"), fileName: "a.txt" }],
    disabled,
  );
  assert.equal(doc.error?.code, "attachment_documents_disabled");

  // Images stay allowed — they don't depend on the extraction pipeline.
  const image = validateAttachments(
    [{ mimeType: "image/png", base64: TINY_PNG_BASE64 }],
    disabled,
  );
  assert.equal(image.error, undefined);
});

// ============================================================================
// Extraction
// ============================================================================

test("extracts plain text", async () => {
  const doc = await extractDocument(
    Buffer.from("Clause 4: The term is 24 months.", "utf8"),
    "text",
    "terms.txt",
    CONFIG,
  );
  assert.match(doc.text, /24 months/);
  assert.equal(doc.format, "text");
  assert.equal(doc.truncated, false);
});

test("strips a UTF-8 BOM", async () => {
  const doc = await extractDocument(
    Buffer.from("﻿Hello", "utf8"),
    "text",
    "bom.txt",
    CONFIG,
  );
  assert.equal(doc.text, "Hello");
});

test("truncates to the character budget and flags it", async () => {
  const doc = await extractDocument(
    Buffer.from("x".repeat(500), "utf8"),
    "text",
    "long.txt",
    { ...CONFIG, maxDocumentChars: 100 },
  );
  assert.equal(doc.charCount, 100);
  assert.equal(doc.truncated, true);
});

test("rejects an empty document", async () => {
  await assert.rejects(
    () => extractDocument(Buffer.from("   ", "utf8"), "text", "blank.txt", CONFIG),
    (error: unknown) =>
      error instanceof DocumentExtractionError && error.code === "empty_document",
  );
});

test("rejects a PDF without a %PDF header", async () => {
  await assert.rejects(
    () =>
      extractDocument(
        Buffer.from("this is definitely not a pdf", "utf8"),
        "pdf",
        "fake.pdf",
        CONFIG,
      ),
    (error: unknown) =>
      error instanceof DocumentExtractionError && error.code === "invalid_pdf",
  );
});

test("rejects a docx that isn't a zip archive", async () => {
  await assert.rejects(
    () =>
      extractDocument(
        Buffer.from("plain text pretending to be docx", "utf8"),
        "docx",
        "fake.docx",
        CONFIG,
      ),
    (error: unknown) =>
      error instanceof DocumentExtractionError && error.code === "invalid_docx",
  );
});

/**
 * Build a zip by hand. `claimedSize` overrides the uncompressed size the
 * headers state, to model an archive that lies about itself.
 */
function buildZip(entries: Array<{ name: string; data: Buffer; claimedSize?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data, claimedSize } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data);
    const size = claimedSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The smallest .docx Mammoth accepts, plus any extra parts. */
function buildDocx(text: string, extra: Array<{ name: string; data: Buffer; claimedSize?: number }> = []): Buffer {
  const xml = (s: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${s}`, "utf8");
  return buildZip([
    {
      name: "[Content_Types].xml",
      data: xml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `</Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: xml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: "word/document.xml",
      data: xml(
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    },
    ...extra,
  ]);
}

test("extracts text from a real docx", async () => {
  const doc = await extractDocument(buildDocx("Clause 4: the term is 24 months."), "docx", "contract.docx", CONFIG);
  assert.match(doc.text, /Clause 4: the term is 24 months\./);
});

test("rejects a docx that expands past the limit, whatever its headers claim", async () => {
  const padding = { name: "word/media/padding.bin", data: Buffer.alloc(48 * 1024 * 1024) };
  for (const bomb of [buildDocx("hi", [padding]), buildDocx("hi", [{ ...padding, claimedSize: 100 }])]) {
    assert.ok(bomb.length < 100 * 1024, "the archive itself is small");
    await assert.rejects(
      () => extractDocument(bomb, "docx", "bomb.docx", CONFIG),
      (error: unknown) => error instanceof DocumentExtractionError && error.code === "docx_too_large",
    );
  }
});

/** Rewrite a zip's end record: entry counts and central-directory size. */
function patchEnd(zip: Buffer, entries: number, centralSize?: number): Buffer {
  const out = Buffer.from(zip);
  const end = out.length - 22;
  out.writeUInt16LE(entries, end + 8);
  out.writeUInt16LE(entries, end + 10);
  if (centralSize !== undefined) out.writeUInt32LE(centralSize, end + 12);
  return out;
}

test("a docx whose end record under-counts its entries is refused, not measured", async () => {
  // Mammoth's zip reader reads every directory record whatever the count
  // says; a checker that trusted the count would skip the padding.
  const bomb = buildDocx("hi", [{ name: "word/media/padding.bin", data: Buffer.alloc(48 * 1024 * 1024) }]);
  await assert.rejects(
    () => extractDocument(patchEnd(bomb, 3), "docx", "bomb.docx", CONFIG),
    (error: unknown) => error instanceof DocumentExtractionError && error.code === "unreadable_docx",
  );
});

test("a docx whose entries share bytes is refused", async () => {
  const docx = buildDocx("hi");
  const end = docx.length - 22;
  const centralSize = docx.readUInt32LE(end + 12);
  const centralOffset = docx.readUInt32LE(end + 16);
  const firstRecordLength = 46 + docx.readUInt16LE(centralOffset + 28);
  // A second directory record pointing at the first entry's bytes.
  const duplicate = docx.subarray(centralOffset, centralOffset + firstRecordLength);
  const overlapped = patchEnd(
    Buffer.concat([docx.subarray(0, end), duplicate, docx.subarray(end)]),
    docx.readUInt16LE(end + 10) + 1,
    centralSize + firstRecordLength,
  );
  await assert.rejects(
    () => extractDocument(overlapped, "docx", "overlap.docx", CONFIG),
    (error: unknown) => error instanceof DocumentExtractionError && error.code === "unreadable_docx",
  );
});

test("rejects a docx whose archive is corrupt", async () => {
  const docx = buildDocx("hi");
  const truncated = docx.subarray(0, docx.length - 30);
  await assert.rejects(
    () => extractDocument(truncated, "docx", "broken.docx", CONFIG),
    (error: unknown) => error instanceof DocumentExtractionError && error.code === "unreadable_docx",
  );
});

// ============================================================================
// Resolution
// ============================================================================

test("splits images from documents", async () => {
  const body = "Clause 4: ".concat("The term is 24 months. ".repeat(20));
  const result = await resolveAttachments(
    [
      classified({ mimeType: "image/png", base64: TINY_PNG_BASE64 }),
      classified({
        mimeType: "text/plain",
        base64: b64(body),
        fileName: "terms.txt",
      }),
    ],
    CONFIG,
  );

  assert.equal(result.images.length, 1);
  assert.equal(result.documents.length, 1);
  // The image must NOT appear in the prompt context — it goes to the
  // provider as a native image block instead.
  assert.ok(!result.contextBlock.includes(TINY_PNG_BASE64));
  assert.match(result.contextBlock, /<document-context>/);
  assert.match(result.contextBlock, /terms\.txt/);
  assert.match(result.contextBlock, /24 months/);
});

test("produces no context block when only images are attached", async () => {
  const result = await resolveAttachments(
    [classified({ mimeType: "image/png", base64: TINY_PNG_BASE64 })],
    CONFIG,
  );
  assert.equal(result.contextBlock, "");
  assert.equal(result.documents.length, 0);
});

test("an unreadable document warns instead of failing the turn", async () => {
  const result = await resolveAttachments(
    [
      classified({
        mimeType: "application/pdf",
        base64: b64("not a real pdf"),
        fileName: "broken.pdf",
      }),
      classified({
        mimeType: "text/plain",
        base64: b64("This one is fine."),
        fileName: "ok.txt",
      }),
    ],
    CONFIG,
  );

  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0]?.fileName, "ok.txt");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /broken\.pdf|PDF/);
});

test("the shared character budget stops runaway documents", async () => {
  const big = classified({
    mimeType: "text/plain",
    base64: b64("y".repeat(5000)),
    fileName: "big.txt",
  });
  const result = await resolveAttachments([big, big, big], {
    ...CONFIG,
    maxTotalDocumentChars: 6000,
  });

  const total = result.documents.reduce((sum, d) => sum + d.charCount, 0);
  assert.ok(total <= 6000, `total ${total} should stay within budget`);
  assert.ok(result.documents.length < 3, "at least one document is dropped");
});

// ============================================================================
// Layout analysis
// ============================================================================

/** Build a page of text runs flowing normally down the page. */
function flowingPage(count: number, startY = 800): Array<{
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  return Array.from({ length: count }, (_, i) => ({
    str: `line ${i}`,
    x: 50,
    y: startY - i * 14,
    width: 200,
    height: 12,
  }));
}

test("normal downward flow scores zero", () => {
  const signals = analyzeLayout([flowingPage(40)]);
  assert.equal(signals.maxBackJump, 0);
  assert.equal(signals.score, 0);
});

test("a two-column break stays below the escalation threshold", () => {
  // Column one runs down the page, then column two restarts near the top —
  // a jump back of roughly one column height. This is benign: measured
  // against a real two-column PDF it extracts in correct order.
  const page = [
    ...flowingPage(20, 800),
    ...flowingPage(20, 640).map((item) => ({ ...item, x: 320 })),
  ];
  const signals = analyzeLayout([page]);
  assert.ok(
    signals.score < 0.5,
    `column break should not escalate, got ${signals.score}`,
  );
});

test("out-of-flow content near the top scores high", () => {
  // A stamp or sidebar emitted last, sitting at the top of the page: the
  // reading order jumps back most of the page height.
  const page = [
    ...flowingPage(30, 800),
    { str: "CERTIFIED TRUE COPY", x: 340, y: 790, width: 160, height: 14 },
  ];
  const signals = analyzeLayout([page]);
  assert.ok(
    signals.maxBackJump > 0.6,
    `expected a large jump, got ${signals.maxBackJump}`,
  );
  assert.ok(
    signals.score >= 0.5,
    `should escalate, got ${signals.score}`,
  );
});

test("layout analysis tolerates degenerate pages", () => {
  assert.equal(analyzeLayout([]).score, 0);
  assert.equal(analyzeLayout([[]]).score, 0);
  // Every run on the same baseline — page height is zero, must not divide by it.
  const flat = analyzeLayout([
    [
      { str: "a", x: 0, y: 100, width: 10, height: 10 },
      { str: "b", x: 20, y: 100, width: 10, height: 10 },
    ],
  ]);
  assert.ok(Number.isFinite(flat.score));
  assert.equal(flat.score, 0);
});

// ============================================================================
// Native escalation
// ============================================================================

/**
 * Swap in a stand-in PDF extractor for one test.
 *
 * Routing is what these tests are about — whether a document goes native or
 * stays on the text path — so the extractor is stubbed to produce each
 * outcome directly rather than depending on hand-built PDF fixtures.
 */
async function withPdfStrategy(
  strategy: () => Promise<never> | Promise<unknown>,
  run: () => Promise<void>,
): Promise<void> {
  registerExtractionStrategy("pdf", strategy as never);
  try {
    await run();
  } finally {
    resetExtractionStrategies();
  }
}

const pdfAttachment = (name = "scan.pdf") =>
  classified({
    mimeType: "application/pdf",
    base64: b64("%PDF-1.4 placeholder"),
    fileName: name,
  });

test("a scanned PDF escalates when the provider can render it", async () => {
  await withPdfStrategy(
    async () => {
      throw new DocumentExtractionError("no text layer", "scanned_pdf");
    },
    async () => {
      const result = await resolveAttachments([pdfAttachment()], CONFIG, {
        supportsNativeDocuments: true,
      });
      assert.equal(result.nativeDocuments.length, 1);
      assert.equal(result.nativeDocuments[0]?.reason, "no-text-layer");
      assert.equal(result.documents.length, 0);
      assert.equal(result.warnings.length, 0);
    },
  );
});

test("a scanned PDF is rejected when the provider cannot", async () => {
  await withPdfStrategy(
    async () => {
      throw new DocumentExtractionError("no text layer", "scanned_pdf");
    },
    async () => {
      const result = await resolveAttachments([pdfAttachment()], CONFIG, {
        supportsNativeDocuments: false,
      });
      assert.equal(result.nativeDocuments.length, 0);
      assert.equal(result.warnings.length, 1);
    },
  );
});

test("a layout-heavy PDF escalates but keeps its text for history", async () => {
  await withPdfStrategy(
    async () => ({
      text: "Rates above are exclusive of GST.".repeat(10),
      warnings: [],
      signals: {
        maxBackJump: 0.63,
        backJumpCount: 1,
        columnCount: 3,
        score: 0.74,
      },
    }),
    async () => {
      const result = await resolveAttachments(
        [pdfAttachment("rates.pdf")],
        CONFIG,
        { supportsNativeDocuments: true },
      );
      assert.equal(result.nativeDocuments.length, 1);
      assert.equal(result.nativeDocuments[0]?.reason, "layout");
      // Sent natively, but the text survives so later turns aren't blind.
      assert.match(
        result.nativeDocuments[0]?.extractedText ?? "",
        /exclusive of GST/,
      );
      // It must NOT also occupy the prompt context — that would double-bill.
      assert.equal(result.contextBlock, "");
    },
  );
});

test("a simple PDF stays on the text path", async () => {
  await withPdfStrategy(
    async () => ({
      text: "Clause 1. This agreement runs for 24 months.",
      warnings: [],
      signals: {
        maxBackJump: 0.2,
        backJumpCount: 1,
        columnCount: 2,
        score: 0.0,
      },
    }),
    async () => {
      const result = await resolveAttachments(
        [pdfAttachment("simple.pdf")],
        CONFIG,
        { supportsNativeDocuments: true },
      );
      assert.equal(result.nativeDocuments.length, 0);
      assert.equal(result.documents.length, 1);
      assert.match(result.contextBlock, /24 months/);
    },
  );
});

test('pdfStrategy "text" never escalates, even on a scan', async () => {
  await withPdfStrategy(
    async () => {
      throw new DocumentExtractionError("no text layer", "scanned_pdf");
    },
    async () => {
      const result = await resolveAttachments(
        [pdfAttachment()],
        { ...CONFIG, pdfStrategy: "text" },
        { supportsNativeDocuments: true },
      );
      assert.equal(result.nativeDocuments.length, 0);
      assert.equal(result.warnings.length, 1);
    },
  );
});

test('pdfStrategy "native" skips extraction entirely', async () => {
  let extractorCalled = false;
  await withPdfStrategy(
    async () => {
      extractorCalled = true;
      return { text: "should not be reached", warnings: [] };
    },
    async () => {
      const result = await resolveAttachments(
        [pdfAttachment("any.pdf")],
        { ...CONFIG, pdfStrategy: "native" },
        { supportsNativeDocuments: true },
      );
      assert.equal(extractorCalled, false, "extraction should be skipped");
      assert.equal(result.nativeDocuments[0]?.reason, "policy");
    },
  );
});

test("non-PDF documents never escalate", async () => {
  // Neither Azure OpenAI nor Anthropic accepts .docx as native input, so a
  // Word file must stay on the extraction path whatever the strategy says.
  const result = await resolveAttachments(
    [
      classified({
        mimeType: "text/plain",
        base64: b64("plain text body that is long enough to matter"),
        fileName: "notes.txt",
      }),
    ],
    { ...CONFIG, pdfStrategy: "native" },
    { supportsNativeDocuments: true },
  );
  assert.equal(result.nativeDocuments.length, 0);
  assert.equal(result.documents.length, 1);
});

// ============================================================================
// Config
// ============================================================================

test("config loads and caches", () => {
  resetAttachmentConfig();
  const first = loadAttachmentConfig();
  assert.ok(first.maxImageBytes > 0);
  assert.ok(first.maxDocumentBytes >= first.maxImageBytes);
  assert.equal(loadAttachmentConfig(), first);
  resetAttachmentConfig();
});

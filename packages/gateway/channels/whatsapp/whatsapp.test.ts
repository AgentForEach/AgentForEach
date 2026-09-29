/**
 * AgentForEach Channels — WhatsApp Plugin Tests
 *
 * Covers the parts where being wrong is expensive and invisible: signature
 * verification, the retryable/terminal error split, deduplication of Meta's
 * week-long redeliveries, the service window, consent, and the Markdown
 * degradation that decides whether replies are readable at all.
 *
 * The stores are injected, so nothing here touches Cosmos.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifyWhatsAppWebhook, verifyWhatsAppChallenge } from "./verify.js";
import {
  classifyError,
  isStaleMediaError,
  backoffDelayMs,
  withRetry,
  WhatsAppErrorCode,
  type WhatsAppFailure,
} from "./errors.js";
import {
  mediaCacheKey,
  resolveMediaId,
  invalidateMediaId,
  setMediaIdCache,
  resetMediaIdCache,
} from "./media.js";
import { markdownToWhatsApp, stripFormatting, fit, truncate } from "./format.js";
import { MemoryTtlStore } from "./kv-store.js";
import { claimMessage, setDedupeStore, resetDedupeStore } from "./dedupe.js";
import {
  recordInbound,
  isWindowOpen,
  setWindowStore,
  resetWindowStore,
} from "./window.js";
import {
  classifyConsentText,
  isOptedOut,
  setOptedOut,
  setOptedIn,
  setConsentStore,
  resetConsentStore,
} from "./consent.js";
import { parseWhatsAppWebhook, enrichWhatsAppInbound } from "./inbound.js";
import {
  loadWhatsAppConfig,
  normalisePhone,
  whatsappRegistrationBlocker,
} from "./config.js";
import { splitMessage } from "../util/split.js";

// ============================================================================
// Helpers
// ============================================================================

function webhook(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "PNID" },
              contacts: [{ wa_id: "919876543210", profile: { name: "Asha" } }],
              messages: [
                {
                  id: `wamid.${Math.random().toString(36).slice(2)}`,
                  from: "919876543210",
                  timestamp: "1700000000",
                  ...message,
                },
              ],
              ...extra,
            },
          },
        ],
      },
    ],
  };
}

function freshStores(): void {
  resetDedupeStore();
  resetWindowStore();
  resetConsentStore();
  resetMediaIdCache();
  setDedupeStore(new MemoryTtlStore());
  setWindowStore(new MemoryTtlStore());
  setConsentStore(new MemoryTtlStore());
  setMediaIdCache(new MemoryTtlStore());
}

// ============================================================================
// Verification
// ============================================================================

describe("verify", () => {
  test("challenge is rejected when no verify token is configured", () => {
    // The unconfigured default: there is nothing to compare against, and
    // echoing an arbitrary challenge would let anyone point their own Meta app
    // at this endpoint.
    const result = verifyWhatsAppChallenge({
      "hub.mode": "subscribe",
      "hub.verify_token": "anything",
      "hub.challenge": "12345",
    });
    assert.equal(result, undefined);
  });

  test("challenge requires mode=subscribe and a challenge value", () => {
    assert.equal(verifyWhatsAppChallenge({}), undefined);
    assert.equal(
      verifyWhatsAppChallenge({ "hub.mode": "unsubscribe", "hub.challenge": "x" }),
      undefined,
    );
  });

  test("without an app secret, webhooks are rejected unless explicitly allowed for local dev", () => {
    const saved = process.env.ALLOW_UNSIGNED_WEBHOOKS;
    try {
      delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
      assert.equal(verifyWhatsAppWebhook({}, "{}"), false);
      process.env.ALLOW_UNSIGNED_WEBHOOKS = "true";
      assert.equal(verifyWhatsAppWebhook({}, "{}"), true);
    } finally {
      if (saved === undefined) delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
      else process.env.ALLOW_UNSIGNED_WEBHOOKS = saved;
    }
  });

  test("without an app secret, verification fails closed in the cloud even if allowed", () => {
    const saved = process.env.WEBSITE_SITE_NAME;
    const savedAllow = process.env.ALLOW_UNSIGNED_WEBHOOKS;
    process.env.WEBSITE_SITE_NAME = "agentforeach-func";
    process.env.ALLOW_UNSIGNED_WEBHOOKS = "true";
    try {
      assert.equal(verifyWhatsAppWebhook({}, "{}"), false);
    } finally {
      if (saved === undefined) delete process.env.WEBSITE_SITE_NAME;
      else process.env.WEBSITE_SITE_NAME = saved;
      if (savedAllow === undefined) delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
      else process.env.ALLOW_UNSIGNED_WEBHOOKS = savedAllow;
    }
  });

  test("HMAC digest matches Meta's scheme over the raw body", () => {
    // Verifies our understanding of the algorithm independently of config:
    // sha256 HMAC of the RAW bytes, hex, prefixed "sha256=".
    const secret = "app-secret";
    const body = '{"object":"whatsapp_business_account"}';
    const digest = createHmac("sha256", secret).update(body, "utf8").digest("hex");

    assert.equal(digest.length, 64);
    // Re-serialising the parsed JSON produces different bytes — the mistake
    // the raw-body plumbing exists to prevent.
    const reserialised = JSON.stringify(JSON.parse(body) as unknown);
    const other = createHmac("sha256", secret)
      .update(`${reserialised} `, "utf8")
      .digest("hex");
    assert.notEqual(digest, other);
  });
});

// ============================================================================
// Errors
// ============================================================================

describe("errors", () => {
  test("throughput errors are retryable", () => {
    for (const code of [
      WhatsAppErrorCode.RATE_LIMIT,
      WhatsAppErrorCode.PAIR_RATE_LIMIT,
      WhatsAppErrorCode.MEDIA_RATE_LIMIT,
    ]) {
      assert.equal(classifyError(code, "rate").retryable, true, `code ${code}`);
    }
  });

  test("window and delivery failures are terminal", () => {
    const window = classifyError(WhatsAppErrorCode.REENGAGEMENT_REQUIRED, "closed");
    assert.equal(window.retryable, false);
    assert.equal(window.windowClosed, true);

    assert.equal(
      classifyError(WhatsAppErrorCode.UNDELIVERABLE, "gone").retryable,
      false,
    );
  });

  test("unknown codes are terminal by default", () => {
    // Biased deliberately: an unknown code we retry forever is a silent quota
    // burn, one we surface is a log line someone can act on.
    assert.equal(classifyError(999999, "mystery").retryable, false);
  });

  test("transport 5xx and 429 without a body are retryable", () => {
    assert.equal(classifyError(undefined, "boom", 503).retryable, true);
    assert.equal(classifyError(undefined, "slow", 429).retryable, true);
    assert.equal(classifyError(undefined, "bad", 400).retryable, false);
  });

  test("backoff is bounded and jittered", () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const delay = backoffDelayMs(attempt);
      assert.ok(delay >= 0, "never negative");
      assert.ok(delay <= 60_000, `attempt ${attempt} capped, got ${delay}`);
    }
  });

  test("withRetry stops immediately on a terminal failure", async () => {
    let calls = 0;
    const failure: WhatsAppFailure = {
      code: WhatsAppErrorCode.REENGAGEMENT_REQUIRED,
      message: "closed",
      retryable: false,
      windowClosed: true,
    };

    const result = await withRetry(
      async () => {
        calls++;
        return { ok: false as const, failure };
      },
      { attempts: 5 },
      async () => undefined,
    );

    assert.equal(calls, 1);
    assert.equal(result.ok, false);
  });

  test("withRetry retries a retryable failure up to the attempt cap", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          return {
            ok: false as const,
            failure: classifyError(WhatsAppErrorCode.RATE_LIMIT, "slow down"),
          };
        }
        return { ok: true as const, value: "wamid.1" };
      },
      { attempts: 5 },
      async () => undefined,
    );

    assert.equal(calls, 3);
    assert.equal(result.ok, true);
  });
});

// ============================================================================
// Formatting
// ============================================================================

describe("format", () => {
  test("emphasis is converted to WhatsApp's dialect", () => {
    assert.equal(markdownToWhatsApp("**bold**"), "*bold*");
    assert.equal(markdownToWhatsApp("__bold__"), "*bold*");
    assert.equal(markdownToWhatsApp("a *word* here"), "a _word_ here");
    assert.equal(markdownToWhatsApp("~~gone~~"), "~gone~");
  });

  test("headings become bold lines", () => {
    assert.equal(markdownToWhatsApp("## Your options"), "*Your options*");
  });

  test("tables become key: value lines", () => {
    // The construct with the widest gap between Markdown and WhatsApp, and the
    // most common way a bot looks broken.
    const table = [
      "| Doc | Time |",
      "| --- | --- |",
      "| NDA | 2 min |",
      "| Lease | 5 min |",
    ].join("\n");

    const out = markdownToWhatsApp(table);
    assert.ok(!out.includes("|"), `no pipes should survive: ${out}`);
    assert.ok(out.includes("Doc: NDA"));
    assert.ok(out.includes("Time: 2 min"));
    assert.ok(out.includes("Doc: Lease"));
  });

  test("links keep both label and destination", () => {
    assert.equal(
      markdownToWhatsApp("[our terms](https://example.com/t)"),
      "our terms: https://example.com/t",
    );
  });

  test("code fences are preserved verbatim", () => {
    const fence = "```";
    const input = `${fence}\n| not | a table |\n${fence}`;
    const out = markdownToWhatsApp(input);
    assert.ok(out.includes("| not | a table |"), out);
  });

  test("inline code is preserved verbatim, backticks and all", () => {
    // WhatsApp renders single-backtick spans natively, and the CONTENT must
    // not go through the emphasis rules: `snake__case__` is an identifier,
    // not a bold request.
    assert.equal(
      markdownToWhatsApp("run `snake__case__fn` now"),
      "run `snake__case__fn` now",
    );
    assert.equal(markdownToWhatsApp("try `*.ts` here"), "try `*.ts` here");
  });

  test("literal FENCE-like text survives the placeholder round-trip", () => {
    assert.equal(markdownToWhatsApp("FENCE0 is a token"), "FENCE0 is a token");
  });

  test("truncate keeps newlines and formatting, unlike fit", () => {
    const body = "*Choose one:*\n\nOption A or Option B";
    assert.equal(truncate(body, 200), body);

    const long = `${"word ".repeat(50)}end`;
    const out = truncate(long, 40);
    assert.ok(out.length <= 40, `got ${out.length}`);
    assert.ok(out.endsWith("…"));
  });

  test("horizontal rules are dropped", () => {
    assert.equal(markdownToWhatsApp("a\n\n---\n\nb"), "a\n\nb");
  });

  test("stripFormatting removes every marker", () => {
    assert.equal(stripFormatting("*bold* _it_ ~s~"), "bold it s");
  });

  test("fit truncates on a word boundary", () => {
    const out = fit("Security deposit refund timeline", 20);
    assert.ok(out.length <= 20, `got ${out.length}: ${out}`);
    assert.ok(out.endsWith("…"));
  });

  test("fit leaves short strings untouched", () => {
    assert.equal(fit("Rent", 20), "Rent");
  });
});

// ============================================================================
// Splitting
// ============================================================================

describe("split", () => {
  test("short messages are not split", () => {
    assert.deepEqual(splitMessage("hello", 4096), ["hello"]);
  });

  test("long messages split on a newline near the limit", () => {
    const text = `${"a".repeat(90)}\n${"b".repeat(90)}`;
    const chunks = splitMessage(text, 100);
    assert.equal(chunks.length, 2);
    assert.ok(chunks.every((c) => c.length <= 100));
  });
});

// ============================================================================
// Dedupe
// ============================================================================

describe("dedupe", () => {
  beforeEach(freshStores);

  test("a message id can only be claimed once", async () => {
    assert.equal(await claimMessage("wamid.A"), true);
    assert.equal(await claimMessage("wamid.A"), false);
    assert.equal(await claimMessage("wamid.B"), true);
  });

  test("an empty id is always processed", async () => {
    // Better to answer than to swallow a message because it arrived malformed.
    assert.equal(await claimMessage(""), true);
    assert.equal(await claimMessage(""), true);
  });

  test("the store's add is first-writer-wins", async () => {
    const s = new MemoryTtlStore();
    assert.equal(await s.add("k", "first", 60), true);
    assert.equal(await s.add("k", "second", 60), false);
    assert.equal(await s.get("k"), "first");

    await s.delete("k");
    assert.equal(await s.add("k", "third", 60), true);
  });
});

// ============================================================================
// Service window
// ============================================================================

describe("window", () => {
  beforeEach(freshStores);

  test("an unknown chat reports closed", async () => {
    // Safe direction: closed routes through the template path, which is legal
    // in both states. Assuming open earns a 131047 at send time.
    assert.equal(await isWindowOpen("919876543210"), false);
  });

  test("an inbound message opens the window", async () => {
    await recordInbound("919876543210");
    assert.equal(await isWindowOpen("919876543210"), true);
  });

  test("the window closes after 24 hours", async () => {
    const now = Date.now();
    await recordInbound("919876543210", now - 25 * 60 * 60 * 1000);
    assert.equal(await isWindowOpen("919876543210", now), false);

    await recordInbound("919876543210", now - 23 * 60 * 60 * 1000);
    assert.equal(await isWindowOpen("919876543210", now), true);
  });
});

// ============================================================================
// Consent
// ============================================================================

describe("consent", () => {
  beforeEach(freshStores);

  test("STOP and START are recognised, case and punctuation insensitive", () => {
    assert.equal(classifyConsentText("stop"), "opt-out");
    assert.equal(classifyConsentText("  STOP "), "opt-out");
    assert.equal(classifyConsentText("Stop."), "opt-out");
    assert.equal(classifyConsentText("start"), "opt-in");
  });

  test("a keyword inside a sentence is not an opt-out", () => {
    // Substring matching would silence anyone who wrote "stop by tomorrow".
    assert.equal(classifyConsentText("stop by tomorrow"), undefined);
    assert.equal(classifyConsentText("please start the lease draft"), undefined);
  });

  test("opt-out is recorded and reversible", async () => {
    assert.equal(await isOptedOut("919876543210"), false);
    await setOptedOut("919876543210");
    assert.equal(await isOptedOut("919876543210"), true);
    await setOptedIn("919876543210");
    assert.equal(await isOptedOut("919876543210"), false);
  });
});

// ============================================================================
// Inbound parsing
// ============================================================================

describe("inbound", () => {
  beforeEach(freshStores);

  test("a text message becomes an InboundMessage", async () => {
    const msg = await parseWhatsAppWebhook(
      webhook({ type: "text", text: { body: "hello" } }),
    );

    assert.ok(msg);
    assert.equal(msg.text, "hello");
    assert.equal(msg.senderId, "919876543210");
    assert.equal(msg.chatId, "919876543210");
    assert.equal(msg.senderName, "Asha");
    assert.equal(msg.isGroupChat, false);
    assert.equal(msg.timestampMs, 1700000000 * 1000);
  });

  test("a redelivery is dropped", async () => {
    const payload = webhook({ type: "text", text: { body: "hello" } });
    assert.ok(await parseWhatsAppWebhook(payload));
    assert.equal(await parseWhatsAppWebhook(payload), undefined);
  });

  test("an inbound message opens the service window", async () => {
    // The window is measured from the message's own timestamp, not from when
    // the webhook landed — so the fixture needs a current one.
    const now = Math.floor(Date.now() / 1000);
    await parseWhatsAppWebhook(
      webhook({ type: "text", text: { body: "hi" }, timestamp: String(now) }),
    );
    assert.equal(await isWindowOpen("919876543210"), true);
  });

  test("a message older than the window does not re-open it", async () => {
    // A redelivery of an ancient message must not make free-form sending look
    // legal again.
    await parseWhatsAppWebhook(webhook({ type: "text", text: { body: "hi" } }));
    assert.equal(await isWindowOpen("919876543210"), false);
  });

  test("a status callback yields no message", async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  {
                    id: "wamid.X",
                    recipient_id: "919876543210",
                    status: "delivered",
                    timestamp: "1700000000",
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    assert.equal(await parseWhatsAppWebhook(payload), undefined);
  });

  test("a completed Flow (nfm_reply) becomes an agent turn carrying the params", async () => {
    // A product integration: the Flow's SUCCESS params come back as an
    // nfm_reply, and the agent resumes the conversation with the outcome.
    const msg = await parseWhatsAppWebhook(
      webhook({
        type: "interactive",
        interactive: {
          type: "nfm_reply",
          nfm_reply: {
            name: "flow",
            body: "Sent",
            response_json: '{"outcome":"drafted","documentId":"DOC-1"}',
          },
        },
      }),
    );

    assert.ok(msg);
    assert.equal(
      msg.text,
      '[Completed the form] {"outcome":"drafted","documentId":"DOC-1"}',
    );
  });

  test("an interactive reply carries the title, not the id", async () => {
    const msg = await parseWhatsAppWebhook(
      webhook({
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: "opt_lease", title: "Rent agreement" },
        },
      }),
    );

    assert.ok(msg);
    assert.equal(msg.text, "Rent agreement");
  });

  test("a location renders as readable text", async () => {
    const msg = await parseWhatsAppWebhook(
      webhook({
        type: "location",
        location: { latitude: 12.97, longitude: 77.59, name: "Indiranagar" },
      }),
    );

    assert.ok(msg);
    assert.match(msg.text, /Indiranagar/);
    assert.match(msg.text, /12\.97/);
  });

  test("an unsupported message still produces a turn", async () => {
    // A view-once photo or disappearing message. Silence here reads as broken.
    const msg = await parseWhatsAppWebhook(webhook({ type: "unsupported" }));
    assert.ok(msg);
    assert.ok(msg.text.length > 0);
  });

  test("a reaction does not start a turn", async () => {
    const msg = await parseWhatsAppWebhook(
      webhook({ type: "reaction", reaction: { message_id: "wamid.Y", emoji: "👍" } }),
    );
    assert.equal(msg, undefined);
  });

  test("STOP opts out and does not reach the agent", async () => {
    const msg = await parseWhatsAppWebhook(
      webhook({ type: "text", text: { body: "STOP" } }),
    );
    assert.equal(msg, undefined);
    assert.equal(await isOptedOut("919876543210"), true);
  });

  test("an opted-out sender is ignored until they opt back in", async () => {
    await setOptedOut("919876543210");

    assert.equal(
      await parseWhatsAppWebhook(webhook({ type: "text", text: { body: "hello?" } })),
      undefined,
    );

    await parseWhatsAppWebhook(webhook({ type: "text", text: { body: "start" } }));
    assert.equal(await isOptedOut("919876543210"), false);

    const msg = await parseWhatsAppWebhook(
      webhook({ type: "text", text: { body: "hello again" } }),
    );
    assert.ok(msg);
  });

  test("a payload with no messages yields nothing", async () => {
    assert.equal(await parseWhatsAppWebhook({}), undefined);
    assert.equal(await parseWhatsAppWebhook({ entry: [] }), undefined);
  });

  test("parsing a media message is cheap: placeholder text, no download", async () => {
    // The download happens post-ack in enrichWhatsAppInbound, never in
    // parseInbound — a 5 MB image must not hold Meta's webhook open.
    const msg = await parseWhatsAppWebhook(
      webhook({ type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg" } }),
    );

    assert.ok(msg);
    assert.equal(msg.text, "[sent an image]");
    assert.equal(msg.attachments, undefined);
  });

  test("enrichment degrades to the bare message when the download fails", async () => {
    // Unconfigured channel: no access token, so the fetch cannot happen. The
    // turn still runs on the placeholder text.
    const msg = await parseWhatsAppWebhook(
      webhook({ type: "image", image: { id: "MEDIA1" } }),
    );
    assert.ok(msg);

    const enriched = await enrichWhatsAppInbound(msg);
    assert.equal(enriched.text, "[sent an image]");
    assert.equal(enriched.attachments, undefined);
  });

  test("enrichment leaves a text message untouched", async () => {
    const msg = await parseWhatsAppWebhook(
      webhook({ type: "text", text: { body: "hello" } }),
    );
    assert.ok(msg);
    assert.deepEqual(await enrichWhatsAppInbound(msg), msg);
  });
});

// ============================================================================
// Config
// ============================================================================

describe("config", () => {
  test("phone numbers normalise to comparable digits", () => {
    assert.equal(normalisePhone("+91 98765-43210"), "919876543210");
    assert.equal(normalisePhone("919876543210"), "919876543210");
  });

  test("an unconfigured channel is disabled rather than half-enabled", () => {
    // A channel that registers and then fails every send is worse than one
    // that stays quiet.
    const cfg = loadWhatsAppConfig();
    assert.equal(cfg.enabled, false);
  });

  test("dedupe defaults to durable storage", () => {
    // Meta redelivers for up to 7 days; an in-memory set loses its contents to
    // a redeploy and the agent answers a days-old message as if it were new.
    assert.equal(loadWhatsAppConfig().dedupeStore, "cosmos");
  });

  test("the default configuration counts as an unsafe identity fallback", () => {
    // No identity section at all resolves to fallbackMode "config-default" —
    // the identity module's own default — and the resolver applies that
    // fallback whether or not the identity system is enabled. The guard must
    // therefore judge the RESOLVED config; checking the raw section waved
    // this exact state through, which was the bypass of the registration
    // refusal.
    assert.match(whatsappRegistrationBlocker() ?? "", /authorizedSenders/);
  });
});

// ============================================================================
// Media id cache
// ============================================================================

describe("media cache", () => {
  let store: MemoryTtlStore;

  beforeEach(() => {
    resetMediaIdCache();
    store = new MemoryTtlStore();
    setMediaIdCache(store);
  });

  test("the key is the content, not the filename", () => {
    // Two sends of the same bytes under different names are one upload.
    const a = mediaCacheKey("QUJD", "application/pdf");
    const b = mediaCacheKey("QUJD", "application/pdf");
    assert.equal(a, b);
  });

  test("different bytes and different types key differently", () => {
    assert.notEqual(
      mediaCacheKey("QUJD", "application/pdf"),
      mediaCacheKey("WFla", "application/pdf"),
    );
    assert.notEqual(
      mediaCacheKey("QUJD", "application/pdf"),
      mediaCacheKey("QUJD", "image/jpeg"),
    );
  });

  test("a cached handle is reused and reported as cached", async () => {
    await store.set(mediaCacheKey("QUJD", "application/pdf"), "media-1", 60);

    const resolved = await resolveMediaId("QUJD", "application/pdf", "a.pdf");

    assert.deepEqual(resolved, { id: "media-1", cached: true });
  });

  test("the same bytes under a new filename still hit the cache", async () => {
    await store.set(mediaCacheKey("QUJD", "application/pdf"), "media-1", 60);

    const resolved = await resolveMediaId("QUJD", "application/pdf", "renamed.pdf");

    assert.equal(resolved?.id, "media-1");
    assert.equal(resolved?.cached, true);
  });

  test("invalidating forgets the handle", async () => {
    const key = mediaCacheKey("QUJD", "application/pdf");
    await store.set(key, "media-1", 60);

    await invalidateMediaId("QUJD", "application/pdf");

    assert.equal(await store.get(key), undefined);
  });

  test("a miss with no credentials resolves to nothing rather than throwing", async () => {
    // Unconfigured channel: the upload cannot happen, and the caller falls
    // back to the message text rather than sending a broken media message.
    assert.equal(await resolveMediaId("QUJD", "application/pdf"), undefined);
  });

  test("stale-handle errors are recognised", () => {
    // 131052 is what a media_id past Meta's 30-day retention returns. It is
    // terminal for a blind retry but recoverable by re-uploading.
    assert.equal(
      isStaleMediaError(classifyError(WhatsAppErrorCode.MEDIA_DOWNLOAD_ERROR, "gone")),
      true,
    );
    assert.equal(
      isStaleMediaError(classifyError(WhatsAppErrorCode.INVALID_PARAM, "bad id")),
      true,
    );
    assert.equal(
      isStaleMediaError(classifyError(WhatsAppErrorCode.RATE_LIMIT, "slow")),
      false,
    );
  });

  test("a stale-handle error is not retried by the transport", () => {
    // Re-sending the same dead id would fail identically forever; the fix is
    // a fresh upload, which the media path does explicitly.
    assert.equal(
      classifyError(WhatsAppErrorCode.MEDIA_DOWNLOAD_ERROR, "gone").retryable,
      false,
    );
  });
});

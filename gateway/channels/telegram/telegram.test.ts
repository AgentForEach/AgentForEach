/**
 * Telegram channel: webhook verification and the registration guard.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyTelegramWebhook } from "./verify.js";
import { parseTelegramUpdate } from "./inbound.js";
import { resetTelegramConfig, telegramRegistrationBlocker } from "./config.js";
import { resetChannelsConfig } from "../config.js";
import { resetIdentityConfigCache } from "../../identity/index.js";
import { resetConfigCache } from "../../utils/index.js";

const ENV_KEYS = [
  "CONFIG_FILE_JSON",
  "WEBSITE_SITE_NAME",
  "TELEGRAM_BOT_TOKEN",
  "ALLOW_UNSIGNED_WEBHOOKS",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function resetCaches() {
  resetConfigCache();
  resetChannelsConfig();
  resetTelegramConfig();
  resetIdentityConfigCache();
}

beforeEach(() => {
  delete process.env.WEBSITE_SITE_NAME;
  delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetCaches();
});

function useConfig(telegram: Record<string, unknown>, identity: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentforeach-tg-"));
  const file = join(dir, "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      identity: { enabled: true, fallbackMode: "config-default", ...identity },
      channels: { telegram: { enabled: true, botToken: "123:abc", ...telegram } },
    }),
  );
  process.env.CONFIG_FILE_JSON = file;
  resetCaches();
}

test("webhook without a configured secret is rejected unless explicitly allowed locally", () => {
  useConfig({});
  assert.equal(verifyTelegramWebhook({}, ""), false);

  process.env.ALLOW_UNSIGNED_WEBHOOKS = "true";
  assert.equal(verifyTelegramWebhook({}, ""), true);

  // Never in the cloud, even with the flag.
  process.env.WEBSITE_SITE_NAME = "agentforeach-func";
  assert.equal(verifyTelegramWebhook({}, ""), false);
});

test("numeric authorizedSenders in JSON are compared as strings", () => {
  useConfig({ authorizedSenders: [123456789] });
  assert.equal(telegramRegistrationBlocker(), null);
});

test("webhook with a secret requires the matching header", () => {
  useConfig({ webhookSecretToken: "s3cret" });
  assert.equal(verifyTelegramWebhook({ "x-telegram-bot-api-secret-token": "s3cret" }, ""), true);
  assert.equal(verifyTelegramWebhook({ "x-telegram-bot-api-secret-token": "nope" }, ""), false);
  assert.equal(verifyTelegramWebhook({}, ""), false);
});

test("the channel refuses to register when strangers would act as the default user", () => {
  useConfig({ authorizedSenders: [], defaultUserId: "owner" });
  assert.match(telegramRegistrationBlocker() ?? "", /authorizedSenders/);
});

test("an allowlist or pairing-only identity makes the channel safe to register", () => {
  useConfig({ authorizedSenders: ["123456789"] });
  assert.equal(telegramRegistrationBlocker(), null);

  useConfig({ authorizedSenders: [] }, { fallbackMode: "sender-passthrough" });
  assert.equal(telegramRegistrationBlocker(), null);
});

test("in the cloud the channel also needs a webhook secret", () => {
  process.env.WEBSITE_SITE_NAME = "agentforeach-func";
  useConfig({ authorizedSenders: ["123456789"] });
  assert.match(telegramRegistrationBlocker() ?? "", /webhook secret/);

  useConfig({ authorizedSenders: ["123456789"], webhookSecretToken: "s3cret" });
  assert.equal(telegramRegistrationBlocker(), null);
});

test("messages sent on behalf of a chat have no sender to identify and are dropped", async () => {
  useConfig({ authorizedSenders: [] }, { fallbackMode: "sender-passthrough" });
  const update = (from: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    update_id: 1,
    message: { message_id: 7, date: 1, text: "hi", chat: { id: -100, type: "supergroup", title: "G" }, from, ...extra },
  });

  const person = await parseTelegramUpdate(update({ id: 42, is_bot: false, first_name: "Ann" }));
  assert.equal(person?.senderId, "42");

  const anonymousAdmin = update(
    { id: 1087968824, is_bot: true, first_name: "Group", username: "GroupAnonymousBot" },
    { sender_chat: { id: -100, type: "supergroup", title: "G" } },
  );
  assert.equal(await parseTelegramUpdate(anonymousAdmin), undefined);
  assert.equal(await parseTelegramUpdate(update({ id: 136817688, is_bot: true, first_name: "Channel" })), undefined);
});

test("authorizedSenders matches numeric ids, never usernames", async () => {
  useConfig({ authorizedSenders: ["42", "@alice"] });
  const update = (from: Record<string, unknown>) => ({
    update_id: 1,
    message: { message_id: 7, date: 1, text: "hi", chat: { id: 5, type: "private" }, from },
  });
  assert.equal((await parseTelegramUpdate(update({ id: 42, is_bot: false, first_name: "A" })))?.senderId, "42");
  // Whoever holds the username "alice" now is not who the operator listed.
  assert.equal(await parseTelegramUpdate(update({ id: 99, is_bot: false, first_name: "B", username: "alice" })), undefined);
});

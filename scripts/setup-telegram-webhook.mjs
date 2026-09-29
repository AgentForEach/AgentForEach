#!/usr/bin/env node

/**
 * Set up Telegram Bot webhook to point at a public URL (your Function App, or a tunnel to a local host).
 *
 * Usage:
 *   node scripts/setup-telegram-webhook.mjs https://<your-public-host>
 *   node scripts/setup-telegram-webhook.mjs --delete
 *
 * The bot token is read from agentforeach.json config (or TELEGRAM_BOT_TOKEN env var).
 * The webhook secret is read from TELEGRAM_WEBHOOK_SECRET env var (optional).
 *
 * What it does:
 *   1. Calls Telegram setWebhook API pointing to <url>/api/channels/telegram/webhook
 *   2. Calls getWebhookInfo to verify it was set correctly
 *   3. Optionally sets secret_token for request verification
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(
  __dirname,
  "../packages/gateway/config/agentforeach.json",
);

// ============================================================================
// Config
// ============================================================================

function loadBotToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;

  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const token = config?.channels?.telegram?.botToken;
    if (token && !token.startsWith("$")) return token;
  } catch {
    // fall through
  }

  console.error(
    "Error: No bot token found. Set TELEGRAM_BOT_TOKEN env var or check agentforeach.json",
  );
  process.exit(1);
}

function loadWebhookSecret() {
  return process.env.TELEGRAM_WEBHOOK_SECRET || undefined;
}

// ============================================================================
// Telegram API helpers
// ============================================================================

async function telegramApi(botToken, method, params = {}) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(
      `Telegram API ${method} failed: ${data.description ?? JSON.stringify(data)}`,
    );
  }
  return data.result;
}

// ============================================================================
// Commands
// ============================================================================

async function setWebhook(botToken, publicUrl, secret) {
  const webhookUrl = `${publicUrl.replace(/\/+$/, "")}/api/channels/telegram/webhook`;

  console.log(`\n  Bot token:     ${botToken.slice(0, 8)}...${botToken.slice(-4)}`);
  console.log(`  Webhook URL:   ${webhookUrl}`);
  console.log(`  Secret token:  ${secret ? "***" + secret.slice(-4) : "(none)"}\n`);

  const params = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query", "my_chat_member"],
  };
  if (secret) params.secret_token = secret;

  const result = await telegramApi(botToken, "setWebhook", params);
  console.log(`  setWebhook → ${result === true ? "✓ success" : JSON.stringify(result)}\n`);

  // Verify
  const info = await telegramApi(botToken, "getWebhookInfo");
  console.log("  Webhook info:");
  console.log(`    url:                   ${info.url}`);
  console.log(`    has_custom_certificate: ${info.has_custom_certificate}`);
  console.log(`    pending_update_count:  ${info.pending_update_count}`);
  if (info.last_error_date) {
    const errorTime = new Date(info.last_error_date * 1000).toISOString();
    console.log(`    last_error:            ${errorTime} — ${info.last_error_message}`);
  }
  if (info.ip_address) {
    console.log(`    ip_address:            ${info.ip_address}`);
  }
  console.log();

  if (info.url === webhookUrl) {
    console.log("  ✅ Webhook set successfully!\n");
  } else {
    console.error(`  ❌ Webhook URL mismatch! Expected: ${webhookUrl}, Got: ${info.url}\n`);
    process.exit(1);
  }
}

async function deleteWebhook(botToken) {
  const result = await telegramApi(botToken, "deleteWebhook");
  console.log(`\n  deleteWebhook → ${result === true ? "✓ success" : JSON.stringify(result)}`);
  console.log("  ✅ Webhook removed\n");
}

async function getInfo(botToken) {
  const info = await telegramApi(botToken, "getWebhookInfo");
  console.log("\n  Current webhook info:");
  console.log(`    url:                   ${info.url || "(not set)"}`);
  console.log(`    has_custom_certificate: ${info.has_custom_certificate}`);
  console.log(`    pending_update_count:  ${info.pending_update_count}`);
  if (info.last_error_date) {
    const errorTime = new Date(info.last_error_date * 1000).toISOString();
    console.log(`    last_error:            ${errorTime} — ${info.last_error_message}`);
  }
  console.log();

  const me = await telegramApi(botToken, "getMe");
  console.log(`  Bot: @${me.username} (${me.first_name}, id=${me.id})\n`);
}

// ============================================================================
// Main
// ============================================================================

function usage() {
  console.log(`
Usage:
  node scripts/setup-telegram-webhook.mjs <PUBLIC_URL>    Set webhook
  node scripts/setup-telegram-webhook.mjs --delete        Remove webhook
  node scripts/setup-telegram-webhook.mjs --info          Show current webhook info

Examples:
  node scripts/setup-telegram-webhook.mjs https://<your-tunnel>.example.com
  TELEGRAM_WEBHOOK_SECRET=mysecret node scripts/setup-telegram-webhook.mjs https://<your-public-host>
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }

  const botToken = loadBotToken();

  if (args.includes("--delete")) {
    await deleteWebhook(botToken);
    return;
  }

  if (args.includes("--info")) {
    await getInfo(botToken);
    return;
  }

  const publicUrl = args[0];
  if (!publicUrl.startsWith("http")) {
    console.error(`Error: Invalid URL "${publicUrl}". Must start with http:// or https://`);
    process.exit(1);
  }

  const secret = loadWebhookSecret();
  await setWebhook(botToken, publicUrl, secret);
}

main().catch((err) => {
  console.error("\n💥 Error:", err.message ?? err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * The quickstarts' trial sign-in, shared by scripts/quickstart.sh (Azure)
 * and scripts/quickstart-cloudflare.sh.
 *
 *   node scripts/lib/trial.mjs token              # a 30-day token; the secret comes from QUICKSTART_JWT_SECRET
 *   node scripts/lib/trial.mjs config <dir> <name> [cloudflare]
 *       # write <dir>/<name>: <dir>/agentforeach.json set up for the trial
 *
 * The trial config trusts HS256 tokens signed with $QUICKSTART_JWT_SECRET,
 * turns off what a trial stack doesn't have (the knowledge index, a second
 * model provider), and points OpenAI at QUICKSTART_OPENAI_BASE_URL and
 * QUICKSTART_MODEL when they are set. On Cloudflare it also turns sandboxes
 * off: the default config's sandbox backend (ACA) is Azure-only.
 */

import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TRIAL_USER = "quickstart-user";
export const ISSUER = "agentforeach-quickstart";
export const AUDIENCE = "agentforeach";
export const TOKEN_DAYS = 30;

export function mintToken(secret, now = Math.floor(Date.now() / 1000)) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: TRIAL_USER, iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + TOKEN_DAYS * 86400 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function trialConfig(config, env = process.env, platform = "azure") {
  config.auth = {
    ...config.auth,
    providers: [{ type: "jwt", enabled: true, algorithm: "HS256", secret: "$QUICKSTART_JWT_SECRET", issuer: ISSUER, audience: AUDIENCE, userIdClaim: "sub" }],
  };
  // The trial stack has no AI Search index.
  config.knowledge = { ...config.knowledge, enabled: false };
  // Only one model key: failing over to Anthropic would only add errors.
  config.llms.providers.anthropic = { ...config.llms.providers.anthropic, enabled: false };
  config.llms.failover = { ...config.llms.failover, enabled: false };
  const baseUrl = env.QUICKSTART_OPENAI_BASE_URL;
  const model = env.QUICKSTART_MODEL;
  if (baseUrl) {
    // Chat and embeddings both go to the endpoint (same key).
    config.llms.providers.openai = { ...config.llms.providers.openai, baseUrl };
    config.llms.embedding = { ...config.llms.embedding, baseUrl };
  }
  if (model) {
    // Every model the config names, not only chat's: an Azure OpenAI deployment
    // or another endpoint may serve no model but this one.
    config.llms.providers.openai = { ...config.llms.providers.openai, defaultModel: model };
    if (config.cron?.execution) config.cron.execution = { ...config.cron.execution, defaultModel: model };
    if (config.session?.compactionModel) config.session = { ...config.session, compactionModel: model };
  }
  if (platform === "cloudflare" && config.skills?.sandbox) {
    config.skills.sandbox = { ...config.skills.sandbox, enabled: false };
  }
  return config;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, dir, name, platform] = process.argv.slice(2);
  if (command === "token") {
    const secret = process.env.QUICKSTART_JWT_SECRET;
    if (!secret) throw new Error("QUICKSTART_JWT_SECRET is not set");
    console.log(mintToken(secret));
  } else if (command === "config" && dir && name) {
    const config = JSON.parse(readFileSync(`${dir}/agentforeach.json`, "utf8"));
    writeFileSync(`${dir}/${name}`, JSON.stringify(trialConfig(config, process.env, platform), null, 2) + "\n");
  } else {
    console.error("usage: trial.mjs token | trial.mjs config <dir> <name> [cloudflare]");
    process.exit(2);
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { trialConfig } from "./trial.mjs";

const base = () => ({
  auth: { providers: [] },
  knowledge: { enabled: true },
  llms: { providers: { openai: { defaultModel: "gpt-5-mini" }, anthropic: { enabled: true } }, failover: { enabled: true }, embedding: {} },
  cron: { execution: { defaultModel: "gpt-4.1-mini" } },
  session: { compactionModel: "gpt-5-mini" },
  skills: { sandbox: { enabled: true } },
});

test("QUICKSTART_MODEL replaces every model the config names", () => {
  const config = trialConfig(base(), { QUICKSTART_MODEL: "my-deployment" });
  assert.equal(config.llms.providers.openai.defaultModel, "my-deployment");
  assert.equal(config.cron.execution.defaultModel, "my-deployment");
  assert.equal(config.session.compactionModel, "my-deployment");
});

test("without QUICKSTART_MODEL the config's own models stay", () => {
  const config = trialConfig(base(), {});
  assert.equal(config.cron.execution.defaultModel, "gpt-4.1-mini");
  assert.equal(config.session.compactionModel, "gpt-5-mini");
});

test("on Cloudflare the trial turns sandboxes off", () => {
  assert.equal(trialConfig(base(), {}, "cloudflare").skills.sandbox.enabled, false);
  assert.equal(trialConfig(base(), {}, "azure").skills.sandbox.enabled, true);
});

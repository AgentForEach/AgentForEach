import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isModelAllowed } from "./model-policy.js";
import { resetLlmConfig } from "./config.js";
import { resetUsageConfigCache } from "../usage/config.js";
import { resetConfigCache } from "../utils/index.js";

const saved = process.env.CONFIG_FILE_JSON;
afterEach(() => {
  if (saved === undefined) delete process.env.CONFIG_FILE_JSON;
  else process.env.CONFIG_FILE_JSON = saved;
  resetConfigCache();
  resetLlmConfig();
  resetUsageConfigCache();
});

function useConfig(config: unknown) {
  const file = join(mkdtempSync(join(tmpdir(), "agentforeach-models-")), "config.json");
  writeFileSync(file, JSON.stringify(config));
  process.env.CONFIG_FILE_JSON = file;
  resetConfigCache();
  resetLlmConfig();
  resetUsageConfigCache();
}

test("without an allowlist, only priced models (and the default) may be requested", () => {
  useConfig({ llms: { providers: { openai: { defaultModel: "gpt-5-mini" } } } });
  assert.equal(isModelAllowed("openai", "gpt-5-mini"), true);
  assert.equal(isModelAllowed("openai", "gpt-4o"), true); // has a built-in price
  assert.equal(isModelAllowed("openai", "gpt-9-ultra"), false); // no price: would bill at fallback
});

test("a configured allowlist narrows the choice but never allows an unpriced model", () => {
  useConfig({ llms: { providers: { openai: { allowedModels: ["gpt-5*"] } } } });
  assert.equal(isModelAllowed("openai", "gpt-5-mini"), true);
  assert.equal(isModelAllowed("openai", "GPT-5.2"), true); // priced, any case
  assert.equal(isModelAllowed("openai", "gpt-4o"), false); // priced, not in the list
  assert.equal(isModelAllowed("openai", "gpt-5-pro"), false); // in the list, no price
});

test("operators can allow a model by pricing it", () => {
  useConfig({
    llms: { providers: { openai: { allowedModels: ["gpt-5*"] } } },
    usage: { pricing: { "gpt-5-pro": { inputPer1M: 15, outputPer1M: 120 } } },
  });
  assert.equal(isModelAllowed("openai", "gpt-5-pro"), true);
});

import { isOpenAIReasoningModel } from "./providers/openai.js";

test("sampling params are skipped for OpenAI reasoning models", () => {
  for (const m of ["gpt-5-mini", "GPT-5.2", "o3-mini", "o4-mini", "o1"]) assert.equal(isOpenAIReasoningModel(m), true, m);
  for (const m of ["gpt-4o", "gpt-4.1-mini"]) assert.equal(isOpenAIReasoningModel(m), false, m);
});

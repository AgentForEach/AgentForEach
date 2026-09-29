/**
 * AgentForEach LLM Module — Responses API config tests
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../utils/index.js";
import { resolveProviderConfig, resetLlmConfig } from "./config.js";
import { OpenAIProvider } from "./providers/openai.js";
import type { ProviderRequest } from "./types.js";

function resetAll(): void {
  resetConfigCache();
  resetLlmConfig();
}

test("resolveProviderConfig — reads Responses API controls from config", () => {
  const configPath = join(mkdtempSync(join(tmpdir(), "llm-config-")), "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      llms: {
        providers: {
          openai: {
            enabled: true,
            apiKey: "$OPENAI_API_KEY",
            defaultModel: "gpt-5-mini",
            responses: { truncation: "disabled", contextManagement: { enabled: true, compactThreshold: 75000 } },
          },
        },
      },
    }),
  );
  const previousConfig = process.env.CONFIG_FILE_JSON;
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.CONFIG_FILE_JSON = configPath;
  process.env.OPENAI_API_KEY = "test-key";
  resetAll();

  try {
    const cfg = resolveProviderConfig("openai");
    assert.ok(cfg);
    assert.equal(cfg.responses?.truncation, "disabled");
    assert.equal(cfg.responses?.contextManagement?.enabled, true);
    assert.equal(cfg.responses?.contextManagement?.compactThreshold, 75000);
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
    if (previousConfig === undefined) {
      delete process.env.CONFIG_FILE_JSON;
    } else {
      process.env.CONFIG_FILE_JSON = previousConfig;
    }
    resetAll();
  }
});

test("OpenAIProvider — maps configured truncation and context management", () => {
  const provider = new OpenAIProvider({
    apiKey: "test-key",
    defaultModel: "gpt-5-mini",
    responses: {
      truncation: "auto",
      contextManagement: {
        enabled: true,
        compactThreshold: 16000,
      },
    },
  });

  const request: ProviderRequest = {
    model: "gpt-5-mini",
    input: "hello",
  };

  const params = (
    provider as unknown as {
      buildRequestParams: (
        request: ProviderRequest,
        model: string,
      ) => Record<string, unknown>;
    }
  ).buildRequestParams(request, "gpt-5-mini");

  assert.equal(params.truncation, "auto");
  assert.deepStrictEqual(params.context_management, [
    { type: "compaction", compact_threshold: 16000 },
  ]);
});

test("OpenAIProvider — omits invalid context management thresholds", () => {
  const provider = new OpenAIProvider({
    apiKey: "test-key",
    defaultModel: "gpt-5-mini",
    responses: {
      contextManagement: {
        enabled: true,
        compactThreshold: 0,
      },
    },
  });

  const request: ProviderRequest = {
    model: "gpt-5-mini",
    input: "hello",
  };

  const params = (
    provider as unknown as {
      buildRequestParams: (
        request: ProviderRequest,
        model: string,
      ) => Record<string, unknown>;
    }
  ).buildRequestParams(request, "gpt-5-mini");

  assert.equal("context_management" in params, false);
});
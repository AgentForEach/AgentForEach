import test from "node:test";
import assert from "node:assert/strict";

import { OpenAIProvider } from "./openai.js";
import type { ProviderRequest } from "../types.js";

const provider = new OpenAIProvider({ apiKey: "test", defaultModel: "gpt-5.6-luna" } as never);
const build = (r: ProviderRequest) =>
  (provider as unknown as { buildRequestParams: (r: ProviderRequest, m: string) => Record<string, unknown> })
    .buildRequestParams(r, "gpt-5.6-luna");

test("requests carry a stable per-user prompt_cache_key, and no raw user or session id", () => {
  const req = (userId: string) =>
    ({ input: "hi", metadata: { userId, sessionId: "whatsapp-15551234567", runId: "r1" } }) as ProviderRequest;
  const a = build(req("whatsapp:+15551234567"));
  const again = build(req("whatsapp:+15551234567"));
  const other = build(req("whatsapp:+15557654321"));

  assert.equal(typeof a.prompt_cache_key, "string");
  assert.equal(a.prompt_cache_key, again.prompt_cache_key, "same user, same key");
  assert.notEqual(a.prompt_cache_key, other.prompt_cache_key);
  const wire = JSON.stringify(a);
  assert.ok(!wire.includes("15551234567"), "the phone number never reaches the provider");
  assert.equal((a.metadata as Record<string, string>).runId, "r1");
});

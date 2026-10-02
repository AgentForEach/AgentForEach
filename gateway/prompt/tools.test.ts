import test from "node:test";
import assert from "node:assert/strict";

import { getPromptToolDefinitions, PromptToolHandler, PROMPT_UPDATE_TOOL_NAME } from "./tools.js";
import type { PromptDocumentStore } from "./store.js";
import {
  setPromptConfigModeForTest,
  resetPromptConfigModeCache,
} from "./prompt-config.js";

function makeStoreMock() {
  const calls = {
    patchData: 0,
    completeOnboarding: 0,
  };

  const store: PromptDocumentStore = {
    patchData: async () => {
      calls.patchData += 1;
      return {
        id: "u:default:USER",
        userId: "u",
        agentId: "default",
        documentType: "USER",
        data: {},
        version: 2,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      } as any;
    },
    completeOnboarding: async () => {
      calls.completeOnboarding += 1;
    },
  } as unknown as PromptDocumentStore;

  return { store, calls };
}

test("prompt_update supports onboarding completion with updates", async () => {
  const { store, calls } = makeStoreMock();
  const handler = new PromptToolHandler(store);

  const raw = await handler.handle(
    PROMPT_UPDATE_TOOL_NAME,
    {
      documentType: "USER",
      updates: { name: "Alice" },
      completeOnboarding: true,
    },
    "u",
    "default",
  );

  const result = JSON.parse(raw) as {
    onboardingCompleted?: boolean;
    updated?: string[];
  };
  assert.equal(calls.patchData, 1);
  assert.equal(calls.completeOnboarding, 1);
  assert.equal(result.onboardingCompleted, true);
  assert.deepEqual(result.updated, ["name"]);
});

test("prompt_update allows empty updates when completeOnboarding=true", async () => {
  const { store, calls } = makeStoreMock();
  const handler = new PromptToolHandler(store);

  const raw = await handler.handle(
    PROMPT_UPDATE_TOOL_NAME,
    {
      documentType: "USER",
      updates: {},
      completeOnboarding: true,
    },
    "u",
    "default",
  );

  const result = JSON.parse(raw) as {
    onboardingCompleted?: boolean;
    error?: string;
  };
  assert.equal(result.error, undefined);
  assert.equal(result.onboardingCompleted, true);
  assert.equal(calls.patchData, 0);
  assert.equal(calls.completeOnboarding, 1);
});

test("prompt_update on BOOTSTRAP with completeOnboarding=true completes onboarding", async () => {
  const { store, calls } = makeStoreMock();
  const handler = new PromptToolHandler(store);

  const raw = await handler.handle(
    PROMPT_UPDATE_TOOL_NAME,
    { documentType: "BOOTSTRAP", updates: {}, completeOnboarding: true },
    "u",
    "default",
  );

  const result = JSON.parse(raw) as { onboardingCompleted?: boolean; error?: string };
  assert.equal(result.error, undefined);
  assert.equal(result.onboardingCompleted, true);
  assert.equal(calls.patchData, 0);
  assert.equal(calls.completeOnboarding, 1);
});

test("prompt_update on BOOTSTRAP without completeOnboarding is still refused", async () => {
  const { store, calls } = makeStoreMock();
  const handler = new PromptToolHandler(store);

  const raw = await handler.handle(
    PROMPT_UPDATE_TOOL_NAME,
    { documentType: "BOOTSTRAP", updates: { step: "done" } },
    "u",
    "default",
  );

  const result = JSON.parse(raw) as { error?: string };
  assert.match(result.error ?? "", /BOOTSTRAP/);
  assert.equal(calls.patchData, 0);
  assert.equal(calls.completeOnboarding, 0);
});

test("static mode: completeOnboarding=true on IDENTITY completes onboarding without writing", async () => {
  setPromptConfigModeForTest("static");
  try {
    const { store, calls } = makeStoreMock();
    const handler = new PromptToolHandler(store);

    const raw = await handler.handle(
      PROMPT_UPDATE_TOOL_NAME,
      { documentType: "IDENTITY", updates: { name: "Aria" }, completeOnboarding: true },
      "u",
      "default",
    );

    const result = JSON.parse(raw) as { onboardingCompleted?: boolean; updated?: string[] };
    assert.equal(result.onboardingCompleted, true);
    assert.deepEqual(result.updated, []);
    assert.equal(calls.patchData, 0);
    assert.equal(calls.completeOnboarding, 1);
  } finally {
    resetPromptConfigModeCache();
  }
});

// ============================================================================
// Static mode — prompt_update enforcement
// ============================================================================

test("static mode: prompt_update rejects IDENTITY update", async () => {
  setPromptConfigModeForTest("static");
  try {
    const { store } = makeStoreMock();
    const handler = new PromptToolHandler(store);

    const raw = await handler.handle(
      PROMPT_UPDATE_TOOL_NAME,
      { documentType: "IDENTITY", updates: { name: "Aria" } },
      "u",
      "default",
    );

    const result = JSON.parse(raw) as { error?: string };
    assert.ok(result.error, "Expected an error for static IDENTITY update");
    assert.match(result.error, /static/i);
    assert.match(result.error, /read-only/i);
  } finally {
    resetPromptConfigModeCache();
  }
});

test("static mode: prompt_update rejects SOUL update", async () => {
  setPromptConfigModeForTest("static");
  try {
    const { store } = makeStoreMock();
    const handler = new PromptToolHandler(store);

    const raw = await handler.handle(
      PROMPT_UPDATE_TOOL_NAME,
      { documentType: "SOUL", updates: { vibe: "mysterious" } },
      "u",
      "default",
    );

    const result = JSON.parse(raw) as { error?: string };
    assert.ok(result.error, "Expected an error for static SOUL update");
    assert.match(result.error, /static/i);
  } finally {
    resetPromptConfigModeCache();
  }
});

test("static mode: prompt_update allows USER update", async () => {
  setPromptConfigModeForTest("static");
  try {
    const { store, calls } = makeStoreMock();
    const handler = new PromptToolHandler(store);

    const raw = await handler.handle(
      PROMPT_UPDATE_TOOL_NAME,
      { documentType: "USER", updates: { name: "Alice" } },
      "u",
      "default",
    );

    const result = JSON.parse(raw) as { error?: string; updated?: string[] };
    assert.equal(result.error, undefined);
    assert.deepEqual(result.updated, ["name"]);
    assert.equal(calls.patchData, 1);
  } finally {
    resetPromptConfigModeCache();
  }
});

test("static mode: preferences on any subject can be saved, and the tool says where they go", async () => {
  setPromptConfigModeForTest("static");
  try {
    const { store, calls } = makeStoreMock();
    const handler = new PromptToolHandler(store);
    const preferences = ["Prefers coffee over tea", "When a website asks for a human check, hand me the browser without asking"];
    const raw = await handler.handle(PROMPT_UPDATE_TOOL_NAME, { documentType: "USER", updates: { preferences } }, "u", "default");
    const result = JSON.parse(raw) as { error?: string; updated?: string[] };
    assert.equal(result.error, undefined);
    assert.deepEqual(result.updated, ["preferences"]);
    assert.equal(calls.patchData, 1);

    const description = getPromptToolDefinitions().find((t) => t.name === PROMPT_UPDATE_TOOL_NAME)!.description;
    assert.match(description, /USER\.preferences = anything the user tells you they prefer/);
    assert.match(description, /preferences \(string\[\]\)/, "listed among the writable USER fields");
  } finally {
    resetPromptConfigModeCache();
  }
});

test("dynamic mode: prompt_update allows IDENTITY update", async () => {
  setPromptConfigModeForTest("dynamic");
  try {
    const { store, calls } = makeStoreMock();
    const handler = new PromptToolHandler(store);

    const raw = await handler.handle(
      PROMPT_UPDATE_TOOL_NAME,
      { documentType: "IDENTITY", updates: { name: "Aria" } },
      "u",
      "default",
    );

    const result = JSON.parse(raw) as { error?: string; updated?: string[] };
    assert.equal(result.error, undefined);
    assert.deepEqual(result.updated, ["name"]);
    assert.equal(calls.patchData, 1);
  } finally {
    resetPromptConfigModeCache();
  }
});

import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryStorage, type Collection } from "@agentforeach/storage";
import { PromptDocumentStore } from "./store.js";
import { DEFAULT_TEMPLATES } from "./templates.js";
import {
  resetPromptConfigModeCache,
  setPromptConfigModeForTest,
} from "./prompt-config.js";
import type { OnboardingState, PromptDocument } from "./types.js";

async function setupStore(): Promise<PromptDocumentStore> {
  const store = new PromptDocumentStore(new InMemoryStorage());
  await store.initialize();
  return store;
}

test("seedDefaults creates all prompt docs for new user", async () => {
  const store = await setupStore();
  const seeded = await store.seedDefaults("u1", "default");

  assert.equal(seeded.length, 8);
  assert.ok(seeded.includes("BOOTSTRAP"));

  const docs = await store.loadAll("u1", "default");
  assert.equal(docs.size, 8);
});

test("seedDefaults repairs malformed existing docs", async () => {
  const store = await setupStore();

  await store.upsertData("u2", "default", "AGENTS", {});
  const seeded = await store.seedDefaults("u2", "default");
  assert.ok(seeded.length >= 1);

  const agents = await store.getData("u2", "default", "AGENTS");
  assert.ok(agents);
  assert.equal(typeof (agents as Record<string, unknown>).contextGuide, "string");
});

test("seedDefaults removes stale BOOTSTRAP when onboarding already completed", async () => {
  const store = await setupStore();
  await store.seedDefaults("u3", "default");
  await store.completeOnboarding("u3", "default");

  // Recreate stale BOOTSTRAP manually (simulates legacy bad state)
  const staleBootstrap: PromptDocument = {
    id: "u3:default:BOOTSTRAP",
    userId: "u3",
    agentId: "default",
    documentType: "BOOTSTRAP",
    data: "legacy" as unknown as PromptDocument["data"],
    version: 1,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  const promptContainer = (store as unknown as { promptContainer: Collection<PromptDocument> }).promptContainer;
  await promptContainer.upsert(staleBootstrap);

  await store.seedDefaults("u3", "default");
  const bootstrap = await store.load("u3", "default", "BOOTSTRAP");
  assert.equal(bootstrap, null);
});

test("seedDefaults refreshes a locked doc seeded from an older template", async () => {
  setPromptConfigModeForTest("static");
  try {
    const store = await setupStore();
    await store.seedDefaults("u-refresh", "default");

    // Simulate a doc seeded by an older config: same type, different content.
    await store.upsertData("u-refresh", "default", "TOOLS", {
      notes: "Old workflow: complete any new contract in ~8-10 tool rounds",
    });

    await store.seedDefaults("u-refresh", "default");
    const tools = await store.getData("u-refresh", "default", "TOOLS");
    assert.deepEqual(
      tools,
      DEFAULT_TEMPLATES.TOOLS,
      "a locked doc that drifted from the template must be refreshed on seed",
    );
  } finally {
    resetPromptConfigModeCache();
  }
});

test("seedDefaults never touches USER, the one doc with a write path", async () => {
  setPromptConfigModeForTest("static");
  try {
    const store = await setupStore();
    await store.seedDefaults("u-user", "default");
    await store.upsertData("u-user", "default", "USER", {
      aboutMe: "prefers plain-language summaries",
    } as never);

    await store.seedDefaults("u-user", "default");
    const user = await store.getData("u-user", "default", "USER");
    assert.deepEqual(user, { aboutMe: "prefers plain-language summaries" });
  } finally {
    resetPromptConfigModeCache();
  }
});

test("seedDefaults leaves drifted docs alone in dynamic mode", async () => {
  setPromptConfigModeForTest("dynamic");
  try {
    const store = await setupStore();
    await store.seedDefaults("u-dyn", "default");
    await store.upsertData("u-dyn", "default", "TOOLS", {
      notes: "the agent edited this deliberately",
    });

    await store.seedDefaults("u-dyn", "default");
    const tools = await store.getData("u-dyn", "default", "TOOLS");
    assert.deepEqual(tools, { notes: "the agent edited this deliberately" });
  } finally {
    resetPromptConfigModeCache();
  }
});

test("patchData merges nested object and removes null keys", async () => {
  const store = await setupStore();
  await store.upsertData("u4", "default", "TOOLS", {
    notes: "n1",
    integrations: {
      calendar: "old",
      jira: "keep",
    },
  });

  const updated = await store.patchData("u4", "default", "TOOLS", {
    integrations: {
      calendar: "new",
      jira: null as unknown as string,
      slack: "added",
    },
  });

  const integrations = (updated.data as Record<string, unknown>).integrations as Record<string, unknown>;
  assert.equal(integrations.calendar, "new");
  assert.equal(integrations.slack, "added");
  assert.equal("jira" in integrations, false);
});

test("isOnboardingPending is false when completed state exists", async () => {
  const store = await setupStore();
  await store.seedDefaults("u5", "default");
  await store.completeOnboarding("u5", "default");

  const pending = await store.isOnboardingPending("u5", "default");
  assert.equal(pending, false);
});

test("isOnboardingPending is true when bootstrap exists and not completed", async () => {
  const store = await setupStore();
  await store.seedDefaults("u6", "default");
  const pending = await store.isOnboardingPending("u6", "default");
  assert.equal(pending, true);
});

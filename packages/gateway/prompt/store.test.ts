import test from "node:test";
import assert from "node:assert/strict";

import type {
  BaseDocument,
  ContainerHandle,
  ContainerOptions,
  DatabaseProvider,
  PatchOperation,
  QueryOptions,
  QueryParameter,
} from "../database/index.js";
import { PromptDocumentStore } from "./store.js";
import { DEFAULT_TEMPLATES } from "./templates.js";
import {
  resetPromptConfigModeCache,
  setPromptConfigModeForTest,
} from "./prompt-config.js";
import type { OnboardingState, PromptDocument } from "./types.js";

class InMemoryContainer<T extends BaseDocument> implements ContainerHandle<T> {
  private docs = new Map<string, T>();

  async create(document: T): Promise<T> {
    this.docs.set(document.id, structuredClone(document));
    return structuredClone(document);
  }

  async upsert(document: T): Promise<T> {
    this.docs.set(document.id, structuredClone(document));
    return structuredClone(document);
  }

  async read(id: string, partitionKey: string): Promise<T | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    if ((doc as Record<string, unknown>).userId !== partitionKey) return null;
    return structuredClone(doc);
  }

  async replace(id: string, partitionKey: string, document: T): Promise<T> {
    const existing = await this.read(id, partitionKey);
    if (!existing) throw new Error("not found");
    this.docs.set(id, structuredClone(document));
    return structuredClone(document);
  }

  async patch(
    id: string,
    partitionKey: string,
    operations: PatchOperation[],
  ): Promise<T> {
    const existing = await this.read(id, partitionKey);
    if (!existing) throw new Error("not found");
    const target = existing as unknown as Record<string, unknown>;

    for (const op of operations) {
      const path = op.path.replace(/^\//, "").split("/");
      if (path.length === 0) continue;

      if (op.op === "remove") {
        const key = path[path.length - 1];
        let ptr = target;
        for (let i = 0; i < path.length - 1; i += 1) {
          ptr = ptr[path[i]] as Record<string, unknown>;
        }
        delete ptr[key];
        continue;
      }

      if (op.op === "incr") {
        const key = path[path.length - 1];
        let ptr = target;
        for (let i = 0; i < path.length - 1; i += 1) {
          ptr = ptr[path[i]] as Record<string, unknown>;
        }
        ptr[key] = Number(ptr[key] ?? 0) + Number(op.value ?? 0);
        continue;
      }

      if (op.op === "set") {
        const key = path[path.length - 1];
        let ptr = target;
        for (let i = 0; i < path.length - 1; i += 1) {
          const current = ptr[path[i]];
          if (!current || typeof current !== "object") {
            ptr[path[i]] = {};
          }
          ptr = ptr[path[i]] as Record<string, unknown>;
        }
        ptr[key] = op.value;
      }
    }

    this.docs.set(id, structuredClone(existing));
    return structuredClone(existing);
  }

  async delete(id: string, partitionKey: string): Promise<boolean> {
    const existing = await this.read(id, partitionKey);
    if (!existing) return false;
    this.docs.delete(id);
    return true;
  }

  async query<R = T>(_querySpec: unknown, options: QueryOptions = {}): Promise<R[]> {
    const partitionKey = options.partitionKey;
    const out: unknown[] = [];
    for (const doc of this.docs.values()) {
      if (
        partitionKey !== undefined &&
        (doc as Record<string, unknown>).userId !== partitionKey
      ) {
        continue;
      }
      out.push(structuredClone(doc));
    }
    return out as R[];
  }

  async queryWithParams<R = T>(
    sql: string,
    parameters: QueryParameter[] = [],
    options: QueryOptions = {},
  ): Promise<R[]> {
    const userId = parameters.find((p) => p.name === "@userId")?.value;
    const agentId = parameters.find((p) => p.name === "@agentId")?.value;

    if (typeof userId === "string" && typeof agentId === "string") {
      const out: unknown[] = [];
      for (const doc of this.docs.values()) {
        const obj = doc as Record<string, unknown>;
        if (obj.userId === userId && obj.agentId === agentId) {
          out.push(structuredClone(doc));
        }
      }
      return out as R[];
    }

    return this.query<R>(sql, options);
  }

  async count(): Promise<number> {
    return this.docs.size;
  }

  getRawContainer(): unknown {
    return this.docs;
  }
}

class InMemoryDatabaseProvider implements DatabaseProvider {
  readonly name = "memory";
  private containers = new Map<string, InMemoryContainer<BaseDocument>>();

  async initialize(): Promise<void> {
    return;
  }

  async getOrCreateContainer<T extends BaseDocument = BaseDocument>(
    options: ContainerOptions,
  ): Promise<ContainerHandle<T>> {
    const id = options.id;
    if (!id) throw new Error("container id required");

    const existing = this.containers.get(id);
    if (existing) return existing as unknown as ContainerHandle<T>;

    const container = new InMemoryContainer<BaseDocument>();
    this.containers.set(id, container);
    return container as unknown as ContainerHandle<T>;
  }

  getDatabaseId(): string {
    return "memory";
  }
}

async function setupStore(): Promise<PromptDocumentStore> {
  const db = new InMemoryDatabaseProvider();
  const store = new PromptDocumentStore(db);
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

  const promptContainer = (store as unknown as { promptContainer: ContainerHandle<PromptDocument> }).promptContainer;
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

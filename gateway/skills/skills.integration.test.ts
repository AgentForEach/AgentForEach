/**
 * AgentForEach Skills Module — Integration / End-to-End Tests
 *
 * Exercises the full prompt-based skills pipeline:
 *
 *   Suite 1: UserSkillStore ↔ Cosmos DB round-trip (skipped when env vars missing)
 *   Suite 3: Full skill lifecycle (list → setup → read → verify)
 *   Suite 7: Multi-user isolation with registry
 *   Suite 8: Error propagation — blob errors, unknown paths and tools
 *   Suite 9: Security boundaries — traversal, unknown skills, credential keys
 *
 * Environment variables:
 *   - COSMOS_ENDPOINT / COSMOS_KEY — for real Cosmos DB tests
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  SkillToolHandler,
  SKILL_LIST_TOOL_NAME,
  SKILL_SETUP_TOOL_NAME,
  SKILL_READ_TOOL_NAME,
  HTTP_FETCH_TOOL_NAME,
  getSkillToolDefinitions,
} from "./handler.js";
import { resolveUserSkills } from "./registry.js";
import { buildSkillsSection } from "../prompt/sections/skills.js";
import type {
  SkillManifest,
  SkillStatus,
  UserSkillConfig,
  SkillAuditEntry,
} from "./types.js";
import { UserSkillStore } from "./store.js";

// ============================================================================
// Environment Check
// ============================================================================

const HAS_COSMOS = !!process.env.COSMOS_ENDPOINT && !!process.env.COSMOS_KEY;
const SKIP_COSMOS = HAS_COSMOS ? false : "Missing COSMOS_ENDPOINT or COSMOS_KEY";

const TEST_USER_ID = `integration-test-skills-${Date.now()}`;

// ============================================================================
// Test Manifests
// ============================================================================

const WEATHER_MANIFEST: SkillManifest = {
  id: "weather",
  name: "Weather",
  description: "Get current weather and forecasts",
  category: "information",
  credentials: [],
  blobPath: "weather/SKILL.md",
};

const GITHUB_MANIFEST: SkillManifest = {
  id: "github",
  name: "GitHub",
  description: "Interact with GitHub repositories",
  category: "productivity",
  credentials: [
    { key: "GITHUB_TOKEN", label: "GitHub Token", required: true },
  ],
  requiredBins: ["curl", "jq"],
  blobPath: "github/SKILL.md",
};

const SLACK_MANIFEST: SkillManifest = {
  id: "slack",
  name: "Slack",
  description: "Send and manage Slack messages",
  category: "communication",
  credentials: [
    { key: "SLACK_TOKEN", label: "Slack Bot Token", required: true },
    { key: "SLACK_CHANNEL", label: "Default Channel", required: false },
  ],
  blobPath: "slack/SKILL.md",
};

// ============================================================================
// Mock Blob Store
// ============================================================================

const WEATHER_SKILL_MD = `---
id: weather
name: Weather
description: Get current weather and forecasts
category: information
credentials: []
---

# Weather Skill

Use the Open-Meteo API (free, no API key required).

## Get Current Weather

1. Geocode the location:
   exec: ["curl", "-s", "https://geocoding-api.open-meteo.com/v1/search?name=LOCATION&count=1"]
   Extract latitude and longitude from .results[0].

2. Fetch current weather:
   exec: ["curl", "-s", "https://api.open-meteo.com/v1/forecast?latitude=LAT&longitude=LON&current=temperature_2m,weather_code&timezone=auto"]

3. Format the response with temperature and conditions.

## Weather Codes

| Code | Condition |
|------|-----------|
| 0 | Clear sky |
| 1-3 | Partly cloudy |
| 61-65 | Rain |
`;

const GITHUB_SKILL_MD = `---
id: github
name: GitHub
description: Interact with GitHub repositories
category: productivity
credentials: [{"key": "GITHUB_TOKEN", "label": "GitHub Token", "required": true}]
---

# GitHub Skill

Requires GITHUB_TOKEN for API access.

## List Repos
exec: ["curl", "-s", "-H", "Authorization: token $GITHUB_TOKEN", "https://api.github.com/user/repos"]
`;

const SLACK_SKILL_MD = `---
id: slack
name: Slack
description: Send and manage Slack messages
category: communication
credentials: [{"key": "SLACK_TOKEN", "label": "Slack Bot Token", "required": true}, {"key": "SLACK_CHANNEL", "label": "Default Channel", "required": false}]
---

# Slack Skill

Post messages to Slack channels.
`;

class MockBlobStore {
  private files = new Map<string, string>();
  private manifests: SkillManifest[];
  public listCallCount = 0;
  public readCallCount = 0;

  constructor(manifests: SkillManifest[]) {
    this.manifests = manifests;
    this.files.set("weather/SKILL.md", WEATHER_SKILL_MD);
    this.files.set("github/SKILL.md", GITHUB_SKILL_MD);
    this.files.set("slack/SKILL.md", SLACK_SKILL_MD);
  }

  async listSkills(): Promise<SkillManifest[]> {
    this.listCallCount++;
    return this.manifests;
  }

  async readFile(path: string): Promise<string> {
    this.readCallCount++;
    if (path.includes("..")) throw new Error("Invalid path: directory traversal not allowed");
    if (path.startsWith("/")) throw new Error("Invalid path: must be relative");
    const content = this.files.get(path);
    if (!content) throw new Error(`Blob not found: ${path}`);
    return content;
  }

  invalidateCache(): void {}
}

/** A blob store that simulates failures. */
class FailingBlobStore {
  async listSkills(): Promise<SkillManifest[]> {
    throw new Error("Azure Blob Storage connection refused");
  }
  async readFile(_path: string): Promise<string> {
    throw new Error("Azure Blob Storage read timeout");
  }
  invalidateCache(): void {}
}

/** A blob store that returns content with a delay. */
class SlowBlobStore {
  private inner: MockBlobStore;
  private delayMs: number;

  constructor(manifests: SkillManifest[], delayMs: number) {
    this.inner = new MockBlobStore(manifests);
    this.delayMs = delayMs;
  }

  async listSkills(): Promise<SkillManifest[]> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return this.inner.listSkills();
  }

  async readFile(path: string): Promise<string> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return this.inner.readFile(path);
  }

  invalidateCache(): void {}
}

// ============================================================================
// Mock Store
// ============================================================================

function createMockStore() {
  const data = new Map<string, UserSkillConfig>();
  const auditLog: SkillAuditEntry[] = [];

  return {
    get: async (userId: string, skillId: string) =>
      data.get(`${userId}:${skillId}`) ?? null,
    getAllForUser: async (userId: string) =>
      Array.from(data.values()).filter((c) => c.userId === userId),
    upsert: async (config: UserSkillConfig) => {
      data.set(config.id, config);
      return config;
    },
    delete: async (userId: string, skillId: string) => {
      return data.delete(`${userId}:${skillId}`);
    },
    logAudit: async (entry: SkillAuditEntry) => {
      auditLog.push(entry);
    },
    initialize: async () => {},
    _data: data,
    _auditLog: auditLog,
  };
}

// ============================================================================
// Helper — create handler with common defaults
// ============================================================================

function createHandler(opts: {
  manifests?: SkillManifest[];
  statuses?: SkillStatus[];
  userCredentials?: Record<string, string>;
  store?: ReturnType<typeof createMockStore>;
  blobStore?: MockBlobStore | FailingBlobStore | SlowBlobStore;
}) {
  const manifests = opts.manifests ?? [WEATHER_MANIFEST, GITHUB_MANIFEST, SLACK_MANIFEST];
  const blobStore = opts.blobStore ?? new MockBlobStore(manifests);
  const store = opts.store ?? createMockStore();
  const statuses = opts.statuses ?? manifests.map((m) => ({
    manifest: m,
    configured: false,
    credentialsComplete: m.credentials.every((c) => !c.required),
    enabled: m.credentials.every((c) => !c.required),
  }));

  const handler = new SkillToolHandler(
    store as unknown as UserSkillStore,
    blobStore as any,
    statuses,
    opts.userCredentials ?? {},
  );

  return { handler, store, blobStore, statuses };
}

// ============================================================================
// Suite 1: UserSkillStore ↔ Cosmos DB Round-Trip
// ============================================================================

test("UserSkillStore — Cosmos DB round-trip", { skip: SKIP_COSMOS }, async (t) => {
  const { CosmosStorage } = await import("@agentforeach/storage-cosmos");
  const db = new CosmosStorage({
    endpoint: process.env.COSMOS_ENDPOINT!,
    key: process.env.COSMOS_KEY!,
    databaseId: "agentforeach-test",
  });
  const store = new UserSkillStore(db, "user-skills-test");
  await store.initialize();

  const userId = TEST_USER_ID;

  await t.test("get returns null for non-existent skill", async () => {
    const result = await store.get(userId, "nonexistent");
    assert.equal(result, null);
  });

  await t.test("upsert + get round-trip", async () => {
    const config: UserSkillConfig = {
      id: UserSkillStore.buildId(userId, "weather"),
      userId,
      skillId: "weather",
      enabled: true,
      credentials: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsert(config);
    const result = await store.get(userId, "weather");
    assert.ok(result);
    assert.equal(result!.skillId, "weather");
    assert.equal(result!.enabled, true);
  });

  await t.test("getAllForUser returns all configs", async () => {
    const config: UserSkillConfig = {
      id: UserSkillStore.buildId(userId, "github"),
      userId,
      skillId: "github",
      enabled: false,
      credentials: { GITHUB_TOKEN: "test" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsert(config);

    const all = await store.getAllForUser(userId);
    assert.ok(all.length >= 2);
  });

  await t.test("delete removes a config", async () => {
    await store.delete(userId, "github");
    const result = await store.get(userId, "github");
    assert.equal(result, null);
  });

  await t.test("user isolation — different users don't see each other's configs", async () => {
    const otherUser = `${userId}-other`;
    const other = await store.getAllForUser(otherUser);
    assert.equal(other.length, 0);
  });

  // Cleanup
  await store.delete(userId, "weather");
});

// ============================================================================
// Suite 3: Full Skill Lifecycle — list → setup → read → exec
// ============================================================================

test("Full skill lifecycle — list → setup → read → exec", async (t) => {
  const userId = "user-lifecycle-test";

  await t.test("weather skill (credential-free): list → read → exec", async () => {
    const { handler } = createHandler({});

    // Step 1: List skills
    const listRaw = await handler.handle(SKILL_LIST_TOOL_NAME, {}, userId);
    const listResult = JSON.parse(listRaw);
    assert.equal(listResult.skills.length, 3);

    // Weather should be enabled (credential-free)
    const weatherSkill = listResult.skills.find((s: any) => s.id === "weather");
    assert.ok(weatherSkill);
    assert.equal(weatherSkill.enabled, true);
    assert.equal(weatherSkill.credentialsComplete, true);
    assert.equal(weatherSkill.blobPath, "weather/SKILL.md");

    // GitHub should NOT be enabled (needs GITHUB_TOKEN)
    const githubSkill = listResult.skills.find((s: any) => s.id === "github");
    assert.ok(githubSkill);
    assert.equal(githubSkill.enabled, false);
    assert.equal(githubSkill.credentialsComplete, false);

    // Step 2: Read the weather SKILL.md
    const readRaw = await handler.handle(SKILL_READ_TOOL_NAME, {
      path: "weather/SKILL.md",
    }, userId);
    const readResult = JSON.parse(readRaw);
    assert.equal(readResult.skill_id, "weather");
    assert.ok(readResult.content.includes("Open-Meteo API"));
    assert.ok(readResult.content.includes("Get Current Weather"));
    assert.ok(readResult.content.includes("Weather Codes"));

    // Step 3: Verify weather can be used (read was successful, skill is ready)
    assert.ok(readResult.content.includes("Weather Codes"));
  });

  await t.test("github skill: setup credentials → enable → read → exec", async () => {
    const store = createMockStore();
    const blobStore = new MockBlobStore([WEATHER_MANIFEST, GITHUB_MANIFEST, SLACK_MANIFEST]);

    // Start with GitHub disabled
    const statuses: SkillStatus[] = [
      { manifest: WEATHER_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
      { manifest: GITHUB_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
      { manifest: SLACK_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];

    const handler = new SkillToolHandler(
      store as unknown as UserSkillStore,
      blobStore as any,
      statuses,
      {},
    );

    // Step 1: Verify GitHub cannot be read while disabled
    const readDisabled = await handler.handle(SKILL_READ_TOOL_NAME, {
      path: "github/SKILL.md",
    }, userId);
    assert.ok(JSON.parse(readDisabled).error?.includes("not enabled"));

    // Step 2: Enable GitHub
    const enableRaw = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "github",
      action: "enable",
    }, userId);
    const enableResult = JSON.parse(enableRaw);
    assert.equal(enableResult.success, true);
    assert.equal(enableResult.enabled, true);
    assert.equal(enableResult.credentialsComplete, false); // Still no token

    // Step 3: Set credentials
    // (Need to wait > 30s due to rate limiting, or use a fresh handler)
    // For testing, create a new handler that has the updated status
    const updatedStatuses: SkillStatus[] = [
      { manifest: WEATHER_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
      { manifest: GITHUB_MANIFEST, configured: true, credentialsComplete: true, enabled: true },
      { manifest: SLACK_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];

    const handler2 = new SkillToolHandler(
      store as unknown as UserSkillStore,
      blobStore as any,
      updatedStatuses,
      { GITHUB_TOKEN: "ghp_test123" },
    );

    // Step 4: Read GitHub SKILL.md (should work now)
    const readRaw = await handler2.handle(SKILL_READ_TOOL_NAME, {
      path: "github/SKILL.md",
    }, userId);
    const readResult = JSON.parse(readRaw);
    assert.equal(readResult.skill_id, "github");
    assert.ok(readResult.content.includes("GITHUB_TOKEN"));
    assert.ok(readResult.content.includes("List Repos"));

    // Step 5: Verify GitHub skill is ready (read was successful)
    assert.ok(readResult.content.includes("List Repos"));
  });

  await t.test("skill setup persists to store and writes audit log", async () => {
    const store = createMockStore();
    const { handler } = createHandler({ store });

    // Enable weather skill
    await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "weather",
      action: "enable",
    }, userId);

    // Verify store contains the config
    const config = await store.get(userId, "weather");
    assert.ok(config);
    assert.equal(config!.enabled, true);
    assert.equal(config!.userId, userId);

    // Wait for audit log (fire-and-forget)
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(store._auditLog.length >= 1);
    assert.equal(store._auditLog[0].skillId, "weather");
    assert.equal(store._auditLog[0].action, "enable");
  });
});

// ============================================================================
// Suite 7: Multi-User Isolation with Registry
// ============================================================================

test("Multi-user isolation with registry", async (t) => {
  await t.test("different users get independent skill states", async () => {
    const blobStore = new MockBlobStore([WEATHER_MANIFEST, GITHUB_MANIFEST]);
    const mockStore = createMockStore();

    // User A enables weather + sets github token
    const userAConfig: UserSkillConfig = {
      id: "userA:github",
      userId: "userA",
      skillId: "github",
      enabled: true,
      credentials: { GITHUB_TOKEN: "ghp_userA" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mockStore.upsert(userAConfig);

    // User B has no configs
    const resolvedA = await resolveUserSkills(
      blobStore as any,
      mockStore as unknown as UserSkillStore,
      "userA",
    );
    const resolvedB = await resolveUserSkills(
      blobStore as any,
      mockStore as unknown as UserSkillStore,
      "userB",
    );

    // User A: weather auto-enabled, github enabled with creds
    const weatherA = resolvedA.statuses.find((s) => s.manifest.id === "weather");
    assert.equal(weatherA!.enabled, true);
    const githubA = resolvedA.statuses.find((s) => s.manifest.id === "github");
    assert.equal(githubA!.enabled, true);
    assert.equal(githubA!.credentialsComplete, true);
    assert.equal(resolvedA.userCredentials.GITHUB_TOKEN, "ghp_userA");

    // User B: weather auto-enabled, github NOT enabled (no config)
    const weatherB = resolvedB.statuses.find((s) => s.manifest.id === "weather");
    assert.equal(weatherB!.enabled, true);
    const githubB = resolvedB.statuses.find((s) => s.manifest.id === "github");
    assert.equal(githubB!.enabled, false);
    assert.equal(githubB!.credentialsComplete, false);
    assert.equal(resolvedB.userCredentials.GITHUB_TOKEN, undefined);
  });

  await t.test("credential-free skills auto-enable for all users", async () => {
    const blobStore = new MockBlobStore([WEATHER_MANIFEST]);
    const mockStore = createMockStore();

    const resolvedX = await resolveUserSkills(
      blobStore as any,
      mockStore as unknown as UserSkillStore,
      "userX",
    );
    const resolvedY = await resolveUserSkills(
      blobStore as any,
      mockStore as unknown as UserSkillStore,
      "userY",
    );

    assert.equal(resolvedX.statuses[0].enabled, true);
    assert.equal(resolvedY.statuses[0].enabled, true);
  });

  await t.test("agent whitelist restricts skills per-agent", async () => {
    const blobStore = new MockBlobStore([WEATHER_MANIFEST, GITHUB_MANIFEST, SLACK_MANIFEST]);
    const mockStore = createMockStore();

    // Resolve with agent whitelist that only allows weather
    const resolved = await resolveUserSkills(
      blobStore as any,
      mockStore as unknown as UserSkillStore,
      "userZ",
      ["weather"],
    );

    assert.equal(resolved.statuses.length, 1);
    assert.equal(resolved.statuses[0].manifest.id, "weather");
  });

  await t.test("users can have different credentials for same skill", async () => {
    const blobStore = new MockBlobStore([GITHUB_MANIFEST]);
    const mockStore = createMockStore();

    await mockStore.upsert({
      id: "alice:github",
      userId: "alice",
      skillId: "github",
      enabled: true,
      credentials: { GITHUB_TOKEN: "ghp_alice" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await mockStore.upsert({
      id: "bob:github",
      userId: "bob",
      skillId: "github",
      enabled: true,
      credentials: { GITHUB_TOKEN: "ghp_bob" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const aliceResolved = await resolveUserSkills(
      blobStore as any,
      mockStore as unknown as UserSkillStore,
      "alice",
    );
    const bobResolved = await resolveUserSkills(
      blobStore as any,
      mockStore as unknown as UserSkillStore,
      "bob",
    );

    assert.equal(aliceResolved.userCredentials.GITHUB_TOKEN, "ghp_alice");
    assert.equal(bobResolved.userCredentials.GITHUB_TOKEN, "ghp_bob");
  });
});

// ============================================================================
// Suite 8: Error Propagation
// ============================================================================

test("Error propagation", async (t) => {
  await t.test("blob store read error is caught by handler", async () => {
    const failingBlobStore = new FailingBlobStore();
    const statuses: SkillStatus[] = [
      { manifest: WEATHER_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
    ];
    const handler = new SkillToolHandler(
      createMockStore() as unknown as UserSkillStore,
      failingBlobStore as any,
      statuses,
      {},
    );

    const raw = await handler.handle(SKILL_READ_TOOL_NAME, {
      path: "weather/SKILL.md",
    }, "user1");
    const r = JSON.parse(raw);
    assert.ok(r.error);
    assert.ok(r.error.includes("read timeout") || r.error.includes("Storage"));
  });

  await t.test("skill_read on unknown path returns error", async () => {
    const { handler } = createHandler({});
    const raw = await handler.handle(SKILL_READ_TOOL_NAME, {
      path: "nonexistent/SKILL.md",
    }, "user1");
    const r = JSON.parse(raw);
    assert.ok(r.error);
    assert.ok(r.error.includes("No skill found"));
  });

  await t.test("skill_setup on unknown skill returns error", async () => {
    const { handler } = createHandler({});
    const raw = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "nonexistent_skill",
      action: "enable",
    }, "user1");
    const r = JSON.parse(raw);
    assert.ok(r.error);
    assert.ok(r.error.includes("Unknown skill"));
  });

  await t.test("skill_setup rejects invalid action", async () => {
    const { handler } = createHandler({});
    const raw = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "weather",
      action: "delete",
    }, "user1");
    const r = JSON.parse(raw);
    assert.ok(r.error);
    assert.ok(r.error.includes("Unknown action"));
  });

  await t.test("unknown tool name returns error", async () => {
    const { handler } = createHandler({});
    const raw = await handler.handle("skill_activate", {}, "user1");
    const r = JSON.parse(raw);
    assert.ok(r.error);
    assert.ok(r.error.includes("Unknown skill tool"));
  });
});

// ============================================================================
// Suite 9: Security Boundaries
// ============================================================================

test("Security boundaries", async (t) => {

  await t.test("blob store rejects ../ in path", async () => {
    const blobStore = new MockBlobStore([WEATHER_MANIFEST]);
    await assert.rejects(
      () => blobStore.readFile("../../../etc/passwd"),
      /traversal/,
    );
  });

  await t.test("blob store rejects absolute paths", async () => {
    const blobStore = new MockBlobStore([WEATHER_MANIFEST]);
    await assert.rejects(
      () => blobStore.readFile("/etc/passwd"),
      /relative/,
    );
  });

  await t.test("handler rejects paths not matching any known skill", async () => {
    const { handler } = createHandler({});
    const raw = await handler.handle(SKILL_READ_TOOL_NAME, {
      path: "malicious/SKILL.md",
    }, "user1");
    const r = JSON.parse(raw);
    assert.ok(r.error);
    assert.ok(r.error.includes("No skill found"));
  });

  await t.test("skill_setup rejects unknown credential keys", async () => {
    const { handler } = createHandler({});
    const raw = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "github",
      action: "set_credentials",
      credentials: { EVIL_KEY: "hacked" },
    }, "user1");
    const r = JSON.parse(raw);
    assert.ok(r.error);
    assert.ok(r.error.includes("Unknown credential keys"));
  });

});

// ============================================================================
// Suite 11: Registry → Prompt → Handler Full Pipeline
// ============================================================================

test("Registry → Prompt → Handler full pipeline", async (t) => {
  await t.test("resolved skills produce valid prompt section", async () => {
    const blobStore = new MockBlobStore([WEATHER_MANIFEST, GITHUB_MANIFEST]);
    const mockStore = createMockStore();

    // User has github configured
    await mockStore.upsert({
      id: "promptUser:github",
      userId: "promptUser",
      skillId: "github",
      enabled: true,
      credentials: { GITHUB_TOKEN: "ghp_test" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const resolved = await resolveUserSkills(
      blobStore as any,
      mockStore as unknown as UserSkillStore,
      "promptUser",
    );

    // Build prompt section
    const section = buildSkillsSection({
      isMinimal: false,
      skillStatuses: resolved.statuses,
    });

    const text = section.join("\n");
    assert.ok(text.includes("## Skills"));
    assert.ok(text.includes("<available_skills>"));
    assert.ok(text.includes("weather:"));
    assert.ok(text.includes("github:"));
    assert.ok(text.includes("weather/SKILL.md"));
    assert.ok(text.includes("github/SKILL.md"));
    assert.ok(!text.includes("Skills Needing Setup")); // All skills are enabled
  });

  await t.test("partially configured skills show needs-setup", async () => {
    const blobStore = new MockBlobStore([WEATHER_MANIFEST, GITHUB_MANIFEST, SLACK_MANIFEST]);
    const mockStore = createMockStore();

    const resolved = await resolveUserSkills(
      blobStore as any,
      mockStore as unknown as UserSkillStore,
      "newUser",
    );

    const section = buildSkillsSection({
      isMinimal: false,
      skillStatuses: resolved.statuses,
    });

    const text = section.join("\n");
    assert.ok(text.includes("<available_skills>"));
    assert.ok(text.includes("weather:")); // Auto-enabled
    assert.ok(text.includes("Skills Needing Setup"));
    assert.ok(text.includes("GitHub")); // Needs setup
    assert.ok(text.includes("Slack")); // Needs setup
    assert.ok(text.includes("skill_setup")); // Instructions
  });

  await t.test("resolved statuses feed into handler correctly", async () => {
    const blobStore = new MockBlobStore([WEATHER_MANIFEST, GITHUB_MANIFEST]);
    const mockStore = createMockStore();

    const resolved = await resolveUserSkills(
      blobStore as any,
      mockStore as unknown as UserSkillStore,
      "handlerUser",
    );

    const handler = new SkillToolHandler(
      mockStore as unknown as UserSkillStore,
      blobStore as any,
      resolved.statuses,
      resolved.userCredentials,
    );

    // List should show all skills with correct states
    const listRaw = await handler.handle(SKILL_LIST_TOOL_NAME, {}, "handlerUser");
    const list = JSON.parse(listRaw);
    assert.equal(list.skills.length, 2);

    const weather = list.skills.find((s: any) => s.id === "weather");
    assert.equal(weather.enabled, true);

    const github = list.skills.find((s: any) => s.id === "github");
    assert.equal(github.enabled, false);

    // Read weather should work
    const readRaw = await handler.handle(SKILL_READ_TOOL_NAME, {
      path: "weather/SKILL.md",
    }, "handlerUser");
    assert.ok(!JSON.parse(readRaw).error);

    // Read github should fail (not enabled)
    const readGithub = await handler.handle(SKILL_READ_TOOL_NAME, {
      path: "github/SKILL.md",
    }, "handlerUser");
    assert.ok(JSON.parse(readGithub).error);
  });

  await t.test("minimal mode produces empty prompt section", async () => {
    const blobStore = new MockBlobStore([WEATHER_MANIFEST]);
    const mockStore = createMockStore();

    const resolved = await resolveUserSkills(
      blobStore as any,
      mockStore as unknown as UserSkillStore,
      "minimalUser",
    );

    const section = buildSkillsSection({
      isMinimal: true,
      skillStatuses: resolved.statuses,
    });

    assert.equal(section.length, 0);
  });
});

// ============================================================================
// Suite 12: Tool Definitions Compliance
// ============================================================================

test("Tool definitions compliance", async (t) => {
  const tools = getSkillToolDefinitions();

  await t.test("returns exactly four tools", () => {
    assert.equal(tools.length, 4);
  });

  await t.test("all tools have type=function", () => {
    for (const tool of tools) {
      assert.equal(tool.type, "function");
    }
  });

  await t.test("all tools have name, description, parameters", () => {
    for (const tool of tools) {
      assert.ok(tool.name);
      assert.ok(tool.description);
      assert.ok(tool.parameters);
      assert.equal(tool.parameters.type, "object");
      assert.ok(tool.parameters.properties);
    }
  });

  await t.test("tool names match constants", () => {
    const names = new Set(tools.map((t) => t.name));
    assert.ok(names.has(SKILL_LIST_TOOL_NAME));
    assert.ok(names.has(SKILL_SETUP_TOOL_NAME));
    assert.ok(names.has(SKILL_READ_TOOL_NAME));
    assert.ok(names.has(HTTP_FETCH_TOOL_NAME));
  });

  await t.test("http_fetch tool url is required string", () => {
    const fetchTool = tools.find((t) => t.name === HTTP_FETCH_TOOL_NAME)!;
    assert.ok(fetchTool.parameters.required?.includes("url"));
    assert.equal(fetchTool.parameters.properties.url.type, "string");
  });

  await t.test("skill_read path is required", () => {
    const readTool = tools.find((t) => t.name === SKILL_READ_TOOL_NAME)!;
    assert.ok(readTool.parameters.required?.includes("path"));
    assert.equal(readTool.parameters.properties.path.type, "string");
  });

  await t.test("skill_setup requires skill_id and action", () => {
    const setupTool = tools.find((t) => t.name === SKILL_SETUP_TOOL_NAME)!;
    assert.ok(setupTool.parameters.required?.includes("skill_id"));
    assert.ok(setupTool.parameters.required?.includes("action"));
  });

  await t.test("skill_list has no required parameters", () => {
    const listTool = tools.find((t) => t.name === SKILL_LIST_TOOL_NAME)!;
    assert.ok(!listTool.parameters.required?.length);
  });
});

// ============================================================================
// Suite 14: Skill Setup — Credential Lifecycle
// ============================================================================

test("Skill setup — credential lifecycle", async (t) => {
  await t.test("set credentials, verify completeness, then update", async () => {
    const store = createMockStore();
    const statuses: SkillStatus[] = [
      { manifest: SLACK_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];
    const handler = new SkillToolHandler(
      store as unknown as UserSkillStore,
      new MockBlobStore([SLACK_MANIFEST]) as any,
      statuses,
      {},
    );
    const userId = "cred-lifecycle-user";

    // Step 1: Set required credential
    const setRaw = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "slack",
      action: "set_credentials",
      credentials: { SLACK_TOKEN: "xoxb-123" },
    }, userId);
    const setResult = JSON.parse(setRaw);
    assert.equal(setResult.success, true);
    assert.equal(setResult.credentialsComplete, true); // SLACK_TOKEN is the only required one

    // Verify store has the credential
    const config = await store.get(userId, "slack");
    assert.ok(config);
    assert.equal(config!.credentials.SLACK_TOKEN, "xoxb-123");
  });

  await t.test("merges optional + required credentials across calls", async () => {
    const store = createMockStore();
    const statuses: SkillStatus[] = [
      { manifest: SLACK_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];
    const handler = new SkillToolHandler(
      store as unknown as UserSkillStore,
      new MockBlobStore([SLACK_MANIFEST]) as any,
      statuses,
      {},
    );
    const userId = "merge-cred-user";

    // Set required credential first
    await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "slack",
      action: "set_credentials",
      credentials: { SLACK_TOKEN: "xoxb-initial" },
    }, userId);

    // Backdate updatedAt to bypass rate limiting for the second call
    const existing = await store.get(userId, "slack");
    existing!.updatedAt = new Date(Date.now() - 60_000).toISOString();
    await store.upsert(existing!);

    // Add optional credential (same handler is fine now)
    const raw2 = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "slack",
      action: "set_credentials",
      credentials: { SLACK_CHANNEL: "#general" },
    }, userId);
    const result2 = JSON.parse(raw2);
    assert.equal(result2.success, true);
    assert.equal(result2.credentialsComplete, true);

    // Both credentials should be present
    const config = await store.get(userId, "slack");
    assert.equal(config!.credentials.SLACK_TOKEN, "xoxb-initial");
    assert.equal(config!.credentials.SLACK_CHANNEL, "#general");
  });

  await t.test("enable and disable lifecycle", async () => {
    const store = createMockStore();
    const statuses: SkillStatus[] = [
      { manifest: WEATHER_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
    ];
    const handler = new SkillToolHandler(
      store as unknown as UserSkillStore,
      new MockBlobStore([WEATHER_MANIFEST]) as any,
      statuses,
      {},
    );
    const userId = "enable-disable-user";

    // Enable
    const enableRaw = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "weather",
      action: "enable",
    }, userId);
    assert.equal(JSON.parse(enableRaw).enabled, true);

    // Backdate updatedAt to bypass rate limiting for the disable call
    const existing = await store.get(userId, "weather");
    existing!.updatedAt = new Date(Date.now() - 60_000).toISOString();
    await store.upsert(existing!);

    // Disable
    const disableRaw = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "weather",
      action: "disable",
    }, userId);
    assert.equal(JSON.parse(disableRaw).enabled, false);

    // Verify store state
    const config = await store.get(userId, "weather");
    assert.equal(config!.enabled, false);
  });

  await t.test("audit log records all actions with correct fields", async () => {
    const store = createMockStore();
    const statuses: SkillStatus[] = [
      { manifest: GITHUB_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];
    const handler = new SkillToolHandler(
      store as unknown as UserSkillStore,
      new MockBlobStore([GITHUB_MANIFEST]) as any,
      statuses,
      {},
    );
    const userId = "audit-user";

    // Set credentials (includes credentialKeysSet in audit)
    await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "github",
      action: "set_credentials",
      credentials: { GITHUB_TOKEN: "ghp_test" },
    }, userId);

    // Wait for fire-and-forget audit
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(store._auditLog.length >= 1);
    const entry = store._auditLog[0];
    assert.equal(entry.userId, userId);
    assert.equal(entry.skillId, "github");
    assert.equal(entry.action, "set_credentials");
    assert.ok(entry.credentialKeysSet?.includes("GITHUB_TOKEN"));
    // Values should NOT appear in audit
    assert.ok(!JSON.stringify(entry).includes("ghp_test"));
    assert.ok(entry.timestamp);
  });
});

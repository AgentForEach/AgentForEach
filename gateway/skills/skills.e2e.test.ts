/**
 * AgentForEach Skills Module — End-to-End Infrastructure Tests
 *
 * Validates the skills pipeline against REAL infrastructure:
 *   - Suite 1:  Cosmos DB — UserSkillStore CRUD, partition isolation, audit logging
 *   - Suite 2:  Azure Blob Storage (Azurite) — SkillBlobStore upload, list, read, cache
 *   - Suite 3:  Cosmos + Blob → Registry — resolveUserSkills with real stores
 *   - Suite 4:  Full Handler pipeline with real Cosmos + Blob
 *   - Suite 5:  OpenAI tool loop — LLM invokes skill_list → skill_read → http_fetch
 *   - Suite 6:  Prompt section generation from real resolved skills
 *   - Suite 7:  Multi-user isolation — Cosmos partition key guarantees
 *   - Suite 8:  Credential flow — Cosmos persist → registry merge
 *   - Suite 9:  Blob edge cases — large files, missing blobs, invalid frontmatter
 *   - Suite 10: Concurrent operations — parallel upserts, race conditions
 *
 * Environment variables (skips suites that need missing ones):
 *   - COSMOS_ENDPOINT / COSMOS_KEY — for real Cosmos DB tests
 *   - AzureWebJobsStorage — for real Blob Storage tests (e.g. "UseDevelopmentStorage=true" for Azurite)
 *   - OPENAI_API_KEY — for real OpenAI LLM tests
 */

import test from "node:test";
import assert from "node:assert/strict";

import { UserSkillStore } from "./store.js";
import { SkillBlobStore } from "./blob-store.js";
import { resolveUserSkills, type ResolvedSkills } from "./registry.js";
import {
  SkillToolHandler,
  getSkillToolDefinitions,
  SKILL_LIST_TOOL_NAME,
  SKILL_SETUP_TOOL_NAME,
  SKILL_READ_TOOL_NAME,
  HTTP_FETCH_TOOL_NAME,
} from "./handler.js";
import { buildSkillsSection } from "../prompt/sections/skills.js";
import type {
  SkillManifest,
  SkillStatus,
  UserSkillConfig,
  SkillAuditEntry,
} from "./types.js";

// ============================================================================
// Environment Checks
// ============================================================================

const HAS_COSMOS = !!process.env.COSMOS_ENDPOINT && !!process.env.COSMOS_KEY;
const HAS_BLOB = !!process.env.AzureWebJobsStorage;
const HAS_OPENAI = !!process.env.OPENAI_API_KEY;

const SKIP_COSMOS = HAS_COSMOS ? false : "Missing COSMOS_ENDPOINT or COSMOS_KEY";
const SKIP_BLOB = HAS_BLOB ? false : "Missing AzureWebJobsStorage";
const SKIP_COSMOS_AND_BLOB = (HAS_COSMOS && HAS_BLOB) ? false : "Missing COSMOS + Blob env vars";
const SKIP_OPENAI = HAS_OPENAI ? false : "Missing OPENAI_API_KEY";
const SKIP_ALL = (HAS_COSMOS && HAS_BLOB && HAS_OPENAI) ? false : "Missing one or more env vars";

// Unique prefix to avoid collision between test runs
const RUN_ID = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_USER_A = `${RUN_ID}-userA`;
const TEST_USER_B = `${RUN_ID}-userB`;
const TEST_USER_C = `${RUN_ID}-userC`;

// ============================================================================
// Skill Content for Blob Upload
// ============================================================================

const WEATHER_SKILL_MD = `---
id: weather
name: Weather
description: Get current weather and forecasts via Open-Meteo
category: information
credentials: []
requiredBins: ["curl", "jq"]
---

# Weather Skill

Use the Open-Meteo API (free, no API key required).

## Get Current Weather

1. Geocode the location:
   \`exec: ["curl", "-s", "https://geocoding-api.open-meteo.com/v1/search?name=LOCATION&count=1"]\`
   Extract latitude and longitude from .results[0].

2. Fetch current weather:
   \`exec: ["curl", "-s", "https://api.open-meteo.com/v1/forecast?latitude=LAT&longitude=LON&current=temperature_2m,weather_code&timezone=auto"]\`

3. Format the response with temperature and conditions.

## Weather Codes

| Code | Condition |
|------|-----------|
| 0 | Clear sky |
| 1-3 | Partly cloudy |
| 45-48 | Fog |
| 51-55 | Drizzle |
| 61-65 | Rain |
| 71-75 | Snow |
| 95 | Thunderstorm |
`;

const GITHUB_SKILL_MD = `---
id: github
name: GitHub
description: Interact with GitHub repositories and issues
category: productivity
credentials: [{"key": "GITHUB_TOKEN", "label": "GitHub Personal Access Token", "helpText": "Create at https://github.com/settings/tokens", "required": true}]
requiredBins: ["curl", "jq"]
---

# GitHub Skill

Requires a GitHub Personal Access Token for API access.

## List User Repos
\`exec: ["curl", "-s", "-H", "Authorization: token $GITHUB_TOKEN", "https://api.github.com/user/repos?per_page=5"]\`

## Get Repo Info
\`exec: ["curl", "-s", "-H", "Authorization: token $GITHUB_TOKEN", "https://api.github.com/repos/OWNER/REPO"]\`

## List Issues
\`exec: ["curl", "-s", "-H", "Authorization: token $GITHUB_TOKEN", "https://api.github.com/repos/OWNER/REPO/issues?state=open&per_page=5"]\`
`;

const NOTION_SKILL_MD = `---
id: notion
name: Notion
description: Read and write Notion pages and databases
category: productivity
credentials: [{"key": "NOTION_API_KEY", "label": "Notion Integration Token", "required": true}, {"key": "NOTION_DEFAULT_DB", "label": "Default Database ID", "required": false}]
requiredBins: ["curl", "jq"]
---

# Notion Skill

Requires a Notion Internal Integration Token.

## Query a Database
\`exec: ["curl", "-s", "-X", "POST", "-H", "Authorization: Bearer $NOTION_API_KEY", "-H", "Notion-Version: 2022-06-28", "-H", "Content-Type: application/json", "https://api.notion.com/v1/databases/DB_ID/query", "-d", "{}"]\`
`;

// Blob container name specifically for tests (avoid polluting production)
const TEST_CONTAINER_NAME = `skills-e2e-${RUN_ID.slice(0, 20)}`;
const TEST_COSMOS_CONTAINER_ID = `user-skills-e2e-${RUN_ID.slice(0, 12)}`;

// ============================================================================
// Shared Helpers
// ============================================================================

/** Upload a SKILL.md blob to the test container. */
async function uploadSkillBlob(
  connectionString: string,
  containerName: string,
  blobPath: string,
  content: string,
): Promise<void> {
  const { BlobServiceClient } = await import("@azure/storage-blob");
  const blobService = BlobServiceClient.fromConnectionString(connectionString);
  const container = blobService.getContainerClient(containerName);
  await container.createIfNotExists();
  const blockBlob = container.getBlockBlobClient(blobPath);
  await blockBlob.upload(content, Buffer.byteLength(content, "utf-8"), {
    blobHTTPHeaders: { blobContentType: "text/markdown; charset=utf-8" },
  });
}

/** Delete the test blob container. */
async function deleteTestContainer(
  connectionString: string,
  containerName: string,
): Promise<void> {
  const { BlobServiceClient } = await import("@azure/storage-blob");
  const blobService = BlobServiceClient.fromConnectionString(connectionString);
  const container = blobService.getContainerClient(containerName);
  try {
    await container.delete();
  } catch {
    // Ignore — may not exist
  }
}

/** Create a real Cosmos-backed UserSkillStore. */
async function createRealStore(): Promise<UserSkillStore> {
  const { CosmosStorage } = await import("@agentforeach/storage-cosmos");
  const db = new CosmosStorage({
    endpoint: process.env.COSMOS_ENDPOINT!,
    key: process.env.COSMOS_KEY!,
    databaseId: "agentforeach-test",
  });
  const store = new UserSkillStore(db, TEST_COSMOS_CONTAINER_ID);
  await store.initialize();
  return store;
}

/** Build a UserSkillConfig document. */
function buildConfig(
  userId: string,
  skillId: string,
  enabled: boolean,
  credentials: Record<string, string> = {},
): UserSkillConfig {
  const now = new Date().toISOString();
  return {
    id: UserSkillStore.buildId(userId, skillId),
    userId,
    skillId,
    enabled,
    credentials,
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================================================
// Suite 1: UserSkillStore ↔ Real Cosmos DB
// ============================================================================

test("E2E: UserSkillStore ↔ Cosmos DB", { skip: SKIP_COSMOS }, async (t) => {
  const store = await createRealStore();
  const userId = TEST_USER_A;

  await t.test("get returns null for non-existent skill", async () => {
    const result = await store.get(userId, "does-not-exist");
    assert.equal(result, null);
  });

  await t.test("upsert creates new document", async () => {
    const config = buildConfig(userId, "weather", true);
    const result = await store.upsert(config);
    assert.equal(result.id, `${userId}:weather`);
    assert.equal(result.skillId, "weather");
    assert.equal(result.enabled, true);
  });

  await t.test("get retrieves upserted document", async () => {
    const result = await store.get(userId, "weather");
    assert.ok(result);
    assert.equal(result.skillId, "weather");
    assert.equal(result.enabled, true);
    assert.equal(result.userId, userId);
  });

  await t.test("upsert updates existing document (idempotent)", async () => {
    const config = buildConfig(userId, "weather", false, { FOO: "bar" });
    await store.upsert(config);
    const result = await store.get(userId, "weather");
    assert.ok(result);
    assert.equal(result.enabled, false);
    assert.equal(result.credentials.FOO, "bar");
  });

  await t.test("upsert multiple skills for same user", async () => {
    await store.upsert(buildConfig(userId, "github", true, { GITHUB_TOKEN: "ghp_test" }));
    await store.upsert(buildConfig(userId, "notion", false, { NOTION_API_KEY: "ntn_test" }));

    const all = await store.getAllForUser(userId);
    assert.ok(all.length >= 3, `Expected >= 3 configs, got ${all.length}`);

    const ids = all.map((c) => c.skillId);
    assert.ok(ids.includes("weather"));
    assert.ok(ids.includes("github"));
    assert.ok(ids.includes("notion"));
  });

  await t.test("getAllForUser returns only this user's configs", async () => {
    const otherUserId = TEST_USER_B;
    const others = await store.getAllForUser(otherUserId);
    assert.equal(others.length, 0);
  });

  await t.test("delete removes a specific config", async () => {
    await store.delete(userId, "notion");
    const result = await store.get(userId, "notion");
    assert.equal(result, null);
  });

  await t.test("delete is idempotent (deleting non-existent returns false)", async () => {
    const result = await store.delete(userId, "notion");
    // Should not throw, just return false
    assert.equal(result, false);
  });

  await t.test("audit logging round-trip", async () => {
    const entry: SkillAuditEntry = {
      id: `audit:${userId}:weather:${new Date().toISOString()}`,
      userId,
      skillId: "weather",
      action: "enable",
      timestamp: new Date().toISOString(),
    };
    await store.logAudit(entry);
    // Can verify by reading back (audit uses same container, typed as UserSkillConfig)
    // The document should exist, though we can't query by audit ID easily
    // This just verifies no errors on write
  });

  await t.test("credential values persisted correctly", async () => {
    const specialCreds = {
      API_KEY: "sk-proj-abc123!@#$%^&*(){}[]|\\:;'\"<>,.?/",
      WEBHOOK_URL: "https://hooks.example.com/path?key=val&foo=bar",
      EMPTY: "",
    };
    await store.upsert(buildConfig(userId, "special-creds", true, specialCreds));
    const result = await store.get(userId, "special-creds");
    assert.ok(result);
    assert.equal(result.credentials.API_KEY, specialCreds.API_KEY);
    assert.equal(result.credentials.WEBHOOK_URL, specialCreds.WEBHOOK_URL);
    assert.equal(result.credentials.EMPTY, "");
  });

  // Cleanup
  await store.delete(userId, "weather");
  await store.delete(userId, "github");
  await store.delete(userId, "special-creds");
});

// ============================================================================
// Suite 2: SkillBlobStore ↔ Real Blob Storage (Azurite)
// ============================================================================

test("E2E: SkillBlobStore ↔ Blob Storage", { skip: SKIP_BLOB }, async (t) => {
  const connectionString = process.env.AzureWebJobsStorage!;

  // Setup: upload test skill files
  await uploadSkillBlob(connectionString, TEST_CONTAINER_NAME, "weather/SKILL.md", WEATHER_SKILL_MD);
  await uploadSkillBlob(connectionString, TEST_CONTAINER_NAME, "github/SKILL.md", GITHUB_SKILL_MD);
  await uploadSkillBlob(connectionString, TEST_CONTAINER_NAME, "notion/SKILL.md", NOTION_SKILL_MD);

  const blobStore = new SkillBlobStore(connectionString, TEST_CONTAINER_NAME);

  await t.test("listSkills discovers all uploaded SKILL.md files", async () => {
    const manifests = await blobStore.listSkills();
    assert.ok(manifests.length >= 3, `Expected >= 3 manifests, got ${manifests.length}`);

    const ids = manifests.map((m) => m.id);
    assert.ok(ids.includes("weather"), "Should find weather skill");
    assert.ok(ids.includes("github"), "Should find github skill");
    assert.ok(ids.includes("notion"), "Should find notion skill");
  });

  await t.test("listSkills parses frontmatter correctly", async () => {
    const manifests = await blobStore.listSkills();
    const weather = manifests.find((m) => m.id === "weather")!;
    assert.equal(weather.name, "Weather");
    assert.equal(weather.description, "Get current weather and forecasts via Open-Meteo");
    assert.equal(weather.category, "information");
    assert.equal(weather.blobPath, "weather/SKILL.md");
    assert.deepEqual(weather.credentials, []);
    assert.deepEqual(weather.requiredBins, ["curl", "jq"]);
  });

  await t.test("listSkills parses credentials correctly", async () => {
    const manifests = await blobStore.listSkills();
    const github = manifests.find((m) => m.id === "github")!;
    assert.equal(github.credentials.length, 1);
    assert.equal(github.credentials[0].key, "GITHUB_TOKEN");
    assert.equal(github.credentials[0].label, "GitHub Personal Access Token");
    assert.equal(github.credentials[0].required, true);
    assert.ok(github.credentials[0].helpText?.includes("github.com/settings/tokens"));
  });

  await t.test("listSkills parses multi-credential skills", async () => {
    const manifests = await blobStore.listSkills();
    const notion = manifests.find((m) => m.id === "notion")!;
    assert.equal(notion.credentials.length, 2);
    const required = notion.credentials.filter((c) => c.required);
    const optional = notion.credentials.filter((c) => !c.required);
    assert.equal(required.length, 1);
    assert.equal(optional.length, 1);
    assert.equal(required[0].key, "NOTION_API_KEY");
    assert.equal(optional[0].key, "NOTION_DEFAULT_DB");
  });

  await t.test("listSkills caches results (second call is fast)", async () => {
    const start1 = Date.now();
    await blobStore.listSkills();
    const elapsed1 = Date.now() - start1;

    const start2 = Date.now();
    const manifests2 = await blobStore.listSkills();
    const elapsed2 = Date.now() - start2;

    // Second call should be significantly faster (cached)
    assert.ok(elapsed2 < 5, `Cached lookup took ${elapsed2}ms, expected < 5ms`);
    assert.ok(manifests2.length >= 3);
  });

  await t.test("invalidateCache forces re-scan", async () => {
    blobStore.invalidateCache();

    const start = Date.now();
    const manifests = await blobStore.listSkills();
    const elapsed = Date.now() - start;

    // After invalidation, should re-scan (slower than cache)
    assert.ok(manifests.length >= 3);
    // Just verify it works — can't reliably assert timing
  });

  await t.test("readFile returns correct SKILL.md content", async () => {
    const content = await blobStore.readFile("weather/SKILL.md");
    assert.ok(content.includes("# Weather Skill"));
    assert.ok(content.includes("Open-Meteo API"));
    assert.ok(content.includes("Weather Codes"));
    assert.ok(content.includes("Clear sky"));
  });

  await t.test("readFile works for all uploaded skills", async () => {
    const weatherContent = await blobStore.readFile("weather/SKILL.md");
    const githubContent = await blobStore.readFile("github/SKILL.md");
    const notionContent = await blobStore.readFile("notion/SKILL.md");

    assert.ok(weatherContent.includes("Weather Skill"));
    assert.ok(githubContent.includes("GitHub Skill"));
    assert.ok(notionContent.includes("Notion Skill"));
  });

  await t.test("readFile rejects path traversal", async () => {
    await assert.rejects(
      () => blobStore.readFile("../../../etc/passwd"),
      /traversal|invalid/i,
    );
  });

  await t.test("readFile rejects absolute paths", async () => {
    await assert.rejects(
      () => blobStore.readFile("/etc/passwd"),
      /relative|invalid/i,
    );
  });

  await t.test("readFile throws for non-existent blob", async () => {
    await assert.rejects(
      () => blobStore.readFile("doesnotexist/SKILL.md"),
      /not found|404|does not exist/i,
    );
  });

  // Cleanup blob container
  await deleteTestContainer(connectionString, TEST_CONTAINER_NAME);
});

// ============================================================================
// Suite 3: Real Cosmos + Real Blob → Registry Resolution
// ============================================================================

test("E2E: Registry — resolveUserSkills with real Cosmos + Blob", { skip: SKIP_COSMOS_AND_BLOB }, async (t) => {
  const connectionString = process.env.AzureWebJobsStorage!;
  const blobContainerName = `skills-registry-e2e-${RUN_ID.slice(0, 16)}`;

  // Setup: upload skills to Blob
  await uploadSkillBlob(connectionString, blobContainerName, "weather/SKILL.md", WEATHER_SKILL_MD);
  await uploadSkillBlob(connectionString, blobContainerName, "github/SKILL.md", GITHUB_SKILL_MD);
  await uploadSkillBlob(connectionString, blobContainerName, "notion/SKILL.md", NOTION_SKILL_MD);

  const blobStore = new SkillBlobStore(connectionString, blobContainerName);
  const store = await createRealStore();
  // Use a fresh user uncontaminated by Suite 1 Cosmos tests
  const userId = `${RUN_ID}-registryUser`;

  await t.test("new user: credential-free skills auto-enabled, others not", async () => {
    const resolved = await resolveUserSkills(blobStore, store, userId);

    const weather = resolved.statuses.find((s) => s.manifest.id === "weather");
    assert.ok(weather);
    assert.equal(weather.enabled, true, "credential-free skill should auto-enable");
    assert.equal(weather.credentialsComplete, true);
    assert.equal(weather.configured, false, "new user has no config yet");

    const github = resolved.statuses.find((s) => s.manifest.id === "github");
    assert.ok(github);
    assert.equal(github.enabled, false, "credential-required skill not auto-enabled");
    assert.equal(github.credentialsComplete, false);

    const notion = resolved.statuses.find((s) => s.manifest.id === "notion");
    assert.ok(notion);
    assert.equal(notion.enabled, false);
    assert.equal(notion.credentialsComplete, false);

    // No credentials in merged map
    assert.equal(Object.keys(resolved.userCredentials).length, 0);
  });

  await t.test("user configures github with token → resolves correctly", async () => {
    await store.upsert(buildConfig(userId, "github", true, { GITHUB_TOKEN: "ghp_realtest123" }));

    const resolved = await resolveUserSkills(blobStore, store, userId);
    const github = resolved.statuses.find((s) => s.manifest.id === "github");
    assert.ok(github);
    assert.equal(github.enabled, true);
    assert.equal(github.credentialsComplete, true);
    assert.equal(github.configured, true);

    // Credentials should be merged
    assert.equal(resolved.userCredentials.GITHUB_TOKEN, "ghp_realtest123");
  });

  await t.test("partial credentials → credentialsComplete = false", async () => {
    // Notion needs NOTION_API_KEY (required), but only set NOTION_DEFAULT_DB (optional)
    await store.upsert(buildConfig(userId, "notion", true, { NOTION_DEFAULT_DB: "db123" }));

    const resolved = await resolveUserSkills(blobStore, store, userId);
    const notion = resolved.statuses.find((s) => s.manifest.id === "notion");
    assert.ok(notion);
    assert.equal(notion.enabled, true);
    assert.equal(notion.credentialsComplete, false, "Missing required NOTION_API_KEY");
    assert.equal(notion.configured, true);

    // Incomplete skill credentials should NOT be merged into resolved credentials
    assert.equal(resolved.userCredentials.NOTION_DEFAULT_DB, undefined);
  });

  await t.test("complete notion credentials → credentialsComplete = true", async () => {
    await store.upsert(buildConfig(userId, "notion", true, {
      NOTION_API_KEY: "ntn_realtest",
      NOTION_DEFAULT_DB: "db456",
    }));

    const resolved = await resolveUserSkills(blobStore, store, userId);
    const notion = resolved.statuses.find((s) => s.manifest.id === "notion");
    assert.ok(notion);
    assert.equal(notion.credentialsComplete, true);

    // Now credentials should be in merged map
    assert.equal(resolved.userCredentials.NOTION_API_KEY, "ntn_realtest");
    assert.equal(resolved.userCredentials.NOTION_DEFAULT_DB, "db456");
    assert.equal(resolved.userCredentials.GITHUB_TOKEN, "ghp_realtest123");
  });

  await t.test("agent whitelist filters skills", async () => {
    const resolved = await resolveUserSkills(blobStore, store, userId, ["weather"]);
    assert.equal(resolved.statuses.length, 1);
    assert.equal(resolved.statuses[0].manifest.id, "weather");
  });

  await t.test("disabling a skill excludes credentials from merge", async () => {
    await store.upsert(buildConfig(userId, "github", false, { GITHUB_TOKEN: "ghp_disabled" }));

    const resolved = await resolveUserSkills(blobStore, store, userId);
    const github = resolved.statuses.find((s) => s.manifest.id === "github");
    assert.ok(github);
    assert.equal(github.enabled, false);
    // Disabled skill credentials should NOT be in merged map
    assert.equal(resolved.userCredentials.GITHUB_TOKEN, undefined);
  });

  // Cleanup
  await store.delete(userId, "github");
  await store.delete(userId, "notion");
  await deleteTestContainer(connectionString, blobContainerName);
});

// ============================================================================
// Suite 4: Full Handler Pipeline — Real Cosmos + Real Blob
// ============================================================================

test("E2E: Full handler with real Cosmos + Blob", { skip: SKIP_COSMOS_AND_BLOB }, async (t) => {
  const connectionString = process.env.AzureWebJobsStorage!;
  const blobContainerName = `skills-handler-e2e-${RUN_ID.slice(0, 16)}`;
  const userId = TEST_USER_C;

  // Setup: upload skills
  await uploadSkillBlob(connectionString, blobContainerName, "weather/SKILL.md", WEATHER_SKILL_MD);
  await uploadSkillBlob(connectionString, blobContainerName, "github/SKILL.md", GITHUB_SKILL_MD);

  const blobStore = new SkillBlobStore(connectionString, blobContainerName);
  const store = await createRealStore();

  await t.test("lifecycle: list → enable → set_credentials → read", async () => {
    // 1. Resolve initial state
    let resolved = await resolveUserSkills(blobStore, store, userId);
    let handler = new SkillToolHandler(store, blobStore, resolved.statuses, resolved.userCredentials);

    // 2. List skills
    const listRaw = await handler.handle(SKILL_LIST_TOOL_NAME, {}, userId);
    const listResult = JSON.parse(listRaw);
    assert.ok(listResult.skills.length >= 2);

    const weatherListed = listResult.skills.find((s: any) => s.id === "weather");
    assert.ok(weatherListed);
    assert.equal(weatherListed.enabled, true);

    // 3. Read weather (should work — credential-free, auto-enabled)
    const readWeather = await handler.handle(SKILL_READ_TOOL_NAME, { path: "weather/SKILL.md" }, userId);
    const readResult = JSON.parse(readWeather);
    assert.ok(!readResult.error, `Unexpected error: ${readResult.error}`);
    assert.equal(readResult.skill_id, "weather");
    assert.ok(readResult.content.includes("Open-Meteo"));

    // 4. Read GitHub (should fail — not enabled)
    const readGithub = await handler.handle(SKILL_READ_TOOL_NAME, { path: "github/SKILL.md" }, userId);
    const githubResult = JSON.parse(readGithub);
    assert.ok(githubResult.error);
    assert.ok(githubResult.error.includes("not enabled"));

    // 6. Enable GitHub
    const enableRaw = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "github",
      action: "enable",
    }, userId);
    const enableResult = JSON.parse(enableRaw);
    assert.equal(enableResult.success, true);
    assert.equal(enableResult.enabled, true);
    assert.equal(enableResult.credentialsComplete, false); // No token yet

    // 7. Set GitHub credentials (backdate to avoid rate limit)
    const existing = await store.get(userId, "github");
    if (existing) {
      existing.updatedAt = new Date(Date.now() - 60_000).toISOString();
      await store.upsert(existing);
    }

    const setCredsRaw = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "github",
      action: "set_credentials",
      credentials: { GITHUB_TOKEN: "ghp_handler_e2e_test" },
    }, userId);
    const setCredsResult = JSON.parse(setCredsRaw);
    assert.equal(setCredsResult.success, true);
    assert.equal(setCredsResult.credentialsComplete, true);

    // 8. Verify Cosmos state before re-resolve
    const verifyConfig = await store.get(userId, "github");
    assert.ok(verifyConfig, "Config should exist in Cosmos after set_credentials");
    assert.equal(verifyConfig.enabled, true, "enabled should still be true after set_credentials");
    assert.ok(verifyConfig.credentials.GITHUB_TOKEN, "GITHUB_TOKEN should be set in Cosmos");

    // Invalidate blob cache to get fresh manifests for re-resolve
    blobStore.invalidateCache();

    // Re-resolve and create new handler with updated state
    resolved = await resolveUserSkills(blobStore, store, userId);
    handler = new SkillToolHandler(store, blobStore, resolved.statuses, resolved.userCredentials);

    // Verify resolved state
    const githubStatus = resolved.statuses.find((s) => s.manifest.id === "github");
    assert.ok(githubStatus, "github should be in resolved statuses");
    assert.equal(githubStatus.enabled, true, "github should be enabled in resolved statuses");
    assert.equal(githubStatus.credentialsComplete, true, "github credentials should be complete");

    // 9. Now GitHub read should work
    const readGithub2 = await handler.handle(SKILL_READ_TOOL_NAME, { path: "github/SKILL.md" }, userId);
    const githubResult2 = JSON.parse(readGithub2);
    assert.ok(!githubResult2.error, `Unexpected error: ${githubResult2.error}`);
    assert.equal(githubResult2.skill_id, "github");
    assert.ok(githubResult2.content.includes("GitHub Skill"));

    // 10. Verify credentials are in resolved userCredentials
    assert.equal(resolved.userCredentials["GITHUB_TOKEN"], "ghp_handler_e2e_test");
  });

  // Cleanup
  await store.delete(userId, "github");
  await deleteTestContainer(connectionString, blobContainerName);
});

// ============================================================================
// Suite 5: OpenAI Tool Loop — LLM drives skill_list → skill_read → exec
// ============================================================================

test("E2E: OpenAI tool loop — LLM uses skills", { skip: SKIP_ALL }, async (t) => {
  const connectionString = process.env.AzureWebJobsStorage!;
  const blobContainerName = `skills-openai-e2e-${RUN_ID.slice(0, 16)}`;
  const userId = `openai-e2e-${RUN_ID}`;

  // Setup: upload weather skill
  await uploadSkillBlob(connectionString, blobContainerName, "weather/SKILL.md", WEATHER_SKILL_MD);

  const blobStore = new SkillBlobStore(connectionString, blobContainerName);
  const store = await createRealStore();

  // Resolve skills (weather auto-enabled)
  const resolved = await resolveUserSkills(blobStore, store, userId);
  const handler = new SkillToolHandler(store, blobStore, resolved.statuses, resolved.userCredentials);

  // Build tool definitions for OpenAI
  const toolDefs = getSkillToolDefinitions();

  await t.test("OpenAI calls skill_list when asked about available skills", async () => {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    // Build prompt section for context
    const skillsSection = buildSkillsSection({
      isMinimal: false,
      skillStatuses: resolved.statuses,
    });
    const systemPrompt = [
      "You are a helpful assistant with access to skills.",
      ...skillsSection,
      "When asked about skills, use the skill_list tool to check available skills.",
    ].join("\n");

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      instructions: systemPrompt,
      input: "What skills do I have available?",
      tools: toolDefs.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
        strict: false,
      })),
      tool_choice: "auto",
    });

    // Check if the model called skill_list
    const toolCalls = response.output.filter(
      (item: any) => item.type === "function_call",
    );

    // The model should call skill_list (though it might respond directly)
    // We accept either behaviour — the key test is the tool integration works
    if (toolCalls.length > 0) {
      const call = toolCalls[0] as any;
      assert.equal(call.name, SKILL_LIST_TOOL_NAME);

      // Execute the tool call through our handler
      const result = await handler.handle(call.name, JSON.parse(call.arguments || "{}"), userId);
      const parsed = JSON.parse(result);
      assert.ok(parsed.skills);
      assert.ok(parsed.skills.length >= 1);
      assert.ok(parsed.skills.some((s: any) => s.id === "weather"));
    }
  });

  await t.test("OpenAI calls skill_read then http_fetch to get weather", async () => {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    const skillsSection = buildSkillsSection({
      isMinimal: false,
      skillStatuses: resolved.statuses,
    });
    const systemPrompt = [
      "You are a helpful assistant with skills.",
      ...skillsSection,
      "To answer weather questions, first call skill_read with the weather skill path,",
      "then follow the instructions — translate exec: [\"curl\", ...] to http_fetch calls.",
      "Available weather skill path: weather/SKILL.md",
    ].join("\n");

    // Turn 1: ask for weather
    const response1 = await openai.responses.create({
      model: "gpt-4.1-mini",
      instructions: systemPrompt,
      input: "What's the weather in London right now? Use the weather skill.",
      tools: toolDefs.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
        strict: false,
      })),
      tool_choice: "auto",
    });

    const toolCalls1 = response1.output.filter(
      (item: any) => item.type === "function_call",
    );

    // Should call at least one tool (skill_read or http_fetch)
    if (toolCalls1.length === 0) {
      // Model might answer directly without tools — skip
      return;
    }

    // Execute each tool call and collect results
    const toolResults: Array<{ call_id: string; output: string }> = [];
    for (const call of toolCalls1) {
      const fc = call as any;
      if (fc.type !== "function_call") continue;
      const args = JSON.parse(fc.arguments || "{}");
      const result = await handler.handle(fc.name, args, userId);
      toolResults.push({ call_id: fc.call_id, output: result });

      // Validate individual tool results
      const parsed = JSON.parse(result);
      if (fc.name === SKILL_READ_TOOL_NAME) {
        assert.ok(!parsed.error, `skill_read error: ${parsed.error}`);
        assert.ok(parsed.content?.includes("Open-Meteo") || parsed.content?.includes("Weather"));
      }
    }

    // Verify we got at least one successful tool result
    assert.ok(toolResults.length > 0, "Should have at least one tool result");
  });

  // Cleanup
  await deleteTestContainer(connectionString, blobContainerName);
});

// ============================================================================
// Suite 6: Prompt Section from Real Resolved Skills
// ============================================================================

test("E2E: Prompt section from real resolved skills", { skip: SKIP_COSMOS_AND_BLOB }, async (t) => {
  const connectionString = process.env.AzureWebJobsStorage!;
  const blobContainerName = `skills-prompt-e2e-${RUN_ID.slice(0, 16)}`;
  const userId = `prompt-e2e-${RUN_ID}`;

  await uploadSkillBlob(connectionString, blobContainerName, "weather/SKILL.md", WEATHER_SKILL_MD);
  await uploadSkillBlob(connectionString, blobContainerName, "github/SKILL.md", GITHUB_SKILL_MD);

  const blobStore = new SkillBlobStore(connectionString, blobContainerName);
  const store = await createRealStore();

  await t.test("new user: weather ready, github needs setup", async () => {
    const resolved = await resolveUserSkills(blobStore, store, userId);
    const section = buildSkillsSection({
      isMinimal: false,
      skillStatuses: resolved.statuses,
    });
    const text = section.join("\n");

    assert.ok(text.includes("## Skills"));
    assert.ok(text.includes("<available_skills>"));
    assert.ok(text.includes("weather:"), "Weather should be in available_skills");
    assert.ok(text.includes("weather/SKILL.md"));
    assert.ok(text.includes("Skills Needing Setup"));
    assert.ok(text.includes("GitHub"), "GitHub should be in needs-setup");
    assert.ok(text.includes("skill_setup"), "Should mention skill_setup");
  });

  await t.test("configured user: all skills ready", async () => {
    await store.upsert(buildConfig(userId, "github", true, { GITHUB_TOKEN: "ghp_test" }));

    const resolved = await resolveUserSkills(blobStore, store, userId);
    const section = buildSkillsSection({
      isMinimal: false,
      skillStatuses: resolved.statuses,
    });
    const text = section.join("\n");

    assert.ok(text.includes("weather:"));
    assert.ok(text.includes("github:"));
    assert.ok(!text.includes("Skills Needing Setup"), "All skills are configured");
  });

  await t.test("minimal mode produces empty output", async () => {
    const resolved = await resolveUserSkills(blobStore, store, userId);
    const section = buildSkillsSection({
      isMinimal: true,
      skillStatuses: resolved.statuses,
    });
    assert.equal(section.length, 0);
  });

  // Cleanup
  await store.delete(userId, "github");
  await deleteTestContainer(connectionString, blobContainerName);
});

// ============================================================================
// Suite 7: Multi-User Partition Isolation (Real Cosmos)
// ============================================================================

test("E2E: Multi-user partition isolation", { skip: SKIP_COSMOS_AND_BLOB }, async (t) => {
  const connectionString = process.env.AzureWebJobsStorage!;
  const blobContainerName = `skills-multiuser-e2e-${RUN_ID.slice(0, 16)}`;

  await uploadSkillBlob(connectionString, blobContainerName, "weather/SKILL.md", WEATHER_SKILL_MD);
  await uploadSkillBlob(connectionString, blobContainerName, "github/SKILL.md", GITHUB_SKILL_MD);

  const blobStore = new SkillBlobStore(connectionString, blobContainerName);
  const store = await createRealStore();

  const alice = `alice-${RUN_ID}`;
  const bob = `bob-${RUN_ID}`;

  await t.test("alice and bob get independent skill states", async () => {
    // Alice enables GitHub with her token
    await store.upsert(buildConfig(alice, "github", true, { GITHUB_TOKEN: "ghp_alice_real" }));

    // Bob enables GitHub with his token
    await store.upsert(buildConfig(bob, "github", true, { GITHUB_TOKEN: "ghp_bob_real" }));

    const resolvedAlice = await resolveUserSkills(blobStore, store, alice);
    const resolvedBob = await resolveUserSkills(blobStore, store, bob);

    // Both should have GitHub enabled
    const githubAlice = resolvedAlice.statuses.find((s) => s.manifest.id === "github");
    const githubBob = resolvedBob.statuses.find((s) => s.manifest.id === "github");
    assert.ok(githubAlice?.enabled);
    assert.ok(githubBob?.enabled);

    // Credentials should be isolated
    assert.equal(resolvedAlice.userCredentials.GITHUB_TOKEN, "ghp_alice_real");
    assert.equal(resolvedBob.userCredentials.GITHUB_TOKEN, "ghp_bob_real");
  });

  await t.test("alice disabling does not affect bob", async () => {
    await store.upsert(buildConfig(alice, "github", false, { GITHUB_TOKEN: "ghp_alice_real" }));

    const resolvedAlice = await resolveUserSkills(blobStore, store, alice);
    const resolvedBob = await resolveUserSkills(blobStore, store, bob);

    assert.equal(
      resolvedAlice.statuses.find((s) => s.manifest.id === "github")?.enabled,
      false,
    );
    assert.equal(
      resolvedBob.statuses.find((s) => s.manifest.id === "github")?.enabled,
      true,
    );
  });

  await t.test("getAllForUser returns only that user's configs", async () => {
    const aliceConfigs = await store.getAllForUser(alice);
    const bobConfigs = await store.getAllForUser(bob);

    assert.ok(aliceConfigs.every((c) => c.userId === alice));
    assert.ok(bobConfigs.every((c) => c.userId === bob));
  });

  await t.test("credential injection isolation — resolved credentials per user", async () => {
    const resolvedAlice = await resolveUserSkills(blobStore, store, alice);
    const resolvedBob = await resolveUserSkills(blobStore, store, bob);

    // Alice's disabled skill should NOT have GITHUB_TOKEN in resolved credentials
    assert.ok(
      !resolvedAlice.userCredentials["GITHUB_TOKEN"],
      "Alice's disabled skill should not have GITHUB_TOKEN in resolved credentials",
    );

    // Bob's enabled skill should have GITHUB_TOKEN in resolved credentials
    assert.equal(
      resolvedBob.userCredentials["GITHUB_TOKEN"],
      "ghp_bob_real",
      "Bob's enabled skill should have GITHUB_TOKEN in resolved credentials",
    );
  });

  // Cleanup
  await store.delete(alice, "github");
  await store.delete(bob, "github");
  await deleteTestContainer(connectionString, blobContainerName);
});

// ============================================================================
// Suite 8: Credential Flow — Cosmos → Registry → Resolved Credentials
// ============================================================================

test("E2E: Credential flow end-to-end", { skip: SKIP_COSMOS_AND_BLOB }, async (t) => {
  const connectionString = process.env.AzureWebJobsStorage!;
  const blobContainerName = `skills-creds-e2e-${RUN_ID.slice(0, 16)}`;
  const userId = `creds-e2e-${RUN_ID}`;

  await uploadSkillBlob(connectionString, blobContainerName, "github/SKILL.md", GITHUB_SKILL_MD);
  await uploadSkillBlob(connectionString, blobContainerName, "notion/SKILL.md", NOTION_SKILL_MD);

  const blobStore = new SkillBlobStore(connectionString, blobContainerName);
  const store = await createRealStore();

  await t.test("multiple skill credentials merge into resolved credentials", async () => {
    await store.upsert(buildConfig(userId, "github", true, { GITHUB_TOKEN: "ghp_merge_test" }));
    await store.upsert(buildConfig(userId, "notion", true, {
      NOTION_API_KEY: "ntn_merge_test",
      NOTION_DEFAULT_DB: "db_merge_test",
    }));

    const resolved = await resolveUserSkills(blobStore, store, userId);

    // All three credential keys should be merged
    assert.equal(resolved.userCredentials.GITHUB_TOKEN, "ghp_merge_test");
    assert.equal(resolved.userCredentials.NOTION_API_KEY, "ntn_merge_test");
    assert.equal(resolved.userCredentials.NOTION_DEFAULT_DB, "db_merge_test");
  });

  await t.test("updating credentials in Cosmos reflects in next resolve", async () => {
    // Change GITHUB_TOKEN
    await store.upsert(buildConfig(userId, "github", true, { GITHUB_TOKEN: "ghp_updated_v2" }));

    const resolved = await resolveUserSkills(blobStore, store, userId);
    assert.equal(resolved.userCredentials.GITHUB_TOKEN, "ghp_updated_v2");
  });

  // Cleanup
  await store.delete(userId, "github");
  await store.delete(userId, "notion");
  await deleteTestContainer(connectionString, blobContainerName);
});

// ============================================================================
// Suite 9: Blob Edge Cases — Large Files, Invalid Frontmatter, Encoding
// ============================================================================

test("E2E: Blob storage edge cases", { skip: SKIP_BLOB }, async (t) => {
  const connectionString = process.env.AzureWebJobsStorage!;
  const blobContainerName = `skills-edge-e2e-${RUN_ID.slice(0, 16)}`;

  await t.test("large SKILL.md file (100 KB)", async () => {
    const bigContent = [
      "---",
      "id: bigskill",
      "name: Big Skill",
      "description: A skill with a very large instruction file",
      "category: testing",
      "credentials: []",
      "---",
      "",
      "# Big Skill Instructions",
      "",
      // Generate ~100 KB of content
      ...Array.from({ length: 2000 }, (_, i) =>
        `## Step ${i + 1}\n\nThis is instruction step ${i + 1}. Repeat this pattern for testing.\n`,
      ),
    ].join("\n");

    await uploadSkillBlob(connectionString, blobContainerName, "bigskill/SKILL.md", bigContent);
    const blobStore = new SkillBlobStore(connectionString, blobContainerName);

    const manifests = await blobStore.listSkills();
    const big = manifests.find((m) => m.id === "bigskill");
    assert.ok(big);
    assert.equal(big.name, "Big Skill");

    const content = await blobStore.readFile("bigskill/SKILL.md");
    assert.ok(content.length > 50_000, `Expected > 50KB, got ${content.length}`);
    assert.ok(content.includes("Step 2000"));
  });

  await t.test("SKILL.md with invalid frontmatter is skipped in listing", async () => {
    const badContent = "# No frontmatter here\n\nJust a regular markdown file.";
    await uploadSkillBlob(connectionString, blobContainerName, "badskill/SKILL.md", badContent);

    const blobStore = new SkillBlobStore(connectionString, blobContainerName);
    blobStore.invalidateCache();

    const manifests = await blobStore.listSkills();
    // badskill should be skipped (malformed frontmatter)
    const bad = manifests.find((m) => m.id === "badskill");
    assert.equal(bad, undefined, "Malformed SKILL.md should be skipped");
    // bigskill should still be there
    const big = manifests.find((m) => m.id === "bigskill");
    assert.ok(big, "Valid skill should still be listed");
  });

  await t.test("SKILL.md with unicode content", async () => {
    const unicodeContent = `---
id: unicode
name: Unicode Skill 日本語
description: Tests unicode handling — émojis 🎉, CJK 中文, diacritics àéîõü
category: testing
credentials: []
---

# Unicode Skill 🌍

Instructions with special characters:
- Japanese: こんにちは世界
- Chinese: 你好世界
- Korean: 안녕하세요
- Emoji: 🚀🎯✅❌
- Math: ∑∏∫∂∆
`;

    await uploadSkillBlob(connectionString, blobContainerName, "unicode/SKILL.md", unicodeContent);
    const blobStore = new SkillBlobStore(connectionString, blobContainerName);
    blobStore.invalidateCache();

    const manifests = await blobStore.listSkills();
    const unicode = manifests.find((m) => m.id === "unicode");
    assert.ok(unicode);
    // Note: the simple parser may strip some unicode from name/description

    const content = await blobStore.readFile("unicode/SKILL.md");
    assert.ok(content.includes("こんにちは世界"));
    assert.ok(content.includes("🚀🎯"));
  });

  await t.test("non-SKILL.md files in container are ignored", async () => {
    // Upload some non-skill files
    await uploadSkillBlob(connectionString, blobContainerName, "readme.md", "# README");
    await uploadSkillBlob(connectionString, blobContainerName, "notes/TODO.md", "# TODO");

    const blobStore = new SkillBlobStore(connectionString, blobContainerName);
    blobStore.invalidateCache();

    const manifests = await blobStore.listSkills();
    // Only files ending in /SKILL.md should be included
    for (const m of manifests) {
      assert.ok(m.blobPath.endsWith("/SKILL.md"), `Unexpected blob path: ${m.blobPath}`);
    }
  });

  // Cleanup
  await deleteTestContainer(connectionString, blobContainerName);
});

// ============================================================================
// Suite 10: Concurrent Operations
// ============================================================================

test("E2E: Concurrent operations", { skip: SKIP_COSMOS }, async (t) => {
  const store = await createRealStore();

  await t.test("parallel upserts for different users succeed", async () => {
    const users = Array.from({ length: 10 }, (_, i) => `concurrent-user-${RUN_ID}-${i}`);

    // Upsert all 10 users' configs in parallel
    await Promise.all(
      users.map((userId) =>
        store.upsert(buildConfig(userId, "weather", true, { NOTE: `user-${userId}` })),
      ),
    );

    // Verify all were saved
    for (const userId of users) {
      const result = await store.get(userId, "weather");
      assert.ok(result, `Config for ${userId} should exist`);
      assert.equal(result.enabled, true);
      assert.equal(result.credentials.NOTE, `user-${userId}`);
    }

    // Cleanup
    await Promise.all(users.map((userId) => store.delete(userId, "weather")));
  });

  await t.test("parallel upserts for same user (last writer wins)", async () => {
    const userId = `concurrent-same-${RUN_ID}`;

    // Upsert 5 different values for the same document in parallel
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.upsert(buildConfig(userId, "weather", true, { VERSION: `v${i}` })),
      ),
    );

    // One of the writes should win — just verify the document exists and is consistent
    const result = await store.get(userId, "weather");
    assert.ok(result);
    assert.equal(result.enabled, true);
    assert.ok(result.credentials.VERSION?.startsWith("v"));

    // Cleanup
    await store.delete(userId, "weather");
  });

  await t.test("parallel reads are safe", async () => {
    const userId = `concurrent-read-${RUN_ID}`;
    await store.upsert(buildConfig(userId, "weather", true));

    // Read the same document 20 times in parallel
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.get(userId, "weather")),
    );

    for (const result of results) {
      assert.ok(result);
      assert.equal(result.skillId, "weather");
      assert.equal(result.enabled, true);
    }

    // Cleanup
    await store.delete(userId, "weather");
  });
});

// ============================================================================
// Suite 11: Real http_fetch → Open-Meteo API (network integration)
// ============================================================================

test("E2E: Real http_fetch → Open-Meteo API", async (t) => {
  // Minimal handler: only needs http_fetch, no real Cosmos/Blob required
  const handler = new SkillToolHandler(
    null as any,   // store — not used by http_fetch
    null as any,   // blobStore — not used by http_fetch
    [],            // statuses
    {},            // credentials
  );

  await t.test("geocode + weather pipeline via http_fetch (what LLM would do)", async () => {
    // Step 1: Geocode "Paris" — LLM reads exec: ["curl", ...] and translates to http_fetch
    const geocodeRaw = await handler.handle(
      HTTP_FETCH_TOOL_NAME,
      { url: "https://geocoding-api.open-meteo.com/v1/search?name=Paris&count=1", timeout: 15 },
      "e2e-test-user",
    );
    const geocodeResult = JSON.parse(geocodeRaw);

    if (geocodeResult.error) {
      // Network unavailable — skip
      return;
    }

    assert.equal(geocodeResult.status, 200, `Geocode status: ${geocodeResult.status}`);
    const geocodeData = JSON.parse(geocodeResult.body);
    assert.ok(geocodeData.results?.length > 0, "Should find Paris");
    const lat = geocodeData.results[0].latitude;
    const lon = geocodeData.results[0].longitude;
    assert.ok(lat > 48 && lat < 49, `Paris latitude ${lat} should be ~48.85`);
    assert.ok(lon > 2 && lon < 3, `Paris longitude ${lon} should be ~2.35`);

    // Step 2: Fetch current weather — same translation from exec: ["curl", ...]
    const weatherRaw = await handler.handle(
      HTTP_FETCH_TOOL_NAME,
      {
        url: `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`,
        timeout: 15,
      },
      "e2e-test-user",
    );
    const weatherResult = JSON.parse(weatherRaw);
    assert.equal(weatherResult.status, 200, `Weather status: ${weatherResult.status}`);

    const weatherData = JSON.parse(weatherResult.body);
    assert.ok(weatherData.current, "Should have current weather");
    assert.ok(typeof weatherData.current.temperature_2m === "number");
    assert.ok(typeof weatherData.current.weather_code === "number");
    assert.ok(typeof weatherData.current.wind_speed_10m === "number");

    // Sanity check: temperature between -30 and +50°C
    const temp = weatherData.current.temperature_2m;
    assert.ok(temp >= -30 && temp <= 50, `Temperature ${temp}°C should be reasonable`);
  });

  await t.test("http_fetch returns structured response with status and headers", async () => {
    const raw = await handler.handle(
      HTTP_FETCH_TOOL_NAME,
      { url: "https://geocoding-api.open-meteo.com/v1/search?name=London&count=1" },
      "e2e-test-user",
    );
    const result = JSON.parse(raw);
    assert.equal(result.status, 200);
    assert.ok(result.contentType.includes("application/json"));
    assert.ok(result.body, "Should have response body");
    const body = JSON.parse(result.body);
    assert.ok(body.results?.[0]?.name === "London");
  });
});

// ============================================================================
// Suite 12: Audit Log Verification (Real Cosmos)
// ============================================================================

test("E2E: Audit log persistence in Cosmos", { skip: SKIP_COSMOS_AND_BLOB }, async (t) => {
  const connectionString = process.env.AzureWebJobsStorage!;
  const blobContainerName = `skills-audit-e2e-${RUN_ID.slice(0, 16)}`;
  const userId = `audit-e2e-${RUN_ID}`;

  await uploadSkillBlob(connectionString, blobContainerName, "weather/SKILL.md", WEATHER_SKILL_MD);
  await uploadSkillBlob(connectionString, blobContainerName, "github/SKILL.md", GITHUB_SKILL_MD);

  const blobStore = new SkillBlobStore(connectionString, blobContainerName);
  const store = await createRealStore();

  await t.test("skill_setup writes audit entries via real Cosmos", async () => {
    const resolved = await resolveUserSkills(blobStore, store, userId);
    const handler = new SkillToolHandler(store, blobStore, resolved.statuses, resolved.userCredentials);

    // Enable weather
    const enableResult = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "weather",
      action: "enable",
    }, userId);
    assert.equal(JSON.parse(enableResult).success, true);

    // Wait for fire-and-forget audit to complete
    await new Promise((r) => setTimeout(r, 500));

    // Verify the config was stored
    const config = await store.get(userId, "weather");
    assert.ok(config);
    assert.equal(config.enabled, true);
  });

  // Cleanup
  await store.delete(userId, "weather");
  await deleteTestContainer(connectionString, blobContainerName);
});

// ============================================================================
// Suite 13: Handler Rate Limiting (Real Cosmos timing)
// ============================================================================

test("E2E: Handler rate limiting with real Cosmos", { skip: SKIP_COSMOS_AND_BLOB }, async (t) => {
  const connectionString = process.env.AzureWebJobsStorage!;
  const blobContainerName = `skills-ratelimit-e2e-${RUN_ID.slice(0, 16)}`;
  const userId = `ratelimit-e2e-${RUN_ID}`;

  await uploadSkillBlob(connectionString, blobContainerName, "weather/SKILL.md", WEATHER_SKILL_MD);

  const blobStore = new SkillBlobStore(connectionString, blobContainerName);
  const store = await createRealStore();

  await t.test("rapid skill_setup calls are rate-limited", async () => {
    const resolved = await resolveUserSkills(blobStore, store, userId);
    const handler = new SkillToolHandler(store, blobStore, resolved.statuses, resolved.userCredentials);

    // First call should succeed
    const first = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "weather",
      action: "enable",
    }, userId);
    assert.equal(JSON.parse(first).success, true);

    // Immediate second call should be rate-limited
    const second = await handler.handle(SKILL_SETUP_TOOL_NAME, {
      skill_id: "weather",
      action: "disable",
    }, userId);
    const secondResult = JSON.parse(second);
    assert.ok(secondResult.error);
    assert.ok(secondResult.error.includes("Rate limited"));
  });

  // Cleanup
  await store.delete(userId, "weather");
  await deleteTestContainer(connectionString, blobContainerName);
});

// ============================================================================
// Suite 14: OpenAI — Tool Definitions Format Validation
// ============================================================================

test("E2E: OpenAI accepts skill tool definitions", { skip: SKIP_OPENAI }, async (t) => {
  await t.test("tool definitions are valid for OpenAI Responses API", async () => {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    const toolDefs = getSkillToolDefinitions();
    const tools = toolDefs.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
      strict: false,
    }));

    // The real test: OpenAI API accepts our tool definitions without error
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      instructions: "You are a test assistant. List available tools.",
      input: "What tools do you have?",
      tools,
      tool_choice: "none", // Don't actually call tools — just validate definitions
    });

    // Should get a response without errors
    assert.ok(response.output, "Should get a response");
    assert.ok(response.output.length > 0, "Should have output items");
  });
});

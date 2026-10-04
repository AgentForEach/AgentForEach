import assert from "node:assert/strict";
import test from "node:test";
import { MemoryObjectStore, S3ObjectStore, type ObjectStore } from "@agentforeach/platform";
import { AzureBlobObjectStore } from "@agentforeach/platform-azure";
import { installAzureBlob, LazyObjectStore, openObjectStore, resolveObjectStorage, s3ObjectStorage, type ObjectStorageOpener } from "./index.js";
import { SkillBlobStore } from "../skills/blob-store.js";
import { ExportBlobStore } from "../skills/sandbox/export-store.js";

/** Containers kept in memory, so the domain stores run without a cloud. */
function memoryStorage(): ObjectStorageOpener & { containers: Map<string, MemoryObjectStore>; created: string[] } {
  const containers = new Map<string, MemoryObjectStore>();
  const created: string[] = [];
  return {
    provider: "memory",
    containers,
    created,
    open(container, options) {
      if (options?.createContainer) created.push(container);
      if (!containers.has(container)) containers.set(container, new MemoryObjectStore({ bucket: container }));
      return containers.get(container)!;
    },
  };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("object storage defaults to Azure Blob Storage on the runtime account, loaded on first use", async () => {
  const conn = "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=a2V5;EndpointSuffix=core.windows.net";
  withEnv({ OBJECT_STORE_PROVIDER: undefined, AzureWebJobsStorage__accountName: undefined }, () => {
    assert.equal(resolveObjectStorage(undefined), undefined, "nothing configured");
    assert.equal(resolveObjectStorage(conn), conn);
  });
  const store = openObjectStore(conn, "skills");
  assert.ok(store instanceof LazyObjectStore);
  assert.equal(store.provider, "azure-blob");
  const azure = await store.resolve();
  assert.ok(azure instanceof AzureBlobObjectStore);
  assert.equal(azure.containerUrl, "https://acct.blob.core.windows.net/skills");
  assert.equal(await store.resolve(), azure, "built once");
});

test("the Azure entry builds azure-blob stores when they're opened", () => {
  installAzureBlob((storage, container, options) => new AzureBlobObjectStore(storage, container, options));
  try {
    assert.ok(openObjectStore("DefaultEndpointsProtocol=https;AccountName=a;AccountKey=a2V5;EndpointSuffix=core.windows.net", "skills") instanceof AzureBlobObjectStore);
    assert.throws(() => openObjectStore("not a connection string", "skills"), "a malformed connection string fails at once");
  } finally {
    installAzureBlob(undefined);
  }
});

test("OBJECT_STORE_PROVIDER=s3 opens one bucket per container", () => {
  const env = {
    OBJECT_STORE_PROVIDER: "s3",
    OBJECT_STORE_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    OBJECT_STORE_S3_REGION: "auto",
    OBJECT_STORE_S3_ACCESS_KEY_ID: "id",
    OBJECT_STORE_S3_SECRET_ACCESS_KEY: "secret",
    OBJECT_STORE_S3_BUCKETS: '{"skills":"acme-skills"}',
  };
  withEnv(env, () => {
    const storage = resolveObjectStorage("AccountName=ignored;AccountKey=x");
    assert.ok(storage && typeof storage === "object" && "open" in storage);
    assert.equal(storage.provider, "s3");
    const skills = openObjectStore(storage, "skills");
    assert.ok(skills instanceof S3ObjectStore);
    assert.equal((skills as unknown as { bucket: string }).bucket, "acme-skills");
    assert.equal((openObjectStore(storage, "user-exports") as unknown as { bucket: string }).bucket, "user-exports");
  });
  assert.equal(s3ObjectStorage({ OBJECT_STORE_S3_ENDPOINT: "https://x.test" }), undefined, "keys are required");
  const keys = { OBJECT_STORE_S3_ACCESS_KEY_ID: "id", OBJECT_STORE_S3_SECRET_ACCESS_KEY: "secret" };
  const region = (endpoint: string) =>
    (s3ObjectStorage({ ...keys, OBJECT_STORE_S3_ENDPOINT: endpoint })!.open("skills") as unknown as { region: string }).region;
  assert.equal(region("https://abc123.r2.cloudflarestorage.com"), "auto", "R2 signs with region auto");
  assert.equal(region("https://s3.us-east-1.amazonaws.com"), "us-east-1");
  withEnv({ OBJECT_STORE_PROVIDER: "ftp" }, () => assert.equal(resolveObjectStorage("x"), undefined));
});

test("SkillBlobStore over any object store: discovery, reads, caps and zips", async () => {
  const storage = memoryStorage();
  const skills = storage.open("skills");
  await skills.put("weather/SKILL.md", "---\nid: weather\nname: Weather\ndescription: Forecasts\ncategory: utility\ncredentials: []\n---\nBody");
  await skills.put("weather/skill.zip", new Uint8Array([80, 75, 3, 4]));
  await skills.put("notes/README.md", "not a skill");
  await skills.put("huge/SKILL.md", "x".repeat(256 * 1024 + 1));

  const store = new SkillBlobStore(storage, "skills");
  const manifests = await store.listSkills();
  assert.deepEqual(manifests.map((m) => m.blobPath), ["weather/SKILL.md"], "oversize SKILL.md files are skipped");
  assert.equal(await store.readFile("weather/SKILL.md").then((t) => t.endsWith("Body")), true);
  await assert.rejects(store.readFile("huge/SKILL.md"), /Blob "huge\/SKILL.md" exceeds maximum size \(262144 bytes\)/);
  await assert.rejects(store.readFile("../etc/passwd"), /directory traversal/);
  assert.equal(await store.hasSkillZip("weather"), true);
  assert.equal(await store.hasSkillZip("notes"), false);
  assert.deepEqual([...(await store.downloadSkillZip("weather"))], [80, 75, 3, 4]);
});

test("ExportBlobStore over any object store: per-user folders, headers, signed links, erasure", async () => {
  const storage = memoryStorage();
  const exports = new ExportBlobStore(storage);
  const result = await exports.upload("alice@example.com", "../report.csv", Buffer.from("a,b\n"));
  assert.deepEqual(storage.created, ["user-exports"], "the container may be created on write");

  const container: ObjectStore = storage.containers.get("user-exports")!;
  assert.match(result.blobPath, /^[0-9a-f]{32}\/[0-9a-f-]{36}_report\.csv$/);
  assert.equal(result.sizeBytes, 4);
  assert.match(result.downloadUrl, /^https:\/\/objects\.memory\.invalid\/user-exports\//);
  const hours = (Date.parse(result.expiresAt) - Date.now()) / 3_600_000;
  assert.ok(hours > 23.9 && hours <= 24, `expires in ${hours}h`);
  const stored = (container as unknown as { objects: Map<string, { contentType?: string; contentDisposition?: string }> }).objects.get(result.blobPath);
  assert.equal(stored?.contentType, "text/csv");
  assert.equal(stored?.contentDisposition, 'attachment; filename="report.csv"');

  await exports.upload("bob", "b.txt", Buffer.from("b"));
  assert.equal(await exports.deleteUserFiles("alice@example.com"), 1);
  assert.equal(await exports.deleteUserFiles("alice@example.com"), 0);
  assert.equal(await exports.deleteUserFiles("bob"), 1);
});

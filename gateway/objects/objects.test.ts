import assert from "node:assert/strict";
import test from "node:test";
import { MemoryObjectStore, S3ObjectStore, type ObjectStore } from "@agentforeach/platform";
import { AzureBlobObjectStore } from "@agentforeach/platform-azure";
import { installHost, resetHostForTests } from "../runtime/host.js";
import { installAzureBlob, installS3Defaults, LazyObjectStore, openObjectStore, resolveObjectStorage, s3ObjectStorage, type ObjectStorageOpener } from "./index.js";
import { SkillBlobStore } from "../skills/blob-store.js";
import { contentDisposition, ExportBlobStore } from "../skills/sandbox/export-store.js";

/** Containers kept in memory, so the domain stores run without a cloud. */
function memoryStorage(credentialsExpireAt?: Date): ObjectStorageOpener & { containers: Map<string, MemoryObjectStore>; created: string[] } {
  const containers = new Map<string, MemoryObjectStore>();
  const created: string[] = [];
  return {
    provider: "memory",
    containers,
    created,
    open(container, options) {
      if (options?.createContainer) created.push(container);
      if (!containers.has(container)) containers.set(container, new MemoryObjectStore({ bucket: container, credentialsExpireAt: () => credentialsExpireAt }));
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

/** An s3 store's private settings, for checking what the env configured. */
const settings = (store: ObjectStore) => store as unknown as Record<string, unknown> & { ownerHeaders: Record<string, string> };

test("OBJECT_STORE_S3_* shares a bucket by prefix and sets the owner check, KMS key, version erasure and timeout", () => {
  const keys = { OBJECT_STORE_S3_ENDPOINT: "https://s3.eu-west-1.amazonaws.com", OBJECT_STORE_S3_ACCESS_KEY_ID: "id", OBJECT_STORE_S3_SECRET_ACCESS_KEY: "secret" };
  const storage = s3ObjectStorage({
    ...keys,
    OBJECT_STORE_S3_BUCKETS: '{"skills":"acme/skills/","user-exports":"acme/exports"}',
    OBJECT_STORE_S3_EXPECTED_BUCKET_OWNER: "123456789012",
    OBJECT_STORE_S3_KMS_KEY_ID: "alias/exports",
    OBJECT_STORE_S3_DELETE_VERSIONS: "true",
    OBJECT_STORE_S3_TIMEOUT_MS: "5000",
    OBJECT_STORE_S3_MAX_SIGNED_URL_SECONDS: "900",
  })!;
  const skills = settings(storage.open("skills"));
  const exports = settings(storage.open("user-exports", { createContainer: true }));
  assert.deepEqual([skills.bucket, skills.prefix, exports.bucket, exports.prefix], ["acme", "skills/", "acme", "exports/"]);
  assert.deepEqual(exports.ownerHeaders, { "x-amz-expected-bucket-owner": "123456789012" });
  assert.equal(exports.kmsKeyId, "alias/exports");
  assert.equal(exports.deleteVersions, true);
  assert.equal(exports.timeoutMs, 5000);
  assert.equal(exports.maxSignedUrlSeconds, 900);
  assert.equal(settings(s3ObjectStorage(keys)!.open("skills")).maxSignedUrlSeconds, undefined, "no cap unless configured (R2, MinIO)");
  assert.equal(exports.createBucket, true, "static keys may create a missing bucket, as before");
  assert.equal(settings(s3ObjectStorage(keys)!.open("skills")).deleteVersions, false);

  assert.equal(s3ObjectStorage({ ...keys, OBJECT_STORE_S3_BUCKETS: '{"skills":"acme/","user-exports":"acme/exports/"}' }), undefined, "overlapping places in one bucket");
  assert.equal(s3ObjectStorage({ ...keys, OBJECT_STORE_S3_BUCKETS: '{"skills":"acme","user-exports":"acme"}' }), undefined, "one bucket, no prefixes");
});

test("without keys, the s3 provider uses the host's own credentials, endpoint and region", async () => {
  const keys = { OBJECT_STORE_S3_ACCESS_KEY_ID: "id", OBJECT_STORE_S3_SECRET_ACCESS_KEY: "secret" };
  const credentials = async () => ({ accessKeyId: "ASIAEXAMPLE", secretAccessKey: "s", sessionToken: "t", expiration: new Date(Date.now() + 3_600_000) });
  const defaults = { credentials, endpoint: "https://s3.us-west-2.amazonaws.com", region: "us-west-2", addressing: "virtual" as const, deleteVersions: true, maxSignedUrlSeconds: 3600 };
  assert.equal(s3ObjectStorage({}), undefined, "nothing installed, nothing configured");

  installS3Defaults(defaults);
  try {
    withEnv({ OBJECT_STORE_PROVIDER: "s3", ...Object.fromEntries(Object.keys(keys).map((k) => [k, undefined])), OBJECT_STORE_S3_ENDPOINT: undefined, OBJECT_STORE_S3_REGION: undefined, OBJECT_STORE_S3_BUCKETS: '{"user-exports":"acme-exports"}' }, () => {
      const storage = resolveObjectStorage(undefined);
      assert.ok(storage && typeof storage === "object" && "open" in storage);
      const exports = settings(openObjectStore(storage, "user-exports", { createContainer: true }));
      assert.equal(exports.credentials, credentials);
      assert.equal((exports.endpoint as URL).host, "s3.us-west-2.amazonaws.com");
      assert.deepEqual([exports.region, exports.addressing, exports.deleteVersions, exports.maxSignedUrlSeconds], ["us-west-2", "virtual", true, 3600]);
      assert.equal(exports.createBucket, false, "the host's buckets are provisioned, never created");
    });
    const store = s3ObjectStorage({ OBJECT_STORE_S3_DELETE_VERSIONS: "false", OBJECT_STORE_S3_MAX_SIGNED_URL_SECONDS: "7200" })!.open("user-exports");
    assert.deepEqual([settings(store).deleteVersions, settings(store).maxSignedUrlSeconds], [false, 7200], "the env overrides the host");
    const { url, expiresAt } = await store.signedUrlWithExpiry!("u/f.txt", { expiresAt: new Date(Date.now() + 86_400_000) });
    assert.match(url, /^https:\/\/user-exports\.s3\.us-west-2\.amazonaws\.com\/u\/f\.txt\?.*X-Amz-Security-Token=t/);
    assert.ok(expiresAt.getTime() <= Date.now() + 3_600_000 - 60_000, "cut short to the credentials");
    const unexpiring = s3ObjectStorage({}, { ...defaults, credentials: async () => ({ accessKeyId: "ASIA", secretAccessKey: "s", sessionToken: "t" }) })!.open("user-exports");
    const capped = await unexpiring.signedUrlWithExpiry!("u/f.txt", { expiresAt: new Date(Date.now() + 86_400_000) });
    assert.ok(capped.expiresAt.getTime() <= Date.now() + 3_600_000, "credentials without an expiration: the host's cap");
    assert.equal(settings(s3ObjectStorage(keys, defaults)!.open("skills")).credentials !== credentials, true, "static keys win");
  } finally {
    installS3Defaults(undefined);
  }
});

test("on AWS, an unset OBJECT_STORE_PROVIDER is an error, never Azure Blob Storage", () => {
  const conn = "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=a2V5;EndpointSuffix=core.windows.net";
  withEnv({ OBJECT_STORE_PROVIDER: undefined, AWS_LAMBDA_FUNCTION_NAME: "agentforeach-http" }, () => {
    assert.throws(() => resolveObjectStorage(conn), /set OBJECT_STORE_PROVIDER=s3/);
  });
  installHost({ platform: "aws", isProductionHost: true, publicBaseUrl: undefined, label: "aws:test" });
  try {
    withEnv({ OBJECT_STORE_PROVIDER: undefined, AWS_LAMBDA_FUNCTION_NAME: undefined }, () => {
      assert.throws(() => resolveObjectStorage(conn), /set OBJECT_STORE_PROVIDER=s3/);
    });
    withEnv({ OBJECT_STORE_PROVIDER: "azure-blob" }, () => assert.equal(resolveObjectStorage(conn), conn, "an explicit choice stands"));
  } finally {
    resetHostForTests();
  }
  withEnv({ OBJECT_STORE_PROVIDER: undefined, AWS_LAMBDA_FUNCTION_NAME: undefined }, () => assert.equal(resolveObjectStorage(conn), conn, "elsewhere the default is unchanged"));
});

test("a lazily built store reports its links' expiry, falling back to the expiry asked for", async () => {
  const expiresAt = new Date(Date.now() + 3_600_000);
  const clamped = new LazyObjectStore("memory", async () => new MemoryObjectStore({ credentialsExpireAt: () => new Date(Date.now() + 600_000) }));
  assert.ok((await clamped.signedUrlWithExpiry("k", { expiresAt })).expiresAt.getTime() < Date.now() + 600_000);
  const plain = { provider: "plain", signedUrl: async () => "https://x.test/k" } as unknown as ObjectStore;
  assert.deepEqual(await new LazyObjectStore("plain", async () => plain).signedUrlWithExpiry("k", { expiresAt }), { url: "https://x.test/k", expiresAt });
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
  assert.equal(stored?.contentDisposition, `attachment; filename="report.csv"; filename*=UTF-8''report.csv`);

  await exports.upload("bob", "b.txt", Buffer.from("b"));
  assert.equal(await exports.deleteUserFiles("alice@example.com"), 1);
  assert.equal(await exports.deleteUserFiles("alice@example.com"), 0);
  assert.equal(await exports.deleteUserFiles("bob"), 1);
});

test("ExportBlobStore turns any file name into a valid key and a safe download header", async () => {
  const storage = memoryStorage();
  const exports = new ExportBlobStore(storage);
  const objects = () => (storage.containers.get("user-exports") as unknown as { objects: Map<string, { contentDisposition?: string }> }).objects;

  const unicode = await exports.upload("u", "Quarterly report ünïcödé ✓ (final).csv", Buffer.from("x"));
  assert.match(unicode.blobPath, /_Quarterly report ünïcödé ✓ \(final\)\.csv$/, "spaces and Unicode stay in the key");
  assert.equal(
    objects().get(unicode.blobPath)?.contentDisposition,
    `attachment; filename="Quarterly report _n_c_d_ _ (final).csv"; filename*=UTF-8''Quarterly%20report%20%C3%BCn%C3%AFc%C3%B6d%C3%A9%20%E2%9C%93%20%28final%29.csv`,
  );

  const hostile = await exports.upload("u", 'a"b\\c\r\nSet-Cookie: x=1\t.txt', Buffer.from("x"));
  assert.match(hostile.blobPath, /_a_b_c__Set-Cookie: x=1_\.txt$/);
  const header = objects().get(hostile.blobPath)?.contentDisposition ?? "";
  assert.doesNotMatch(header, /[\r\n\t\\]/, "no header injection");
  assert.equal(header.match(/"/g)?.length, 2, "only the quotes around the ASCII name");

  const long = await exports.upload("u", `${"é".repeat(400)}.pdf`, Buffer.from("x"));
  const name = long.blobPath.split("_").slice(1).join("_");
  assert.ok(Buffer.byteLength(name) <= 255 && name.endsWith(".pdf"), `kept ${Buffer.byteLength(name)} bytes`);

  for (const result of [unicode, hostile, long]) assert.equal(await storage.containers.get("user-exports")!.exists(result.blobPath), true);
  assert.equal(contentDisposition("it's.txt"), `attachment; filename="it's.txt"; filename*=UTF-8''it%27s.txt`);
});

test("ExportBlobStore reports when the link really expires", async () => {
  const credentialsExpireAt = new Date(Date.now() + 15 * 60_000);
  const exports = new ExportBlobStore(memoryStorage(credentialsExpireAt));
  const result = await exports.upload("u", "r.csv", Buffer.from("x"));
  assert.ok(Date.parse(result.expiresAt) <= credentialsExpireAt.getTime() - 60_000, `${result.expiresAt}, not the 24 hours asked for`);
  assert.equal(new URL(result.downloadUrl).searchParams.get("expires"), result.expiresAt);
});

test("SkillBlobStore reads skill files whose names have spaces and Unicode", async () => {
  const storage = memoryStorage();
  await storage.open("skills").put("météo skill/SKILL.md", "---\nid: meteo\nname: Météo\ndescription: d\ncategory: utility\n---\nBody");
  await storage.open("skills").put("météo skill/docs/read me.md", "notes");
  const store = new SkillBlobStore(storage, "skills");
  assert.deepEqual((await store.listSkills()).map((m) => m.blobPath), ["météo skill/SKILL.md"]);
  assert.equal(await store.readFile("météo skill/docs/read me.md"), "notes");
  await assert.rejects(store.readFile("météo skill//docs"), { code: "invalid" });
});

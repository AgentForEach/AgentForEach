/**
 * ACA Sandboxes client against an in-memory fake of the data plane.
 *
 * The fake implements only what the client calls: list-by-label, create,
 * get, resume, executeShellCommand, files (PUT/GET/list) and delete. It
 * records every request so tests can assert on the wire shape.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { AcaSandboxesClient, buildExecCommand, labelHash } from "./aca-sandboxes-client.js";
import { dataPath } from "./shared.js";
import type { SandboxConfig } from "./types.js";

const ENDPOINT = "https://management.westus2.azuredevcompute.io";
const BASE = "/subscriptions/sub-1/resourceGroups/rg-1/sandboxGroups/grp-1";

type FakeSandbox = {
  id: string;
  state: string;
  createdAt: string;
  labels: Record<string, string>;
  body: Record<string, unknown>;
  files: Map<string, Buffer>;
};

type Recorded = { method: string; path: string; query: URLSearchParams; body?: unknown };

class FakeDataPlane {
  sandboxes = new Map<string, FakeSandbox>();
  requests: Recorded[] = [];
  nextExec: { exitCode?: number; stdout: string; stderr: string } = {
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  };
  /** Statuses to return, in order, before handling requests normally. */
  failNext: number[] = [];
  /** Leave labels out of list and get responses (a service that drops them). */
  omitLabels = false;
  /** Called after a create, to simulate another instance racing. */
  onCreate?: () => void;
  stoppedReason?: string;
  private seq = 0;

  add(labels: Record<string, string>, state = "Running", createdAt = "2026-09-01T00:00:00.000Z") {
    const id = `sbx-${++this.seq}`;
    this.sandboxes.set(id, { id, state, createdAt, labels, body: {}, files: new Map() });
    return id;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const raw = init.body;
    let body: unknown;
    if (typeof raw === "string") body = JSON.parse(raw);
    else if (raw instanceof Uint8Array) body = Buffer.from(raw);
    this.requests.push({ method, path: url.pathname, query: url.searchParams, body });

    assert.equal(url.origin, ENDPOINT);
    assert.equal(url.searchParams.get("api-version"), "2026-02-01-preview");
    assert.match(String((init.headers as Record<string, string>).Authorization), /^Bearer test-token$/);
    assert.ok(url.pathname.startsWith(BASE), url.pathname);

    const rest = url.pathname.slice(BASE.length);
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    const view = (sb: FakeSandbox) => ({
      id: sb.id,
      state: sb.state,
      createdAt: sb.createdAt,
      ...(this.omitLabels ? {} : { labels: sb.labels }),
      ...(this.stoppedReason ? { stateDetails: { stoppedReason: this.stoppedReason } } : {}),
    });

    const failure = this.failNext.shift();
    if (failure) return json(failure, { error: `injected ${failure}` });

    if (rest === "/sandboxes" && method === "GET") {
      const [key, value] = (url.searchParams.get("labels") ?? "").split("=");
      const matches = [...this.sandboxes.values()].filter((s) => s.labels[key] === value);
      return json(200, { value: matches.map(view) });
    }
    if (rest === "/sandboxes" && method === "PUT") {
      const b = body as { labels: Record<string, string> };
      const id = this.add(b.labels, "Running", `2026-09-29T00:00:0${this.seq}.000Z`);
      this.sandboxes.get(id)!.body = body as Record<string, unknown>;
      this.onCreate?.();
      return json(201, { id, state: "Creating", labels: b.labels });
    }

    const m = rest.match(/^\/sandboxes\/([^/]+)(\/.*)?$/);
    if (!m) return json(400, { error: "unexpected path" });
    const sandbox = this.sandboxes.get(m[1]);
    if (!sandbox) return json(404, { error: "SandboxNotFound" });
    const sub = m[2] ?? "";

    if (sub === "" && method === "GET") return json(200, view(sandbox));
    if (sub === "" && method === "DELETE") {
      this.sandboxes.delete(sandbox.id);
      return new Response(null, { status: 202 });
    }
    if (sub === "/resume" && method === "POST") {
      if (this.stoppedReason === "Disabled") return json(400, { error: "SandboxDisabled" });
      sandbox.state = "Running";
      return new Response(null, { status: 202 });
    }
    if (sub === "/egresspolicy" && method === "POST") {
      sandbox.body.egressPolicy = body;
      return json(200, body);
    }
    if (sub === "/lifecycle" && method === "POST") {
      sandbox.body.lifecycleUpdate = body;
      return json(200, body);
    }
    if (sandbox.state !== "Running") {
      return json(409, { title: "GlobalSandboxNotRunning", status: 409 });
    }

    if (sub === "/executeShellCommand" && method === "POST") return json(200, this.nextExec);
    if (sub === "/files" && method === "PUT") {
      sandbox.files.set(url.searchParams.get("path")!, body as Buffer);
      return json(200, {});
    }
    if (sub === "/files" && method === "GET") {
      const file = sandbox.files.get(url.searchParams.get("path")!);
      return file ? new Response(new Uint8Array(file), { status: 200 }) : json(404, { error: "FileNotFound" });
    }
    if (sub === "/files/list" && method === "GET") {
      if (sandbox.files.size === 0) return json(404, { error: "DirectoryNotFound" });
      return json(200, {
        path: "/mnt/data",
        entries: [
          // Shape observed on the live service (not the SDK's isDirectory/modifiedAt).
          ...[...sandbox.files.entries()].map(([p, b]) => ({
            name: p.split("/").pop(),
            path: p,
            size: b.byteLength,
            mode: 420,
            isDir: false,
            isSymlink: false,
            modifiedTime: 1790659885,
          })),
          { name: "subdir", path: "/mnt/data/subdir", size: 4096, isDir: true, modifiedTime: 1790659885 },
        ],
      });
    }
    return json(400, { error: `unhandled ${method} ${sub}` });
  };
}

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    enabled: true,
    provider: "aca-sandboxes",
    poolManagementEndpoint: "",
    containerType: "PythonLTS",
    identifierStrategy: "userId",
    defaultTimeoutSec: 120,
    maxTimeoutSec: 300,
    cooldownSec: 600,
    networkAccess: "disabled",
    maxOutputChars: 50_000,
    exportsContainerName: "user-exports",
    exportExpiryHours: 24,
    maxExportBytes: 50 * 1024 * 1024,
    sandboxes: {
      subscriptionId: "sub-1",
      resourceGroup: "rg-1",
      sandboxGroup: "grp-1",
      endpoint: ENDPOINT,
      diskImage: "ubuntu",
      cpu: "1000m",
      memory: "2048Mi",
      autoSuspendSec: 300,
      suspendMode: "Disk",
      autoDeleteDays: 30,
      egressAllowHosts: ["pypi.org"],
      defaultTimeoutSec: 120,
      maxTimeoutSec: 200,
    },
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function setup(overrides: Partial<SandboxConfig> = {}) {
  const fake = new FakeDataPlane();
  globalThis.fetch = fake.fetch as typeof fetch;
  const client = new AcaSandboxesClient(config(overrides), {
    tokenProvider: { getToken: async () => "test-token" },
    pollIntervalMs: 1,
    readyTimeoutMs: 200,
    retryBaseMs: 1,
  });
  return { fake, client };
}

/** Identifier the client uses for a user (userId strategy). */
const idFor = (userId: string) => JSON.stringify([userId]);
const owner = (userId: string) => ({
  app: "agentforeach",
  "agentforeach-owner": labelHash(idFor(userId)),
  "agentforeach-user": labelHash(userId),
});
const creates = (fake: FakeDataPlane) =>
  fake.requests.filter((r) => r.method === "PUT" && r.path === `${BASE}/sandboxes`).length;

// ============================================================================
// Lifecycle
// ============================================================================

test("creates one sandbox per user with suspend policy, full-inspection egress and hashed labels", async () => {
  const { fake, client } = setup();
  await client.exec({ command: "echo hi" }, client.resolveIdentifier("alice@example.com"));

  const put = fake.requests.find((r) => r.method === "PUT" && r.path === `${BASE}/sandboxes`);
  assert.ok(put, "expected a create call");
  const body = put.body as {
    sourcesRef: unknown;
    resources: unknown;
    lifecycle: unknown;
    egressPolicy: unknown;
    labels: Record<string, string>;
  };
  assert.deepEqual(body.sourcesRef, { diskImage: { name: "ubuntu", isPublic: true } });
  assert.deepEqual(body.resources, { cpu: "1000m", memory: "2048Mi" });
  assert.deepEqual(body.lifecycle, {
    autoSuspendPolicy: { enabled: true, interval: 300, mode: "Disk" },
  });
  assert.deepEqual(body.egressPolicy, {
    defaultAction: "Deny",
    trafficInspection: "Full",
    hostRules: [{ pattern: "pypi.org", action: "Allow" }],
  });
  assert.deepEqual(body.labels, owner("alice@example.com"));
  assert.ok(!JSON.stringify(body.labels).includes("alice"), "user id must not leak into labels");
});

test("POST /lifecycle repeats auto-suspend, because it replaces the whole policy", async () => {
  // Live finding: posting only autoDeletePolicy removed autoSuspendPolicy,
  // leaving sandboxes running (and billing) forever.
  const { fake, client } = setup();
  await client.exec({ command: "true" }, client.resolveIdentifier("amy"));
  const lifecycle = fake.requests.find((r) => r.path.endsWith("/lifecycle"));
  assert.deepEqual(lifecycle?.body, {
    autoSuspendPolicy: { enabled: true, interval: 300, mode: "Disk" },
    autoDeletePolicy: { enabled: true, deleteIntervalInSeconds: 30 * 86_400 },
  });
});

test("an explicit disk size is sent with the resources", async () => {
  const { fake, client } = setup({
    sandboxes: { ...config().sandboxes!, diskImageId: "img-1", disk: "40Gi" },
  });
  await client.exec({ command: "true" }, client.resolveIdentifier("ada"));
  const put = fake.requests.find((r) => r.method === "PUT" && r.path === `${BASE}/sandboxes`);
  const body = put?.body as { sourcesRef: unknown; resources: unknown };
  assert.deepEqual(body.sourcesRef, { diskImage: { id: "img-1" } });
  assert.deepEqual(body.resources, { cpu: "1000m", memory: "2048Mi", disk: "40Gi" });
});

test("reuses the oldest existing sandbox for the owner instead of creating", async () => {
  const { fake, client } = setup();
  fake.add(owner("bob"), "Running", "2026-09-02T00:00:00.000Z");
  const oldest = fake.add(owner("bob"), "Running", "2026-09-01T00:00:00.000Z");
  fake.add(owner("someone-else"));

  const result = await client.exec({ command: "ls" }, client.resolveIdentifier("bob"));
  assert.equal(result.exitCode, 0);
  assert.equal(creates(fake), 0);
  const exec = fake.requests.find((r) => r.path.endsWith("/executeShellCommand"))!;
  assert.equal(exec.path, `${BASE}/sandboxes/${oldest}/executeShellCommand`);
});

test("fails closed when the service returns sandboxes without labels", async () => {
  const { fake, client } = setup();
  fake.add(owner("victim"));
  fake.omitLabels = true;
  // Neither the unlabeled sandbox nor a new one (whose owner can't be verified) may be used.
  await assert.rejects(
    client.exec({ command: "cat ~/.agentforeach/env" }, client.resolveIdentifier("attacker")),
    /does not belong to this owner/,
  );
  assert.equal(fake.requests.filter((r) => r.path.endsWith("/executeShellCommand")).length, 0);
});

test("a listed sandbox whose owner label doesn't match is never used", async () => {
  const { fake, client } = setup();
  const theirs = fake.add(owner("victim"));
  // A service that ignores the label filter returns someone else's sandbox.
  const serve = fake.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === `${BASE}/sandboxes` && (init?.method ?? "GET") === "GET") {
      return new Response(
        JSON.stringify({ value: [{ id: theirs, state: "Running", labels: owner("victim") }] }),
        { status: 200 },
      );
    }
    return serve(input, init);
  }) as typeof fetch;

  await client.exec({ command: "true" }, client.resolveIdentifier("attacker"));
  const exec = fake.requests.find((r) => r.path.endsWith("/executeShellCommand"))!;
  assert.notEqual(exec.path, `${BASE}/sandboxes/${theirs}/executeShellCommand`);
});

test("resumes a suspended sandbox before running a command", async () => {
  const { fake, client } = setup();
  const id = fake.add(owner("carol"), "Suspended");

  await client.exec({ command: "cat notes.txt" }, client.resolveIdentifier("carol"));
  const paths = fake.requests.map((r) => `${r.method} ${r.path.slice(BASE.length)}`);
  const resumeAt = paths.indexOf(`POST /sandboxes/${id}/resume`);
  const execAt = paths.indexOf(`POST /sandboxes/${id}/executeShellCommand`);
  assert.ok(resumeAt >= 0 && resumeAt < execAt, paths.join("\n"));
});

test("a disabled sandbox fails fast with a clear error", async () => {
  const { fake, client } = setup();
  fake.add(owner("dana"), "Stopped");
  fake.stoppedReason = "Disabled";
  await assert.rejects(
    client.exec({ command: "true" }, client.resolveIdentifier("dana")),
    /administratively disabled/,
  );
  assert.equal(fake.requests.filter((r) => r.path.endsWith("/resume")).length, 0);
});

test("resume errors other than 409 surface instead of timing out", async () => {
  const { fake, client } = setup();
  const id = fake.add(owner("dora"), "Suspended");
  const serve = fake.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes(`/sandboxes/${id}/resume`)) {
      return new Response(JSON.stringify({ error: "BadRequest" }), { status: 400 });
    }
    return serve(input, init);
  }) as typeof fetch;
  await assert.rejects(client.exec({ command: "true" }, client.resolveIdentifier("dora")), /400/);
});

test("recovers when the sandbox was stopped behind the client's back", async () => {
  const { fake, client } = setup();
  const identifier = client.resolveIdentifier("dina");
  await client.exec({ command: "true" }, identifier); // client now assumes Running
  const [id] = fake.sandboxes.keys();
  fake.sandboxes.get(id)!.state = "Stopped"; // e.g. another instance or an operator
  const result = await client.exec({ command: "echo back" }, identifier);
  assert.equal(result.exitCode, 0);
  assert.ok(fake.requests.some((r) => r.path.endsWith(`/sandboxes/${id}/resume`)));
});

test("replaces a sandbox that was deleted underneath us", async () => {
  const { fake, client } = setup();
  const first = fake.add(owner("dave"));
  const identifier = client.resolveIdentifier("dave");
  await client.exec({ command: "true" }, identifier);

  fake.sandboxes.delete(first); // e.g. auto-deleted after 30 days stopped
  await client.exec({ command: "true" }, identifier);

  assert.equal(fake.sandboxes.size, 1);
  assert.notEqual([...fake.sandboxes.keys()][0], first);
});

test("parallel tool calls for one user share a single create", async () => {
  const { fake, client } = setup();
  const identifier = client.resolveIdentifier("erin");
  await Promise.all([
    client.exec({ command: "a" }, identifier),
    client.fileWrite({ filename: "x.txt", content: "x" }, identifier),
    client.exec({ command: "b" }, identifier),
  ]);
  assert.equal(creates(fake), 1);
});

test("an instance that loses a create race switches to the winner and deletes its own", async () => {
  const { fake, client } = setup();
  // Another instance's sandbox, older than ours, appears while we create.
  fake.onCreate = () => {
    fake.onCreate = undefined;
    fake.add(owner("finn"), "Running", "2026-09-01T00:00:00.000Z");
  };
  await client.exec({ command: "true" }, client.resolveIdentifier("finn"));
  assert.equal(fake.sandboxes.size, 1, "the losing sandbox is deleted");
  const exec = fake.requests.find((r) => r.path.endsWith("/executeShellCommand"))!;
  assert.ok(exec.path.includes([...fake.sandboxes.keys()][0]));
});

test("per-conversation sandboxes are separate but deletable per user", async () => {
  const { fake, client } = setup({ identifierStrategy: "sessionId" });
  await client.exec({ command: "true" }, client.resolveIdentifier("frank", "chat-1"));
  await client.exec({ command: "true" }, client.resolveIdentifier("frank", "chat-2"));
  const other = fake.add(owner("grace"));
  assert.equal(fake.sandboxes.size, 3);

  assert.equal(await client.deleteUserSandboxes("frank"), 2);
  assert.deepEqual([...fake.sandboxes.keys()], [other]);
});

test("identifiers can't collide across the user/session boundary", () => {
  const { client } = setup({ identifierStrategy: "sessionId" });
  assert.notEqual(client.resolveIdentifier("a:b", "c"), client.resolveIdentifier("a", "b:c"));
});

// ============================================================================
// Retries
// ============================================================================

test("403s right after deploy (RBAC propagation) are retried", async () => {
  const { fake, client } = setup();
  fake.failNext = [403, 403, 403];
  const result = await client.exec({ command: "true" }, client.resolveIdentifier("hana"));
  assert.equal(result.exitCode, 0);
});

test("exec is not retried on a server error, so a command never runs twice", async () => {
  const { fake, client } = setup();
  const identifier = client.resolveIdentifier("hugo");
  await client.exec({ command: "true" }, identifier); // create and warm up
  fake.failNext = [502];
  await assert.rejects(client.exec({ command: "echo once" }, identifier), /502/);
  assert.equal(fake.requests.filter((r) => r.path.endsWith("/executeShellCommand")).length, 2);
});

test("reads are retried on transient errors", async () => {
  const { fake, client } = setup();
  const identifier = client.resolveIdentifier("iris");
  await client.fileWrite({ filename: "a.txt", content: "a" }, identifier);
  fake.failNext = [503, 429];
  assert.equal((await client.fileRead({ filename: "a.txt" }, identifier)).content, "a");
});

test("error messages don't expose the subscription or resource group", async () => {
  const { client } = setup();
  const err = await client
    .fileRead({ filename: "missing.txt" }, client.resolveIdentifier("ivan"))
    .catch((e: Error) => e);
  assert.ok(err instanceof Error);
  assert.doesNotMatch(err.message, /sub-1|rg-1|grp-1/);
});

// ============================================================================
// Exec
// ============================================================================

test("exec wraps the command with cwd, env file and an in-sandbox timeout", async () => {
  const { fake, client } = setup();
  await client.exec({ command: "echo 'hi there'", timeout: 10_000 }, client.resolveIdentifier("henry"));
  const exec = fake.requests.find((r) => r.path.endsWith("/executeShellCommand"))!;
  const command = (exec.body as { command: string }).command;
  assert.equal(command, buildExecCommand("echo 'hi there'", 200)); // capped at sandboxes.maxTimeoutSec
  assert.match(command, /^mkdir -p \/mnt\/data && cd \/mnt\/data/);
  assert.ok(command.endsWith(`timeout -k 5 200 bash -c 'echo '\\''hi there'\\'''`), command);
});

test("exec reports timeouts and truncates long output", async () => {
  const { fake, client } = setup({ maxOutputChars: 5 });
  fake.nextExec = { exitCode: 124, stdout: "0123456789", stderr: "" };
  const result = await client.exec({ command: "sleep 999" }, client.resolveIdentifier("ivy"));
  assert.equal(result.timedOut, true);
  assert.equal(result.truncated, true);
  assert.equal(result.stdout, "01234");
});

test("a missing exitCode means success, as in the SDK", async () => {
  const { fake, client } = setup();
  fake.nextExec = { stdout: "ok", stderr: "" };
  const result = await client.exec({ command: "true" }, client.resolveIdentifier("jade"));
  assert.equal(result.exitCode, 0);
});

test("setEnv writes an env file the exec wrapper sources", async () => {
  const { fake, client } = setup();
  await client.setEnv({ API_KEY: "s3cr'et", "BAD-NAME": "v" }, client.resolveIdentifier("jack"));
  const exec = fake.requests.find((r) => r.path.endsWith("/executeShellCommand"))!;
  const command = (exec.body as { command: string }).command;
  const b64 = command.match(/printf %s '([A-Za-z0-9+/=]*)'/)![1];
  const script = Buffer.from(b64, "base64").toString("utf-8");
  assert.equal(script, "export API_KEY='s3cr'\\''et'\nexport BAD_NAME='v'\n");
  assert.ok(!command.includes("s3cr"), "secret must not appear in the command line");
});

test("setEnv with no credentials empties the env file", async () => {
  const { fake, client } = setup();
  await client.setEnv({}, client.resolveIdentifier("jill"));
  const exec = fake.requests.find((r) => r.path.endsWith("/executeShellCommand"))!;
  assert.match((exec.body as { command: string }).command, /printf %s '' \| base64 -d > /);
});

// ============================================================================
// Files
// ============================================================================

test("file write/read round-trips under /mnt/data and blocks traversal", async () => {
  const { fake, client } = setup();
  const identifier = client.resolveIdentifier("kate");
  await client.fileWrite({ filename: "../../etc/passwd", content: "héllo" }, identifier);
  const put = fake.requests.find((r) => r.method === "PUT" && r.path.endsWith("/files"))!;
  assert.equal(put.query.get("path"), "/mnt/data/etc/passwd");
  assert.equal(put.query.get("createDirs"), "true");

  const read = await client.fileRead({ filename: "../../etc/passwd" }, identifier);
  assert.equal(read.content, "héllo");
  assert.equal(read.sizeBytes, Buffer.byteLength("héllo"));

  const bin = await client.fileReadBinary({ filename: "etc/passwd" }, identifier);
  assert.equal(Buffer.from(bin.contentBase64, "base64").toString("utf-8"), "héllo");
});

test("large files are read only up to the output and export limits", async () => {
  const { client } = setup({ maxOutputChars: 10, maxExportBytes: 64 });
  const identifier = client.resolveIdentifier("kate");
  await client.fileWrite({ filename: "big.txt", content: "x".repeat(1000) }, identifier);

  const read = await client.fileRead({ filename: "big.txt" }, identifier);
  assert.equal(read.content, "x".repeat(10));
  assert.equal(read.truncated, true);
  assert.ok(read.sizeBytes <= 40, "reads at most 4 bytes a character");
  await assert.rejects(
    () => client.fileReadBinary({ filename: "big.txt" }, identifier),
    /too large for export/,
  );

  await client.fileWrite({ filename: "small.txt", content: "tiny" }, identifier);
  const small = await client.fileRead({ filename: "small.txt" }, identifier);
  assert.equal(small.content, "tiny");
  assert.equal(small.truncated, undefined);
});

test("a missing file is an error, not a lost sandbox", async () => {
  const { fake, client } = setup();
  fake.add(owner("liam"));
  await assert.rejects(client.fileRead({ filename: "nope.txt" }, client.resolveIdentifier("liam")), /404/);
  assert.equal(fake.sandboxes.size, 1);
});

test("fileList returns files only, and [] before anything is written", async () => {
  const { client } = setup();
  const identifier = client.resolveIdentifier("mia");
  assert.deepEqual(await client.fileList(identifier), []);
  await client.fileWrite({ filename: "report.csv", content: "a,b" }, identifier);
  const files = await client.fileList(identifier);
  assert.deepEqual(files.map((f) => f.filename), ["report.csv"]);
  assert.equal(files[0].size, 3);
  assert.equal(files[0].lastModified, new Date(1790659885 * 1000).toISOString());
});

test("dataPath keeps every path inside /mnt/data", () => {
  assert.equal(dataPath("a.txt"), "/mnt/data/a.txt");
  assert.equal(dataPath("/mnt/data/a.txt"), "/mnt/data/a.txt");
  assert.equal(dataPath("....//....//x"), "/mnt/data/x");
  assert.equal(dataPath("/etc/shadow"), "/mnt/data/etc/shadow");
});

// ============================================================================
// Egress credential injection
// ============================================================================

test("setEgressCredentials posts a Transform rule per host, keeping deny + Full", async () => {
  const { fake, client } = setup();
  await client.setEgressCredentials(
    [{ key: "GITHUB_TOKEN", hosts: ["api.github.com", "*.githubusercontent.com"], header: "Authorization", value: "Bearer s" }],
    client.resolveIdentifier("nina"),
  );
  const post = fake.requests.find((r) => r.path.endsWith("/egresspolicy"));
  assert.deepEqual(post?.body, {
    defaultAction: "Deny",
    trafficInspection: "Full",
    hostRules: [{ pattern: "pypi.org", action: "Allow" }],
    rules: [
      {
        name: "cred-GITHUB_TOKEN-0",
        match: { host: "api.github.com" },
        action: { type: "Transform", headers: [{ operation: "Set", name: "Authorization", value: "Bearer s" }] },
      },
      {
        name: "cred-GITHUB_TOKEN-1",
        match: { host: "*.githubusercontent.com" },
        action: { type: "Transform", headers: [{ operation: "Set", name: "Authorization", value: "Bearer s" }] },
      },
    ],
  });
});

test("setEgressCredentials with an open network uses Partial inspection so rules apply", async () => {
  const { fake, client } = setup({ networkAccess: "enabled" });
  await client.setEgressCredentials(
    [{ key: "K", hosts: ["api.example.com"], header: "X-Key", value: "v" }],
    client.resolveIdentifier("omar"),
  );
  const post = fake.requests.find((r) => r.path.endsWith("/egresspolicy"));
  const body = post?.body as { defaultAction: string; trafficInspection: string };
  assert.equal(body.defaultAction, "Allow");
  assert.equal(body.trafficInspection, "Partial");
});

import test from "node:test";
import assert from "node:assert/strict";

import { openScope } from "@agentforeach/platform";
import { installHost, resetHostForTests } from "../runtime/host.js";
import { McpManager, serializeMcpToolResultContent } from "./client.js";
import type { McpServerConfig } from "./types.js";

test("serializeMcpToolResultContent returns text content when present", () => {
  const content = serializeMcpToolResultContent({
    content: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ],
    structuredContent: { ok: true, ignored: true },
  });

  assert.equal(content, "first\nsecond");
});

test("serializeMcpToolResultContent falls back to structured content", () => {
  const content = serializeMcpToolResultContent({
    content: [],
    structuredContent: {
      ok: true,
      categories: [{ id: "news", label: "News" }],
    },
  });

  assert.deepEqual(JSON.parse(content), {
    ok: true,
    categories: [{ id: "news", label: "News" }],
  });
});

test("serializeMcpToolResultContent preserves content fallback", () => {
  const content = serializeMcpToolResultContent({
    content: [{ type: "image", data: "abc" }],
  });

  assert.equal(content, JSON.stringify([{ type: "image", data: "abc" }]));
});
// ============================================================================
// Reconnection — a server that was down at boot must not stay gone
// ============================================================================

/**
 * A server unreachable at process start used to be dropped for the life of the
 * process: `initialize()` swallows the failure (correctly — one bad server must
 * not take the agent down), so `AgentClient.initialize()` resolves and the
 * `getAgentClient()` singleton caches a client that is healthy except that a
 * whole tool surface is missing. On Azure Functions a cold start during an MCP
 * deploy produces exactly that, and for an MCP-only deployment it is the worst state available:
 * the agent keeps a prompt that tells it to work through its MCP tools, with
 * none of those tools present, so every request ends in an apology until the
 * instance recycles.
 */
function unreachableServer(name: string): McpServerConfig {
  return {
    name,
    enabled: true,
    transport: "streamable-http",
    // Reserved TEST-NET-1 address with a port nothing listens on; the short
    // timeout is what keeps this test fast.
    url: "http://127.0.0.1:1/mcp",
    namespace: true,
    forwardAuth: false,
    connectTimeoutMs: 150,
    callTimeoutMs: 150,
  };
}

test("mcp manager — a failed server is retried, not abandoned", async () => {
  const manager = new McpManager([unreachableServer("example")]);
  await manager.initialize();

  // Down at boot: no tools, and the manager says so rather than pretending.
  assert.equal(manager.isReady(), false);
  assert.deepEqual(manager.getAllTools(), []);
  assert.deepEqual(manager.getDisconnectedServers(), ["example"]);

  // The retry is scheduled rather than attempted immediately, so a server that
  // is genuinely down does not add its connect timeout to every single turn.
  const before = Date.now();
  await manager.ensureConnected();
  assert.ok(
    Date.now() - before < 100,
    "a backed-off server must not be dialled again on the very next turn",
  );
  assert.deepEqual(
    manager.getDisconnectedServers(),
    ["example"],
    "still disconnected, and still known about",
  );
});

test("mcp manager — ensureConnected is a no-op with nothing configured", async () => {
  const manager = new McpManager([]);
  await manager.initialize();

  await manager.ensureConnected();

  assert.equal(manager.isReady(), false);
  assert.deepEqual(manager.getDisconnectedServers(), []);
});

test("mcp manager — concurrent turns share one reconnect attempt", async () => {
  const manager = new McpManager([unreachableServer("example")]);
  // No initialize(): first ensureConnected is the first attempt, so both
  // callers race for it and must not dial twice.
  const started = Date.now();
  await Promise.all([manager.ensureConnected(), manager.ensureConnected()]);
  const elapsed = Date.now() - started;

  // Two serial 150ms dials would exceed 300ms; one shared attempt stays near it.
  assert.ok(
    elapsed < 300,
    `expected a single shared attempt, took ${elapsed}ms`,
  );
  assert.deepEqual(manager.getDisconnectedServers(), ["example"]);
});

/**
 * The half that actually matters: a retry that reconnects.
 *
 * Uses a real MCP server over the real transport, started only after the
 * manager has already found nothing there, so the tools appear because the
 * reconnect worked and not because the connection was never lost.
 */
test("mcp manager — a server that comes back is picked up, with its tools", async () => {
  const { McpServer } = await import(
    "@modelcontextprotocol/sdk/server/mcp.js"
  );
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { createServer } = await import("node:http");
  const { z } = await import("zod");

  // Claim a port, then release it, so the first dial reliably fails.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const config: McpServerConfig = {
    name: "example",
    enabled: true,
    transport: "streamable-http",
    url: `http://127.0.0.1:${port}/mcp`,
    namespace: true,
    forwardAuth: false,
    connectTimeoutMs: 3_000,
    callTimeoutMs: 3_000,
  };

  const manager = new McpManager([config]);
  await manager.initialize();
  assert.equal(manager.isReady(), false, "nothing is listening yet");
  assert.deepEqual(manager.getAllTools(), []);

  // Bring the server up, the way a finishing deploy would.
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? JSON.parse(raw) : undefined;
        const server = new McpServer({ name: "example", version: "1.0.0" });
        server.registerTool(
          "create_note",
          {
            description: "Create a note.",
            inputSchema: { title: z.string() },
          },
          async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        );
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      })();
    });
  });
  await new Promise<void>((r) => http.listen(port, () => r()));

  try {
    // Clear the backoff the failed boot scheduled — this test is about whether
    // the reconnect succeeds, not about how long it waits first.
    (manager as unknown as { reconnects: Map<string, unknown> }).reconnects.clear();

    await manager.ensureConnected();

    assert.equal(manager.isReady(), true, "the manager should have reconnected");
    assert.deepEqual(manager.getDisconnectedServers(), []);
    assert.deepEqual(
      manager.getAllTools().map((tool) => tool.name),
      ["example_create_note"],
      "the recovered server's tools must reach the agent, namespaced",
    );

    // And the recovered connection is usable, not just listed.
    const result = await manager.callTool("example_create_note", {
      title: "hello",
    });
    assert.equal(result.isError, false);
    assert.equal(result.content, "ok");
  } finally {
    await manager.shutdown();
    await new Promise<void>((r) => http.close(() => r()));
  }
});

// ============================================================================
// Namespacing — the prompt and the tool list must speak the same names
// ============================================================================

/**
 * A single-server deployment whose prompt names tools bare (a common setup)
 * opts out of the `{serverName}_` prefix with `namespace: false`. The manager
 * must expose AND route the bare name. With more than one enabled server the
 * opt-out is unsound (bare names cannot arbitrate collisions), so the
 * constructor forces the prefix back on — asserted here via the exposed names.
 */
async function startToolServer(toolName: string): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { createServer } = await import("node:http");
  const { z } = await import("zod");

  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? JSON.parse(raw) : undefined;
        const server = new McpServer({ name: "example", version: "1.0.0" });
        server.registerTool(
          toolName,
          {
            description: "Create a note.",
            inputSchema: { title: z.string() },
          },
          async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        );
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      })();
    });
  });
  await new Promise<void>((r) => http.listen(0, () => r()));
  const port = (http.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((r) => http.close(() => r())),
  };
}

function liveServer(
  name: string,
  port: number,
  namespace: boolean,
): McpServerConfig {
  return {
    name,
    enabled: true,
    transport: "streamable-http",
    url: `http://127.0.0.1:${port}/mcp`,
    namespace,
    forwardAuth: false,
    connectTimeoutMs: 3_000,
    callTimeoutMs: 3_000,
  };
}

test("mcp manager — namespace:false exposes and routes bare tool names", async () => {
  const srv = await startToolServer("create_note");
  const manager = new McpManager([liveServer("example", srv.port, false)]);
  try {
    await manager.initialize();

    assert.deepEqual(
      manager.getAllTools().map((tool) => tool.name),
      ["create_note"],
      "the model must see the bare name the prompt uses",
    );
    assert.equal(manager.isMcpTool("create_note"), true);

    const result = await manager.callTool("create_note", {
      title: "hello",
    });
    assert.equal(result.isError, false);
    assert.equal(result.content, "ok");
  } finally {
    await manager.shutdown();
    await srv.close();
  }
});

test("mcp manager — namespace:false with two enabled servers is forced back on", async () => {
  const a = await startToolServer("create_note");
  const b = await startToolServer("create_note");
  const manager = new McpManager([
    liveServer("example", a.port, false),
    liveServer("other", b.port, false),
  ]);
  try {
    await manager.initialize();

    assert.deepEqual(
      manager.getAllTools().map((tool) => tool.name).sort(),
      ["example_create_note", "other_create_note"],
      "bare names cannot arbitrate a cross-server collision, so both " +
        "servers must come back prefixed",
    );
  } finally {
    await manager.shutdown();
    await a.close();
    await b.close();
  }
});

// ============================================================================
// Hosts whose connections can't outlive an invocation (Cloudflare Workers)
// ============================================================================

const workersHost = {
  platform: "cloudflare",
  isProductionHost: false,
  publicBaseUrl: undefined,
  label: "test",
  persistent: false,
  subprocesses: false,
};

test("mcp manager (scoped) — each invocation connects for itself, and closes when it ends", async () => {
  const srv = await startToolServer("create_note");
  const manager = new McpManager([liveServer("example", srv.port, true)], { scoped: true });
  try {
    const first = openScope({ invocationId: "turn-1", kind: "job" });
    await first.run(async () => {
      await manager.initialize();
      assert.deepEqual(manager.getConnectedServers(), ["example"]);
      assert.deepEqual(manager.getAllTools().map((t) => t.name), ["example_create_note"]);
      const result = await manager.callTool("example_create_note", { title: "x" });
      assert.equal(result.isError, false);
    });
    await first.settle();

    const second = openScope({ invocationId: "turn-2", kind: "job" });
    await second.run(async () => {
      assert.deepEqual(manager.getConnectedServers(), [], "nothing carried over from the first invocation");
      await manager.ensureConnected(); // what the runner does each turn
      assert.deepEqual(manager.getConnectedServers(), ["example"]);
    });
    await second.settle();

    assert.deepEqual(manager.getConnectedServers(), [], "outside an invocation there are no connections");
    await manager.ensureConnected();
    assert.deepEqual(manager.getConnectedServers(), [], "and none are made: nowhere to close them");
  } finally {
    await srv.close();
  }
});

test("mcp manager (scoped) — a tool call that comes first in an invocation connects for it", async () => {
  const srv = await startToolServer("create_note");
  const manager = new McpManager([liveServer("example", srv.port, true)], { scoped: true });
  try {
    // A HITL resume: the approved tool runs in the wait's own invocation, before any turn connected.
    const resume = openScope({ invocationId: "resume", kind: "job" });
    await resume.run(async () => {
      assert.deepEqual(manager.getConnectedServers(), []);
      const result = await manager.callTool("example_create_note", { title: "x" });
      assert.equal(result.isError, false, result.content);
      assert.equal((await manager.callTool("example_nope", {})).content, "Unknown MCP tool: example_nope");
    });
    await resume.settle();
    assert.deepEqual(manager.getConnectedServers(), []);
  } finally {
    await srv.close();
  }
});

test("mcp manager — the host decides: scoped where it isn't persistent, process-wide otherwise", async () => {
  const srv = await startToolServer("create_note");
  try {
    const processWide = new McpManager([liveServer("example", srv.port, true)]);
    await processWide.initialize();
    assert.deepEqual(processWide.getConnectedServers(), ["example"], "a persistent host (Azure) keeps its connections");
    await processWide.shutdown();

    installHost(workersHost);
    const scoped = new McpManager([liveServer("example", srv.port, true)]);
    await scoped.initialize();
    assert.deepEqual(scoped.getConnectedServers(), [], "on Workers, nothing connects outside an invocation");
  } finally {
    resetHostForTests();
    await srv.close();
  }
});

test("mcp manager — a stdio server is refused where the host can't start processes", async () => {
  installHost(workersHost);
  try {
    const manager = new McpManager(
      [
        {
          name: "local",
          enabled: true,
          transport: "stdio",
          command: "node",
          args: ["-e", "process.exit(0)"],
          namespace: true,
          forwardAuth: false,
          connectTimeoutMs: 1_000,
          callTimeoutMs: 1_000,
        },
      ],
      { scoped: true },
    );
    const opened = openScope({ invocationId: "x", kind: "http" });
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    try {
      await opened.run(() => manager.initialize());
    } finally {
      console.error = original;
    }
    await opened.settle();
    assert.deepEqual(manager.getDisconnectedServers(), ["local"]);
    assert.ok(logged.some((l) => /stdio transport.*can't start processes/.test(l)), logged.join("\n"));
  } finally {
    resetHostForTests();
  }
});

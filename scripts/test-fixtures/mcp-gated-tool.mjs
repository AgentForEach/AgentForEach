#!/usr/bin/env node
/**
 * A tiny MCP server for end-to-end tests of human-in-the-loop: one tool,
 * `send_note`, over Streamable HTTP, so a gateway on any host (Azure
 * Functions locally, a Worker under wrangler dev) can reach it. A HITL
 * policy in the test config gates the tool, so calling it suspends the run
 * until the user answers the form or it times out.
 *
 *   node scripts/test-fixtures/mcp-gated-tool.mjs            # port 18090
 *   MCP_FIXTURE_PORT=18091 node scripts/test-fixtures/mcp-gated-tool.mjs
 *
 *   POST /mcp     the MCP endpoint (stateless Streamable HTTP)
 *   GET  /calls   every send_note call so far, as JSON (what the test checks)
 *   DELETE /calls forget them
 *
 * Gateway config for it (agentforeach.json), with the tool named
 * `<server>_<tool>`:
 *
 *   "mcp": { "enabled": true, "servers": { "fixture": {
 *     "enabled": true, "transport": "streamable-http", "url": "http://127.0.0.1:18090/mcp" } } },
 *   "hitl": { "enabled": true, "tools": {
 *     "fixture_send_note": { "gate": "always", "formType": "confirmation", "timeoutSeconds": 300 } } }
 */

import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const port = Number(process.env.MCP_FIXTURE_PORT ?? 18090);
const calls = [];

function mcpServer() {
  const server = new McpServer({ name: "agentforeach-test-fixture", version: "1.0.0" });
  server.registerTool(
    "send_note",
    {
      description: "Send a short note to someone. Gated by a HITL policy in tests.",
      inputSchema: { to: z.string().describe("Who gets the note"), note: z.string().describe("The note") },
    },
    async ({ to, note }) => {
      calls.push({ to, note, at: new Date().toISOString() });
      console.log(JSON.stringify({ fixture: "send_note", to, note }));
      return { content: [{ type: "text", text: `Note sent to ${to}: ${note}` }] };
    },
  );
  return server;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname === "/calls") {
    if (req.method === "DELETE") calls.length = 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(calls));
    return;
  }
  if (url.pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== "POST") {
    // Stateless: no server-initiated stream and no sessions to end.
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  // Stateless mode: a fresh server and transport per request.
  const server = mcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, await readJson(req));
  } catch (err) {
    console.error(`[fixture] ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) res.writeHead(500).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`MCP test fixture (send_note) on http://127.0.0.1:${port}/mcp`));

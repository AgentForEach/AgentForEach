#!/usr/bin/env node
/**
 * A stand-in for the OpenAI API, for load tests that measure the platform
 * rather than a model provider's rate limits. Serves:
 *
 *   POST /v1/responses   streaming (SSE) and non-streaming Responses API
 *   POST /v1/embeddings  fixed-size random vectors
 *
 * Replies take a realistic shape: a pause before the first token (MOCK_TTFT_MS,
 * default 800), then MOCK_WORDS words (default 60) every MOCK_WORD_MS
 * (default 40). Usage is reported so cost accounting has numbers to add up.
 * No dependencies; runs anywhere Node 18+ runs (PORT, default 8080).
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8080);
const TTFT_MS = Number(process.env.MOCK_TTFT_MS ?? 800);
const WORDS = Number(process.env.MOCK_WORDS ?? 60);
const WORD_MS = Number(process.env.MOCK_WORD_MS ?? 40);
const DIMENSIONS = Number(process.env.MOCK_EMBEDDING_DIMENSIONS ?? 1536);

const VOCAB = "the a quick simple plan works well today because every small step adds up over time and you can adjust as needed".split(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function words(n) {
  return Array.from({ length: n }, (_, i) => VOCAB[(i * 7) % VOCAB.length]);
}

function responseObject(model, text, inputChars) {
  const inputTokens = Math.max(1, Math.round(inputChars / 4));
  const outputTokens = Math.max(1, Math.round(text.length / 4));
  return {
    id: `resp_${randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output: [
      {
        type: "message",
        id: `msg_${randomUUID().replace(/-/g, "")}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
  };
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return { json: body ? JSON.parse(body) : {}, chars: body.length };
}

async function responses(req, res) {
  const { json, chars } = await readJson(req);
  const model = json.model ?? "mock-model";
  const parts = words(WORDS);
  const text = parts.join(" ");

  if (!json.stream) {
    await sleep(TTFT_MS + WORDS * WORD_MS);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(responseObject(model, text, chars)));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const final = responseObject(model, text, chars);
  const itemId = final.output[0].id;
  send({ type: "response.created", response: { ...final, status: "in_progress", output: [] } });
  await sleep(TTFT_MS);
  for (let i = 0; i < parts.length; i++) {
    if (res.destroyed) return;
    send({
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: (i === 0 ? "" : " ") + parts[i],
    });
    await sleep(WORD_MS);
  }
  send({ type: "response.completed", response: final });
  res.end();
}

async function embeddings(req, res) {
  const { json } = await readJson(req);
  const inputs = Array.isArray(json.input) ? json.input : [json.input];
  const data = inputs.map((_, index) => ({
    object: "embedding",
    index,
    embedding: Array.from({ length: json.dimensions ?? DIMENSIONS }, () => Math.random() * 2 - 1),
  }));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ object: "list", data, model: json.model ?? "mock-embedding", usage: { prompt_tokens: 8, total_tokens: 8 } }));
}

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+$/, "");
  const handler =
    req.method === "POST" && path.endsWith("/responses")
      ? responses
      : req.method === "POST" && path.endsWith("/embeddings")
        ? embeddings
        : undefined;
  if (!handler) {
    res.writeHead(path === "" || path === "/health" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: path === "" || path === "/health" }));
    return;
  }
  handler(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(err) } }));
  });
}).listen(PORT, () => console.log(`mock-llm listening on ${PORT}`));

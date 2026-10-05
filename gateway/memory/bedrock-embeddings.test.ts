import test from "node:test";
import assert from "node:assert/strict";

import { bedrockRuntime } from "../llms/index.js";
import { EmbeddingsClient } from "./embeddings.js";

test("Titan embeddings use AWS credentials, normalize and validate vectors; empty inputs keep their positions", async () => {
  const { client } = await bedrockRuntime();
  const send = client.send;
  const inputs: Array<{ inputText: string; normalize: boolean }> = [];
  const replyWith = (embedding: number[]) =>
    (async (command: { input: { body: string } }) => {
      inputs.push(JSON.parse(command.input.body));
      return { body: Buffer.from(JSON.stringify({ embedding })) };
    }) as unknown as typeof client.send;
  try {
    client.send = replyWith(new Array(1024).fill(0.25));
    const embeddings = new EmbeddingsClient("", "amazon.titan-embed-text-v2:0", 4, undefined, "bedrock");
    const vectors = await embeddings.embedBatch(["", "abcde", " z "]);
    assert.equal(inputs.length, 2, "the empty input is not sent");
    assert.equal(inputs[0].inputText, "abcd");
    assert.equal(inputs[0].normalize, true);
    assert.equal(vectors[0][0], 0);
    assert.equal(vectors[1].length, 1024);
    client.send = replyWith([1]);
    await assert.rejects(embeddings.embed("test"), /invalid embedding/);
  } finally {
    client.send = send;
  }
  assert.throws(() => new EmbeddingsClient("", "text-embedding-3-small", 8000, undefined, "bedrock"), /Titan/);
});

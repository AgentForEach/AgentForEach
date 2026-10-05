/**
 * The sandbox server's transport on Bedrock AgentCore Runtime: each request
 * to a sandbox's server.mjs is one InvokeAgentRuntime call on the runtime
 * session that holds it, carrying the server's /invocations envelope
 * {token, path, method, body}; the server answers {status, body}, which
 * becomes the Response the shared SandboxServerClient reads.
 *
 * The AWS SDK's own retries must be off (maxAttempts: 1, as the backend
 * builds its client): after an ambiguous failure a command may already have
 * run, so it is reported, never sent again.
 */

import {
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
  type BedrockAgentCoreClient,
} from "@aws-sdk/client-bedrock-agentcore";
import { execRequestTimeoutMs } from "@agentforeach/platform";

export type AgentCoreSender = Pick<BedrockAgentCoreClient, "send">;

export interface AgentCoreTransportOptions {
  client: AgentCoreSender;
  runtimeArn: string;
  qualifier?: string;
  /** The runtime's SANDBOX_SERVER_TOKEN. */
  token: string;
  /** The largest response read; a larger one fails (and its stream is destroyed). */
  maxResponseBytes: number;
}

/** Room for a cold start on top of a request's own time. */
const START_GRACE_MS = 60_000;
/** Requests other than /exec: files, env, and archives of up to tens of MiB. */
const DEFAULT_REQUEST_MS = 150_000;

type StreamBody = AsyncIterable<Uint8Array> & { destroy?: () => void };

export class AgentCoreTransport {
  constructor(private readonly options: AgentCoreTransportOptions) {}

  /** One request to the server on runtime session `sessionId`. */
  async request(sessionId: string, path: string, init: { method: "GET" | "POST"; body?: string }): Promise<Response> {
    const { client, runtimeArn, qualifier, token, maxResponseBytes } = this.options;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    const timeoutMs =
      path === "/exec" ? execRequestTimeoutMs(Number(body?.timeout) || 120) + START_GRACE_MS : DEFAULT_REQUEST_MS + START_GRACE_MS;
    const output = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: runtimeArn,
        qualifier,
        runtimeSessionId: sessionId,
        contentType: "application/json",
        accept: "application/json",
        payload: Buffer.from(JSON.stringify({ token, path, method: init.method, body })),
      }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
    const text = await readBounded(output.response as StreamBody | undefined, maxResponseBytes);
    const status = output.statusCode ?? 200;
    if (status !== 200) {
      // Not the server's answer (that comes in the envelope): the envelope itself was refused.
      return new Response(JSON.stringify({ error: `AgentCore runtime answered ${status}: ${text.slice(0, 300)}` }), {
        status: status === 401 ? 502 : status,
      });
    }
    let envelope: { status?: unknown; body?: unknown };
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`The AgentCore sandbox answered something other than JSON: ${text.slice(0, 200)}`);
    }
    if (typeof envelope.status !== "number") throw new Error("The AgentCore sandbox answered without a status");
    return new Response(JSON.stringify(envelope.body ?? null), {
      status: envelope.status,
      headers: { "content-type": "application/json" },
    });
  }

  /** Stop runtime session `sessionId` on `qualifier`'s endpoint; false when it was already gone. */
  async stop(sessionId: string, qualifier?: string): Promise<boolean> {
    try {
      await this.options.client.send(
        new StopRuntimeSessionCommand({ agentRuntimeArn: this.options.runtimeArn, qualifier, runtimeSessionId: sessionId }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
      return true;
    } catch (err) {
      if ((err as { name?: string })?.name === "ResourceNotFoundException") return false;
      throw err;
    }
  }
}

/** The response stream as text, failing past `maxBytes`; the stream is always destroyed. */
async function readBounded(stream: StreamBody | undefined, maxBytes: number): Promise<string> {
  if (!stream) throw new Error("The AgentCore sandbox returned no response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) throw new Error(`The AgentCore sandbox's response is larger than ${maxBytes} bytes`);
      chunks.push(chunk);
    }
  } finally {
    stream.destroy?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

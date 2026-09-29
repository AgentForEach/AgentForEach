/**
 * AgentForEach Gateway — Channel Webhook Handler
 *
 * A single generic webhook endpoint that routes incoming messages
 * to the correct channel plugin based on the URL parameter.
 *
 * Routes:
 *   GET  /api/channels/{channelId}/webhook  — provider verification handshake
 *   POST /api/channels/{channelId}/webhook  — messages and events
 *
 * Flow:
 *   1. Resolve channel plugin from {channelId} URL param
 *   2. Verify webhook signature (channel-specific)
 *   3. Parse inbound message (channel-specific)
 *   4. Non-message payloads go to plugin.handleEvent() instead
 *   5. Process through AgentClient pipeline (router.ts)
 *   6. Reply through the channel
 *   7. Return 200 OK to the webhook sender
 *
 * Plugins that set `ackImmediately` get the 200 before the agent turn runs,
 * and the turn is handed to a Durable Functions orchestration. That is for
 * providers which redeliver aggressively while a slow turn is still in flight
 * (Meta retries for up to 7 days); such plugins must dedupe inbound ids
 * durably.
 *
 * An orchestration, not a floating promise: in the Functions programming
 * model the invocation is over when the handler's promise resolves, and the
 * host is free to recycle the instance immediately after — a detached
 * `void processInbound(...)` is killable mid-turn, and because the message id
 * was already claimed for dedupe, the redelivery that could have rescued it
 * gets dropped. The durable activity survives a recycle (at-least-once), at
 * the accepted cost that a crash AFTER the reply was sent can rerun a turn.
 *
 * Design decisions:
 *   - Single handler for all channels (not one per channel). New channels
 *     only need to register a plugin — no new Azure Functions needed.
 *   - Always returns 200 to prevent Telegram/Slack/LINE from retrying.
 *   - Auth is handled by the plugin's verifyWebhook(), not the auth chain
 *     (webhooks are server-to-server, not user-facing).
 *   - authLevel: "anonymous" because external services can't authenticate
 *     to Azure Functions any other way.
 *
 * @see handlers/api.ts — same handler pattern for HTTP API
 * @see handlers/ws-message.ts — similar pipeline for WebSocket messages
 */

import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import * as df from "durable-functions";
import type { InboundMessage } from "../channels/index.js";
import { getChannel, processInbound, ensureIdentityStore } from "../channels/index.js";
import { createCronMutationSignal } from "./cron-signal.js";
import { describeText, redactId } from "../utils/redact.js";

/** Names on the Durable Functions wire — renaming them strands in-flight turns. */
const CHANNEL_TURN_ORCHESTRATION = "ChannelInboundTurn";
const CHANNEL_TURN_ACTIVITY = "ProcessChannelInboundTurn";

type ChannelTurnInput = {
  channelId: string;
  message: InboundMessage;
};

// ============================================================================
// Handler
// ============================================================================

async function channelWebhook(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const channelId = request.params.channelId;

  if (!channelId) {
    return jsonResponse(400, { error: "Missing channelId" });
  }

  // 1. Resolve channel plugin
  const plugin = getChannel(channelId);
  if (!plugin || !plugin.enabled) {
    context.warn(`channelWebhook: unknown or disabled channel "${channelId}"`);
    return jsonResponse(404, { error: "Channel not found" });
  }

  // 2. Read raw body for signature verification
  const rawBody = await request.text();
  let body: unknown;

  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  // 3. Extract headers as a plain object (lowercase keys)
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // 4. Verify webhook authenticity
  if (!plugin.verifyWebhook(headers, rawBody)) {
    context.warn(`channelWebhook: verification failed for "${channelId}"`);
    return jsonResponse(401, { error: "Unauthorized" });
  }

  // 5. Ensure identity store is bootstrapped (lazy, first call only)
  await ensureIdentityStore();

  // 6. Parse inbound message (may be async for channels that download media)
  const message = await plugin.parseInbound(body);
  if (!message) {
    // Not a message we process (e.g., edited_message, service message,
    // unauthorized sender) — but it may still be an event the channel cares
    // about: delivery receipts, account alerts, quality updates.
    //
    // handleEvent is fire-and-forget by contract. Awaiting it would let a slow
    // status callback delay the 200 and earn a redelivery, which is the exact
    // failure it exists to help with.
    if (plugin.handleEvent) {
      void Promise.resolve(plugin.handleEvent(body)).catch((err) => {
        context.error(
          `channelWebhook: handleEvent failed for ${channelId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    // Return 200 so the webhook sender doesn't retry
    return jsonResponse(200, { ok: true, skipped: true });
  }

  context.log(
    `channelWebhook: ${channelId} from=${redactId(message.senderId)} ` +
    `chat=${redactId(message.chatId)} group=${message.isGroupChat} ` +
    `attachments=${message.attachments?.length ?? 0} ` +
    `text=${describeText(message.text)}`,
  );

  // 7. Process through the full pipeline (AgentClient → reply)
  //
  // Channels facing a retry-happy provider ack first and run the turn in a
  // durable orchestration, so a 40-second tool loop cannot earn a redelivery
  // mid-flight — and an instance recycle cannot kill the turn either, which
  // a detached promise would allow (see the module docblock).
  if (plugin.ackImmediately) {
    try {
      const client = df.getClient(context);
      const input: ChannelTurnInput = { channelId, message };
      const instanceId = await client.startNew(CHANNEL_TURN_ORCHESTRATION, {
        input,
      });
      context.log(
        `channelWebhook: ${channelId} turn handed to orchestration ${instanceId}`,
      );
    } catch (err) {
      // No durable client (e.g. storage down): a detached promise is killable
      // but still better than dropping a claimed message on the floor.
      context.warn(
        `channelWebhook: could not start turn orchestration for ${channelId} ` +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          `falling back to detached processing`,
      );
      const partial = plugin.toSendRequest(message);
      const userId = partial.userId ?? message.senderId;
      const onCronMutation = createCronMutationSignal(context, userId);
      void processInbound(channelId, message, { onCronMutation }).catch(() => {
        // Invocation is already complete; nowhere reliable to report to.
      });
    }

    return jsonResponse(200, { ok: true, accepted: true });
  }

  // Signal the Durable Functions scheduler when cron tools mutate jobs.
  const partial = plugin.toSendRequest(message);
  const userId = partial.userId ?? message.senderId;
  const onCronMutation = createCronMutationSignal(context, userId);

  const result = await processInbound(channelId, message, { onCronMutation });

  if (!result.success) {
    context.error(
      `channelWebhook: pipeline failed for ${channelId}: ${result.error}`,
    );
    // Temporary outage: ask the provider to redeliver rather than drop it.
    if (result.retryable) {
      return jsonResponse(503, { ok: false, error: result.error });
    }
  }

  // Otherwise return 200 so webhook senders don't retry a turn that ran
  return jsonResponse(200, {
    ok: result.success,
    error: result.error,
  });
}

// ============================================================================
// Helpers
// ============================================================================

function jsonResponse(status: number, body: unknown): HttpResponseInit {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Provider verification handshake.
 *
 * Meta-family providers (WhatsApp, Messenger, Instagram) register a webhook by
 * calling GET on the webhook path with `hub.mode`, `hub.verify_token` and
 * `hub.challenge`, and expect the challenge echoed back as plain text. A JSON
 * body — or a 404 — fails registration.
 *
 * Channels without a GET handshake omit `verifyChallenge` and get a 404, which
 * is what every non-Meta channel wants.
 */
async function channelWebhookVerify(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const channelId = request.params.channelId;

  if (!channelId) {
    return jsonResponse(400, { error: "Missing channelId" });
  }

  const plugin = getChannel(channelId);
  if (!plugin || !plugin.enabled) {
    context.warn(`channelWebhookVerify: unknown or disabled channel "${channelId}"`);
    return jsonResponse(404, { error: "Channel not found" });
  }

  if (!plugin.verifyChallenge) {
    return jsonResponse(404, { error: "Channel has no verification handshake" });
  }

  const query: Record<string, string> = {};
  request.query.forEach((value, key) => {
    query[key] = value;
  });

  const challenge = plugin.verifyChallenge(query);
  if (challenge === undefined) {
    context.warn(`channelWebhookVerify: rejected handshake for "${channelId}"`);
    return { status: 403, body: "Forbidden" };
  }

  context.log(`channelWebhookVerify: ${channelId} handshake accepted`);
  return {
    status: 200,
    headers: { "Content-Type": "text/plain" },
    body: challenge,
  };
}

// ============================================================================
// Detached Turn — Durable Orchestration
// ============================================================================

/**
 * The whole agent turn for one inbound message, as a single activity.
 *
 * One activity rather than a decomposition: the turn is already orchestrated
 * internally by processInbound, and the property we need from Durable
 * Functions is only that the work survives the webhook invocation ending.
 * At-least-once execution means a mid-turn instance recycle reruns the turn;
 * a rerun after the reply was already sent (crash in the gap between send and
 * checkpoint) can double-send, which is accepted as the rarer, recoverable
 * direction — silent no-reply is the failure users actually notice.
 */
df.app.orchestration(CHANNEL_TURN_ORCHESTRATION, function* (ctx) {
  const input = ctx.df.getInput() as ChannelTurnInput;
  yield ctx.df.callActivity(CHANNEL_TURN_ACTIVITY, input);
});

df.app.activity(CHANNEL_TURN_ACTIVITY, {
  extraInputs: [df.input.durableClient()],
  handler: async (rawInput: unknown, context: InvocationContext): Promise<boolean> => {
    const { channelId, message } = rawInput as ChannelTurnInput;

    // Fresh invocation, possibly a fresh instance — same bootstrap the
    // webhook handler does before parsing.
    await ensureIdentityStore();

    const plugin = getChannel(channelId);
    const partial = plugin?.enabled ? plugin.toSendRequest(message) : undefined;
    const userId = partial?.userId ?? message.senderId;
    const onCronMutation = createCronMutationSignal(context, userId);

    const result = await processInbound(channelId, message, { onCronMutation });
    if (!result.success) {
      context.error(
        `channelTurn: pipeline failed for ${channelId}: ${result.error}`,
      );
    }
    return result.success;
  },
});

// ============================================================================
// Function Registration
// ============================================================================

app.http("channelWebhook", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "api/channels/{channelId}/webhook",
  extraInputs: [df.input.durableClient()],
  handler: channelWebhook,
});

app.http("channelWebhookVerify", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "api/channels/{channelId}/webhook",
  handler: channelWebhookVerify,
});

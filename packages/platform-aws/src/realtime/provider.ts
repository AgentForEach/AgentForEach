/**
 * AgentForEach Platform AWS — AppSync Events realtime provider
 *
 * The realtime port on AWS AppSync Events, ported from the AWS reference
 * (docs/AppSync-Events.md records what was validated live):
 *
 *   - Pushes are HTTP publishes to the Event API, signed with SigV4
 *     (service "appsync") using the AWS credential chain; the browser never
 *     holds AWS credentials. A frame too large for one event goes as
 *     fragments the portable client reassembles.
 *   - Publishes are serialized per channel within this process (a stream's
 *     deltas arrive in order), bounded (128 frames, 8 MiB a channel), stale
 *     work refused after 10 s, and each frame has 5 s. HTTP errors and
 *     per-event failures reject the caller. Each publish is also the
 *     invocation's background work, so a host that freezes after its
 *     response (Lambda) waits for it first.
 *   - Clients connect with a descriptor (`clientAccess().descriptor`):
 *     subscribe-only, to the channels their token lists.
 *   - The relay binds each party to its own inbox channel and its peer's
 *     (`groupAccess({ peerUserId })`).
 *
 * There is no presence, no forced disconnect and no dynamic group
 * membership: the capabilities say so, and those calls throw.
 */

import {
  background,
  encodeRealtimeFrame,
  signRequest,
  type AwsCredentials,
  type ClientAccess,
  type ClientAccessOptions,
  type GroupAccess,
  type GroupAccessOptions,
  type RealtimeCapabilities,
  type RealtimeProvider,
  type RealtimeRelay,
} from "@agentforeach/platform";
import { validateAppSyncConfig, type AppSyncEventsConfig } from "./config.js";
import { awsCredentials } from "../objects/credentials.js";
import { allChannel, groupChannel, issueClientToken, issueRelayToken, userChannel } from "./tokens.js";

export const APPSYNC_PROVIDER_ID = "aws-appsync-events";

export const APPSYNC_CAPABILITIES: RealtimeCapabilities = Object.freeze({
  push: true,
  relay: true,
  protocol: "appsync-events",
  inbound: "http",
  presence: false,
  disconnect: false,
});

/** Frames waiting on one channel, and their bytes, before a publish is refused. */
const QUEUE_FRAMES = 128;
const QUEUE_BYTES = 8 * 1024 * 1024;
/** A frame still queued after this is refused rather than sent late. */
const STALE_MS = 10_000;
/** How long one frame (all its events) may take to publish. */
const FRAME_BUDGET_MS = 5_000;

export type AppSyncEventsRealtimeOptions = AppSyncEventsConfig & {
  /** Static keys or a function returning fresh ones. Default: the pack's AWS credential chain (`awsCredentials()`). */
  credentials?: AwsCredentials | (() => Promise<AwsCredentials>);
  /** For tests. */
  fetch?: typeof fetch;
};

type ChannelQueue = { tail: Promise<void>; frames: number; bytes: number };

export class AppSyncEventsRealtime implements RealtimeProvider {
  readonly id = APPSYNC_PROVIDER_ID;
  readonly label = "AWS AppSync Events";
  readonly capabilities = APPSYNC_CAPABILITIES;
  readonly relay: RealtimeRelay;
  private readonly config: AppSyncEventsConfig;
  private readonly endpoint: URL;
  private readonly credentials: () => Promise<AwsCredentials>;
  private readonly fetch: typeof fetch;
  private readonly queues = new Map<string, ChannelQueue>();

  constructor(options: AppSyncEventsRealtimeOptions) {
    const { credentials, fetch: fetcher, ...config } = options;
    this.config = validateAppSyncConfig(config);
    this.endpoint = new URL(config.httpEndpoint);
    this.credentials = typeof credentials === "function" ? credentials : credentials ? async () => credentials : awsCredentials();
    this.fetch = fetcher ?? ((input, init) => fetch(input, init));
    this.relay = {
      host: new URL(config.realtimeEndpoint).host,
      groupAccess: async (o) => this.groupAccess(o),
    };
  }

  async sendToUser(userId: string, data: unknown): Promise<void> {
    await this.publish(userChannel(this.config.namespace, userId), data);
  }

  async sendToGroup(group: string, data: unknown): Promise<void> {
    await this.publish(groupChannel(this.config.namespace, group), data);
  }

  async sendToAll(data: unknown): Promise<void> {
    await this.publish(allChannel(this.config.namespace), data);
  }

  async isUserOnline(_userId: string): Promise<boolean> {
    throw new Error("AppSync Events has no presence (capabilities.presence is false)");
  }

  async disconnectUser(_userId: string, _reason?: string): Promise<void> {
    throw new Error("AppSync Events can't close a user's connections (capabilities.disconnect is false); their tokens lapse instead");
  }

  async clientAccess(userId: string, options: ClientAccessOptions): Promise<ClientAccess> {
    const { token, channels, expiresAtMs } = issueClientToken(this.config, userId, options.groups ?? [], options.ttlMinutes);
    const url = this.config.realtimeEndpoint;
    return {
      url,
      token,
      expiresAtMs,
      descriptor: { protocol: "appsync-events", url, authorization: this.authorization(token), channels, expiresAtMs },
    };
  }

  private async groupAccess(o: GroupAccessOptions): Promise<GroupAccess> {
    if (!o.peerUserId) throw new Error("AppSync Events binds a relay connection to both parties: peerUserId is required");
    const { token, subscribe, publish, expiresAtMs } = issueRelayToken(this.config, {
      hub: o.hub,
      group: o.group,
      userId: o.userId,
      peerUserId: o.peerUserId,
      ttlMinutes: o.ttlMinutes,
    });
    const url = this.config.realtimeEndpoint;
    return {
      url,
      descriptor: { protocol: "appsync-events", url, authorization: this.authorization(token), channels: [subscribe], publish, expiresAtMs },
    };
  }

  private authorization(token: string): { host: string; Authorization: string } {
    return { host: this.endpoint.host, Authorization: token };
  }

  /** Queue `frame` behind the channel's earlier frames; resolves once AppSync accepted every event. */
  private publish(channel: string, frame: unknown): Promise<void> {
    const events = encodeRealtimeFrame(frame);
    const bytes = events.reduce((n, e) => n + Buffer.byteLength(e), 0);
    const queue = this.queues.get(channel) ?? { tail: Promise.resolve(), frames: 0, bytes: 0 };
    if (queue.frames >= QUEUE_FRAMES || queue.bytes + bytes > QUEUE_BYTES) {
      return Promise.reject(new Error("AppSync Events: the publish queue for this channel is full"));
    }
    queue.frames++;
    queue.bytes += bytes;
    this.queues.set(channel, queue);
    const queuedAt = Date.now();
    const result = queue.tail.then(async () => {
      if (Date.now() - queuedAt > STALE_MS) throw new Error("AppSync Events: a publish waited too long in the queue");
      const budget = new AbortController();
      const timer = setTimeout(() => budget.abort(new Error("AppSync Events: a publish took longer than 5 s")), FRAME_BUDGET_MS);
      try {
        // One event per request keeps each one under the subscription message limit.
        for (const event of events) await this.publishEvent(channel, event, budget.signal);
      } finally {
        clearTimeout(timer);
      }
    });
    // The queue carries on after a failure; the caller still gets the rejection.
    queue.tail = result
      .catch(() => {})
      .finally(() => {
        queue.frames--;
        queue.bytes -= bytes;
        if (queue.frames === 0 && this.queues.get(channel) === queue) this.queues.delete(channel);
      });
    // Lambda freezes after the response: the host settles the invocation's background work first.
    background(result, () => {});
    return result;
  }

  private async publishEvent(channel: string, event: string, signal: AbortSignal): Promise<void> {
    const body = JSON.stringify({ channel, events: [event] });
    const headers = await signRequest(
      { credentials: await this.credentials(), region: this.config.region, service: "appsync" },
      { method: "POST", url: this.endpoint, headers: { "content-type": "application/json" }, body },
    );
    delete headers["host"]; // fetch sets it, and refuses it from callers
    const response = await this.fetch(this.endpoint, { method: "POST", headers, body, signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`AppSync Events: publish failed (${response.status})`);
    }
    const output = (await response.json().catch(() => ({}))) as { successful?: Array<{ index?: number }>; failed?: unknown[] };
    if (output.failed?.length || output.successful?.length !== 1 || output.successful[0].index !== 0) {
      throw new Error("AppSync Events: the event was not acknowledged");
    }
  }
}

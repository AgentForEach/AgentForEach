/**
 * AgentForEach Platform AWS — AppSync Events channels, tokens and authorizer
 *
 * Channels name no user: a user's channel is a SHA-256 of the id, so ids
 * never appear in AppSync's logs or metrics. Authorization, not the hash, is
 * what keeps users apart: every token lists its exact channels.
 *
 *   /<namespace>/users/<hash[0:32]>/<hash[32:64]>    one user's pushes
 *   /<namespace>/groups/<group>                       a server-chosen group
 *   /<namespace>/all                                  every signed-in client
 *   /<relayNamespace>/<hub>/<group>/<party>           one relay party's inbox
 *
 * Tokens are HMAC-SHA256 over `<domain>.<payload>`, with a separate domain
 * for each kind, so neither can stand in for the other:
 *
 *   afe1.<payload>.<mac>   a client's: subscribe to its listed channels, never publish (60 minutes at most)
 *   afeb1.<payload>.<mac>  a relay party's: subscribe to its own inbox, publish to its peer's (31 minutes at most)
 *
 * The authorizer (AppSync's Lambda authorizer for connect, subscribe and
 * relay publish) checks the MAC, the API, the expiry, the namespace and the
 * exact channel. It never allows a wildcard, and never caches a decision
 * (`ttlOverride: 0`), so nothing outlives its token. An established
 * subscription isn't revoked when its token expires: clients reconnect
 * before then, and that is when the check runs again.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { CHANNEL_SEGMENT, type AppSyncEventsConfig } from "./config.js";

/** A client token's longest life; a client reconnects before it ends. */
export const CLIENT_TOKEN_MAX_MINUTES = 60;
/** A relay token's longest life: a browser handoff lasts 30 minutes at most. */
export const RELAY_TOKEN_MAX_MINUTES = 31;
/** Channels one client token may list (AppSync's subscriptions per connection are bounded too). */
const MAX_CLIENT_CHANNELS = 16;
/** An issuing clock may run this far ahead of the authorizer's. */
const CLOCK_SKEW_MS = 30_000;

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

export function userChannel(namespace: string, userId: string): string {
  if (!userId) throw new Error("AppSync Events: a user id is required");
  const hash = sha256Hex(userId);
  return `/${namespace}/users/${hash.slice(0, 32)}/${hash.slice(32)}`;
}

export function groupChannel(namespace: string, group: string): string {
  if (!CHANNEL_SEGMENT.test(group)) throw new Error(`AppSync Events: "${group}" can't be a channel segment`);
  return `/${namespace}/groups/${group}`;
}

export const allChannel = (namespace: string): string => `/${namespace}/all`;

/** One relay party's inbox: its peer publishes here, it subscribes. */
export function relayChannel(relayNamespace: string, hub: string, group: string, userId: string): string {
  if (!CHANNEL_SEGMENT.test(group)) throw new Error(`AppSync Events: "${group}" can't be a relay group`);
  if (!hub || !userId) throw new Error("AppSync Events: a relay channel needs its hub and party");
  return `/${relayNamespace}/${sha256Hex(hub).slice(0, 16)}/${group}/${sha256Hex(userId).slice(0, 32)}`;
}

type TokenDomain = "afe1" | "afeb1";

const mac = (domain: TokenDomain, payload: string, secret: string): Buffer =>
  createHmac("sha256", secret).update(`${domain}.${payload}`).digest();

function seal(domain: TokenDomain, claims: Record<string, unknown>, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${domain}.${payload}.${mac(domain, payload, secret).toString("base64url")}`;
}

function lifetime(ttlMinutes: number, maxMinutes: number, now: number): { issuedAtMs: number; expiresAtMs: number } {
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error("AppSync Events: a token needs a positive lifetime");
  return { issuedAtMs: now, expiresAtMs: now + Math.min(ttlMinutes, maxMinutes) * 60_000 };
}

export type ClientToken = { token: string; channels: string[]; expiresAtMs: number };

/** A subscriber token for the user's channel, the broadcast channel and `groups`; at most 60 minutes. */
export function issueClientToken(
  config: AppSyncEventsConfig,
  userId: string,
  groups: string[],
  ttlMinutes: number,
  now = Date.now(),
): ClientToken {
  const { issuedAtMs, expiresAtMs } = lifetime(ttlMinutes, CLIENT_TOKEN_MAX_MINUTES, now);
  const channels = [
    ...new Set([userChannel(config.namespace, userId), allChannel(config.namespace), ...groups.map((g) => groupChannel(config.namespace, g))]),
  ];
  if (channels.length > MAX_CLIENT_CHANNELS) throw new Error("AppSync Events: too many channels for one token");
  const token = seal("afe1", { apiId: config.apiId, channels, issuedAtMs, expiresAtMs }, config.tokenSecret);
  return { token, channels, expiresAtMs };
}

export type RelayToken = { token: string; subscribe: string; publish: string; expiresAtMs: number };

/**
 * A relay party's token: it subscribes to its own inbox and publishes to its
 * peer's, so whatever arrives in its inbox came from the peer.
 */
export function issueRelayToken(
  config: AppSyncEventsConfig,
  party: { hub: string; group: string; userId: string; peerUserId: string; ttlMinutes: number },
  now = Date.now(),
): RelayToken {
  if (party.ttlMinutes > RELAY_TOKEN_MAX_MINUTES) {
    throw new Error(`AppSync Events: a relay token lasts at most ${RELAY_TOKEN_MAX_MINUTES} minutes`);
  }
  if (party.userId === party.peerUserId) throw new Error("AppSync Events: a relay needs two parties");
  const { issuedAtMs, expiresAtMs } = lifetime(party.ttlMinutes, RELAY_TOKEN_MAX_MINUTES, now);
  const subscribe = relayChannel(config.relayNamespace, party.hub, party.group, party.userId);
  const publish = relayChannel(config.relayNamespace, party.hub, party.group, party.peerUserId);
  const token = seal(
    "afeb1",
    { apiId: config.apiId, namespace: config.relayNamespace, subscribe, publish, issuedAtMs, expiresAtMs },
    config.tokenSecret,
  );
  return { token, subscribe, publish, expiresAtMs };
}

/** What AppSync sends a Lambda authorizer (the fields used here). */
export type AppSyncAuthorizerEvent = {
  authorizationToken?: string;
  requestContext?: {
    apiId?: string;
    operation?: string;
    channel?: string | null;
    channelNamespaceName?: string | null;
  };
};

export type AppSyncAuthorizerResult = { isAuthorized: boolean; ttlOverride: number };

const DENY: AppSyncAuthorizerResult = Object.freeze({ isAuthorized: false, ttlOverride: 0 });

/** The authorizer's decision for one connect, subscribe or publish. Never cached (`ttlOverride: 0`). */
export function authorizeAppSyncEvent(config: AppSyncEventsConfig, event: AppSyncAuthorizerEvent, now = Date.now()): AppSyncAuthorizerResult {
  try {
    const token = event.authorizationToken;
    const context = event.requestContext;
    if (typeof token !== "string" || token.length > 8192 || !context || context.apiId !== config.apiId) return DENY;
    const [domain, payload, signature, extra] = token.split(".");
    if ((domain !== "afe1" && domain !== "afeb1") || !payload || !signature || extra !== undefined) return DENY;
    if (!/^[A-Za-z0-9_-]+$/.test(signature)) return DENY;
    const actual = Buffer.from(signature, "base64url");
    const expected = mac(domain, payload, config.tokenSecret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return DENY;

    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const maxMs = (domain === "afe1" ? CLIENT_TOKEN_MAX_MINUTES : RELAY_TOKEN_MAX_MINUTES) * 60_000;
    if (
      claims?.apiId !== config.apiId ||
      !Number.isFinite(claims.issuedAtMs) ||
      !Number.isFinite(claims.expiresAtMs) ||
      claims.expiresAtMs <= now ||
      claims.issuedAtMs > now + CLOCK_SKEW_MS ||
      claims.expiresAtMs - claims.issuedAtMs > maxMs
    ) {
      return DENY;
    }

    const { operation, channel, channelNamespaceName } = context;
    if (operation === "EVENT_CONNECT") return { isAuthorized: true, ttlOverride: 0 };
    if (typeof channel !== "string" || channel.includes("*")) return DENY;

    if (domain === "afe1") {
      // Clients only listen; only the gateway, with IAM, publishes here.
      const allowed =
        operation === "EVENT_SUBSCRIBE" &&
        channelNamespaceName === config.namespace &&
        Array.isArray(claims.channels) &&
        claims.channels.includes(channel);
      return { isAuthorized: allowed, ttlOverride: 0 };
    }
    const allowed =
      channelNamespaceName === config.relayNamespace &&
      claims.namespace === config.relayNamespace &&
      ((operation === "EVENT_SUBSCRIBE" && channel === claims.subscribe) || (operation === "EVENT_PUBLISH" && channel === claims.publish));
    return { isAuthorized: allowed, ttlOverride: 0 };
  } catch {
    return DENY;
  }
}

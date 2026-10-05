/**
 * AgentForEach Real-Time System — Barrel Exports
 *
 * Public API for the real-time communication layer.
 *
 * This module provides:
 *   - Configuration (agentforeach.json "websocket" section)
 *   - Wire protocol types (frames, events, groups)
 *   - Provider interface & registry (extensible WebSocket backends)
 *   - Server-side push functions (send to user/group/all)
 *   - Client token generation (for iOS/Android/Web to connect)
 *   - Push delivery adapter (auto-registered on import)
 */

// — Configuration —
export type {
  WebSocketConfig,
  WebSocketTokenConfig,
  WebSocketGroupDefaults,
} from "./config.js";
export {
  loadWebSocketConfig,
  resolveConnectionString,
  resolveHub,
  resolveProviderId,
  resolveDefaultTokenTtl,
  resolveMaxTokenTtl,
  resolveDefaultGroups,
  isWebSocketEnabled,
  resetWebSocketConfig,
} from "./config.js";

// — Wire Protocol Types —
export { PROTOCOL_VERSION, EVENTS, GROUPS } from "./types.js";
export type {
  WebSocketProviderId,
  WebSocketProvider,
  WebSocketProviderFactory,
  WebSocketProviderConfig,
  TokenGenerationOptions,
  ClientAccessToken,
  RequestFrame,
  ResponseFrame,
  EventFrame,
  Frame,
  FrameError,
  EventName,
  GroupName,
  ClientTokenClaims,
  ClientId,
  ClientRole,
  CronEventPayload,
  ChatEventPayload,
  ChatThinkingPayload,
  ChatDeltaPayload,
  ChatReasoningDeltaPayload,
  ChatToolStartPayload,
  ChatToolDeltaPayload,
  ChatToolDonePayload,
  ChatProviderFallbackPayload,
  ChatFinalPayload,
  ChatErrorPayload,
  ChatAbortedPayload,
  PresenceEntry,
  PresencePayload,
} from "./types.js";

// — Provider Registry —
export type { RealtimeProviderRegistration, WebSocketProviderTraits } from "./providers/index.js";
export {
  registerWebSocketProvider,
  installRealtimeProvider,
  getActiveProvider,
  getRealtimeRelay,
  realtimeCapabilities,
  realtimeUpstreamWebhooks,
  relayHost,
  relayEgressEntry,
  hasWebSocketProvider,
  listWebSocketProviders,
  clearWebSocketProviderCache,
} from "./providers/index.js";

// — Server-Side Push (provider-agnostic) —
export {
  sendEventToUser,
  sendResponseToUser,
  sendEventToGroup,
  sendEventToAll,
  sendFrameToUser,
  addUserToGroup,
  removeUserFromGroup,
  isUserOnline,
  disconnectUser,
} from "./emitter.js";

// — Client Token Generation —
export type { TokenOptions } from "./auth.js";
export { generateClientToken, getDefaultGroups } from "./auth.js";

// — Push Delivery Adapter (self-registers on import) —
export { pushAdapter } from "./push-adapter.js";

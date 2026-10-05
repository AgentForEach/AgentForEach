/**
 * Realtime port: the contract, protocol v1 (codec, roles, tokens), the
 * socket-agnostic hub every self-hosted provider runs, the in-memory
 * provider, and the portable browser client. The conformance suite is a
 * separate entry point, `@agentforeach/platform/realtime/conformance`.
 */

export type {
  RealtimeProvider,
  RealtimeCapabilities,
  ResolvedRealtimeCapabilities,
  RealtimeProtocol,
  RealtimeRelay,
  ClientAccess,
  ClientAccessOptions,
  ConnectionDescriptor,
  AppSyncAuthorization,
  GroupAccess,
  GroupAccessOptions,
} from "./types.js";
export { resolveRealtimeCapabilities } from "./types.js";
export {
  REALTIME_SUBPROTOCOL,
  MAX_FRAME_BYTES,
  frames,
  frameBytes,
  parseClientFrame,
  roles,
  hasGroupRole,
  type ClientFrame,
  type ServiceFrame,
  type DataType,
  type AckErrorName,
} from "./protocol.js";
export { RealtimeHub, type ConnectionState, type HubConnection, type HubEvent, type HubEventHandler, type RealtimeHubOptions } from "./hub.js";
export { sealRealtimeToken, openRealtimeToken, type RealtimeTokenClaims } from "./token.js";
export { TicketLedger, memoryTicketStorage, RELAY_RESUME_MS, type TicketStorage } from "./tickets.js";
export { MemoryRealtime, type MemoryRealtimeOptions } from "./memory.js";
export {
  defineRealtimeClient,
  realtimeClientModule,
  realtimeClientScript,
  encodeFrame as encodeRealtimeFrame,
  createFrameDecoder as createRealtimeFrameDecoder,
  connectRealtime,
  connectRelay,
  keepConnected,
  backoffDelay,
  type RealtimeClient,
  type RealtimeConnection,
  type RealtimeRelayConnection,
  type RealtimeConnectOptions,
  type RealtimeRelayOptions,
  type RealtimeConnectionState,
  type RealtimeSocket,
  type RealtimeSocketConstructor,
  type KeepConnectedOptions,
  type EncodeFrameOptions,
} from "./client/index.js";

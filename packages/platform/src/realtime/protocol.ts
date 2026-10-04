/**
 * AgentForEach Platform — Realtime protocol v1
 *
 * The subset of Azure Web PubSub's `json.webpubsub.azure.v1` subprotocol
 * that AgentForEach clients use (docs/Realtime-Protocol.md). Every frame is
 * one JSON text message. Any realtime provider speaks exactly this, so the
 * web-chat client, the browser live view and the sandbox's browser driver
 * run unchanged on every cloud.
 */

/** The WebSocket subprotocol clients request. */
export const REALTIME_SUBPROTOCOL = "json.webpubsub.azure.v1";

/** Largest frame a connection may send, in UTF-8 bytes (Web PubSub's limit). */
export const MAX_FRAME_BYTES = 1024 * 1024;

export type DataType = "json" | "text";

// ── Client → service ────────────────────────────────────────────────────

export type JoinGroupFrame = { type: "joinGroup"; group: string; ackId?: number };
export type LeaveGroupFrame = { type: "leaveGroup"; group: string; ackId?: number };
export type SendToGroupFrame = {
  type: "sendToGroup";
  group: string;
  ackId?: number;
  noEcho?: boolean;
  dataType: DataType;
  data: unknown;
};
export type EventFrame = { type: "event"; event: string; ackId?: number; dataType: DataType; data: unknown };

export type ClientFrame = JoinGroupFrame | LeaveGroupFrame | SendToGroupFrame | EventFrame;

// ── Service → client ────────────────────────────────────────────────────

export type ConnectedFrame = { type: "system"; event: "connected"; userId: string; connectionId: string };
export type DisconnectedFrame = { type: "system"; event: "disconnected"; message: string };
export type ServerMessageFrame = { type: "message"; from: "server"; dataType: DataType; data: unknown };
export type GroupMessageFrame = {
  type: "message";
  from: "group";
  fromUserId: string;
  group: string;
  dataType: DataType;
  data: unknown;
};
export type AckErrorName = "Forbidden" | "InternalServerError" | "Duplicate";
export type AckFrame =
  | { type: "ack"; ackId: number; success: true }
  | { type: "ack"; ackId: number; success: false; error: { name: AckErrorName; message: string } };

export type ServiceFrame = ConnectedFrame | DisconnectedFrame | ServerMessageFrame | GroupMessageFrame | AckFrame;

/** Builders for every frame the service sends. */
export const frames = {
  connected: (userId: string, connectionId: string): ConnectedFrame => ({ type: "system", event: "connected", userId, connectionId }),
  disconnected: (message: string): DisconnectedFrame => ({ type: "system", event: "disconnected", message }),
  server: (data: unknown, dataType: DataType = "json"): ServerMessageFrame => ({ type: "message", from: "server", dataType, data }),
  group: (fromUserId: string, group: string, data: unknown, dataType: DataType = "json"): GroupMessageFrame => ({
    type: "message",
    from: "group",
    fromUserId,
    group,
    dataType,
    data,
  }),
  ack: (ackId: number, error?: { name: AckErrorName; message: string }): AckFrame =>
    error ? { type: "ack", ackId, success: false, error } : { type: "ack", ackId, success: true },
};

/** UTF-8 length of a frame's text. */
export function frameBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isGroup = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
const isAckId = (v: unknown): v is number | undefined => v === undefined || (Number.isSafeInteger(v) && (v as number) >= 0);

function dataTypeOf(frame: Record<string, unknown>): DataType | undefined {
  const dataType = frame.dataType ?? "json";
  if (dataType !== "json" && dataType !== "text") return undefined;
  if (dataType === "text" && typeof frame.data !== "string") return undefined;
  return dataType;
}

/**
 * Parses one client frame. Returns undefined for anything that is not a
 * valid protocol v1 frame; the service ignores those.
 */
export function parseClientFrame(text: string): ClientFrame | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(frame) || !isAckId(frame.ackId)) return undefined;
  const ackId = frame.ackId as number | undefined;
  const withAck = <T extends object>(f: T): T => (ackId === undefined ? f : { ...f, ackId });

  switch (frame.type) {
    case "joinGroup":
    case "leaveGroup":
      if (!isGroup(frame.group)) return undefined;
      return withAck({ type: frame.type, group: frame.group });
    case "sendToGroup": {
      const dataType = dataTypeOf(frame);
      if (!isGroup(frame.group) || !dataType || !("data" in frame)) return undefined;
      return withAck({
        type: "sendToGroup" as const,
        group: frame.group,
        ...(frame.noEcho === true ? { noEcho: true } : {}),
        dataType,
        data: frame.data,
      });
    }
    case "event": {
      const dataType = dataTypeOf(frame);
      if (typeof frame.event !== "string" || !frame.event || !dataType) return undefined;
      return withAck({ type: "event" as const, event: frame.event, dataType, data: frame.data });
    }
    default:
      return undefined;
  }
}

// ── Roles ───────────────────────────────────────────────────────────────

/** Web PubSub's role strings, kept so one token format serves every cloud. */
export const roles = {
  joinLeaveGroup: (group?: string): string => (group ? `webpubsub.joinLeaveGroup.${group}` : "webpubsub.joinLeaveGroup"),
  sendToGroup: (group?: string): string => (group ? `webpubsub.sendToGroup.${group}` : "webpubsub.sendToGroup"),
};

/** Whether `granted` includes `role` for `group`, either for that group or for every group. */
export function hasGroupRole(granted: readonly string[], role: (group?: string) => string, group: string): boolean {
  return granted.includes(role()) || granted.includes(role(group));
}

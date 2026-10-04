/**
 * AgentForEach Platform — Realtime test clients
 *
 * A protocol v1 client for tests: frames arrive in a queue that tests wait
 * on. `webSocketTestClient` opens a real WebSocket (any provider); the
 * in-memory provider hands out the same kind of client without a network.
 */

import { REALTIME_SUBPROTOCOL } from "./protocol.js";

// Frames are whatever JSON the service sent; tests inspect them freely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Frame = any;

export interface RealtimeTestClient {
  /** Sends a frame; objects are JSON-encoded, strings sent as they are. */
  send(frame: unknown): void;
  /** The next frame matching `match` (default: any), removed from the queue; frames that don't match stay queued. */
  next(match?: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  /** Every frame matching `match` that arrives within `ms`. */
  collect(ms: number, match?: (frame: Frame) => boolean): Promise<Frame[]>;
  /** Resolves when the connection closes. */
  readonly closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

/** A queue of received frames, with waiters. */
export class FrameQueue {
  private readonly frames: Frame[] = [];
  private readonly waiters = new Set<() => void>();

  push(text: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(text);
    } catch {
      frame = { unparsed: text };
    }
    this.frames.push(frame);
    for (const wake of [...this.waiters]) wake();
  }

  async next(match: (frame: Frame) => boolean = () => true, timeoutMs = 5000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex(match);
      if (index >= 0) return this.frames.splice(index, 1)[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`No matching frame within ${timeoutMs} ms; received ${JSON.stringify(this.frames)}`);
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        this.waiters.add(wake);
      });
    }
  }

  async collect(ms: number, match: (frame: Frame) => boolean = () => true): Promise<Frame[]> {
    await new Promise((r) => setTimeout(r, ms));
    const out: Frame[] = [];
    for (let i = 0; i < this.frames.length; ) {
      if (match(this.frames[i])) out.push(...this.frames.splice(i, 1));
      else i++;
    }
    return out;
  }
}

/** Opens `url` with the protocol v1 subprotocol; resolves once the socket is open. */
export async function webSocketTestClient(url: string): Promise<RealtimeTestClient> {
  const socket = new WebSocket(url, REALTIME_SUBPROTOCOL);
  const queue = new FrameQueue();
  let resolveClosed!: (value: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((r) => (resolveClosed = r));
  socket.addEventListener("message", (event) => queue.push(typeof event.data === "string" ? event.data : String(event.data)));
  socket.addEventListener("close", (event) => resolveClosed({ code: event.code, reason: event.reason }));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`WebSocket to ${new URL(url).host} failed`)), { once: true });
  });
  return {
    send: (frame) => socket.send(typeof frame === "string" ? frame : JSON.stringify(frame)),
    next: (match, timeoutMs) => queue.next(match, timeoutMs),
    collect: (ms, match) => queue.collect(ms, match),
    closed,
    close: () => socket.close(1000),
  };
}

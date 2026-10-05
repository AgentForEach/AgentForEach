/**
 * The live view's inline script: it parses, it carries the current portable
 * realtime client, its CSP hash is the script's, and run against a stub page
 * and a fake relay it draws only newer frames and frees every image.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { realtimeClientModule, realtimeClientScript } from "@agentforeach/platform";
import { REALTIME_CLIENT_SCRIPT } from "./realtime-client-script.js";
import { viewerHeaders, viewerHtml, viewerLink } from "./viewer.js";

const HOST = "afe-wps.webpubsub.azure.com";
const inlineScript = (): string => /<script>([\s\S]*)<\/script>/.exec(viewerHtml(HOST))![1];

test("viewer: the inline script parses, starts with the portable client, and the CSP hash is computed from it", () => {
  const script = inlineScript();
  assert.doesNotThrow(() => new vm.Script(script));
  assert.ok(script.startsWith(REALTIME_CLIENT_SCRIPT), "the client is inlined first");
  const hash = createHash("sha256").update(script).digest("base64");
  assert.ok(viewerHeaders(HOST)["Content-Security-Policy"].includes(`script-src 'sha256-${hash}'`));
});

test("the checked-in client copies are current (node scripts/sync-realtime-client.mjs)", () => {
  assert.equal(REALTIME_CLIENT_SCRIPT, realtimeClientScript(), "gateway/skills/browser/realtime-client-script.ts");
  // From dist/gateway/skills/browser to gateway/sandbox-container/browser.
  const driverCopy = readFileSync(new URL("../../../../sandbox-container/browser/realtime-client.mjs", import.meta.url), "utf8");
  assert.equal(driverCopy, realtimeClientModule(), "gateway/sandbox-container/browser/realtime-client.mjs");
});

/** An element that accepts whatever the script does to it. */
function element(): Record<string, unknown> {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  return {
    textContent: "",
    value: "",
    hidden: false,
    dataset: {},
    width: 1280,
    height: 800,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] ??= []).push(fn),
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
  };
}

class FakeSocket {
  static last: FakeSocket;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  private listeners: Record<string, Array<(e: { data?: string }) => void>> = {};
  constructor(
    readonly url: string,
    readonly protocols: string,
  ) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: (e: { data?: string }) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", {}));
  }
  emit(type: string, event: { data?: string }): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

test("viewer: draws only frames newer than the last, closes every decoded image, and believes only the driver", async () => {
  const relayUrl = "wss://afe-wps.webpubsub.azure.com/client/hubs/agentforeach_browser?access_token=V";
  const link = viewerLink("https://gw.example", { relayUrl, group: "bh-1", expiresAt: Date.now() + 600_000, reason: "Log in", driverUserId: "browser-driver:ab" });
  const elements = new Map<string, Record<string, unknown>>();
  const drawn: number[] = [];
  const closed: number[] = [];
  const canvas = element();
  canvas.getContext = () => ({ drawImage: (img: { seq: number }) => drawn.push(img.seq) });
  elements.set("screen", canvas);
  // Decoding finishes when the test says: frames can resolve out of order.
  const decoding: Array<() => void> = [];
  const context = vm.createContext({
    location: { hash: `#${link.split("#")[1]}`, pathname: "/api/browser/view", reload() {} },
    history: { replaceState() {} },
    sessionStorage: { setItem() {}, getItem: () => null, removeItem() {} },
    navigator: { platform: "Linux", userAgent: "test" },
    document: {
      getElementById: (id: string) => elements.get(id) ?? (elements.set(id, element()), elements.get(id)),
      querySelector: () => ({ content: HOST }),
      querySelectorAll: () => [],
      body: element(),
    },
    addEventListener() {},
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    WebSocket: FakeSocket,
    Blob: class {
      constructor(readonly parts: Uint8Array[]) {}
    },
    createImageBitmap: (blob: { parts: Uint8Array[] }) => {
      const seq = blob.parts[0][0];
      return new Promise((resolve) => decoding.push(() => resolve({ width: 1280, height: 800, seq, close: () => closed.push(seq) })));
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    crypto,
    JSON,
    Promise,
    Uint8Array,
    Set,
    Map,
    Math,
    Number,
    String,
    Date,
    Array,
    Object,
    Error,
  });
  context.window = context;
  vm.runInContext(inlineScript(), context);

  const socket = FakeSocket.last;
  assert.equal(socket.url, relayUrl);
  assert.equal(socket.protocols, "json.webpubsub.azure.v1");
  socket.receive({ type: "system", event: "connected" });
  assert.deepEqual(socket.sent.shift(), { type: "joinGroup", group: "bh-1", ackId: 1 });
  socket.receive({ type: "ack", ackId: 1, success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent.shift()?.data, { kind: "hello" });

  // A JPEG whose first byte names its frame, so the stub decoder can tell them apart.
  const frame = (seq: number, from = "browser-driver:ab") =>
    socket.receive({ type: "message", from: "group", fromUserId: from, group: "bh-1", data: { kind: "frame", seq, w: 1280, h: 800, jpeg: btoa(String.fromCharCode(seq)) } });
  frame(1);
  frame(3);
  frame(2); // older than 3: never decoded
  frame(9, "intruder"); // not the driver: ignored
  assert.equal(decoding.length, 2, "frames 1 and 3 decode; 2 is stale and 9 is not the driver's");
  decoding[1](); // frame 3 finishes first
  decoding[0](); // then frame 1, which is now older than what's on screen
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(drawn, [3]);
  assert.deepEqual(closed.sort(), [1, 3], "every decoded image is freed");
  socket.close();
});

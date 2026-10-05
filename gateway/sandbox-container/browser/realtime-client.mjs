// The AgentForEach portable realtime client, generated from packages/platform/src/realtime/client/index.ts.
// Don't edit it: change the source, then run `node scripts/sync-realtime-client.mjs`.
const client = (function defineRealtimeClient() {
    const MAX_FRAME_BYTES = 4 * 1024 * 1024;
    /** Fragments of one frame, at most: 4 MiB in the relay's 64,000-byte chunks. */
    const MAX_FRAGMENTS = 66;
    /** A fragment's base64, at most: a 120 KiB chunk. */
    const MAX_FRAGMENT_CHARS = 164_000;
    /** Frames being reassembled at once, and how long one may take. */
    const MAX_PENDING_FRAMES = 4;
    const PENDING_FRAME_MS = 30_000;
    /** A relay's AppSync events: one publish each, smaller than a client event (they ride a WebSocket message with the token). */
    const RELAY_EVENT = { maxEventBytes: 100_000, chunkBytes: 64_000 };
    /** Unacknowledged relay publishes, and bytes, before the link counts as congested. */
    const RELAY_INFLIGHT_EVENTS = 80;
    const RELAY_INFLIGHT_BYTES = 6 * 1024 * 1024;
    const V1_SUBPROTOCOL = "json.webpubsub.azure.v1";
    const APPSYNC_SUBPROTOCOL = "aws-appsync-event-ws";
    /** AppSync's keep-alive interval, at most (its `connectionTimeoutMs`). */
    const MAX_KEEPALIVE_MS = 300_000;
    /** A client connection renews its token this long before it expires. */
    const RENEW_BEFORE_MS = 5_000;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    function base64(bytes) {
        let text = "";
        for (let i = 0; i < bytes.length; i += 8192)
            text += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return btoa(text);
    }
    function base64url(text) {
        return base64(encoder.encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function encodeFrame(frame, options = {}) {
        const { maxEventBytes = 180 * 1024, chunkBytes = 120 * 1024 } = options;
        const json = JSON.stringify(frame);
        const bytes = encoder.encode(json);
        if (bytes.length > MAX_FRAME_BYTES)
            throw new Error("Realtime frame exceeds 4 MiB");
        // An event travels as a JSON string inside JSON: measure it escaped.
        if (encoder.encode(JSON.stringify(json)).length <= maxEventBytes)
            return [json];
        const count = Math.ceil(bytes.length / chunkBytes);
        if (count > MAX_FRAGMENTS)
            throw new Error("Realtime frame needs too many fragments");
        const id = options.id ?? crypto.randomUUID();
        return Array.from({ length: count }, (_, index) => JSON.stringify({
            type: "afe-fragment",
            version: 1,
            id,
            index,
            count,
            data: base64(bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes)),
        }));
    }
    function createFrameDecoder() {
        const pending = new Map();
        return (input) => {
            const frame = typeof input === "string" ? JSON.parse(input) : input;
            if (!frame || frame.type !== "afe-fragment")
                return frame;
            const { id, index, count, data } = frame;
            if (frame.version !== 1 ||
                typeof id !== "string" ||
                id.length > 128 ||
                !Number.isInteger(count) ||
                count < 1 ||
                count > MAX_FRAGMENTS ||
                !Number.isInteger(index) ||
                index < 0 ||
                index >= count ||
                typeof data !== "string" ||
                data.length > MAX_FRAGMENT_CHARS) {
                throw new Error("Invalid realtime fragment");
            }
            const now = Date.now();
            for (const [key, entry] of pending)
                if (entry.expires <= now)
                    pending.delete(key);
            let entry = pending.get(id);
            if (!entry) {
                if (pending.size >= MAX_PENDING_FRAMES)
                    throw new Error("Too many incomplete realtime frames");
                entry = { chunks: new Map(), count, size: 0, expires: now + PENDING_FRAME_MS };
                pending.set(id, entry);
            }
            if (entry.count !== count)
                throw new Error("Inconsistent realtime fragments");
            // A fragment delivered twice is the same fragment.
            if (!entry.chunks.has(index)) {
                const chunk = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
                entry.size += chunk.length;
                if (entry.size > MAX_FRAME_BYTES) {
                    pending.delete(id);
                    throw new Error("Realtime frame exceeds 4 MiB");
                }
                entry.chunks.set(index, chunk);
            }
            if (entry.chunks.size !== count)
                return undefined;
            pending.delete(id);
            const bytes = new Uint8Array(entry.size);
            let offset = 0;
            for (let i = 0; i < count; i++) {
                const chunk = entry.chunks.get(i);
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            return JSON.parse(decoder.decode(bytes));
        };
    }
    /** One socket's opening, readiness, timers and end, for both protocols. */
    function lifecycle(socket, timeoutMs, onClose) {
        let ready = false;
        let closed = false;
        let resolveReady;
        let rejectReady;
        const whenReady = new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        const timers = new Set();
        const end = () => {
            closed = true;
            for (const t of timers)
                clearTimeout(t);
            timers.clear();
            try {
                socket.close(1000);
            }
            catch {
                // already closing
            }
        };
        const life = {
            ready: whenReady,
            get open() {
                return ready && !closed;
            },
            get closed() {
                return closed;
            },
            connected() {
                if (ready || closed)
                    return;
                ready = true;
                life.clear(handshake);
                resolveReady();
            },
            fail(error) {
                if (closed)
                    return;
                end();
                if (!ready)
                    rejectReady(error);
                else
                    onClose?.(error);
            },
            close() {
                if (closed)
                    return;
                end();
                if (!ready)
                    rejectReady(new Error("Realtime connection closed"));
            },
            timer(ms, fn) {
                const t = setTimeout(() => {
                    timers.delete(t);
                    fn();
                }, ms);
                timers.add(t);
                return t;
            },
            clear(t) {
                if (t === undefined)
                    return;
                clearTimeout(t);
                timers.delete(t);
            },
        };
        const handshake = life.timer(timeoutMs, () => life.fail(new Error("Realtime connection timed out")));
        return life;
    }
    function socketClass(options) {
        const Socket = options.WebSocket ?? globalThis.WebSocket;
        if (!Socket)
            throw new Error("No WebSocket implementation");
        return Socket;
    }
    /** Protocol v1: the service greets with `connected`; a relay then joins its group. */
    function connectV1(descriptor, options, relay) {
        const socket = new (socketClass(options))(descriptor.url, V1_SUBPROTOCOL);
        const life = lifecycle(socket, options.timeoutMs ?? (relay ? 15_000 : 10_000), options.onClose);
        const decode = createFrameDecoder();
        let reason = "";
        socket.addEventListener("message", (event) => {
            if (life.closed)
                return;
            let message;
            try {
                message = JSON.parse(String(event.data));
            }
            catch {
                return; // not a protocol v1 frame
            }
            if (message?.type === "system") {
                if (message.event === "connected") {
                    if (relay)
                        socket.send(JSON.stringify({ type: "joinGroup", group: relay.group, ackId: 1 }));
                    else
                        life.connected();
                }
                else if (message.event === "disconnected") {
                    reason = String(message.message ?? "");
                }
                return;
            }
            if (relay && message?.type === "ack" && message.ackId === 1 && !life.open) {
                if (message.success === true)
                    life.connected();
                else
                    life.fail(new Error("The relay refused to join the group"));
                return;
            }
            if (message?.type !== "message" || !life.open)
                return;
            if (relay) {
                // The service stamps fromUserId from the sender's token: only the peer speaks.
                if (message.from !== "group" || message.fromUserId !== relay.peerUserId)
                    return;
                if (message.group !== undefined && message.group !== relay.group)
                    return;
                relay.onMessage?.(message.data, message.fromUserId);
                return;
            }
            if (message.from !== "server")
                return;
            let frame;
            try {
                frame = decode(message.data);
            }
            catch {
                return; // a text frame that isn't JSON: not ours
            }
            if (frame !== undefined)
                options.onMessage?.(frame);
        });
        socket.addEventListener("error", () => life.fail(new Error("Realtime connection failed")));
        socket.addEventListener("close", () => life.fail(new Error(reason ? `Realtime connection closed: ${reason}` : "Realtime connection closed")));
        return life.ready.then(() => ({
            close: () => life.close(),
            get bufferedAmount() {
                return socket.bufferedAmount;
            },
            send(data) {
                if (!relay || !life.open)
                    return false;
                socket.send(JSON.stringify({ type: "sendToGroup", group: relay.group, dataType: "json", noEcho: true, data }));
                return true;
            },
        }));
    }
    /**
     * AppSync Events: `connection_init`, then one subscribe per channel; the
     * connection counts once every subscription is confirmed. A relay also
     * publishes to its peer's channel, each publish answered or the
     * connection given up.
     */
    function connectAppSync(descriptor, options, relay) {
        const { authorization, channels } = descriptor;
        if (!authorization?.Authorization ||
            !authorization.host ||
            !Array.isArray(channels) ||
            channels.length < 1 ||
            channels.length > 16 ||
            (relay && (channels.length !== 1 || !descriptor.publish || descriptor.publish === channels[0]))) {
            return Promise.reject(new Error("Invalid AppSync connection"));
        }
        const socket = new (socketClass(options))(descriptor.url, [APPSYNC_SUBPROTOCOL, `header-${base64url(JSON.stringify(authorization))}`]);
        const life = lifecycle(socket, options.timeoutMs ?? (relay ? 15_000 : 10_000), options.onClose);
        const decode = createFrameDecoder();
        const subscribing = new Set();
        const subscriptions = new Set();
        const inflight = new Map();
        let acknowledged = false;
        let keepAliveMs = MAX_KEEPALIVE_MS;
        let heartbeat;
        let published = 0;
        const raw = (message) => socket.send(JSON.stringify(message));
        const inflightBytes = () => [...inflight.values()].reduce((n, p) => n + p.bytes, 0);
        const alive = () => {
            life.clear(heartbeat);
            heartbeat = life.timer(keepAliveMs, () => life.fail(new Error("Realtime keep-alive timed out")));
        };
        if (Number.isFinite(descriptor.expiresAtMs)) {
            // A relay ends with its token; a client connection reconnects with a new one just before.
            const left = descriptor.expiresAtMs - Date.now() - (relay ? 0 : RENEW_BEFORE_MS);
            life.timer(Math.max(1, left), () => life.fail(new Error(relay ? "The relay connection expired" : "Realtime token expired; reconnect to renew")));
        }
        socket.addEventListener("open", () => {
            if (!life.closed)
                raw({ type: "connection_init" });
        });
        socket.addEventListener("message", (event) => {
            if (life.closed)
                return;
            try {
                if (typeof event.data !== "string" || event.data.length > 6 * 1024 * 1024)
                    throw new Error("Invalid message");
                const message = JSON.parse(event.data);
                switch (message?.type) {
                    case "connection_ack": {
                        if (acknowledged)
                            return;
                        acknowledged = true;
                        const timeout = Number(message.connectionTimeoutMs);
                        if (timeout > 0)
                            keepAliveMs = Math.min(MAX_KEEPALIVE_MS, Math.max(1000, timeout));
                        alive();
                        channels.forEach((channel, index) => {
                            const id = `s${index}`;
                            subscribing.add(id);
                            subscriptions.add(id);
                            raw({ type: "subscribe", id, channel, authorization });
                        });
                        return;
                    }
                    case "ka":
                        if (acknowledged)
                            alive();
                        return;
                    case "subscribe_success":
                        if (subscribing.delete(message.id) && subscribing.size === 0)
                            life.connected();
                        return;
                    case "publish_success": {
                        const entry = inflight.get(message.id);
                        if (!entry)
                            return;
                        if (Array.isArray(message.failed) && message.failed.length)
                            throw new Error("Publish rejected");
                        life.clear(entry.timer);
                        inflight.delete(message.id);
                        return;
                    }
                    case "data": {
                        if (!subscriptions.has(message.id))
                            return;
                        // AppSync has delivered both one event (a string) and a list of them.
                        const payload = message.event ?? message.events;
                        const events = Array.isArray(payload) ? payload : [payload];
                        if (events.length > 5)
                            throw new Error("Too many events");
                        for (const item of events) {
                            const frame = decode(item);
                            if (frame === undefined)
                                continue;
                            // Only the peer can publish to a relay's channel (its token's one publish channel).
                            if (relay)
                                relay.onMessage?.(frame, relay.peerUserId);
                            else
                                options.onMessage?.(frame);
                        }
                        return;
                    }
                    default:
                        if (String(message?.type).includes("error"))
                            throw new Error(String(message.type));
                }
            }
            catch {
                life.fail(new Error("AppSync refused the connection, a subscription or a publish"));
            }
        });
        socket.addEventListener("error", () => life.fail(new Error("Realtime connection failed")));
        socket.addEventListener("close", () => life.fail(new Error("Realtime connection closed")));
        return life.ready.then(() => ({
            close: () => life.close(),
            get bufferedAmount() {
                return socket.bufferedAmount + inflightBytes();
            },
            send(data, sendOptions = {}) {
                if (!relay || !life.open)
                    return false;
                let events;
                try {
                    events = encodeFrame(data, RELAY_EVENT);
                }
                catch {
                    life.fail(new Error("A relay message is too large"));
                    return false;
                }
                const sizes = events.map((e) => encoder.encode(e).length);
                const bytes = sizes.reduce((n, s) => n + s, 0);
                if (inflight.size + events.length > RELAY_INFLIGHT_EVENTS || socket.bufferedAmount + inflightBytes() + bytes > RELAY_INFLIGHT_BYTES) {
                    if (sendOptions.droppable)
                        return false;
                    life.fail(new Error("The relay is congested"));
                    return false;
                }
                events.forEach((item, i) => {
                    const id = `p${++published}`;
                    const timer = life.timer(relay.publishTimeoutMs ?? 15_000, () => life.fail(new Error("A relay publish timed out")));
                    inflight.set(id, { bytes: sizes[i], timer });
                    raw({ type: "publish", id, channel: descriptor.publish, events: [item], authorization });
                });
                return true;
            },
        }));
    }
    function connect(descriptor, options, relay) {
        try {
            const url = new URL(descriptor?.url);
            if (!/^wss?:$/.test(url.protocol) || url.username || url.password)
                throw new Error("Invalid realtime URL");
            if (relay && (!relay.group || !relay.peerUserId))
                throw new Error("A relay connection needs its group and peer");
            if (descriptor.protocol === "v1")
                return connectV1(descriptor, options, relay);
            if (descriptor.protocol === "appsync-events")
                return connectAppSync(descriptor, options, relay);
            throw new Error("Unsupported realtime protocol");
        }
        catch (err) {
            return Promise.reject(err);
        }
    }
    function connectRealtime(descriptor, options = {}) {
        return connect(descriptor, options, undefined).then((c) => ({ close: () => c.close() }));
    }
    function connectRelay(descriptor, options) {
        const { WebSocket, timeoutMs, onClose } = options;
        return connect(descriptor, { WebSocket, timeoutMs, onClose }, options);
    }
    function backoffDelay(attempt, minDelayMs = 500, maxDelayMs = 30_000) {
        const ceiling = Math.min(maxDelayMs, minDelayMs * 2 ** Math.max(0, attempt - 1));
        return Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
    }
    /** A connection that lasted this long resets the backoff; a flapping one doesn't. */
    const STABLE_MS = 10_000;
    function keepConnected(options) {
        const { access, onState, minDelayMs = 500, maxDelayMs = 30_000, maxAttempts = Infinity } = options;
        let stopped = false;
        let current;
        let timer;
        let attempt = 0;
        let openedAt = 0;
        const retry = (error) => {
            if (stopped)
                return;
            if (openedAt && Date.now() - openedAt >= STABLE_MS)
                attempt = 0;
            openedAt = 0;
            attempt++;
            if (attempt > maxAttempts) {
                stopped = true;
                onState?.("closed", { attempt, error });
                return;
            }
            const delayMs = backoffDelay(attempt, minDelayMs, maxDelayMs);
            onState?.("retrying", { attempt, delayMs, error });
            timer = setTimeout(run, delayMs);
        };
        async function run() {
            if (stopped)
                return;
            onState?.("connecting", { attempt });
            try {
                const descriptor = await access();
                if (stopped)
                    return;
                const connection = await connectRealtime(descriptor, {
                    ...options,
                    onClose: (error) => {
                        current = undefined;
                        retry(error);
                    },
                });
                if (stopped)
                    return connection.close();
                current = connection;
                openedAt = Date.now();
                onState?.("open", { attempt });
            }
            catch (err) {
                retry(err instanceof Error ? err : new Error(String(err)));
            }
        }
        void run();
        return {
            close() {
                if (stopped)
                    return;
                stopped = true;
                clearTimeout(timer);
                current?.close();
                current = undefined;
                onState?.("closed", { attempt });
            },
        };
    }
    return { MAX_FRAME_BYTES, encodeFrame, createFrameDecoder, connectRealtime, connectRelay, keepConnected, backoffDelay };
})();
export const { encodeFrame, createFrameDecoder, connectRealtime, connectRelay, keepConnected, backoffDelay } = client;

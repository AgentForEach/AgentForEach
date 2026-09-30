/**
 * AgentForEach Skills Layer — Browser live view
 *
 * The page a user opens to take over the browser for a login, a CAPTCHA, a
 * second factor or a payment. The gateway serves it (GET /api/browser/view);
 * what it needs arrives in the URL fragment, which browsers never send to a
 * server: the Web PubSub URL with a token that can only join this handoff's
 * group, the group, the driver's relay id, the deadline and the reason.
 *
 * It draws the frames the driver streams and sends the user's mouse, touch,
 * keyboard and paste input back through the same group. It only connects to
 * this deployment's Web PubSub host, and only believes messages the driver
 * sent. Web chat embeds it (…#…&embed=1) inside the handoff form, which has
 * its own Done and Cancel; opened on its own, it shows them.
 */

import { createHash } from "node:crypto";

const SCRIPT = String.raw`
(function () {
  "use strict";
  var KEY = "afe-handoff";
  // Read the link once, then keep it in this tab only, so a reload still works.
  var raw = location.hash.slice(1);
  if (raw) { try { sessionStorage.setItem(KEY, raw); } catch (e) {} }
  else { try { raw = sessionStorage.getItem(KEY) || ""; } catch (e) {} }
  var q = new URLSearchParams(raw);
  var relayUrl = q.get("r"), group = q.get("g"), driverId = q.get("d"), expiresAt = Number(q.get("e")) || 0, reason = q.get("m") || "";
  var embed = q.get("embed") === "1";
  // The token has done its job once read: keep it out of the address bar, history and screenshots.
  history.replaceState(null, "", location.pathname);
  window.addEventListener("hashchange", function () { location.reload(); }); // a newer link opened in this tab
  var $ = function (id) { return document.getElementById(id); };
  var canvas = $("screen"), ctx = canvas.getContext("2d");
  var frameW = 1280, frameH = 800, ws, ended = false, lastMove = 0, lastHeard = Date.now();
  var pressed = new Set();
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  if (embed) document.body.classList.add("embed");
  $("reason").textContent = reason || "The agent needs you to take over the browser.";

  function status(text) { $("status").textContent = text; }
  function finish(text) {
    if (ended) return;
    ended = true;
    status(text);
    document.body.classList.add("ended");
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    try { ws && ws.close(); } catch (e) {}
  }
  function send(data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "sendToGroup", group: group, dataType: "json", noEcho: true, data: data }));
  }
  if (!relayUrl || !group || !driverId) { finish("This link is incomplete. Ask the agent for a new one."); return; }
  // Only this deployment's relay: a link pointing elsewhere is not ours.
  var relayHost = document.querySelector('meta[name="afe-relay-host"]').content;
  try { if (new URL(relayUrl).host !== relayHost || new URL(relayUrl).protocol !== "wss:") throw 0; }
  catch (e) { finish("This link doesn't belong to this service. Don't use it."); return; }

  // Countdown to the deadline, and a check that the browser is still there.
  function tick() {
    if (ended) return;
    if (expiresAt) {
      var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      $("timer").textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") + " left";
      if (left === 0) return finish("Time is up. Go back to the chat and tell the agent where you got to.");
    }
    if (Date.now() - lastHeard > 25000) status("Lost the connection to the browser. Go back to the chat.");
  }
  setInterval(tick, 1000); tick();
  setInterval(function () { send({ kind: "ping" }); }, 10000);

  function draw(msg) {
    var bin = atob(msg.jpeg), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    createImageBitmap(new Blob([bytes], { type: "image/jpeg" })).then(function (img) {
      if (canvas.width !== img.width || canvas.height !== img.height) { canvas.width = img.width; canvas.height = img.height; }
      frameW = msg.w || img.width; frameH = msg.h || img.height;
      ctx.drawImage(img, 0, 0);
      document.body.classList.add("live");
    });
  }
  function showStatus(d) {
    var host = ""; try { host = new URL(d.url).host; } catch (e) {}
    $("host").textContent = host || d.url || "";
    $("title").textContent = d.title || "";
    if (!ended) status("");
  }
  function showDialog(d) {
    var box = $("dialog");
    $("dialogText").textContent = (d.type === "prompt" ? "The page asks: " : "The page says: ") + d.message;
    $("dialogInput").hidden = d.type !== "prompt";
    $("dialogInput").value = d.defaultValue || "";
    $("dialogCancel").hidden = d.type === "alert";
    box.hidden = false;
  }
  function answerDialog(accept) {
    $("dialog").hidden = true;
    send({ kind: "dialog", accept: accept, text: $("dialogInput").value.slice(0, 500) });
  }
  $("dialogOk").addEventListener("click", function () { answerDialog(true); });
  $("dialogCancel").addEventListener("click", function () { answerDialog(false); });

  ws = new WebSocket(relayUrl, "json.webpubsub.azure.v1");
  ws.onopen = function () {
    status("Connecting to the browser…");
    ws.send(JSON.stringify({ type: "joinGroup", group: group, ackId: 1 }));
    send({ kind: "hello" });
  };
  ws.onmessage = function (m) {
    var msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
    // Only the driver speaks for the browser: anything else in the group is ignored.
    if (msg.type !== "message" || !msg.data || msg.fromUserId !== driverId) return;
    lastHeard = Date.now();
    var d = msg.data;
    if (d.kind === "frame") draw(d);
    else if (d.kind === "status") showStatus(d);
    else if (d.kind === "dialog") showDialog(d);
    else if (d.kind === "notice") $("notice").textContent = String(d.text || "").slice(0, 300);
    else if (d.kind === "ended") finish(d.reason === "done" || d.reason === "agent_resumed"
      ? "Done. The agent has the browser again."
      : "The live view has ended. Go back to the chat.");
  };
  // A reload closes the socket too; keep the saved link so the page can reconnect.
  var leaving = false;
  addEventListener("pagehide", function () { leaving = true; });
  ws.onclose = function () { if (!leaving) finish("The live view has ended. Go back to the chat."); };

  // Page coordinates from a point on the canvas, allowing for the letterbox around the drawn frame.
  function at(e) {
    var r = canvas.getBoundingClientRect();
    var scale = Math.min(r.width / canvas.width, r.height / canvas.height);
    var w = canvas.width * scale, h = canvas.height * scale;
    var x = (e.clientX - r.left - (r.width - w) / 2) / w, y = (e.clientY - r.top - (r.height - h) / 2) / h;
    return { x: Math.min(Math.max(x, 0), 1) * frameW, y: Math.min(Math.max(y, 0), 1) * frameH, inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
  }
  var BUTTONS = ["left", "middle", "right"];
  var touch = null; // a finger: a drag scrolls, a tap clicks
  canvas.addEventListener("pointerdown", function (e) {
    canvas.focus(); e.preventDefault();
    var p = at(e); if (!p.inside) return;
    if (e.pointerType === "touch") { touch = { x: e.clientX, y: e.clientY, p: p, scrolled: false }; return; }
    send({ kind: "mouse", type: "down", x: p.x, y: p.y, button: BUTTONS[e.button] || "left" });
  });
  canvas.addEventListener("pointerup", function (e) {
    var p = at(e);
    if (e.pointerType === "touch") {
      if (touch && !touch.scrolled) {
        send({ kind: "mouse", type: "down", x: touch.p.x, y: touch.p.y, button: "left" });
        send({ kind: "mouse", type: "up", x: touch.p.x, y: touch.p.y, button: "left" });
        $("typeBox").focus(); // a tap on a field should bring up the phone's keyboard
      }
      touch = null; return;
    }
    send({ kind: "mouse", type: "up", x: p.x, y: p.y, button: BUTTONS[e.button] || "left" });
  });
  canvas.addEventListener("pointermove", function (e) {
    if (touch) {
      var dy = touch.y - e.clientY, dx = touch.x - e.clientX;
      if (!touch.scrolled && Math.abs(dy) + Math.abs(dx) < 10) return;
      touch.scrolled = true; touch.x = e.clientX; touch.y = e.clientY;
      var r = canvas.getBoundingClientRect(), k = frameW / r.width;
      send({ kind: "mouse", type: "wheel", x: touch.p.x, y: touch.p.y, deltaX: dx * k, deltaY: dy * k });
      return;
    }
    var now = Date.now(); if (now - lastMove < 40) return; lastMove = now; // ~25 a second is plenty for hover menus
    var p = at(e); if (p.inside) send({ kind: "mouse", type: "move", x: p.x, y: p.y });
  });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    var p = at(e); send({ kind: "mouse", type: "wheel", x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY });
  }, { passive: false });
  canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  // On a Mac, Command does what Control does on the (Linux) browser.
  function mapKey(key) { return isMac && key === "Meta" ? "Control" : key; }
  canvas.addEventListener("keydown", function (e) {
    // Let paste happen here, so its text is sent (the browser's own clipboard is empty).
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    var key = mapKey(e.key); pressed.add(key);
    send({ kind: "key", type: "down", key: key });
  });
  canvas.addEventListener("keyup", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    var key = mapKey(e.key); pressed.delete(key);
    send({ kind: "key", type: "up", key: key });
  });
  // Keys held when focus leaves would stay down in the browser: let them go.
  function releaseKeys() { pressed.forEach(function (key) { send({ kind: "key", type: "up", key: key }); }); pressed.clear(); }
  canvas.addEventListener("blur", releaseKeys);
  window.addEventListener("blur", releaseKeys);
  function sendText(text) { if (text) send({ kind: "text", text: text.slice(0, 2000) }); }
  canvas.addEventListener("paste", function (e) {
    var text = e.clipboardData && e.clipboardData.getData("text"); if (text) { e.preventDefault(); sendText(text); }
  });

  // Phones: a text box opens the keyboard; its text is typed where the page's cursor is.
  $("typeForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var box = $("typeBox"); sendText(box.value); box.value = "";
  });
  function press(key) { send({ kind: "key", type: "down", key: key }); send({ kind: "key", type: "up", key: key }); }
  document.querySelectorAll("[data-key]").forEach(function (b) { b.addEventListener("click", function () { press(b.dataset.key); }); });

  $("done").addEventListener("click", function () { send({ kind: "done" }); finish("Done. Go back to the chat and tell the agent you've finished."); });
  $("cancel").addEventListener("click", function () { send({ kind: "cancel" }); finish("Cancelled. Go back to the chat."); });
  // The chat that embeds this view tells it when the user pressed its own Done or Cancel.
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent || window.parent === window) return;
    if (e.data === "afe-handoff-done") send({ kind: "done" });
    if (e.data === "afe-handoff-cancel") send({ kind: "cancel" });
  });
})();
`;

const STYLE = `
:root { --night: #151827; --ink: #e9e7e1; --amber: #F29A1F; --dim: #8a8fa3; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--night); color: var(--ink); font: 14px/1.4 system-ui, sans-serif; }
header { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 10px 16px; flex-wrap: wrap; }
#reason { font-weight: 600; }
#timer { color: var(--amber); font-variant-numeric: tabular-nums; }
.address { display: flex; gap: 10px; align-items: baseline; padding: 0 16px 6px; min-width: 0; }
#host { font: 600 15px ui-monospace, monospace; color: var(--ink); background: #0b0d16; padding: 3px 8px; border-radius: 6px; white-space: nowrap; flex: none; }
#title { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.warn { color: var(--dim); padding: 0 16px 6px; margin: 0; font-size: 13px; }
#status { color: var(--amber); padding: 0 16px 6px; }
#status:empty { display: none; }
main { padding: 0 16px; display: flex; justify-content: center; }
canvas { display: block; max-width: 100%; max-height: 75vh; width: auto; height: auto; background: #0b0d16; border-radius: 6px; outline: none; touch-action: none; cursor: default; }
canvas:focus { box-shadow: 0 0 0 2px var(--amber); }
body:not(.live) canvas { min-height: 240px; width: 100%; }
#dialog { margin: 8px 16px; padding: 12px; border: 1px solid var(--amber); border-radius: 8px; display: grid; gap: 8px; }
#dialog[hidden] { display: none; }
#notice { color: var(--amber); padding: 0 16px; }
#notice:empty { display: none; }
form, .keys { display: flex; gap: 8px; padding: 8px 16px; flex-wrap: wrap; }
input { flex: 1; min-width: 160px; padding: 8px; border-radius: 6px; border: 1px solid #3a3f55; background: #0b0d16; color: var(--ink); }
button { padding: 8px 14px; border-radius: 6px; border: 0; background: #2a2f45; color: var(--ink); cursor: pointer; }
button.primary { background: var(--amber); color: var(--night); font-weight: 600; }
.embed #done, .embed #cancel { display: none; }
.ended canvas { opacity: 0.35; } .ended form, .ended .keys, .ended #done, .ended #cancel, .ended #dialog { display: none; }
p.hint { color: var(--dim); padding: 0 16px 16px; margin: 0; }
`;

const BODY = `
<header><span id="reason"></span><span><span id="timer"></span>
<button id="cancel">Cancel</button> <button id="done" class="primary">Done</button></span></header>
<div class="address"><span id="host"></span><span id="title"></span></div>
<p class="warn">Check the address above before you type a password or card details.</p>
<div id="status">Connecting…</div>
<main><canvas id="screen" tabindex="0" width="1280" height="800" aria-label="The agent's browser. Click to use it."></canvas></main>
<div id="dialog" hidden><span id="dialogText"></span><input id="dialogInput" hidden autocomplete="off"><span><button id="dialogOk" class="primary">OK</button> <button id="dialogCancel">Cancel</button></span></div>
<div id="notice"></div>
<form id="typeForm"><input id="typeBox" placeholder="Type here to send text to the page" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="submit">Send</button></form>
<div class="keys"><button data-key="Enter">Enter</button><button data-key="Tab">Tab</button><button data-key="Backspace">Backspace</button><button data-key="Escape">Esc</button><button data-key="ArrowDown">↓</button><button data-key="ArrowUp">↑</button></div>
<p class="hint">Only you see this. The agent doesn't see what you type, and when you're done it sees the page with password and card fields hidden. For a dropdown, click it, then use ↓ ↑ and Enter.</p>
`;

const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("base64");

const escapeAttr = (value: string) => value.replace(/[^a-zA-Z0-9.\-]/g, "");

/** The live view page, for this deployment's Web PubSub host. */
export function viewerHtml(relayHost: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="afe-relay-host" content="${escapeAttr(relayHost)}">
<title>Take over the browser</title><style>${STYLE}</style></head>
<body>${BODY}<script>${SCRIPT}</script></body></html>`;
}

/**
 * Headers for the page: only its own script runs, it only connects to this
 * deployment's Web PubSub, and it can be framed (by the chat that embeds it;
 * without a link's fragment it holds nothing worth framing).
 */
export function viewerHeaders(relayHost: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'sha256-${SCRIPT_HASH}'`,
      "style-src 'unsafe-inline'",
      "img-src data: blob:",
      `connect-src wss://${escapeAttr(relayHost)}`,
      "frame-ancestors *",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
  };
}

/** Where a handoff's viewer lives: `browser.handoff.viewerBaseUrl`, or this Function App's own address. */
export function viewerBaseUrl(configured: string | undefined): string | undefined {
  if (configured) return configured.replace(/\/$/, "");
  const host = process.env.WEBSITE_HOSTNAME;
  if (!host) return undefined;
  return `${host.startsWith("localhost") ? "http" : "https"}://${host}`;
}

/** The link for one handoff; everything sensitive rides in the fragment. */
export function viewerLink(
  baseUrl: string,
  h: { relayUrl: string; group: string; expiresAt: number; reason: string; driverUserId: string },
  embed = false,
): string {
  const fragment = new URLSearchParams({
    r: h.relayUrl,
    g: h.group,
    d: h.driverUserId,
    e: String(h.expiresAt),
    m: h.reason,
  });
  if (embed) fragment.set("embed", "1");
  return `${baseUrl}/api/browser/view#${fragment.toString()}`;
}

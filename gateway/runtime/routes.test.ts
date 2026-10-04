/**
 * The route and schedule table (with the Azure pack's own schedules) must
 * register exactly what the gateway registered before the table existed. registrations.baseline.json was
 * recorded from the pre-table gateway (every app.http / app.timer call, with
 * the cron API enabled); a deliberate route change updates it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerFunctions, withDurableMaintenance, type FunctionsApp } from "@agentforeach/platform-azure";
import { matchRoute } from "@agentforeach/platform";
import { buildRouteTable } from "../routes.js";
import { viewerLink } from "../skills/browser/viewer.js";
import { registerWebSocketProvider } from "../websocket/providers/index.js";

interface Recorded {
  http: Array<{ name: string; route: string; methods: string[]; authLevel: string; extraInputs: string[] }>;
  timer: Array<{ name: string; schedule: string; runOnStartup: boolean; extraInputs: string[] }>;
}

const baselinePath = fileURLToPath(new URL("../../../runtime/registrations.baseline.json", import.meta.url));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Recorded;

function record(): Recorded {
  const out: Recorded = { http: [], timer: [] };
  const target: FunctionsApp = {
    http: (name, o) =>
      out.http.push({
        name,
        route: o.route!,
        methods: [...(o.methods ?? [])],
        authLevel: o.authLevel!,
        extraInputs: (o.extraInputs ?? []).map((i) => i.type),
      }),
    timer: (name, o) =>
      out.timer.push({
        name,
        schedule: o.schedule,
        runOnStartup: o.runOnStartup ?? false,
        extraInputs: (o.extraInputs ?? []).map((i) => i.type),
      }),
  };
  registerFunctions(withDurableMaintenance(buildRouteTable()), target);
  const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
  out.http.sort(byJson);
  out.timer.sort(byJson);
  return out;
}

test("the Azure host registers the same HTTP routes as before the route table", () => {
  assert.deepEqual(record().http, baseline.http);
});

test("the Azure host registers the same timers as before the route table", () => {
  assert.deepEqual(record().timer, baseline.timer);
});

test("the ws/* webhooks are served only for a realtime provider that sends them", () => {
  const wsRoutes = () => buildRouteTable().routes.filter((r) => r.route.startsWith("ws/")).map((r) => r.route);
  assert.deepEqual(wsRoutes().sort(), ["ws/connect", "ws/disconnected", "ws/message", "ws/{*catchAllEvent}"]);
  registerWebSocketProvider("sockets-elsewhere", () => ({}) as never, { upstreamWebhooks: false });
  const before = process.env.WEBSOCKET_PROVIDER;
  process.env.WEBSOCKET_PROVIDER = "sockets-elsewhere";
  try {
    assert.deepEqual(wsRoutes(), []);
    const routes = buildRouteTable().routes.map((r) => r.route);
    assert.ok(routes.includes("negotiate"), "negotiate serves every provider");
    assert.ok(routes.includes("api/chat"), "the other routes stay");
  } finally {
    if (before === undefined) delete process.env.WEBSOCKET_PROVIDER;
    else process.env.WEBSOCKET_PROVIDER = before;
  }
});

test("the browser handoff link the agent sends opens a served route", () => {
  const link = viewerLink("https://gw.example", { relayUrl: "wss://r", group: "g", expiresAt: 1, reason: "login", driverUserId: "d" });
  const match = matchRoute(buildRouteTable().routes, "GET", new URL(link).pathname);
  assert.equal(match?.route.name, "browserView", `${new URL(link).pathname} is served`);
});

test("route names are unique", () => {
  const names = buildRouteTable().routes.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
});

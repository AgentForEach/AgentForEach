/**
 * The phase-scoped gateway: `always` + ONE phase per turn, derived from the
 * previous run's tool calls; channel-scoped rules stay off channels that
 * cannot honour them; and a flat config behaves exactly as it always did —
 * which is the kill-switch.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGatewayReferenceSection,
  deriveGatewayPhase,
} from "./sections/safety.js";
import type { GatewayTextConfig } from "./prompt-config.js";

const cfg: GatewayTextConfig = {
  header: "## Gateway",
  always: ["<fit_test> always-on rule"],
  phases: {
    routing: { enterOn: [], rules: ["<routing_rule> pick well"] },
    building: {
      enterOn: ["list_templates", "create_draft"],
      rules: [
        "<building_rule> build once",
        { channels: ["app"], rule: "<widget_rule> tap the picker" },
      ],
    },
    reviewing: {
      enterOn: ["render_preview", "publish_draft"],
      rules: ["<review_rule> read it first"],
    },
  },
};

test("gateway phases — a fresh conversation lands on the first phase", () => {
  assert.equal(deriveGatewayPhase(cfg, []), "routing");
  assert.equal(deriveGatewayPhase(cfg, undefined), "routing");
  const lines = buildGatewayReferenceSection(cfg, { seenTools: [] });
  assert.ok(lines.some((l) => l.startsWith("<fit_test>")));
  assert.ok(lines.some((l) => l.startsWith("<routing_rule>")));
  assert.ok(!lines.some((l) => l.startsWith("<building_rule>")));
});

test("gateway phases — the last intersecting phase wins", () => {
  assert.equal(deriveGatewayPhase(cfg, ["list_templates"]), "building");
  // A run that built AND rendered is reviewing — declaration order is
  // precedence, so the later phase takes it.
  assert.equal(
    deriveGatewayPhase(cfg, ["create_draft", "publish_draft"]),
    "reviewing",
  );
});

test("gateway phases — channel scoping serves widget rules only where widgets render", () => {
  const seenTools = ["create_draft"];
  const app = buildGatewayReferenceSection(cfg, { seenTools });
  assert.ok(app.some((l) => l.startsWith("<widget_rule>")), "no channel = app = everything");
  const whatsapp = buildGatewayReferenceSection(cfg, {
    seenTools,
    channel: "whatsapp",
  });
  assert.ok(!whatsapp.some((l) => l.startsWith("<widget_rule>")));
  assert.ok(whatsapp.some((l) => l.startsWith("<building_rule>")));
});

test("gateway phases — a flat config is served whole, untouched", () => {
  const flat: GatewayTextConfig = {
    header: "## Gateway",
    rules: ["<one> a", "<two> b"],
  };
  assert.deepEqual(buildGatewayReferenceSection(flat, { seenTools: ["x"] }), [
    "## Gateway",
    "<one> a",
    "<two> b",
    "",
  ]);
  assert.equal(deriveGatewayPhase(flat, ["anything"]), undefined);
});

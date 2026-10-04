/**
 * AgentForEach Gateway — browser live view page
 *
 * GET /api/browser/view serves the page a user opens to take over the agent's
 * browser (docs/Browser.md, "Handing the browser to the user"). It carries no secret:
 * the handoff's relay token travels in the URL fragment, which browsers
 * never send to a server. 404 while the browser or its handoff is off.
 */

import type { HttpResult, RouteDef } from "@agentforeach/platform";
import { loadSkillsConfig } from "../skills/config.js";
import { viewerHeaders, viewerHtml } from "../skills/browser/viewer.js";
import { relayHost as resolveRelayHost } from "../websocket/providers/index.js";

async function browserView(): Promise<HttpResult> {
  const browser = loadSkillsConfig().sandbox?.browser;
  // The page only ever connects to this deployment's realtime relay; without one there's nothing to show.
  const relayHost = resolveRelayHost();
  if (!browser?.enabled || !browser.handoff.enabled || !relayHost) return { status: 404 };
  return { status: 200, headers: viewerHeaders(relayHost), body: viewerHtml(relayHost) };
}

export const routes: RouteDef[] = [];

routes.push({
  name: "browserView",
  methods: ["GET"],
  route: "api/browser/view",
  handler: browserView,
});

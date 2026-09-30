/**
 * AgentForEach Gateway — browser live view page
 *
 * GET /api/browser/view serves the page a user opens to take over the agent's
 * browser (docs/Browser.md, "Handing the browser to the user"). It carries no secret:
 * the handoff's Web PubSub token travels in the URL fragment, which browsers
 * never send to a server. 404 while the browser or its handoff is off.
 */

import { app, type HttpResponseInit } from "@azure/functions";
import { loadSkillsConfig } from "../skills/config.js";
import { viewerHeaders, viewerHtml } from "../skills/browser/viewer.js";
import { resolveWebPubSubHost } from "../websocket/config.js";

async function browserView(): Promise<HttpResponseInit> {
  const browser = loadSkillsConfig().sandbox?.browser;
  // The page only ever connects to this deployment's Web PubSub; without one there's nothing to show.
  const relayHost = resolveWebPubSubHost();
  if (!browser?.enabled || !browser.handoff.enabled || !relayHost) return { status: 404 };
  return { status: 200, headers: viewerHeaders(relayHost), body: viewerHtml(relayHost) };
}

app.http("browserView", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "browser/view",
  handler: browserView,
});

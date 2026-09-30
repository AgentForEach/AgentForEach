/**
 * AgentForEach Skills Layer — Browser Module
 *
 * A real browser inside each user's ACA Sandbox, driven through one
 * `browser` tool. See docs/Browser.md.
 */

export {
  BrowserToolHandler,
  BROWSER_ACTION_UNIT,
  BROWSER_HANDOFF_UNIT,
  handoffDriverUserId,
  handoffOutcome,
  isBrowserHandoffCall,
  BROWSER_TOOL_NAME,
  checkBrowserArgs,
  getBrowserToolDefinitions,
  isBrowserEnabled,
  isBrowserTool,
  parseDriverOutput,
} from "./handler.js";
export { BROWSER_ACTIONS } from "./types.js";
export type { BrowserGuards, BrowserLimiter, HandoffRelay } from "./handler.js";
export { viewerBaseUrl, viewerHeaders, viewerHtml, viewerLink } from "./viewer.js";
export type { BrowserAction, BrowserConfig, BrowserDriverResult, BrowserJsonConfig } from "./types.js";

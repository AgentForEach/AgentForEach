/**
 * AgentForEach Skills Layer — Browser Types
 *
 * The browser runs inside the user's own ACA Sandbox (see docs/Browser.md),
 * so its settings live under "skills.sandbox.browser" in agentforeach.json.
 */

/** Raw shape of agentforeach.json "skills.sandbox.browser". */
export interface BrowserJsonConfig {
  /**
   * Offer the `browser` tool. Needs the ACA Sandboxes backend and a disk
   * image built with SANDBOX_IMAGE_BROWSER=1. The SANDBOX_BROWSER_ENABLED
   * app setting (set by the IaC) overrides it. Default: false.
   */
  enabled?: boolean;
  /** Timeout for a click, typing, a wait (seconds). Default: 30. */
  actionTimeoutSec?: number;
  /** Timeout for opening a page (seconds). Default: 45. */
  navigationTimeoutSec?: number;
  /** Longest page snapshot or text returned to the model; the model can narrow with query. Default: 8000. */
  maxSnapshotChars?: number;
  /** Browser window size. Default: 1280x800. */
  viewport?: { width: number; height: number };
  /** Close the browser after this many idle seconds, freeing memory for code. Default: 120. */
  idleShutdownSec?: number;
  /** Browser actions one conversation turn may take; stops runaway click loops. Default: 30. */
  maxActionsPerTurn?: number;
  /** Browser actions one scheduled run (job or heartbeat) may take. Default: 10. */
  maxActionsPerScheduledRun?: number;
  /**
   * Show screenshots to the model as images, so it can see what a text
   * snapshot can't (images, charts, layout). Turn off for a model that can't
   * read images; the user still gets a download link. Default: true.
   */
  showScreenshots?: boolean;
  /**
   * Handing the browser to the user for what the agent must not or can't do:
   * a login, a CAPTCHA, a second factor, a payment. The user takes over in a
   * live view relayed through Web PubSub. Needs real-time and a client that
   * renders forms (web chat).
   */
  handoff?: {
    /** Default: true (it still needs Web PubSub and the HITL store). */
    enabled?: boolean;
    /** How long the user has to finish, in minutes. Default: 10 (at most 30). */
    maxMinutes?: number;
    /** Where the gateway's viewer page is served; default: the gateway's own public address (on Azure, WEBSITE_HOSTNAME). */
    viewerBaseUrl?: string;
    /**
     * The Web PubSub hub for live views. Default: the chat hub's name + "_browser" (hub names
     * allow letters, digits and underscores). It must have no event handlers, so a relay token
     * can't send events to the gateway.
     */
    hub?: string;
  };
  /**
   * The only user ids offered the browser, e.g. a pilot group or a paid plan.
   * Omit it to offer the browser to every user.
   */
  users?: string[];
}

/** Resolved browser settings. */
export interface BrowserConfig {
  enabled: boolean;
  actionTimeoutSec: number;
  navigationTimeoutSec: number;
  maxSnapshotChars: number;
  viewport: { width: number; height: number };
  idleShutdownSec: number;
  maxActionsPerTurn: number;
  maxActionsPerScheduledRun: number;
  showScreenshots: boolean;
  handoff: { enabled: boolean; maxMinutes: number; hub: string; viewerBaseUrl?: string };
  /** Allowed user ids; undefined means every user. */
  users?: string[];
}

export const BROWSER_ACTIONS = [
  "navigate",
  "snapshot",
  "click",
  "hover",
  "type",
  "select",
  "upload",
  "press",
  "scroll",
  "back",
  "wait",
  "text",
  "tabs",
  "tab_open",
  "tab_focus",
  "tab_close",
  "screenshot",
  "handoff",
  "reset",
] as const;

/** What the agent hands the browser over for. */
export const HANDOFF_KINDS = ["login", "captcha", "2fa", "payment", "other"] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

/** What the in-sandbox driver prints (gateway/sandbox-container/browser/driver.mjs). */
export interface BrowserDriverResult {
  ok: boolean;
  /** Set by the driver on every answer: it received and carried out the action. */
  handled?: boolean;
  action?: string;
  error?: string;
  tab?: string;
  url?: string;
  title?: string;
  status?: number;
  snapshot?: string;
  text?: string;
  /** Screenshot path under /mnt/data. */
  screenshot?: string;
  /** Window-sized JPEG of the same screenshot for the model, path under /mnt/data. */
  view?: string;
  /** Downloaded files, paths under /mnt/data. */
  downloads?: string[];
  /** The site refused (a bot wall with nothing to pass). */
  blocked?: boolean;
  /** The page is asking for a human check (a CAPTCHA), which the user can do in a handoff. */
  challenge?: { provider?: string };
  note?: string;
  notes?: string[];
  [key: string]: unknown;
}

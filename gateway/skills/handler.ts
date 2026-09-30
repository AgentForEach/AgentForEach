/**
 * AgentForEach Skills Layer — Skill Tool Handler
 *
 * Handles the skill-related tools:
 *   - skill_list   — list available skills and their status
 *   - skill_setup  — enable/disable skills, set credentials
 *   - skill_read   — read a SKILL.md from Blob Storage
 *   - http_fetch   — make HTTP requests (in-process, no container)
 *
 * The LLM reads a SKILL.md to learn how to use a skill, then naturally
 * picks http_fetch for API calls or sandbox_exec for code/shell — no
 * system-level routing needed.
 */

import type { ToolDefinition } from "../memory/types.js";
import type {
  SkillStatus,
  SkillAuditEntry,
  UserSkillConfig,
  SkillManifest,
  CredentialBinding,
} from "./types.js";
import { hostMatches, redactCredentialValues } from "./credentials.js";
import { checkUrl, isSsrfBlocked, readBodyText, safeFetch } from "../utils/safe-fetch.js";
import type { SkillBlobStore } from "./blob-store.js";
import { UserSkillStore } from "./store.js";
import { loadSkillsConfig } from "./config.js";
import {
  SandboxToolHandler,
  getSandboxToolDefinitions,
  isSandboxTool as isSandboxToolCheck,
} from "./sandbox/index.js";
import type { SandboxBackend } from "./sandbox/index.js";
import type { ExportBlobStore } from "./sandbox/export-store.js";
import {
  BrowserToolHandler,
  getBrowserToolDefinitions,
  handoffDriverUserId,
  isBrowserEnabled,
  isBrowserTool,
  type HandoffRelay,
} from "./browser/index.js";
import { generateGroupToken } from "../websocket/auth.js";
import type { DirectInputForm } from "../hitl/types.js";
import { getScopedRateLimiter } from "../ratelimit/index.js";
import type { ToolResultImage } from "../llms/types.js";

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Default minimum interval between skill_setup calls for the same skill (ms).
 * Prevents LLM spam and accidental rapid-fire updates.
 */
const DEFAULT_SETUP_MIN_INTERVAL_MS = 30_000; // 30 seconds

// ============================================================================
// Tool Names
// ============================================================================

export const SKILL_LIST_TOOL_NAME = "skill_list";
export const SKILL_SETUP_TOOL_NAME = "skill_setup";
export const SKILL_READ_TOOL_NAME = "skill_read";
export const HTTP_FETCH_TOOL_NAME = "http_fetch";

const SKILL_TOOL_NAMES = new Set([
  SKILL_LIST_TOOL_NAME,
  SKILL_SETUP_TOOL_NAME,
  SKILL_READ_TOOL_NAME,
  HTTP_FETCH_TOOL_NAME,
]);

// ============================================================================
// Tool Definitions
// ============================================================================

const SKILL_LIST_TOOL: ToolDefinition = {
  type: "function",
  name: SKILL_LIST_TOOL_NAME,
  description:
    "List all available skills and their configuration status for the current user.",
  parameters: {
    type: "object",
    properties: {},
  },
};

const SKILL_SETUP_TOOL: ToolDefinition = {
  type: "function",
  name: SKILL_SETUP_TOOL_NAME,
  description:
    "Configure a skill for the current user. Can enable/disable a skill or set its credentials.",
  parameters: {
    type: "object",
    properties: {
      skill_id: {
        type: "string",
        description: "The skill identifier (e.g., 'weather').",
      },
      action: {
        type: "string",
        description: "Action to perform.",
        enum: ["enable", "disable", "set_credentials"],
      },
      credentials: {
        type: "object",
        description:
          "Credential key-value pairs to set (only for 'set_credentials' action).",
      },
    },
    required: ["skill_id", "action"],
  },
};

const SKILL_READ_TOOL: ToolDefinition = {
  type: "function",
  name: SKILL_READ_TOOL_NAME,
  description:
    "Read a skill's SKILL.md instruction file. Always read this before executing a skill. " +
    "SKILL.md files may use exec: [\"curl\", ...] notation — translate those to http_fetch calls. " +
    "For non-HTTP commands (python, jq, etc.), use sandbox_exec instead.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path to the skill file (e.g., 'weather/SKILL.md'). Get paths from skill_list or the available_skills section.",
      },
    },
    required: ["path"],
  },
};

const HTTP_FETCH_TOOL: ToolDefinition = {
  type: "function",
  name: HTTP_FETCH_TOOL_NAME,
  description:
    "Make an HTTP request (GET, POST, PUT, DELETE, PATCH). Runs in-process — lightweight and instant. " +
    "Use this for REST/API calls, webhooks, fetching data from URLs, and any HTTP interaction. " +
    "Credential substitution: use $VAR_NAME (e.g. $GITHUB_TOKEN) in url, headers, or body — " +
    "the server resolves them from the user's configured skill credentials. Never hardcode secrets. " +
    "Prefer this over sandbox_exec when you only need to call an API or fetch a URL. " +
    "For tasks that need code execution, file I/O, or multi-step processing, use sandbox_exec instead.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch. Supports $VAR_NAME credential references.",
      },
      method: {
        type: "string",
        description: 'HTTP method (default: "GET").',
        enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"],
      },
      headers: {
        type: "object",
        description: "Request headers as key-value pairs. Use $VAR_NAME for credential values (e.g. \"Authorization\": \"token $GITHUB_TOKEN\").",
      },
      body: {
        type: "string",
        description: "Request body (string). Supports $VAR_NAME credential references. For JSON, stringify the object first.",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 30, max: 120).",
      },
    },
    required: ["url"],
  },
};

const SKILL_TOOLS: ToolDefinition[] = [
  SKILL_LIST_TOOL,
  SKILL_SETUP_TOOL,
  SKILL_READ_TOOL,
  HTTP_FETCH_TOOL,
];

// ============================================================================
// Public Helpers
// ============================================================================

/** Get all skill tool definitions (registered when skills are enabled). */
export function getSkillToolDefinitions(opts?: {
  sandboxEnabled?: boolean;
  /** The browser runs inside the sandbox, so it needs sandboxEnabled too. */
  browserEnabled?: boolean;
}): ToolDefinition[] {
  const tools = [...SKILL_TOOLS];
  if (opts?.sandboxEnabled) {
    tools.push(...getSandboxToolDefinitions());
    if (opts.browserEnabled) tools.push(...getBrowserToolDefinitions());
  }
  return tools;
}

/** Check whether a tool name is a skill tool (including sandbox and browser tools). */
export function isSkillTool(toolName: string): boolean {
  return SKILL_TOOL_NAMES.has(toolName) || isSandboxToolCheck(toolName) || isBrowserTool(toolName);
}

// ============================================================================
// SSRF Protection — Host Blocklist
// ============================================================================

// ============================================================================
// Skill Tool Handler
// ============================================================================

/**
 * Unified handler for skill-related tool calls.
 *
 * Routes:
 *   - skill_list  → handleList()
 *   - skill_setup → handleSetup()
 *   - skill_read  → handleRead()
 *   - http_fetch  → handleHttpFetch()
 */
export class SkillToolHandler {
  private store: UserSkillStore;
  private blobStore: SkillBlobStore;
  private statuses: SkillStatus[];
  private userCredentials: Record<string, string>;
  private credentialBindings: Record<string, CredentialBinding>;
  /** Refuse credentials whose skill declares no hosts (skills.requireCredentialHosts). */
  private readonly requireCredentialHosts: boolean;
  private sandboxHandler?: SandboxToolHandler;
  private browserHandler?: BrowserToolHandler;
  private readonly setupMinIntervalMs: number;

  constructor(
    store: UserSkillStore,
    blobStore: SkillBlobStore,
    statuses: SkillStatus[],
    userCredentials: Record<string, string>,
    sandboxClient?: SandboxBackend,
    userId?: string,
    sessionId?: string,
    exportStore?: ExportBlobStore,
    credentialBindings: Record<string, CredentialBinding> = {},
    /**
     * scheduled: this run is a scheduled job or heartbeat (tighter browser cap, nobody to confirm).
     * units: the run's meter for billable actions (credits.unitCoins).
     * handoffSurface: the client renders forms and the run can pause on one, so the browser can
     * be handed to the user.
     */
    options: { scheduled?: boolean; units?: Record<string, number>; handoffSurface?: boolean } = {},
  ) {
    this.store = store;
    this.blobStore = blobStore;
    this.statuses = statuses;
    this.userCredentials = userCredentials;
    this.credentialBindings = credentialBindings;
    this.requireCredentialHosts = loadSkillsConfig().requireCredentialHosts;
    this.setupMinIntervalMs = loadSkillsConfig().setupMinIntervalMs ?? DEFAULT_SETUP_MIN_INTERVAL_MS;

    if (sandboxClient?.isReady() && userId) {
      this.sandboxHandler = new SandboxToolHandler(
        sandboxClient,
        userCredentials,
        userId,
        sessionId,
        blobStore,
        exportStore,
        credentialBindings,
        (skillId) => this.statuses.some((s) => s.manifest.id === skillId && s.enabled),
      );
      const sandboxConfig = loadSkillsConfig().sandbox;
      if (sandboxConfig?.browser && isBrowserEnabled(sandboxConfig, sandboxClient, userId)) {
        this.browserHandler = new BrowserToolHandler(this.sandboxHandler, sandboxConfig.browser, {
          userId,
          scheduled: options.scheduled,
          units: options.units,
          // Resolved on first use, so building the handler never touches the database.
          limiter: { check: (id) => getScopedRateLimiter("browser").check(id) },
          ...(options.handoffSurface ? { handoff: { relay: webPubSubRelay(sandboxConfig.browser.handoff.hub) } } : {}),
        });
      }
    }
  }

  /** Check whether this handler can handle the given tool name. */
  isSkillTool(toolName: string): boolean {
    return SKILL_TOOL_NAMES.has(toolName) || isSandboxToolCheck(toolName) || isBrowserTool(toolName);
  }

  /** Handle a skill tool call. Credential values never appear in the result. */
  async handle(
    toolName: string,
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    return (await this.handleWithImages(toolName, args, userId)).output;
  }

  /** End a live view this run started (the run stopped before the user got it). */
  async stopBrowserHandoff(): Promise<void> {
    await this.browserHandler?.stopHandoff();
  }

  /** As handle, plus any images the tool returned for the model (browser screenshots). */
  async handleWithImages(
    toolName: string,
    args: Record<string, unknown>,
    userId: string,
  ): Promise<{ output: string; images?: ToolResultImage[]; inputRequest?: DirectInputForm }> {
    if (isBrowserTool(toolName) && this.browserHandler) {
      const { output, images, inputRequest } = await this.browserHandler.run(args);
      return {
        output: redactCredentialValues(output, this.userCredentials),
        ...(images ? { images } : {}),
        ...(inputRequest ? { inputRequest } : {}),
      };
    }
    return { output: redactCredentialValues(await this.dispatch(toolName, args, userId), this.userCredentials) };
  }

  private async dispatch(
    toolName: string,
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    // Delegate sandbox tools to sandbox handler
    if (isSandboxToolCheck(toolName)) {
      if (!this.sandboxHandler) {
        return JSON.stringify({
          error:
            "Sandbox is not configured. Set skills.sandbox.enabled=true and provide ACA pool endpoint in agentforeach.json.",
        });
      }
      return this.sandboxHandler.handle(toolName, args);
    }

    if (isBrowserTool(toolName)) {
      if (!this.browserHandler) {
        return JSON.stringify({
          error:
            "The browser is not available. It needs the ACA Sandboxes backend and skills.sandbox.browser.enabled=true (see docs/Browser.md).",
        });
      }
      return this.browserHandler.handle(args);
    }

    switch (toolName) {
      case SKILL_LIST_TOOL_NAME:
        return this.handleList();
      case SKILL_SETUP_TOOL_NAME:
        return this.handleSetup(args, userId);
      case SKILL_READ_TOOL_NAME:
        return this.handleRead(args);
      case HTTP_FETCH_TOOL_NAME:
        return this.handleHttpFetch(args);
      default:
        return JSON.stringify({ error: `Unknown skill tool: ${toolName}` });
    }
  }

  // --------------------------------------------------------------------------
  // skill_list
  // --------------------------------------------------------------------------

  private handleList(): string {
    const skills = this.statuses.map((s) => ({
      id: s.manifest.id,
      name: s.manifest.name,
      description: s.manifest.description,
      category: s.manifest.category,
      enabled: s.enabled,
      configured: s.configured,
      credentialsComplete: s.credentialsComplete,
      blobPath: s.manifest.blobPath,
      requiredCredentials: s.manifest.credentials
        .filter((c) => c.required)
        .map((c) => ({ key: c.key, label: c.label, helpText: c.helpText })),
      requiredBins: s.manifest.requiredBins,
    }));

    return JSON.stringify({ skills }, null, 2);
  }

  // --------------------------------------------------------------------------
  // skill_read
  // --------------------------------------------------------------------------

  private async handleRead(args: Record<string, unknown>): Promise<string> {
    const path = String(args.path ?? "");
    if (!path) {
      return JSON.stringify({ error: "Missing required parameter: path" });
    }

    // Verify the skill exists and is enabled
    const status = this.statuses.find((s) => s.manifest.blobPath === path);
    if (!status) {
      return JSON.stringify({
        error: `No skill found at path "${path}". Use skill_list to see available skills.`,
      });
    }
    if (!status.enabled) {
      return JSON.stringify({
        error: `Skill "${status.manifest.id}" is not enabled. Use skill_setup to enable it first.`,
      });
    }
    if (!status.credentialsComplete) {
      const missing = status.manifest.credentials
        .filter((c) => c.required)
        .map((c) => c.key);
      return JSON.stringify({
        error: `Skill "${status.manifest.id}" is missing required credentials: ${missing.join(", ")}. Use skill_setup to set them.`,
      });
    }

    try {
      const content = await this.blobStore.readFile(path);
      return JSON.stringify({
        skill_id: status.manifest.id,
        path,
        content,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to read skill file";
      return JSON.stringify({ error: msg });
    }
  }

  // --------------------------------------------------------------------------
  // http_fetch
  // --------------------------------------------------------------------------

  /**
   * Substitute `$VAR_NAME` references in a string with values from the
   * user's resolved credentials. Unknown variables are left as-is. A
   * credential bound to hosts is only substituted when `host` is one of them.
   */
  private substituteCredentials(input: string, host?: string): string {
    if (!input.includes("$")) return input;
    return input.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, varName: string) => {
      const binding = this.credentialBindings[varName];
      if (binding && !(host && hostMatches(host, binding.hosts))) return _match;
      return this.userCredentials[varName] ?? _match;
    });
  }

  /** Names of the user's credentials that `inputs` reference as $NAME. */
  private credentialsReferenced(inputs: string[]): string[] {
    const names = new Set<string>();
    for (const input of inputs) {
      for (const [, varName] of input.matchAll(/\$([A-Z_][A-Z0-9_]*)/g)) {
        if (this.userCredentials[varName!]) names.add(varName!);
      }
    }
    return [...names];
  }

  /** Bound credentials referenced in `inputs` that may not go to `host`. */
  private credentialsBlockedFor(host: string, inputs: string[]): string[] {
    const blocked = new Set<string>();
    for (const input of inputs) {
      for (const [, varName] of input.matchAll(/\$([A-Z_][A-Z0-9_]*)/g)) {
        if (!this.userCredentials[varName]) continue;
        const binding = this.credentialBindings[varName];
        if (binding) {
          if (!hostMatches(host, binding.hosts)) {
            blocked.add(`$${varName} (allowed: ${binding.hosts.join(", ")})`);
          }
        } else if (this.requireCredentialHosts) {
          blocked.add(
            `$${varName} (its skill declares no hosts; add "hosts" to the credential in SKILL.md, ` +
              "or set skills.requireCredentialHosts to false)",
          );
        }
      }
    }
    return [...blocked];
  }

  private async handleHttpFetch(args: Record<string, unknown>): Promise<string> {
    const rawUrl = String(args.url ?? "").trim();
    if (!rawUrl) {
      return JSON.stringify({ error: "Missing required parameter: url" });
    }

    const method = String(args.method ?? "GET").toUpperCase();
    const rawHeaders = (args.headers as Record<string, string>) ?? {};
    const rawBody = args.body != null ? String(args.body) : undefined;
    const timeoutSec = Math.min(Math.max(Number(args.timeout) || 30, 1), 120);

    // Resolve the destination host with only unbound credentials, then refuse
    // to send any host-bound credential anywhere else.
    let targetHost: string;
    let targetIsHttps: boolean;
    try {
      const target = new URL(this.substituteCredentials(rawUrl));
      targetHost = target.hostname;
      targetIsHttps = target.protocol === "https:";
    } catch {
      return JSON.stringify({ error: `Invalid URL: "${rawUrl}"` });
    }
    const inputs = [rawUrl, ...Object.values(rawHeaders).map(String), rawBody ?? ""];
    // Credentials never travel in cleartext, whatever host they're bound to.
    if (!targetIsHttps) {
      const referenced = this.credentialsReferenced(inputs);
      if (referenced.length) {
        return JSON.stringify({
          error: `Credentials are only sent over https: ${referenced.map((k) => `$${k}`).join(", ")}`,
        });
      }
    }
    const blocked = this.credentialsBlockedFor(targetHost, inputs);
    if (blocked.length) {
      return JSON.stringify({
        error: `Credential not allowed for host ${targetHost}: ${blocked.join("; ")}`,
      });
    }

    // Substitute $VAR_NAME credential references BEFORE validation
    // so the SSRF check sees the final resolved URL, not the template.
    const url = this.substituteCredentials(rawUrl, targetHost);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      headers[k] = this.substituteCredentials(String(v), targetHost);
    }
    const body = rawBody != null ? this.substituteCredentials(rawBody, targetHost) : undefined;

    // Validate URL (after credential substitution so resolved values are checked)
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      // Report the template: the resolved URL may contain credentials.
      return JSON.stringify({ error: `Invalid URL: "${rawUrl}"` });
    }

    // Cheap pre-check; safeFetch re-checks every address it connects to and
    // every redirect hop.
    const pre = checkUrl(parsedUrl);
    if (!pre.ok) {
      return JSON.stringify({ error: `URL not allowed: ${pre.reason}` });
    }

    try {
      const response = await safeFetch(url, {
        method,
        headers,
        body: method !== "GET" && method !== "HEAD" ? body : undefined,
        timeoutMs: timeoutSec * 1000,
      });

      const contentType = response.headers.get("content-type") ?? "";
      let responseBody: string;

      // Stream at most 1 MB; the rest is never read into memory.
      const { text, truncated } = await readBodyText(response, 1024 * 1024);
      responseBody = truncated ? `${text}\n... [truncated at 1 MB]` : text;

      return JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        contentType,
        body: responseBody,
      });
    } catch (err: unknown) {
      if (isSsrfBlocked(err)) {
        const reason = err.cause instanceof Error ? err.cause.message : err.message;
        return JSON.stringify({ error: `URL not allowed: ${reason}` });
      }
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        return JSON.stringify({ error: `Request timed out after ${timeoutSec}s` });
      }
      const msg = err instanceof Error ? err.message : "HTTP request failed";
      return JSON.stringify({ error: msg });
    }
  }

  // --------------------------------------------------------------------------
  // skill_setup
  // --------------------------------------------------------------------------

  private async handleSetup(
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    const skillId = String(args.skill_id ?? "");
    const action = String(args.action ?? "");

    if (!skillId) {
      return JSON.stringify({ error: "Missing required parameter: skill_id" });
    }
    if (!action) {
      return JSON.stringify({ error: "Missing required parameter: action" });
    }

    // Validate action value
    if (!["enable", "disable", "set_credentials"].includes(action)) {
      return JSON.stringify({
        error: `Unknown action: "${action}". Use "enable", "disable", or "set_credentials".`,
      });
    }

    // Validate skill exists in statuses
    const status = this.statuses.find((s) => s.manifest.id === skillId);
    if (!status) {
      return JSON.stringify({ error: `Unknown skill: "${skillId}"` });
    }
    const manifest = status.manifest;

    // Load existing config (or create new)
    const existing = await this.store.get(userId, skillId);
    const now = new Date().toISOString();

    // Rate limiting: reject if the same skill was modified too recently
    if (existing?.updatedAt) {
      const elapsed = Date.now() - new Date(existing.updatedAt).getTime();
      if (elapsed < this.setupMinIntervalMs) {
        const waitSec = Math.ceil((this.setupMinIntervalMs - elapsed) / 1000);
        return JSON.stringify({
          error: `Rate limited: skill "${skillId}" was just modified. Try again in ${waitSec}s.`,
        });
      }
    }

    const config: UserSkillConfig = existing ?? {
      id: UserSkillStore.buildId(userId, skillId),
      userId,
      skillId,
      enabled: false,
      credentials: {},
      createdAt: now,
      updatedAt: now,
    };

    // Track which credential keys are being set (for audit — values NOT logged)
    let credentialKeysSet: string[] | undefined;

    switch (action) {
      case "enable":
        config.enabled = true;
        config.updatedAt = now;
        break;

      case "disable":
        config.enabled = false;
        config.updatedAt = now;
        break;

      case "set_credentials": {
        const creds = args.credentials;
        if (!creds || typeof creds !== "object") {
          return JSON.stringify({
            error: "Missing credentials object for set_credentials action",
          });
        }

        // Collect valid string credential entries
        const newCreds: Record<string, string> = {};
        for (const [key, value] of Object.entries(creds)) {
          if (typeof value === "string") {
            newCreds[key] = value;
          }
        }

        if (Object.keys(newCreds).length === 0) {
          return JSON.stringify({
            error: "No valid string credentials provided.",
          });
        }

        // Validate against known credential specs
        const validKeys = new Set(manifest.credentials.map((c) => c.key));
        const unknownKeys = Object.keys(newCreds).filter((k) => !validKeys.has(k));
        if (unknownKeys.length > 0 && validKeys.size > 0) {
          return JSON.stringify({
            error: `Unknown credential keys: ${unknownKeys.join(", ")}. Valid keys: ${Array.from(validKeys).join(", ")}`,
          });
        }

        // Merge validated credentials
        for (const [key, value] of Object.entries(newCreds)) {
          config.credentials[key] = value;
        }
        credentialKeysSet = Object.keys(newCreds);
        config.updatedAt = now;
        break;
      }
    }

    await this.store.upsert(config);
    // Later calls in this turn (sandbox_skill_load, skill_read) see the change.
    status.enabled = config.enabled;

    // Fire-and-forget audit log (non-blocking)
    const auditEntry: SkillAuditEntry = {
      id: `audit:${userId}:${skillId}:${now}`,
      userId,
      skillId,
      action: action as SkillAuditEntry["action"],
      timestamp: now,
      ...(credentialKeysSet ? { credentialKeysSet } : {}),
    };
    this.store.logAudit(auditEntry).catch(() => {});

    return JSON.stringify({
      success: true,
      skillId,
      action,
      enabled: config.enabled,
      credentialsComplete: manifest.credentials
        .filter((c) => c.required)
        .every((c) => !!config.credentials[c.key]?.trim()),
    });
  }
}

/**
 * Handoff tokens from the gateway's Web PubSub, on the live-view hub (which
 * has no event handlers), each limited to the one handoff group: the driver
 * joins as a hashed id, the viewer as the user.
 */
function webPubSubRelay(hub: string): HandoffRelay {
  return {
    async issue(viewerUserId, group, ttlMinutes) {
      const [driver, viewer] = await Promise.all([
        generateGroupToken({ hub, userId: handoffDriverUserId(viewerUserId), group, ttlMinutes }),
        generateGroupToken({ hub, userId: viewerUserId, group, ttlMinutes }),
      ]);
      return { driverUrl: driver.url, viewerUrl: viewer.url };
    },
  };
}

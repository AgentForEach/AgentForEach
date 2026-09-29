/**
 * AgentForEach Cron System — Function Tool Definitions & Handler
 *
 * Defines `cron_create`, `cron_list`, `cron_get`, `cron_update`, `cron_delete`,
 * and `cron_runs` as function-type tools for the LLM.
 *
 * When the model calls one of these tools, the runner executes the handler
 * and feeds the result back as function output.
 *
 * Ported from OpenClaw's cron-tool.ts, adapted for:
 *   - Cosmos DB store (instead of Gateway HTTP calls)
 *   - Direct CRUD against CronStore (no proxy layer)
 *   - Simplified actions (no "wake" / "status" — those are orchestrator concerns)
 *
 * @see OpenClaw: src/agents/tools/cron-tool.ts
 */

import type { ToolDefinition } from "../memory/index.js";
import type { CronStore } from "./store.js";
import type { CronJobCreate, CronJobPatch } from "./types.js";
import { parseAbsoluteTimeMs } from "./schedule.js";
import { getDeliveryAdapter } from "./delivery.js";
import {
  getMinEveryMs,
  getMinCronIntervalMs,
  getMaxNameLength,
  getMaxDescriptionLength,
  IMMEDIATE_DELAY_FLOOR_MS,
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
} from "./config.js";
import { INVALID_SESSION_ID_MESSAGE, isValidSessionId } from "../sessions/ids.js";
import { withChannelBinding } from "./recipient-policy.js";

type CronToolContext = {
  channelName?: string;
  channelChatId?: string;
};

// ============================================================================
// Tool Definitions
// ============================================================================

export const CRON_CREATE_TOOL: ToolDefinition = {
  type: "function",
  name: "cron_create",
  description:
    "Create a new scheduled job (cron job). Use this when the user asks to " +
    "schedule a recurring task, set a reminder, or run something at a specific time.\n\n" +
    "REMINDER RULES:\n" +
    '- One-time reminders (e.g., "in 20 minutes", "tomorrow at 9") must use schedule.kind="at".\n' +
    '- Use schedule.kind="every" or "cron" only when the user explicitly asks for recurrence.\n' +
    "- Heartbeats are separate from cron jobs; do not emulate heartbeat behavior with ad-hoc recurring reminders.\n\n" +
    "SCHEDULE TYPES (schedule.kind):\n" +
    '- "at": One-shot at an absolute time. { "kind": "at", "at": "<ISO-8601 timestamp>" }\n' +
    '- "every": Recurring interval. { "kind": "every", "everyMs": <milliseconds> }\n' +
    '- "cron": Cron expression. { "kind": "cron", "expr": "<cron-expression>", "tz": "<optional IANA timezone>" }\n\n' +
    "TARGET + PAYLOAD:\n" +
    '- session_target="isolated" requires payload_kind="agentTurn" with message\n' +
    '- session_target="main" requires payload_kind="systemEvent" with text\n\n' +
    "DELIVERY:\n" +
    "- By default, delivery is AUTO-CONFIGURED: results are sent back through the current channel " +
    "(e.g., Telegram, WhatsApp). You do NOT need to set delivery_mode for normal reminders.\n" +
    "- Only set delivery_mode if the user explicitly asks for a specific delivery method:\n" +
    '  - "channel": Deliver to a specific chat channel (isolated target only)\n' +
    '  - "webhook": HTTP POST to a URL\n' +
    '  - "none": Suppress delivery entirely (result stored only, NOT sent to user)\n' +
    "- IMPORTANT: Do NOT set delivery_mode unless you have a specific reason. " +
    "Omitting it ensures the reminder is delivered back to the user on the same channel they sent it from.\n\n" +
    "EXPIRY:\n" +
    "- Recurring jobs (every/cron) automatically expire after 30 days by default.\n" +
    "- Set expiresAt (ISO-8601 timestamp) for precise control, or expires_in_days for relative days. Maximum is 90 days.\n" +
    "- Expired jobs are auto-disabled. Users can renew them with cron_update.\n" +
    "- One-shot 'at' jobs do not need expiry (they auto-disable after firing).\n\n" +
    "MAX RUNS:\n" +
    "- Set max_runs to auto-stop a recurring job after N successful executions.\n" +
    "- Useful for \"repeat X times\" requests. Omit for unlimited runs.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Human-readable name for the job.",
      },
      description: {
        type: "string",
        description:
          "Brief context about why this job was created and what the user originally asked for. " +
          "This is injected into the system prompt when the job fires, so the executing agent " +
          "understands the intent. Always provide this for reminders and user-initiated tasks.",
      },
      schedule: {
        type: "object",
        description:
          'When to run. Must include "kind" field: "at", "every", or "cron". ' +
          "For 'at': include 'at' (ISO-8601). For 'every': include 'everyMs'. " +
          "For 'cron': include 'expr' and optional 'tz'.",
      },
      schedule_kind: {
        type: "string",
        enum: ["at", "every", "cron"],
        description: "Shorthand kind when passing top-level schedule fields.",
      },
      at: {
        type: "string",
        description:
          'Shorthand one-shot timestamp (ISO-8601 or epoch-like string). Equivalent to schedule={kind:"at",at}.',
      },
      at_ms: {
        type: "number",
        description:
          'Shorthand one-shot epoch milliseconds. Equivalent to schedule={kind:"at",at}.',
      },
      everyMs: {
        type: "number",
        description:
          'Shorthand recurring interval in ms. Equivalent to schedule={kind:"every",everyMs}.',
      },
      every_ms: {
        type: "number",
        description:
          'Shorthand recurring interval in ms. Equivalent to schedule={kind:"every",everyMs}.',
      },
      expr: {
        type: "string",
        description:
          'Shorthand cron expression. Equivalent to schedule={kind:"cron",expr}.',
      },
      cron_expr: {
        type: "string",
        description:
          'Shorthand cron expression. Equivalent to schedule={kind:"cron",expr}.',
      },
      tz: {
        type: "string",
        description:
          "Optional timezone for cron expressions (IANA, e.g., America/New_York).",
      },
      timezone: {
        type: "string",
        description: "Optional timezone alias for cron expressions.",
      },
      delayMs: {
        type: "number",
        description:
          "Relative one-shot delay in milliseconds when exact timestamp is not provided.",
      },
      delay_ms: {
        type: "number",
        description:
          "Relative one-shot delay in milliseconds when exact timestamp is not provided.",
      },
      delay_minutes: {
        type: "number",
        description:
          "Relative one-shot delay in minutes when exact timestamp is not provided.",
      },
      when: {
        type: "string",
        description:
          'Natural-language timing hint (e.g., "in 2 minutes", "after 1 hour", "now").',
      },
      schedule_text: {
        type: "string",
        description:
          'Additional natural-language scheduling hint (e.g., "in 2 minutes").',
      },
      message: {
        type: "string",
        description:
          "The prompt sent to the agent when the job fires. This is the ONLY input the executing " +
          "agent sees, so include enough context for it to produce a useful response. " +
          'For reminders, include who asked, what to remind, and any relevant details. ' +
          'E.g., "The user asked to be reminded to call their mom. Send a warm, concise reminder."',
      },
      text: {
        type: "string",
        description:
          "System-event text injected into the main agent session when the job fires. " +
          "Only used with session_target=\"main\" + payload_kind=\"systemEvent\". " +
          "Include full context since this appears as a system event in the conversation.",
      },
      payload_kind: {
        type: "string",
        enum: ["agentTurn", "systemEvent"],
        description:
          "How the job payload is executed. " +
          "\"agentTurn\": direct LLM call with `message` (for isolated jobs). " +
          "\"systemEvent\": injects `text` into the main session (for main jobs). " +
          "Auto-inferred from session_target if omitted.",
      },
      session_target: {
        type: "string",
        enum: ["isolated", "main"],
        description:
          "\"isolated\" (default): standalone LLM call — fast, no conversation history, result delivered via push/channel. " +
          "\"main\": routes through the user's active session — has full conversation history and all tools.",
      },
      wake_mode: {
        type: "string",
        enum: ["next-heartbeat", "now"],
        description:
          "Only for session_target=\"main\". " +
          "\"now\" (default): flush immediately. " +
          "\"next-heartbeat\": queue until the next heartbeat cycle.",
      },
      is_recurring: {
        type: "boolean",
        description:
          "Optional explicit recurrence hint. Set true only when the user clearly asked for repetition.",
      },
      session_id: {
        type: "string",
        description: "Optional target session id for main-session delivery.",
      },
      delivery_mode: {
        type: "string",
        description:
          'Delivery mode: "none", "announce"/"channel", or "webhook".',
        enum: ["none", "announce", "channel", "webhook"],
      },
      delivery_channel: {
        type: "string",
        description:
          'Channel ID for delivery (e.g., "telegram", "whatsapp"). Required when delivery_mode is "channel".',
      },
      delivery_recipient: {
        type: "string",
        description:
          "Recipient ID within the channel (e.g., chat ID, phone number).",
      },
      enabled: {
        type: "boolean",
        description: "Whether the job starts enabled. Default: true.",
      },
      expires_in_days: {
        type: "number",
        description:
          "How many days until the recurring job expires (relative). " +
          "Default: 30 days. Maximum: 90 days. Ignored if expiresAt is set.",
      },
      expiresAt: {
        type: "string",
        description:
          "Exact expiry timestamp (ISO-8601) for recurring jobs. " +
          "Use this for precise expiry (e.g., \"stop after 5 minutes\"). Takes priority over expires_in_days. " +
          "Must not exceed 90 days from now.",
      },
      max_runs: {
        type: "number",
        description:
          "Maximum number of successful executions before auto-disabling. " +
          "Only for recurring jobs (every/cron). Omit or 0 for unlimited.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

export const CRON_LIST_TOOL: ToolDefinition = {
  type: "function",
  name: "cron_list",
  description:
    "List the user's scheduled jobs. " +
    "Returns all active jobs by default. Set include_disabled to true to also see disabled jobs.",
  parameters: {
    type: "object",
    properties: {
      include_disabled: {
        type: "boolean",
        description:
          "Whether to include disabled jobs in the listing. Default: false.",
      },
      includeDisabled: {
        type: "boolean",
        description: "Alias for include_disabled.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export const CRON_GET_TOOL: ToolDefinition = {
  type: "function",
  name: "cron_get",
  description:
    "Get details of a specific scheduled job by its ID. " +
    "Use this after cron_list to inspect a particular job.",
  parameters: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "The job ID to look up.",
      },
      jobId: {
        type: "string",
        description: "Alias for job_id.",
      },
      id: {
        type: "string",
        description: "Alias for job_id.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export const CRON_UPDATE_TOOL: ToolDefinition = {
  type: "function",
  name: "cron_update",
  description:
    "Update an existing scheduled job. " +
    "You can change the name, schedule, message, delivery, or enabled status. " +
    "Only provide the fields you want to change.",
  parameters: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "The ID of the job to update.",
      },
      jobId: {
        type: "string",
        description: "Alias for job_id.",
      },
      id: {
        type: "string",
        description: "Alias for job_id.",
      },
      name: {
        type: "string",
        description: "New name for the job.",
      },
      description: {
        type: "string",
        description:
          "Updated context about the job's purpose. " +
          "Injected into the executing agent's system prompt, so include the user's original intent.",
      },
      schedule: {
        type: "object",
        description: "New schedule (same format as cron_create).",
      },
      schedule_kind: {
        type: "string",
        enum: ["at", "every", "cron"],
        description: "Shorthand kind for schedule patch.",
      },
      at: {
        type: "string",
        description: "Shorthand one-shot timestamp for schedule patch.",
      },
      at_ms: {
        type: "number",
        description: "Shorthand one-shot epoch ms for schedule patch.",
      },
      everyMs: {
        type: "number",
        description: "Shorthand interval ms for schedule patch.",
      },
      every_ms: {
        type: "number",
        description: "Shorthand interval ms for schedule patch.",
      },
      expr: {
        type: "string",
        description: "Shorthand cron expression for schedule patch.",
      },
      cron_expr: {
        type: "string",
        description: "Shorthand cron expression for schedule patch.",
      },
      tz: {
        type: "string",
        description: "Timezone for cron expression schedule patch.",
      },
      timezone: {
        type: "string",
        description: "Alias for tz.",
      },
      message: {
        type: "string",
        description:
          "New prompt for isolated jobs. This is the ONLY input the executing agent sees — include full context.",
      },
      text: {
        type: "string",
        description:
          "New system-event text for main-session jobs. Appears as a system event in the conversation.",
      },
      payload_kind: {
        type: "string",
        enum: ["agentTurn", "systemEvent"],
        description: "Payload kind override.",
      },
      session_target: {
        type: "string",
        enum: ["isolated", "main"],
        description: "Execution target override.",
      },
      wake_mode: {
        type: "string",
        enum: ["next-heartbeat", "now"],
        description: 'Wake mode override. Default is "now" for new jobs.',
      },
      session_id: {
        type: "string",
        description: "Target session id override.",
      },
      delivery_mode: {
        type: "string",
        description: "New delivery mode.",
        enum: ["none", "announce", "channel", "webhook"],
      },
      delivery_channel: {
        type: "string",
        description: "New delivery channel ID.",
      },
      delivery_recipient: {
        type: "string",
        description: "New delivery recipient.",
      },
      enabled: {
        type: "boolean",
        description: "Enable or disable the job.",
      },
      expires_in_days: {
        type: "number",
        description:
          "Set new expiry as days from now (relative). " +
          "Must be between 1 and 90 days. Ignored if expiresAt is set.",
      },
      expiresAt: {
        type: "string",
        description:
          "Set exact expiry timestamp (ISO-8601). Must not exceed 90 days from now. Takes priority over expires_in_days.",
      },
      max_runs: {
        type: "number",
        description:
          "Set maximum successful executions before auto-disabling. 0 to remove limit.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export const CRON_DELETE_TOOL: ToolDefinition = {
  type: "function",
  name: "cron_delete",
  description: "Delete a scheduled job permanently. This cannot be undone.",
  parameters: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "The ID of the job to delete.",
      },
      jobId: {
        type: "string",
        description: "Alias for job_id.",
      },
      id: {
        type: "string",
        description: "Alias for job_id.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export const CRON_RUNS_TOOL: ToolDefinition = {
  type: "function",
  name: "cron_runs",
  description:
    "Get the recent run history for a scheduled job. " +
    "Shows when the job ran, whether it succeeded, and a summary of results.",
  parameters: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "The job ID to get run history for.",
      },
      jobId: {
        type: "string",
        description: "Alias for job_id.",
      },
      id: {
        type: "string",
        description: "Alias for job_id.",
      },
      limit: {
        type: "number",
        description:
          "Maximum number of recent runs to return (1-50). Default: 10.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/**
 * Get all cron tool definitions for registration with the LLM.
 */
export function getCronToolDefinitions(): ToolDefinition[] {
  return [
    CRON_CREATE_TOOL,
    CRON_LIST_TOOL,
    CRON_GET_TOOL,
    CRON_UPDATE_TOOL,
    CRON_DELETE_TOOL,
    CRON_RUNS_TOOL,
  ];
}

// ============================================================================
// Tool Call Handler
// ============================================================================

export class CronToolHandler {
  private store: CronStore;
  private onMutation?: () => Promise<void>;

  constructor(store: CronStore, onMutation?: () => Promise<void>) {
    this.store = store;
    this.onMutation = onMutation;
  }

  private toPositiveNumber(value: unknown): number | undefined {
    const n = this.toFiniteNumber(value);
    if (n === undefined || n <= 0) return undefined;
    return n;
  }

  private toFiniteNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  private pickStringArg(
    args: Record<string, unknown>,
    keys: readonly string[],
  ): string | undefined {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) return trimmed;
      }
    }
    return undefined;
  }

  private pickBooleanArg(
    args: Record<string, unknown>,
    keys: readonly string[],
  ): boolean | undefined {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") return true;
        if (normalized === "false") return false;
      }
    }
    return undefined;
  }

  private hasAnyArg(
    args: Record<string, unknown>,
    keys: readonly string[],
  ): boolean {
    return keys.some((key) => args[key] !== undefined);
  }

  private toIsoAt(value: unknown): string | undefined {
    if (typeof value === "string") {
      const ms = parseAbsoluteTimeMs(value);
      return ms !== undefined ? new Date(ms).toISOString() : undefined;
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return new Date(value).toISOString();
    }
    return undefined;
  }

  private scheduleFromObject(
    raw: Record<string, unknown>,
  ): CronJobCreate["schedule"] | undefined {
    const kindRaw =
      typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
    const inferredKind =
      kindRaw ||
      (raw.at !== undefined || raw.atMs !== undefined || raw.at_ms !== undefined
        ? "at"
        : "") ||
      (raw.everyMs !== undefined || raw.every_ms !== undefined
        ? "every"
        : "") ||
      (raw.expr !== undefined || raw.cron_expr !== undefined ? "cron" : "");

    if (inferredKind === "at") {
      const at = this.toIsoAt(raw.at ?? raw.atMs ?? raw.at_ms);
      if (!at) return undefined;
      return { kind: "at", at };
    }
    if (inferredKind === "every") {
      const everyMs = this.toPositiveNumber(raw.everyMs ?? raw.every_ms);
      if (!everyMs) return undefined;
      const anchorMs = this.toPositiveNumber(raw.anchorMs ?? raw.anchor_ms);
      return anchorMs
        ? {
            kind: "every",
            everyMs: Math.floor(everyMs),
            anchorMs: Math.floor(anchorMs),
          }
        : { kind: "every", everyMs: Math.floor(everyMs) };
    }
    if (inferredKind === "cron") {
      const exprRaw = raw.expr ?? raw.cron_expr;
      const expr = typeof exprRaw === "string" ? exprRaw.trim() : "";
      if (!expr) return undefined;
      const tzRaw = raw.tz ?? raw.timezone;
      const tz = typeof tzRaw === "string" ? tzRaw.trim() : "";
      return tz ? { kind: "cron", expr, tz } : { kind: "cron", expr };
    }
    return undefined;
  }

  private parseRelativeDelayMs(text: string): number | undefined {
    const normalized = text.trim().toLowerCase();
    if (!normalized) return undefined;

    const numeric =
      /(?:\bin\b|\bafter\b)\s+(\d+)\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|day|d|weeks?|week|w)\b/.exec(
        normalized,
      );
    if (numeric) {
      const value = Number(numeric[1]);
      if (!Number.isFinite(value) || value <= 0) return undefined;
      const unit = numeric[2];
      if (/^s(ec|ecs?|econds?)?$/.test(unit)) return value * 1_000;
      if (/^m(in|ins?|inutes?)?$/.test(unit)) return value * 60_000;
      if (/^h(r|rs?|ours?)?$/.test(unit)) return value * 3_600_000;
      if (/^d(ay|ays?)?$/.test(unit)) return value * 86_400_000;
      if (/^w(eek|eeks?)?$/.test(unit)) return value * 604_800_000;
    }

    const oneUnit =
      /(?:\bin\b|\bafter\b)\s+(?:a|an|one)\s+(second|minute|hour|day|week)s?\b/.exec(
        normalized,
      );
    if (oneUnit) {
      const unit = oneUnit[1];
      if (unit.startsWith("second")) return 1_000;
      if (unit.startsWith("minute")) return 60_000;
      if (unit.startsWith("hour")) return 3_600_000;
      if (unit.startsWith("day")) return 86_400_000;
      if (unit.startsWith("week")) return 604_800_000;
    }

    if (/\b(right now|now|immediately|asap)\b/.test(normalized)) {
      // Small floor avoids "past due" races for immediate reminders.
      return IMMEDIATE_DELAY_FLOOR_MS;
    }
    return undefined;
  }

  private buildScheduleFromArgs(
    args: Record<string, unknown>,
    options?: { allowNaturalHints?: boolean },
  ): CronJobCreate["schedule"] | undefined {
    if (args.schedule && typeof args.schedule === "object") {
      const fromObject = this.scheduleFromObject(
        args.schedule as Record<string, unknown>,
      );
      if (fromObject) return fromObject;
    }

    const kindRaw =
      typeof args.schedule_kind === "string"
        ? args.schedule_kind.trim().toLowerCase()
        : "";
    if (kindRaw === "at") {
      const at = this.toIsoAt(args.at ?? args.atMs ?? args.at_ms);
      if (at) return { kind: "at", at };
    }
    if (kindRaw === "every") {
      const everyMs = this.toPositiveNumber(args.everyMs ?? args.every_ms);
      if (everyMs) return { kind: "every", everyMs: Math.floor(everyMs) };
    }
    if (kindRaw === "cron") {
      const exprRaw = args.expr ?? args.cron_expr;
      const expr = typeof exprRaw === "string" ? exprRaw.trim() : "";
      if (expr) {
        const tzRaw = args.tz ?? args.timezone;
        const tz = typeof tzRaw === "string" ? tzRaw.trim() : "";
        return tz ? { kind: "cron", expr, tz } : { kind: "cron", expr };
      }
    }

    const fromAt = this.toIsoAt(args.at ?? args.atMs ?? args.at_ms);
    if (fromAt) return { kind: "at", at: fromAt };

    const fromEvery = this.toPositiveNumber(args.everyMs ?? args.every_ms);
    if (fromEvery) {
      const anchor = this.toPositiveNumber(args.anchorMs ?? args.anchor_ms);
      return anchor
        ? {
            kind: "every",
            everyMs: Math.floor(fromEvery),
            anchorMs: Math.floor(anchor),
          }
        : { kind: "every", everyMs: Math.floor(fromEvery) };
    }

    const exprRaw = args.expr ?? args.cron_expr;
    const expr = typeof exprRaw === "string" ? exprRaw.trim() : "";
    if (expr) {
      const tzRaw = args.tz ?? args.timezone;
      const tz = typeof tzRaw === "string" ? tzRaw.trim() : "";
      return tz ? { kind: "cron", expr, tz } : { kind: "cron", expr };
    }

    const delayMs =
      this.toPositiveNumber(args.delayMs ?? args.delay_ms) ??
      (() => {
        const mins = this.toPositiveNumber(args.delay_minutes);
        return mins ? mins * 60_000 : undefined;
      })();
    if (delayMs) {
      return {
        kind: "at",
        at: new Date(Date.now() + Math.floor(delayMs)).toISOString(),
      };
    }

    if (options?.allowNaturalHints !== false) {
      const timeHintParts = [
        args.when,
        args.schedule_text,
        args.description,
        args.name,
        args.message,
        args.text,
      ]
        .filter((v) => typeof v === "string")
        .map((v) => String(v));
      const timeHints = timeHintParts.join(" ");
      const relativeDelayMs = this.parseRelativeDelayMs(timeHints);
      if (relativeDelayMs) {
        return {
          kind: "at",
          at: new Date(Date.now() + relativeDelayMs).toISOString(),
        };
      }
    }

    return undefined;
  }

  /**
   * Handle a function tool call from the model.
   *
   * @param toolName - One of: cron_create, cron_list, cron_get, cron_update, cron_delete, cron_runs
   * @param args - The parsed arguments from the model.
   * @param userId - The user id (injected by orchestration, not from model).
   * @returns String result to feed back as function output.
   */
  async handle(
    toolName: string,
    args: Record<string, unknown>,
    userId: string,
    context?: CronToolContext,
  ): Promise<string> {
    try {
      switch (toolName) {
        case "cron_create":
          return await this.handleCreate(args, userId, context);
        case "cron_list":
          return await this.handleList(args, userId);
        case "cron_get":
          return await this.handleGet(args, userId);
        case "cron_update":
          return await this.handleUpdate(args, userId, context);
        case "cron_delete":
          return await this.handleDelete(args, userId);
        case "cron_runs":
          return await this.handleRuns(args, userId);
        default:
          return JSON.stringify({ error: `Unknown cron tool: ${toolName}` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  }

  // --------------------------------------------------------------------------
  // cron_create
  // --------------------------------------------------------------------------

  private async handleCreate(
    args: Record<string, unknown>,
    userId: string,
    context?: CronToolContext,
  ): Promise<string> {
    const name = args.name as string;
    const description = args.description as string | undefined;
    const schedule = this.buildScheduleFromArgs(args, {
      allowNaturalHints: true,
    });
    const sessionTarget =
      (args.session_target as "main" | "isolated" | undefined) ?? "isolated";
    const wakeMode =
      (args.wake_mode as "next-heartbeat" | "now" | undefined) ?? "now";
    const payloadKind =
      (args.payload_kind as "agentTurn" | "systemEvent" | undefined) ??
      (sessionTarget === "main" ? "systemEvent" : "agentTurn");
    const text = typeof args.text === "string" ? args.text : "";
    const message = typeof args.message === "string" ? args.message : "";
    const isRecurringHint = args.is_recurring === true;

    if (!name) return JSON.stringify({ error: "name is required" });

    // Input length limits
    const maxNameLen = getMaxNameLength();
    if (name.length > maxNameLen) {
      return JSON.stringify({
        error: `name is too long (${name.length} chars, max ${maxNameLen})`,
      });
    }
    const maxDescLen = getMaxDescriptionLength();
    if (description && description.length > maxDescLen) {
      return JSON.stringify({
        error: `description is too long (${description.length} chars, max ${maxDescLen})`,
      });
    }

    if (!schedule) {
      return JSON.stringify({
        error:
          'schedule is required (provide schedule, or shorthand fields like at/every_ms/cron_expr, or a relative hint such as "in 2 minutes")',
      });
    }

    // Validate schedule has a kind
    if (!schedule.kind || !["at", "every", "cron"].includes(schedule.kind)) {
      return JSON.stringify({
        error: 'schedule.kind must be one of: "at", "every", "cron"',
      });
    }

    // Minimum interval enforcement
    if (schedule.kind === "every") {
      const minMs = getMinEveryMs();
      if (schedule.everyMs < minMs) {
        return JSON.stringify({
          error: `Interval too short: ${schedule.everyMs}ms. Minimum is ${minMs}ms (${Math.round(minMs / 1000)}s). Use a longer interval.`,
        });
      }
    }
    if (schedule.kind === "cron") {
      const minMs = getMinCronIntervalMs();
      if (minMs > 0) {
        try {
          const { Cron } = await import("croner");
          const now = new Date();
          const cron = new Cron(schedule.expr, { catch: false });
          const first = cron.nextRun(now);
          if (first) {
            const second = cron.nextRun(new Date(first.getTime() + 1000));
            if (second) {
              const gap = second.getTime() - first.getTime();
              if (gap < minMs) {
                return JSON.stringify({
                  error: `Cron fires too frequently (~${Math.round(gap / 1000)}s between runs). Minimum interval is ${Math.round(minMs / 1000)}s. Use a less frequent pattern.`,
                });
              }
            }
          }
        } catch (err) {
          return JSON.stringify({
            error: `Invalid cron expression "${schedule.expr}": ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    // Guardrail: if this looks like a reminder request and recurrence was not
    // explicitly requested, require one-shot schedule.kind="at".
    const reminderContext = [name, description ?? "", message, text]
      .join(" ")
      .toLowerCase();
    const isReminderLike = /\b(remind|reminder|nudge|ping)\b/.test(
      reminderContext,
    );
    const explicitlyRecurring =
      /\b(every|daily|weekly|monthly|yearly|repeat|recurr)\b/.test(
        reminderContext,
      );
    if (
      isReminderLike &&
      schedule.kind !== "at" &&
      !isRecurringHint &&
      !explicitlyRecurring
    ) {
      return JSON.stringify({
        error:
          'This reminder appears one-time. Use schedule.kind="at" for one-time reminders, or set is_recurring=true for recurring reminders.',
      });
    }

    let payload: CronJobCreate["payload"];
    if (payloadKind === "systemEvent") {
      if (!text.trim() && !message.trim()) {
        return JSON.stringify({
          error: "text is required for payload_kind=systemEvent",
        });
      }
      payload = {
        kind: "systemEvent",
        text: (text || message).trim(),
      };
    } else {
      if (!message.trim()) {
        return JSON.stringify({
          error: "message is required for payload_kind=agentTurn",
        });
      }
      payload = {
        kind: "agentTurn",
        message: message.trim(),
      };
    }

    const contextChannelName = context?.channelName?.trim().toLowerCase();
    const contextChannelChatId = context?.channelChatId?.trim();
    // Map in-app channels ("web", "push") to the "push" delivery adapter.
    // "web" = HTTP API, "push" = WebSocket — both deliver via Web PubSub push.
    const deliveryChannelName =
      contextChannelName === "web" || contextChannelName === "push"
        ? "push"
        : contextChannelName;
    const hasChannelAdapter = deliveryChannelName
      ? !!getDeliveryAdapter(deliveryChannelName)
      : false;
    const explicitDeliveryRecipient =
      args.delivery_recipient as string | undefined;

    // Build delivery:
    // - explicit delivery_mode wins (except "none" is treated as unset for
    //   isolated jobs with channel context — the LLM often sets "none"
    //   thinking it's the default, which silently kills delivery)
    // - default for isolated jobs: persist current channel target when available
    // - fallback for isolated jobs: deliver to user's last active channel
    // - default for main jobs: no delivery object
    const rawDeliveryMode = args.delivery_mode as string | undefined;
    // Treat "none" as unset when we have a channel context and isolated target,
    // so the auto-configuration below kicks in. The LLM should only set "none"
    // when the user explicitly asks to suppress delivery.
    const explicitDeliveryMode =
      rawDeliveryMode === "none" &&
      sessionTarget === "isolated" &&
      hasChannelAdapter
        ? undefined
        : rawDeliveryMode;
    // Resolve recipientId: explicit arg → channel context → userId for push
    const resolvedRecipientId =
      explicitDeliveryRecipient ??
      contextChannelChatId ??
      (deliveryChannelName === "push" ? userId : undefined);

    const delivery = explicitDeliveryMode
      ? {
          mode: explicitDeliveryMode as
            | "none"
            | "webhook"
            | "channel"
            | "announce",
          channelId:
            (args.delivery_channel as string | undefined) ??
            (explicitDeliveryMode === "channel" && hasChannelAdapter
              ? deliveryChannelName
              : undefined) ??
            (explicitDeliveryMode === "announce" ? "push" : undefined),
          recipientId:
            explicitDeliveryRecipient ??
            (explicitDeliveryMode === "channel" && hasChannelAdapter
              ? resolvedRecipientId
              : undefined),
          bestEffort: explicitDeliveryMode === "announce",
        }
      : sessionTarget === "isolated"
        ? hasChannelAdapter
          ? {
              mode: "channel" as const,
              channelId: deliveryChannelName,
              recipientId: resolvedRecipientId,
              bestEffort: false,
            }
          : {
              mode: "channel" as const,
              channelId: "last",
              recipientId: args.delivery_recipient as string | undefined,
              bestEffort: false,
            }
        : undefined;

    // Server-derived chat context proves the owner may deliver back here.
    const boundDelivery = withChannelBinding(delivery, {
      channelName: deliveryChannelName,
      channelChatId: contextChannelChatId,
    });

    // Resolve expiresAt for recurring jobs
    //   Priority: expiresAt (ISO-8601) > expires_in_days (relative days) > default (30 days)
    //   Capped at 90 days by assertValidExpiry() in store.createJob()
    let expiresAt: number | undefined;
    if (schedule.kind !== "at") {
      if (typeof args.expiresAt === "string" && args.expiresAt.trim()) {
        const parsed = new Date(args.expiresAt as string).getTime();
        if (Number.isFinite(parsed)) {
          expiresAt = parsed;
        }
      }
      if (
        expiresAt === undefined &&
        typeof args.expires_in_days === "number" &&
        args.expires_in_days > 0
      ) {
        expiresAt = Date.now() + (args.expires_in_days as number) * 86_400_000;
      }
    }
    // If still undefined, store.createJob() applies the default (30 days)

    // Resolve maxRuns for recurring jobs
    const maxRuns =
      schedule.kind !== "at" &&
      typeof args.max_runs === "number" &&
      args.max_runs > 0
        ? Math.floor(args.max_runs as number)
        : undefined;

    if (args.session_id !== undefined && !isValidSessionId(args.session_id)) {
      return JSON.stringify({ error: INVALID_SESSION_ID_MESSAGE });
    }

    // Build job create input
    const input: CronJobCreate = {
      userId,
      name,
      description: args.description as string | undefined,
      enabled: (args.enabled as boolean) ?? true,
      schedule,
      sessionTarget,
      wakeMode,
      sessionId: args.session_id,
      payload,
      delivery: boundDelivery,
      expiresAt,
      maxRuns,
    };

    const job = await this.store.createJob(input);
    await this.triggerMutationSignal();

    return JSON.stringify({
      success: true,
      job: {
        id: job.id,
        name: job.name,
        schedule: job.schedule,
        sessionTarget: job.sessionTarget,
        wakeMode: job.wakeMode,
        enabled: job.enabled,
        delivery: job.delivery
          ? {
              mode: job.delivery.mode,
              channelId: job.delivery.channelId,
              recipientId: job.delivery.recipientId ? "set" : "will-resolve-at-runtime",
            }
          : undefined,
        nextRunAt: job.state.nextRunAtMs
          ? new Date(job.state.nextRunAtMs).toISOString()
          : null,
        expiresAt: job.expiresAt
          ? new Date(job.expiresAt).toISOString()
          : null,
        maxRuns: job.maxRuns ?? null,
      },
    });
  }

  // --------------------------------------------------------------------------
  // cron_list
  // --------------------------------------------------------------------------

  private async handleList(
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    const includeDisabled =
      this.pickBooleanArg(args, ["include_disabled", "includeDisabled"]) ??
      false;
    const jobs = await this.store.listJobs(userId, includeDisabled);

    if (jobs.length === 0) {
      return JSON.stringify({
        jobs: [],
        message: "No scheduled jobs found.",
      });
    }

    const summary = jobs.map((j) => ({
      id: j.id,
      name: j.name,
      schedule: j.schedule,
      enabled: j.enabled,
      nextRunAt: j.state.nextRunAtMs
        ? new Date(j.state.nextRunAtMs).toISOString()
        : null,
      lastStatus: j.state.lastStatus ?? null,
      expiresAt: j.expiresAt
        ? new Date(j.expiresAt).toISOString()
        : null,
      maxRuns: j.maxRuns ?? null,
      runCount: j.state.runCount ?? 0,
    }));

    return JSON.stringify({ jobs: summary, count: jobs.length });
  }

  // --------------------------------------------------------------------------
  // cron_get
  // --------------------------------------------------------------------------

  private async handleGet(
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    const jobId = this.pickStringArg(args, ["job_id", "jobId", "id"]);
    if (!jobId) return JSON.stringify({ error: "job_id is required" });

    const job = await this.store.getJob(jobId, userId);
    if (!job) return JSON.stringify({ error: `Job ${jobId} not found.` });

    return JSON.stringify({
      job: {
        id: job.id,
        name: job.name,
        description: job.description,
        schedule: job.schedule,
        payload: job.payload,
        sessionTarget: job.sessionTarget,
        wakeMode: job.wakeMode,
        delivery: job.delivery,
        enabled: job.enabled,
        createdAt: new Date(job.createdAtMs).toISOString(),
        updatedAt: new Date(job.updatedAtMs).toISOString(),
        nextRunAt: job.state.nextRunAtMs
          ? new Date(job.state.nextRunAtMs).toISOString()
          : null,
        lastRunAt: job.state.lastRunAtMs
          ? new Date(job.state.lastRunAtMs).toISOString()
          : null,
        lastStatus: job.state.lastStatus ?? null,
        lastError: job.state.lastError ?? null,
        consecutiveErrors: job.state.consecutiveErrors ?? 0,
        runCount: job.state.runCount ?? 0,
        expiresAt: job.expiresAt
          ? new Date(job.expiresAt).toISOString()
          : null,
        maxRuns: job.maxRuns ?? null,
      },
    });
  }

  // --------------------------------------------------------------------------
  // cron_update
  // --------------------------------------------------------------------------

  private async handleUpdate(
    args: Record<string, unknown>,
    userId: string,
    context?: CronToolContext,
  ): Promise<string> {
    const jobId = this.pickStringArg(args, ["job_id", "jobId", "id"]);
    if (!jobId) return JSON.stringify({ error: "job_id is required" });

    const patch: CronJobPatch = {};

    if (args.name !== undefined) patch.name = args.name as string;
    if (args.description !== undefined)
      patch.description = args.description as string;
    if (args.enabled !== undefined) patch.enabled = args.enabled as boolean;
    if (args.schedule !== undefined)
      patch.schedule = args.schedule as CronJobPatch["schedule"];
    const hasSchedulePatchArgs = this.hasAnyArg(args, [
      "schedule",
      "schedule_kind",
      "at",
      "at_ms",
      "atMs",
      "everyMs",
      "every_ms",
      "expr",
      "cron_expr",
      "tz",
      "timezone",
    ]);
    if (hasSchedulePatchArgs && args.schedule === undefined) {
      const inferredSchedule = this.buildScheduleFromArgs(args, {
        allowNaturalHints: false,
      });
      if (!inferredSchedule) {
        return JSON.stringify({
          error:
            "Invalid schedule patch. Provide schedule object, or shorthand fields like at/every_ms/cron_expr.",
        });
      }
      patch.schedule = inferredSchedule;
    }
    if (args.session_target !== undefined)
      patch.sessionTarget = args.session_target as "main" | "isolated";
    if (args.wake_mode !== undefined)
      patch.wakeMode = args.wake_mode as "next-heartbeat" | "now";
    if (args.session_id !== undefined) {
      if (!isValidSessionId(args.session_id)) {
        return JSON.stringify({ error: INVALID_SESSION_ID_MESSAGE });
      }
      patch.sessionId = args.session_id;
    }

    const payloadKind = args.payload_kind as
      | "agentTurn"
      | "systemEvent"
      | undefined;
    const wantsPayloadPatch =
      payloadKind !== undefined ||
      args.message !== undefined ||
      args.text !== undefined;
    if (wantsPayloadPatch) {
      const existing = await this.store.getJob(jobId, userId);
      if (!existing)
        return JSON.stringify({ error: `Job ${jobId} not found.` });
      const effectiveKind = payloadKind ?? existing.payload.kind;
      if (effectiveKind === "systemEvent") {
        patch.payload = {
          kind: "systemEvent",
          text:
            args.text !== undefined
              ? String(args.text)
              : existing.payload.kind === "systemEvent"
                ? existing.payload.text
                : (args.message as string | undefined),
        };
      } else {
        patch.payload = {
          kind: "agentTurn",
          message:
            args.message !== undefined
              ? String(args.message)
              : existing.payload.kind === "agentTurn"
                ? existing.payload.message
                : "",

        };
      }
    }

    // Update delivery fields
    if (
      args.delivery_mode !== undefined ||
      args.delivery_channel !== undefined ||
      args.delivery_recipient !== undefined
    ) {
      const existing = await this.store.getJob(jobId, userId);
      if (!existing)
        return JSON.stringify({ error: `Job ${jobId} not found.` });

      const contextChannelName = context?.channelName?.trim().toLowerCase();
      const contextChannelChatId = context?.channelChatId?.trim();
      // Map in-app channels to "push" delivery adapter (same as handleCreate).
      const deliveryChannelName =
        contextChannelName === "web" || contextChannelName === "push"
          ? "push"
          : contextChannelName;
      const hasChannelAdapter = deliveryChannelName
        ? !!getDeliveryAdapter(deliveryChannelName)
        : false;

      const mode =
        (args.delivery_mode as
          | "none"
          | "webhook"
          | "channel"
          | "announce"
          | undefined) ??
        (existing.delivery?.mode ?? "none");

      const channelId =
        (args.delivery_channel as string | undefined) ??
        existing.delivery?.channelId ??
        (mode === "channel" && hasChannelAdapter
          ? deliveryChannelName
          : undefined);

      const recipientId =
        (args.delivery_recipient as string | undefined) ??
        existing.delivery?.recipientId ??
        (mode === "channel" && hasChannelAdapter
          ? (contextChannelChatId ?? (deliveryChannelName === "push" ? userId : undefined))
          : undefined);

      patch.delivery = {
        ...existing.delivery,
        mode,
        ...(channelId !== undefined ? { channelId } : {}),
        ...(recipientId !== undefined ? { recipientId } : {}),
      };
      patch.delivery = withChannelBinding(patch.delivery, {
        channelName: deliveryChannelName,
        channelChatId: contextChannelChatId,
      });
    }

    // Handle expiresAt / expires_in_days
    //   Priority: expiresAt (ISO-8601) > expires_in_days (relative days)
    //   Capped at 90 days by assertValidExpiry() in store.updateJob()
    if (typeof args.expiresAt === "string" && (args.expiresAt as string).trim()) {
      const parsed = new Date(args.expiresAt as string).getTime();
      if (Number.isFinite(parsed)) {
        patch.expiresAt = parsed;
      }
    } else if (
      typeof args.expires_in_days === "number" &&
      args.expires_in_days > 0
    ) {
      patch.expiresAt = Date.now() + args.expires_in_days * 86_400_000;
    }

    // Handle max_runs
    if (typeof args.max_runs === "number") {
      patch.maxRuns = args.max_runs > 0 ? Math.floor(args.max_runs as number) : undefined;
    }

    const updated = await this.store.updateJob(jobId, userId, patch);
    if (!updated) return JSON.stringify({ error: `Job ${jobId} not found.` });
    await this.triggerMutationSignal();

    return JSON.stringify({
      success: true,
      job: {
        id: updated.id,
        name: updated.name,
        schedule: updated.schedule,
        enabled: updated.enabled,
        delivery: updated.delivery
          ? {
              mode: updated.delivery.mode,
              channelId: updated.delivery.channelId,
              recipientId: updated.delivery.recipientId ? "set" : "will-resolve-at-runtime",
            }
          : undefined,
        nextRunAt: updated.state.nextRunAtMs
          ? new Date(updated.state.nextRunAtMs).toISOString()
          : null,
        expiresAt: updated.expiresAt
          ? new Date(updated.expiresAt).toISOString()
          : null,
        maxRuns: updated.maxRuns ?? null,
        runCount: updated.state.runCount ?? 0,
      },
    });
  }

  // --------------------------------------------------------------------------
  // cron_delete
  // --------------------------------------------------------------------------

  private async handleDelete(
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    const jobId = this.pickStringArg(args, ["job_id", "jobId", "id"]);
    if (!jobId) return JSON.stringify({ error: "job_id is required" });

    const ok = await this.store.deleteJob(jobId, userId);
    if (!ok) return JSON.stringify({ error: `Job ${jobId} not found.` });
    await this.triggerMutationSignal();

    return JSON.stringify({
      success: true,
      message: `Job ${jobId} deleted successfully.`,
    });
  }

  // --------------------------------------------------------------------------
  // cron_runs
  // --------------------------------------------------------------------------

  private async handleRuns(
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    const jobId = this.pickStringArg(args, ["job_id", "jobId", "id"]);
    if (!jobId) return JSON.stringify({ error: "job_id is required" });

    // Verify the job belongs to this user before returning run history
    const job = await this.store.getJob(jobId, userId);
    if (!job) return JSON.stringify({ error: `Job ${jobId} not found.` });

    const limitRaw = this.toFiniteNumber(args.limit);
    const limit = Math.min(Math.max(1, limitRaw ?? DEFAULT_QUERY_LIMIT), MAX_QUERY_LIMIT);
    const runs = await this.store.getRuns(jobId, limit);

    if (runs.length === 0) {
      return JSON.stringify({
        runs: [],
        message: "No runs found for this job.",
      });
    }

    const summary = runs.map((r) => ({
      id: r.id,
      timestamp: new Date(r.ts).toISOString(),
      status: r.status,
      error: r.error ?? null,
      summary: r.summary ?? null,
      durationMs: r.durationMs,
      model: r.model ?? null,
      delivered: r.delivered ?? false,
    }));

    return JSON.stringify({ runs: summary, count: runs.length });
  }

  private async triggerMutationSignal(): Promise<void> {
    if (!this.onMutation) {
      console.warn(
        "[cron-tools] triggerMutationSignal: no onMutation callback — scheduler will not be signaled immediately.",
      );
      return;
    }
    try {
      await this.onMutation();
    } catch (err) {
      console.warn(
        `[cron-tools] triggerMutationSignal failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Check if a tool name is a cron tool.
 */
export function isCronTool(toolName: string): boolean {
  return toolName.startsWith("cron_");
}

/**
 * AgentForEach HITL Module — Configuration
 *
 * Loads the "hitl" section from agentforeach.json.
 *
 * The configuration is entirely declarative:
 *   - `forms`           — Named form definitions (schema, layout, groups)
 *   - `tools`           — Tool-name → policy mapping (gate mode, form reference)
 *   - `customFormTypes` — Extra request_user_input types the client renders
 *
 * Built-in form types (text_input, confirmation, single_select,
 * multi_select, form) are always available. Users can define named
 * forms in config and reference them from tool policies — no code
 * changes needed to add HITL for a new MCP server.
 *
 * @see ../utils/config.ts — loadConfigSection pattern
 * @see ./types.ts — HitlFormType, HitlFormDefinition, etc.
 */

import { loadConfigSection } from "../utils/index.js";
import type {
  HitlFormType,
  HitlFormDefinition,
  HitlToolPolicyConfig,
  HitlUiHints,
} from "./types.js";

// ============================================================================
// JSON Config Shape (raw — matches agentforeach.json structure)
// ============================================================================

/**
 * Raw JSON shape for the "hitl" section in agentforeach.json.
 */
export interface HitlJsonConfig {
  enabled?: boolean;
  defaultTimeoutSeconds?: number;

  /** Named form definitions. */
  forms?: Record<string, HitlFormJsonConfig>;

  /** Tool-name → HITL policy mapping. Supports glob patterns. */
  tools?: Record<string, HitlToolJsonConfig>;

  /**
   * Client-rendered request_user_input types beyond the built-ins
   * (type name → description the model sees). See examples/hitl-forms.json.
   */
  customFormTypes?: Record<string, string>;
}

/**
 * Raw JSON for a named form definition.
 */
interface HitlFormJsonConfig {
  title?: string;
  description?: string;
  formType?: HitlFormType;
  schema?: Record<string, unknown>;
  /** UI hints — can be specified as a nested object or at the form top-level. */
  uiHints?: HitlUiHints;
  /** Top-level shorthand (merged into uiHints). */
  layout?: HitlUiHints["layout"];
  groups?: Array<{ label: string; fields: string[] }>;
  requiredFromHuman?: string[];
  hiddenFields?: string[];
  prefilledFields?: string[];
  options?: Array<{ label: string; value: string; description?: string }>;
}

/**
 * Raw JSON for a tool-to-HITL mapping.
 */
interface HitlToolJsonConfig {
  gate: "always" | "when_args_missing" | "confirm_only" | "never";
  /** Reference to a named form in `forms`. */
  form?: string;
  /** Inline form type (if no named form). */
  formType?: HitlFormType;
  /** Intent template with {argName} placeholders. */
  intent?: string;
  /** Override timeout for this tool. */
  timeoutSeconds?: number;
  /** Override schema for this tool's form. */
  schemaOverride?: Record<string, unknown>;
  /** Inline UI hints (merged with form's if both present). */
  uiHints?: HitlUiHints;
}

// ============================================================================
// Resolved Config (runtime-ready)
// ============================================================================

export interface HitlConfig {
  enabled: boolean;
  defaultTimeoutSeconds: number;
  forms: Map<string, HitlFormDefinition>;
  tools: Map<string, HitlToolPolicyConfig>;
  customFormTypes: Map<string, string>;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_TIMEOUT_SECONDS = 300;

// ============================================================================
// Config Loader
// ============================================================================

/** Allowed names for `customFormTypes`. */
const CUSTOM_FORM_TYPE_NAME = /^[a-z_]{1,40}$/;

let _hitlConfig: HitlConfig | undefined;

/**
 * Load the "hitl" section from agentforeach.json.
 * Returns a cached, resolved config singleton.
 */
export function loadHitlConfig(): HitlConfig {
  if (_hitlConfig) return _hitlConfig;

  const section = loadConfigSection<HitlJsonConfig>("hitl");
  const json = section ?? {};

  // Resolve named forms
  const forms = new Map<string, HitlFormDefinition>();
  if (json.forms) {
    for (const [name, raw] of Object.entries(json.forms)) {
      forms.set(name, resolveFormDefinition(name, raw));
    }
  }

  // Resolve tool policies
  const tools = new Map<string, HitlToolPolicyConfig>();
  if (json.tools) {
    for (const [pattern, raw] of Object.entries(json.tools)) {
      tools.set(pattern, resolveToolPolicy(pattern, raw, forms));
    }
  }

  // Custom request_user_input types: the name goes into the tool schema's
  // enum, so it must be a plain identifier; skip anything else
  const customFormTypes = new Map<string, string>();
  for (const [name, description] of Object.entries(json.customFormTypes ?? {})) {
    if (!CUSTOM_FORM_TYPE_NAME.test(name)) {
      console.warn(`[hitl] ignoring customFormTypes.${name}: names are lowercase letters and underscores, up to 40`);
      continue;
    }
    if (typeof description === "string" && description.trim()) {
      customFormTypes.set(name, description.trim());
    }
  }

  _hitlConfig = {
    enabled: json.enabled ?? false,
    defaultTimeoutSeconds: json.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    forms,
    tools,
    customFormTypes,
  };

  return _hitlConfig;
}

/**
 * Check if HITL is enabled.
 */
export function isHitlEnabled(): boolean {
  return loadHitlConfig().enabled;
}

/**
 * Reset config cache (for testing).
 */
export function resetHitlConfig(): void {
  _hitlConfig = undefined;
}

// ============================================================================
// Internal Resolvers
// ============================================================================

function resolveFormDefinition(
  name: string,
  raw: HitlFormJsonConfig,
): HitlFormDefinition {
  return {
    name,
    title: raw.title ?? name,
    description: raw.description,
    formType: raw.formType ?? "form",
    schema: raw.schema,
    uiHints: {
      ...raw.uiHints,
      // Top-level shorthands override nested uiHints
      ...(raw.layout !== undefined ? { layout: raw.layout } : {}),
      ...(raw.groups !== undefined ? { groups: raw.groups } : {}),
      ...(raw.requiredFromHuman !== undefined ? { requiredFromHuman: raw.requiredFromHuman } : {}),
      ...(raw.hiddenFields !== undefined ? { hiddenFields: raw.hiddenFields } : {}),
      ...(raw.prefilledFields !== undefined ? { prefilledFields: raw.prefilledFields } : {}),
    },
    options: raw.options,
  };
}

function resolveToolPolicy(
  pattern: string,
  raw: HitlToolJsonConfig,
  forms: Map<string, HitlFormDefinition>,
): HitlToolPolicyConfig {
  // Resolve the form: named reference takes precedence, then inline formType
  let resolvedForm: HitlFormDefinition | undefined;
  if (raw.form) {
    resolvedForm = forms.get(raw.form);
    if (!resolvedForm) {
      console.warn(
        `[hitl] Tool "${pattern}" references unknown form "${raw.form}". ` +
          `Available forms: ${[...forms.keys()].join(", ") || "(none)"}`,
      );
    }
  }

  // Determine formType: explicit on tool > from named form > default
  const formType: HitlFormType =
    raw.formType ?? resolvedForm?.formType ?? "confirmation";

  // Merge UI hints: tool-level overrides form-level
  const uiHints: HitlUiHints | undefined =
    raw.uiHints || resolvedForm?.uiHints
      ? {
          ...resolvedForm?.uiHints,
          ...raw.uiHints,
        }
      : undefined;

  return {
    toolPattern: pattern,
    gate: raw.gate,
    formType,
    formName: raw.form,
    resolvedForm,
    intentTemplate: raw.intent,
    timeoutSeconds: raw.timeoutSeconds,
    schemaOverride: raw.schemaOverride,
    uiHints,
  };
}

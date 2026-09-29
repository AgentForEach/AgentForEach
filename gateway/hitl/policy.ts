/**
 * AgentForEach HITL Module — Policy Resolution
 *
 * Config-driven policy resolution. All policies are defined in
 * agentforeach.json "hitl.tools" — no hardcoded tool-specific logic.
 *
 * The policy resolver:
 *   1. Loads tool policies from agentforeach.json via loadHitlConfig()
 *   2. Matches a tool name against exact names and glob patterns
 *   3. Determines whether to gate (always, when_args_missing, confirm_only)
 *   4. Resolves the form definition (named form or inline formType)
 *   5. Resolves the intent template with actual arg values
 *
 * @see ./config.ts — loadHitlConfig()
 * @see ./types.ts — HitlToolPolicyConfig, HitlFormDefinition
 */

import type { HitlToolPolicyConfig } from "./types.js";
import { loadHitlConfig, isHitlEnabled } from "./config.js";

// ============================================================================
// Policy Lookup
// ============================================================================

/**
 * Find the HITL policy for a given tool name.
 *
 * Matches exact names first, then falls back to glob patterns.
 * Returns undefined if:
 *   - HITL is disabled in config
 *   - No policy matches the tool name
 *   - The matched policy has gate: "never"
 */
export function getHitlPolicy(
  toolName: string,
): HitlToolPolicyConfig | undefined {
  if (!isHitlEnabled()) return undefined;

  const config = loadHitlConfig();

  // Exact match first
  const exact = config.tools.get(toolName);
  if (exact) return exact.gate === "never" ? undefined : exact;

  // Glob match (simple wildcard: "example_*" matches "example_create_party")
  for (const [pattern, policy] of config.tools) {
    if (!pattern.includes("*")) continue;
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, ".*") + "$",
    );
    if (regex.test(toolName)) {
      return policy.gate === "never" ? undefined : policy;
    }
  }

  return undefined;
}

// ============================================================================
// Gate Decision
// ============================================================================

/**
 * Determine whether a tool call should be gated for human input.
 *
 * @param policy - The matched HITL policy.
 * @param proposedArgs - The LLM's proposed arguments.
 * @param toolSchema - The tool's JSON Schema (from MCP listTools).
 * @returns Whether to gate this call for human input.
 */
export function shouldGate(
  policy: HitlToolPolicyConfig,
  proposedArgs: Record<string, unknown>,
  toolSchema?: Record<string, unknown>,
): boolean {
  switch (policy.gate) {
    case "never":
      return false;
    case "always":
    case "confirm_only":
      return true;
    case "when_args_missing": {
      if (!toolSchema) return true; // No schema → can't verify → gate
      const required = (toolSchema.required ?? []) as string[];
      const missing = required.filter(
        (field) =>
          proposedArgs[field] === undefined ||
          proposedArgs[field] === null ||
          proposedArgs[field] === "",
      );
      return missing.length > 0;
    }
    default:
      return false;
  }
}

// ============================================================================
// Intent Resolution
// ============================================================================

/**
 * Resolve the intent template with actual arg values.
 * Replaces {argName} placeholders with the corresponding proposed arg.
 */
export function resolveIntent(
  policy: HitlToolPolicyConfig,
  proposedArgs: Record<string, unknown>,
): string {
  const template =
    policy.intentTemplate ?? `Provide input for ${policy.toolPattern}`;
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const val = proposedArgs[key];
    return val !== undefined && val !== null ? String(val) : `{${key}}`;
  });
}

// ============================================================================
// Schema Resolution
// ============================================================================

/**
 * Resolve the JSON Schema for the form.
 *
 * Priority: tool's schemaOverride > named form's schema > MCP tool's inputSchema > empty
 */
export function resolveSchema(
  policy: HitlToolPolicyConfig,
  mcpToolSchema?: Record<string, unknown>,
): Record<string, unknown> {
  return (
    policy.schemaOverride ??
    policy.resolvedForm?.schema ??
    mcpToolSchema ??
    { type: "object", properties: {} }
  );
}

/**
 * Resolve the options list for single_select / multi_select forms.
 *
 * Priority: named form's options > LLM's proposedArgs.options > empty
 */
export function resolveOptions(
  policy: HitlToolPolicyConfig,
  proposedArgs: Record<string, unknown>,
): Array<{ label: string; value: string; description?: string }> | undefined {
  if (policy.resolvedForm?.options?.length) {
    return policy.resolvedForm.options;
  }
  // Fall back to LLM-provided options in args
  const argsOptions = proposedArgs.options;
  if (Array.isArray(argsOptions) && argsOptions.length > 0) {
    return argsOptions.map((opt: any) => ({
      label: String(opt.label ?? opt.name ?? opt.value ?? opt),
      value: String(opt.value ?? opt.id ?? opt),
      ...(opt.description ? { description: String(opt.description) } : {}),
    }));
  }
  return undefined;
}

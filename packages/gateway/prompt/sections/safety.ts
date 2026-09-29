/**
 * Prompt Section — Safety & Gateway
 *
 * Builds the "## Safety" and "## AgentForEach Gateway Quick Reference" sections.
 * Contains guardrails and runtime environment context.
 *
 * All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type { SafetyTextConfig, GatewayTextConfig } from "../prompt-config.js";
import { loadPromptTextConfig } from "../prompt-config.js";

/**
 * Build the "## Safety" section with agent guardrails.
 */
export function buildSafetySection(cfg?: SafetyTextConfig): string[] {
  const c = cfg ?? loadPromptTextConfig().safety;
  return [c.header, ...c.rules, ""];
}

/** The rules that apply on [channel] — unscoped rules apply everywhere. */
function rulesForChannel(
  rules: readonly (string | { channels: string[]; rule: string })[] | undefined,
  channel: string | undefined,
): string[] {
  const out: string[] = [];
  for (const entry of rules ?? []) {
    if (typeof entry === "string") {
      out.push(entry);
    } else if (!channel || entry.channels.includes(channel)) {
      // No channel on the request (the app/websocket path) serves every
      // rule — the app is the widest surface and the historical default.
      out.push(entry.rule);
    }
  }
  return out;
}

/**
 * Which phase the previous run's tool calls place the conversation in.
 * Declaration order is precedence (last intersecting phase wins); no
 * intersection — a fresh conversation — lands on the FIRST declared phase.
 */
export function deriveGatewayPhase(
  cfg: GatewayTextConfig,
  seenTools: readonly string[] | undefined,
): string | undefined {
  const phases = cfg.phases;
  if (!phases) return undefined;
  const names = Object.keys(phases);
  if (names.length === 0) return undefined;
  let current = names[0];
  if (seenTools?.length) {
    const seen = new Set(seenTools);
    for (const name of names) {
      if (phases[name].enterOn.some((tool) => seen.has(tool))) current = name;
    }
  }
  return current;
}

/**
 * Build the "## AgentForEach Gateway Quick Reference" section.
 *
 * Flat configs emit every rule (the historical behaviour and the
 * kill-switch). Phase-scoped configs emit `always` plus the ONE phase the
 * previous run's tool calls put the conversation in — and in both forms a
 * rule may be channel-scoped, because guidance about widgets a channel
 * cannot render is contradiction, not caution.
 */
export function buildGatewayReferenceSection(
  cfg?: GatewayTextConfig,
  options?: { seenTools?: readonly string[]; channel?: string },
): string[] {
  const c = cfg ?? loadPromptTextConfig().gateway;
  if (!c.phases) {
    return [c.header, ...rulesForChannel(c.rules, options?.channel), ""];
  }
  const phase = deriveGatewayPhase(c, options?.seenTools);
  const phaseRules = phase ? (c.phases[phase]?.rules ?? []) : [];
  // Observability while phase-scoping beds in: which rulebook each turn got.
  console.log(
    `[prompt] gateway_phase=${phase ?? "(none)"} channel=${options?.channel ?? "app"} seenTools=${options?.seenTools?.length ?? 0}`,
  );
  return [
    c.header,
    ...rulesForChannel(c.always, options?.channel),
    ...rulesForChannel(phaseRules, options?.channel),
    "",
  ];
}

/**
 * Prompt Section — Skills
 *
 * Builds the "## Skills" section. All text is driven by
 * PromptTextConfig (loaded from agentforeach.json).
 */

import type { SkillStatus } from "../../skills/types.js";
import type { SkillsTextConfig } from "../prompt-config.js";
import { loadPromptTextConfig } from "../prompt-config.js";

/**
 * Build the "## Skills" section for the system prompt.
 */
export function buildSkillsSection(params: {
  isMinimal: boolean;
  skillStatuses?: SkillStatus[];
  cfg?: SkillsTextConfig;
}): string[] {
  if (params.isMinimal) return [];
  if (!params.skillStatuses?.length) return [];

  const ready = params.skillStatuses.filter(
    (s) => s.enabled && s.credentialsComplete,
  );
  const needsSetup = params.skillStatuses.filter(
    (s) => !s.enabled || !s.credentialsComplete,
  );

  if (ready.length === 0 && needsSetup.length === 0) return [];

  const cfg = params.cfg ?? loadPromptTextConfig().skills;
  const lines: string[] = [cfg.header, ""];

  // Instructions for the agent
  lines.push(
    ...cfg.intro,
    "",
    cfg.toolGuideHeader,
    ...cfg.toolGuide.map((g) => `- ${g}`),
    "",
    cfg.credentialHeader,
    ...cfg.credentialNote,
    "",
    cfg.translatingHeader,
    cfg.translatingIntro,
    cfg.translatingNote,
    ...cfg.translatingRules.map((r) => `- ${r}`),
    cfg.translatingFallback,
    "",
  );

  if (ready.length > 0) {
    lines.push("<available_skills>");
    for (const s of ready) {
      lines.push(
        `${s.manifest.id}: ${s.manifest.description} [${s.manifest.blobPath}]`,
      );
    }
    lines.push("</available_skills>", "");
  }

  if (needsSetup.length > 0) {
    lines.push(cfg.needsSetupHeader);
    for (const s of needsSetup) {
      const reason =
        !s.configured && !s.enabled
          ? "not configured"
          : !s.enabled
            ? "disabled"
            : "missing credentials";
      lines.push(
        `- **${s.manifest.name}** (\`${s.manifest.id}\`): ${s.manifest.description} (${reason})`,
      );
    }
    lines.push("", cfg.needsSetupFooter, "");
  }

  return lines;
}

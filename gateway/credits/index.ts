/**
 * AgentForEach Credits Module — Barrel Export
 *
 * Token-proportional credit gating for AI usage.
 * Configure via agentforeach.json "credits" section.
 */

export { loadCreditsConfig, resetCreditsConfig } from "./config.js";
export { HttpCreditProvider } from "./provider.js";
export {
	registerCreditsHooks,
	checkCreditsBalance,
	releaseReservationOnThrow,
	reserveCredits,
	runMetered,
	computeCoins,
} from "./hooks.js";
export type { CreditsConfig, CreditProvider } from "./types.js";

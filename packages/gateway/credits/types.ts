/**
 * AgentForEach Credits Module — Types
 *
 * Generic credit/coin gating for AI usage. Configured via agentforeach.json
 * "credits" section. Supports token-proportional billing where each
 * coin represents a fixed USD cost unit (e.g. 1 coin = $0.01).
 */

// ============================================================================
// Configuration
// ============================================================================

export interface CreditsConfig {
  /** Master switch. When false the entire credit system is bypassed. */
  enabled: boolean;

  /** GET endpoint that returns `{ balance: number }` for a user. */
  balanceUrl: string;

  /** POST endpoint that accepts `{ amount: number, currencyCode: string }`. */
  consumeUrl: string;

  /** POST endpoint that reserves the user's available balance for one run. */
  reserveUrl: string;

  /** POST endpoint that settles a reservation against actual run cost. */
  settleUrl: string;

  /** Virtual currency code (e.g. "CRD"). */
  currencyCode: string;

  /**
   * Multiplier applied to `estimatedCostUsd` to get coin amount.
   * Default 100 → 1 coin = $0.01.
   */
  costMultiplier: number;

  /** Minimum coins deducted per run (floor). Default 1. */
  minimumCharge: number;

  /** Shared secret for service-to-service auth. */
  serviceKey: string;

  /** When true, reject sends if balance < minimumCharge. Default true. */
  preFlightCheck: boolean;
}

// ============================================================================
// Provider interface
// ============================================================================

export interface CreditProvider {
  /** Get the current balance for a user. Returns null on failure (fail-open). */
  getBalance(userId: string): Promise<number | null>;

  reserve(userId: string, runId: string): Promise<CreditReservation>;
  settle(userId: string, runId: string, charge: number): Promise<CreditSettlement>;
}

export interface CreditReservation {
  runId: string;
  reserved: number;
  balance: number;
}

export interface CreditSettlement {
  runId: string;
  reserved: number;
  charged: number;
  refunded: number;
  shortfall: number;
  balance: number;
  status: string;
}

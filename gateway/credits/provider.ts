/**
 * AgentForEach Credits Module — HTTP Credit Provider
 *
 * Calls an external REST API to check balance and consume credits.
 * Used by the credits hooks to gate AI usage on coin balance.
 */

import type {
  CreditReservation,
  CreditSettlement,
  CreditsConfig,
  CreditProvider,
} from "./types.js";

export class HttpCreditProvider implements CreditProvider {
  constructor(private readonly config: CreditsConfig) {}

  async getBalance(userId: string): Promise<number | null> {
    try {
      const url = parseHttpUrl(this.config.balanceUrl, "balance");
      if (!url) return null;
      url.searchParams.set("currencyCode", this.config.currencyCode);

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: this.headers(userId),
      });

      if (!res.ok) {
        console.warn(
          `[credits] Balance check failed: ${res.status} ${res.statusText}`,
        );
        return null;
      }

      const body = (await res.json()) as { balance?: number };
      return body.balance ?? null;
    } catch (err) {
      console.warn(
        "[credits] Balance check error:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  async reserve(userId: string, runId: string): Promise<CreditReservation> {
    return this.post<CreditReservation>(
      this.config.reserveUrl,
      "reserve",
      userId,
      { runId },
    );
  }

  async settle(
    userId: string,
    runId: string,
    charge: number,
  ): Promise<CreditSettlement> {
    return this.post<CreditSettlement>(
      this.config.settleUrl,
      "settle",
      userId,
      { runId, charge },
    );
  }

  private async post<T>(
    rawUrl: string,
    label: string,
    userId: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = parseHttpUrl(rawUrl, label);
    if (!url) throw creditError("CREDITS_UNAVAILABLE", `${label} URL is unavailable`);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "POST",
        headers: { ...this.headers(userId), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw creditError(
        "CREDITS_UNAVAILABLE",
        `${label} request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    if (!response.ok) {
      throw creditError(
        payload.error ?? (response.status === 402 ? "INSUFFICIENT_CREDITS" : "CREDITS_UNAVAILABLE"),
        payload.message ?? `${label} failed with HTTP ${response.status}`,
      );
    }
    return payload as T;
  }

  private headers(userId: string): Record<string, string> {
    return {
      "X-Service-Key": this.config.serviceKey,
      "X-User-Id": userId,
    };
  }
}

function creditError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function parseHttpUrl(value: string, label: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url;
  } catch {
    // Fall through to one consistent warning below.
  }

  console.warn(`[credits] ${label} URL is missing or invalid; skipping request.`);
  return null;
}

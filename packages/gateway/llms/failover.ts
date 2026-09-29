/**
 * AgentForEach Provider Layer — Failover Engine
 *
 * Wraps LLM provider calls with automatic retry and fallback logic.
 * When the primary provider returns a retryable error (429, 500, 502, 503)
 * or a network error, the engine tries the next provider in the chain.
 *
 * Cooldown tracking prevents hammering a failing provider. State is
 * per-instance (module-level Map), which resets on Azure Functions cold
 * start — acceptable for personal assistant scale.
 *
 * Inspired by OpenClaw's auth-profiles + model-fallback system, but
 * simplified for serverless: no probe-based health checking, no
 * round-robin key rotation.
 */

import type { Provider, ProviderId, ProviderRequest, ProviderResponse, StreamEvent } from "./types.js";

// ============================================================================
// Configuration
// ============================================================================

export interface FailoverConfig {
  /** Enable the failover engine. Default: false. */
  enabled: boolean;
  /** HTTP status codes that trigger failover. Default: [429, 500, 502, 503]. */
  retryableStatusCodes: number[];
  /** Max retry attempts across the provider chain. Default: 2. */
  maxRetries: number;
  /** Cooldown period in ms — skip a provider that failed within this window. Default: 60000. */
  cooldownMs: number;
  /** Ordered provider chain. First = primary. Default: []. */
  chain: ProviderId[];
}

export const DEFAULT_FAILOVER_CONFIG: FailoverConfig = {
  enabled: false,
  retryableStatusCodes: [429, 500, 502, 503],
  maxRetries: 2,
  cooldownMs: 60_000,
  chain: [],
};

// ============================================================================
// Cooldown Tracking
// ============================================================================

/**
 * Module-level cooldown state: providerId → timestamp when cooldown expires.
 * Resets on cold start (acceptable for serverless).
 */
const providerCooldowns = new Map<string, number>();

/** Check whether a provider is currently in cooldown. */
function isInCooldown(providerId: string): boolean {
  const expiresAt = providerCooldowns.get(providerId);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) {
    providerCooldowns.delete(providerId);
    return false;
  }
  return true;
}

/** Put a provider into cooldown. */
function setCooldown(providerId: string, cooldownMs: number): void {
  providerCooldowns.set(providerId, Date.now() + cooldownMs);
}

/** Clear all cooldowns (for testing). */
export function resetCooldowns(): void {
  providerCooldowns.clear();
}

// ============================================================================
// Error Classification
// ============================================================================

/** Network-level error codes that warrant retry. */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const RETRYABLE_ERROR_NAMES = new Set([
  "APIConnectionTimeoutError",
  "TimeoutError",
]);

/**
 * Determine if an error is retryable.
 *
 * Checks:
 *   1. HTTP status code (from OpenAI/Anthropic SDK `APIError.status`)
 *   2. Network error codes (ECONNREFUSED, ETIMEDOUT, etc.)
 *   3. Explicit "rate_limit" or "overloaded" error types
 */
export function isRetryableError(
  error: unknown,
  retryableStatusCodes: number[],
): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as Record<string, unknown>;

  // Check HTTP status code (OpenAI APIError, Anthropic APIError)
  if (typeof err.status === "number") {
    if (retryableStatusCodes.includes(err.status)) return true;
  }

  // Check for network errors
  if (typeof err.code === "string") {
    if (RETRYABLE_NETWORK_CODES.has(err.code)) return true;
  }

  // SDK-level timeout errors often surface via name rather than code/status.
  if (typeof err.name === "string") {
    if (RETRYABLE_ERROR_NAMES.has(err.name)) return true;
  }

  // Check cause chain for network errors
  if (err.cause && typeof err.cause === "object") {
    const cause = err.cause as Record<string, unknown>;
    if (typeof cause.code === "string" && RETRYABLE_NETWORK_CODES.has(cause.code)) {
      return true;
    }
  }

  // Check error type/message patterns
  const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
  if (
    message.includes("rate_limit") ||
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("overloaded") ||
    message.includes("capacity") ||
    message.includes("service_unavailable") ||
    message.includes("server_error")
  ) {
    return true;
  }

  return false;
}

/**
 * Extract a human-readable reason from an error for the fallback event.
 */
function extractErrorReason(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown error";
  const err = error as Record<string, unknown>;

  if (typeof err.status === "number" && typeof err.message === "string") {
    return `HTTP ${err.status}: ${err.message.slice(0, 100)}`;
  }
  if (typeof err.code === "string") {
    return `Network error: ${err.code}`;
  }
  if (typeof err.message === "string") {
    return err.message.slice(0, 100);
  }
  return "unknown error";
}

// ============================================================================
// Failover Execution — Non-Streaming
// ============================================================================

export interface FailoverResult<T> {
  result: T;
  /** Provider that actually produced the result. */
  providerId: ProviderId;
  /** Providers that were tried and failed, in order. */
  failedProviders: Array<{ providerId: ProviderId; reason: string }>;
}

/**
 * Execute a non-streaming provider call with failover.
 *
 * Tries the primary provider first, then each fallback in order.
 * Skips providers in cooldown.
 */
export async function withFailover(
  primaryProviderId: ProviderId,
  config: FailoverConfig,
  resolveProvider: (id: ProviderId) => Provider,
  resolveDefaultModel: (id: ProviderId) => string,
  request: ProviderRequest,
): Promise<FailoverResult<ProviderResponse>> {
  if (!config.enabled || config.chain.length === 0) {
    // Failover disabled — just call the primary provider directly
    const provider = resolveProvider(primaryProviderId);
    const result = await provider.createResponse(request);
    return { result, providerId: primaryProviderId, failedProviders: [] };
  }

  // Build ordered candidate list: primary first, then chain order (skip primary if already first)
  const candidates = buildCandidateList(primaryProviderId, config.chain);
  const failedProviders: Array<{ providerId: ProviderId; reason: string }> = [];
  let attempts = 0;

  for (const candidateId of candidates) {
    if (attempts >= config.maxRetries + 1) break;

    if (isInCooldown(candidateId)) continue;

    try {
      const provider = resolveProvider(candidateId);
      const adjustedRequest = adjustRequestForProvider(request, candidateId, primaryProviderId, resolveDefaultModel);
      const result = await provider.createResponse(adjustedRequest);
      return { result, providerId: candidateId, failedProviders };
    } catch (err) {
      attempts++;
      const reason = extractErrorReason(err);
      const statusCode = (err as any)?.status ?? (err as any)?.statusCode ?? "n/a";

      if (isRetryableError(err, config.retryableStatusCodes)) {
        console.warn(
          `[failover] provider=${candidateId} failed (attempt ${attempts}/${config.maxRetries + 1}), ` +
            `status=${statusCode}, reason=${reason} — will retry next candidate`,
        );
        setCooldown(candidateId, config.cooldownMs);
        failedProviders.push({ providerId: candidateId, reason });
        continue;
      }

      // Non-retryable error — don't try other providers, just throw
      console.error(
        `[failover] provider=${candidateId} non-retryable error: status=${statusCode}, reason=${reason}`,
        err,
      );
      throw err;
    }
  }

  // All providers exhausted
  const lastFailure = failedProviders[failedProviders.length - 1];
  const exhaustedMsg = `All providers in failover chain exhausted. Last failure: ${lastFailure?.providerId ?? primaryProviderId} — ${lastFailure?.reason ?? "unknown"}`;
  console.error(`[failover] ${exhaustedMsg}`);
  throw new Error(exhaustedMsg);
}

// ============================================================================
// Failover Execution — Streaming
// ============================================================================

/**
 * Execute a streaming provider call with failover.
 *
 * Returns an async iterable that transparently retries with fallback
 * providers on retryable errors. The consumer sees a seamless stream.
 *
 * Note: if a provider fails mid-stream (after some events were already
 * yielded), the failover does NOT restart from the beginning — the
 * error is propagated. Failover only covers initial connection failures.
 */
export async function* withFailoverStream(
  primaryProviderId: ProviderId,
  config: FailoverConfig,
  resolveProvider: (id: ProviderId) => Provider,
  resolveDefaultModel: (id: ProviderId) => string,
  request: ProviderRequest,
  onFallback?: (from: ProviderId, to: ProviderId, reason: string) => void,
): AsyncIterable<StreamEvent> {
  if (!config.enabled || config.chain.length === 0) {
    const provider = resolveProvider(primaryProviderId);
    yield* provider.streamResponse(request);
    return;
  }

  const candidates = buildCandidateList(primaryProviderId, config.chain);
  const failedProviders: Array<{ providerId: ProviderId; reason: string }> = [];
  let attempts = 0;

  for (const candidateId of candidates) {
    if (attempts >= config.maxRetries + 1) break;

    if (isInCooldown(candidateId)) continue;

    try {
      const provider = resolveProvider(candidateId);
      const adjustedRequest = adjustRequestForProvider(request, candidateId, primaryProviderId, resolveDefaultModel);

      // Report fallback if this isn't the first attempt
      if (failedProviders.length > 0) {
        const lastFailed = failedProviders[failedProviders.length - 1]!;
        onFallback?.(lastFailed.providerId, candidateId, lastFailed.reason);
      }

      let yieldedProviderEvents = false;
      for await (const event of provider.streamResponse(adjustedRequest)) {
        if (
          event.type === "error" &&
          !yieldedProviderEvents &&
          isRetryableError(event.error, config.retryableStatusCodes)
        ) {
          throw event.error;
        }

        yieldedProviderEvents = true;
        yield event;
      }
      return; // Success — stream completed
    } catch (err) {
      attempts++;
      const reason = extractErrorReason(err);
      const statusCode = (err as any)?.status ?? (err as any)?.statusCode ?? "n/a";

      if (isRetryableError(err, config.retryableStatusCodes)) {
        console.warn(
          `[failover:stream] provider=${candidateId} failed (attempt ${attempts}/${config.maxRetries + 1}), ` +
            `status=${statusCode}, reason=${reason} — will retry next candidate`,
        );
        setCooldown(candidateId, config.cooldownMs);
        failedProviders.push({ providerId: candidateId, reason });
        continue;
      }

      console.error(
        `[failover:stream] provider=${candidateId} non-retryable error: status=${statusCode}, reason=${reason}`,
        err,
      );
      throw err;
    }
  }

  const lastFailure = failedProviders[failedProviders.length - 1];
  const exhaustedMsg = `All providers in failover chain exhausted (stream). Last failure: ${lastFailure?.providerId ?? primaryProviderId} — ${lastFailure?.reason ?? "unknown"}`;
  console.error(`[failover:stream] ${exhaustedMsg}`);
  throw new Error(exhaustedMsg);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build the ordered candidate list: primary first, then chain members.
 * Deduplicates — if primary is already in the chain, don't repeat it.
 */
function buildCandidateList(primaryId: ProviderId, chain: ProviderId[]): ProviderId[] {
  const seen = new Set<string>();
  const result: ProviderId[] = [];

  // Primary first
  result.push(primaryId);
  seen.add(primaryId);

  // Then chain order
  for (const id of chain) {
    if (!seen.has(id)) {
      result.push(id);
      seen.add(id);
    }
  }

  return result;
}

/**
 * Adjust a provider request when falling back to a different provider.
 *
 * When switching from OpenAI to Anthropic (or vice versa), the model ID
 * won't be valid. Remap to the fallback provider's default model.
 */
function adjustRequestForProvider(
  request: ProviderRequest,
  targetProviderId: ProviderId,
  originalProviderId: ProviderId,
  resolveDefaultModel: (id: ProviderId) => string,
): ProviderRequest {
  if (targetProviderId === originalProviderId) return request;

  // The original model won't exist on the fallback provider — use its default
  return {
    ...request,
    model: resolveDefaultModel(targetProviderId),
  };
}

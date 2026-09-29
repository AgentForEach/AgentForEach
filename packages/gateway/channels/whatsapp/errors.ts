/**
 * AgentForEach Channels — WhatsApp Error Taxonomy And Backoff
 *
 * The Cloud API returns a numeric `error.code` that says whether waiting will
 * help. Getting this split wrong is expensive in both directions: retrying a
 * terminal error burns quota against a wall, and giving up on a throughput
 * error drops messages that would have gone through a second later.
 *
 * Codes from Meta's error reference:
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */

/** Cloud API error codes worth naming. */
export const WhatsAppErrorCode = {
  /** Throughput limit for this phone number exceeded. */
  RATE_LIMIT: 130429,
  /** (Business, Consumer) pair rate limit — too many messages to one user. */
  PAIR_RATE_LIMIT: 131056,
  /** Media upload/fetch rate limited. Usually the forward-proxy path. */
  MEDIA_RATE_LIMIT: 131053,
  /**
   * Media could not be downloaded — including a media_id whose 30-day
   * retention has lapsed. Terminal for a blind retry, but recoverable by
   * re-uploading the bytes. See media.ts.
   */
  MEDIA_DOWNLOAD_ERROR: 131052,
  /** Invalid parameter. A media_id we no longer own arrives as this too. */
  INVALID_PARAM: 100,
  /** Re-engagement required: the 24-hour service window has closed. */
  REENGAGEMENT_REQUIRED: 131047,
  /** Message undeliverable. Meta deliberately does not always say why. */
  UNDELIVERABLE: 131026,
  /**
   * Not delivered because the user opted out of marketing messages through
   * WhatsApp's own interface. Terminal — and a consent signal: events.ts
   * records the opt-out when this arrives on a status callback, so the next
   * send is refused locally instead of bounced remotely.
   */
  MARKETING_OPT_OUT: 131050,
  /** Generic transient API error. */
  API_UNKNOWN: 2,
  /** Application request limit reached. */
  APP_RATE_LIMIT: 4,
} as const;

/**
 * Errors where waiting and trying again is the correct response.
 *
 * Everything else is terminal by default. That direction of bias is
 * deliberate: an unknown code that we retry forever is a silent quota burn,
 * while an unknown code we surface is a log line someone can act on.
 */
const RETRYABLE = new Set<number>([
  WhatsAppErrorCode.RATE_LIMIT,
  WhatsAppErrorCode.PAIR_RATE_LIMIT,
  WhatsAppErrorCode.MEDIA_RATE_LIMIT,
  WhatsAppErrorCode.API_UNKNOWN,
  WhatsAppErrorCode.APP_RATE_LIMIT,
]);

/** Classification of a failed Cloud API call. */
export interface WhatsAppFailure {
  code?: number;
  /** HTTP status, when the failure was transport-level rather than API-level. */
  httpStatus?: number;
  message: string;
  retryable: boolean;
  /** True when the failure means "the 24-hour window has closed". */
  windowClosed: boolean;
}

/**
 * Classify a Cloud API error body (or a transport failure) into a decision.
 */
export function classifyError(
  code: number | undefined,
  message: string,
  httpStatus?: number,
): WhatsAppFailure {
  const windowClosed = code === WhatsAppErrorCode.REENGAGEMENT_REQUIRED;

  // 5xx and 429 without a usable body: treat as transient.
  const transportRetryable =
    code === undefined &&
    httpStatus !== undefined &&
    (httpStatus === 429 || httpStatus >= 500);

  return {
    code,
    httpStatus,
    message,
    retryable:
      !windowClosed && (transportRetryable || (code !== undefined && RETRYABLE.has(code))),
    windowClosed,
  };
}

// ============================================================================
// Backoff
// ============================================================================

/** Backoff schedule: 1s doubling to a 60s cap, with jitter. */
export interface BackoffOptions {
  /** Total attempts including the first. Default 4. */
  attempts?: number;
  baseMs?: number;
  capMs?: number;
}

const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  attempts: 4,
  baseMs: 1_000,
  capMs: 60_000,
};

/**
 * Delay before attempt `n` (1-indexed), with full jitter.
 *
 * Jitter matters more than it looks: without it, every message queued behind a
 * throughput error retries in lockstep and reproduces the burst that caused it.
 */
export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions = {},
): number {
  const { baseMs, capMs } = { ...DEFAULT_BACKOFF, ...options };
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exponential);
}

/**
 * Run `fn` with retry on retryable failures.
 *
 * `fn` resolves with either a success value or a classified failure; it never
 * throws for API-level errors, so the caller keeps one shape to handle.
 */
export async function withRetry<T>(
  fn: () => Promise<{ ok: true; value: T } | { ok: false; failure: WhatsAppFailure }>,
  options: BackoffOptions = {},
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<{ ok: true; value: T } | { ok: false; failure: WhatsAppFailure }> {
  const { attempts } = { ...DEFAULT_BACKOFF, ...options };

  let last: { ok: false; failure: WhatsAppFailure } | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await fn();
    if (result.ok) return result;

    last = result;
    if (!result.failure.retryable) return result;
    if (attempt === attempts) break;

    await sleep(backoffDelayMs(attempt, options));
  }

  return last!;
}

/**
 * Whether a failure means "the media handle is no longer good".
 *
 * Uploaded media is retained for 30 days. A cached id past that lapses into
 * 131052, and re-sending the same id will fail forever — so this is the one
 * failure worth answering by re-uploading rather than by waiting.
 */
export function isStaleMediaError(failure: WhatsAppFailure): boolean {
  return (
    failure.code === WhatsAppErrorCode.MEDIA_DOWNLOAD_ERROR ||
    failure.code === WhatsAppErrorCode.INVALID_PARAM
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * AgentForEach Gateway — User Message Timestamp Injection
 *
 * OpenClaw-style timestamp prefixing for inbound user messages.
 * This gives the model reliable "current time" context without adding
 * dynamic time into the system prompt (which is cache-sensitive).
 */

const CRON_TIME_PATTERN = /Current time:\s/;
const TIMESTAMP_ENVELOPE_PATTERN = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

type TimestampInjectionOptions = {
  timezone?: string;
  now?: Date;
};

function resolveTimezone(timezone?: string): string {
  const candidate = typeof timezone === "string" ? timezone.trim() : "";
  if (!candidate) return "UTC";
  try {
    // Validate IANA timezone.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

function formatYmdHm(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const year = byType.get("year") ?? "0000";
  const month = byType.get("month") ?? "01";
  const day = byType.get("day") ?? "01";
  const hour = byType.get("hour") ?? "00";
  const minute = byType.get("minute") ?? "00";
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function formatTzShort(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(now);
  const tz = parts.find((part) => part.type === "timeZoneName")?.value?.trim();
  return tz || timeZone;
}

export function injectTimestamp(
  message: string,
  opts?: TimestampInjectionOptions,
): string {
  if (!message.trim()) {
    return message;
  }
  if (TIMESTAMP_ENVELOPE_PATTERN.test(message)) {
    return message;
  }
  if (CRON_TIME_PATTERN.test(message)) {
    return message;
  }

  const now = opts?.now ?? new Date();
  const timeZone = resolveTimezone(opts?.timezone);
  const dow = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(now);
  const ymdHm = formatYmdHm(now, timeZone);
  const tzShort = formatTzShort(now, timeZone);

  return `[${dow} ${ymdHm} ${tzShort}] ${message}`;
}

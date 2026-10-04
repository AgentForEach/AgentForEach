/**
 * Schedules as Cloudflare cron triggers.
 *
 * The gateway writes schedules as Azure does, six fields with seconds first
 * (`sec min hour day month weekday`). Cloudflare's cron triggers have five
 * fields and fire on whole minutes, so a schedule converts only if its
 * seconds field is 0. A numeric weekday is refused rather than guessed,
 * because the two count days differently; day names (MON-FRI) carry over.
 */

import type { ScheduleDef } from "@agentforeach/platform";

/** The five-field Cloudflare cron for a six-field schedule; throws when there is no exact equivalent. */
export function toCloudflareCron(schedule: string): string {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 6) {
    throw new Error(`Schedule "${schedule}" must have six fields (sec min hour day month weekday).`);
  }
  const [seconds, ...rest] = fields;
  if (seconds !== "0") {
    throw new Error(`Schedule "${schedule}" runs at second ${seconds}; Cloudflare cron triggers fire on whole minutes.`);
  }
  if (/\d/.test(rest[4])) {
    throw new Error(`Schedule "${schedule}" names weekdays by number; use day names (MON-FRI) so the meaning carries over.`);
  }
  return rest.join(" ");
}

/** The distinct cron triggers a set of schedules needs (wrangler.jsonc `triggers.crons`), in order. */
export function cronTriggers(schedules: readonly Pick<ScheduleDef, "schedule">[]): string[] {
  return [...new Set(schedules.map((s) => toCloudflareCron(s.schedule)))];
}

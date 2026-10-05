/**
 * Schedules as Cloudflare cron triggers.
 *
 * The gateway writes schedules as Azure does, six fields with seconds first
 * (`sec min hour day month weekday`). Cloudflare's cron triggers have five
 * fields and fire on whole minutes; the conversion, and what it refuses, is
 * shared with every whole-minute host (`minuteCron` in @agentforeach/platform).
 */

import { minuteCron, type ScheduleDef } from "@agentforeach/platform";

/** The five-field Cloudflare cron for a six-field schedule; throws when there is no exact equivalent. */
export function toCloudflareCron(schedule: string): string {
  return minuteCron(schedule, "Cloudflare cron triggers");
}

/** The distinct cron triggers a set of schedules needs (wrangler.jsonc `triggers.crons`), in order. */
export function cronTriggers(schedules: readonly Pick<ScheduleDef, "schedule">[]): string[] {
  return [...new Set(schedules.map((s) => toCloudflareCron(s.schedule)))];
}

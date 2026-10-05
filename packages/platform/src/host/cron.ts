/**
 * Schedules on hosts that fire on whole minutes: Cloudflare cron triggers,
 * and an EventBridge Scheduler tick every minute on AWS.
 *
 * The gateway writes schedules as Azure does, six fields with seconds first
 * (`sec min hour day month weekday`). On a whole-minute host a schedule
 * carries over only if its seconds field is 0. A numeric weekday is refused
 * rather than guessed, because cron dialects count days differently; day
 * names (MON-FRI) carry over.
 *
 * Cloudflare matches the remaining five fields itself (`minuteCron`). A host
 * that is woken every minute asks `cronMatcher` whether a schedule is due at
 * that minute, in UTC as on Azure and Cloudflare.
 */

import type { ScheduleDef } from "../host.js";

/**
 * The five whole-minute fields (`min hour day month weekday`) of a six-field
 * schedule; throws when there is no exact equivalent. `firedBy` names what
 * fires it, for the message ("Cloudflare cron triggers").
 */
export function minuteCron(schedule: string, firedBy: string): string {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 6) {
    throw new Error(`Schedule "${schedule}" must have six fields (sec min hour day month weekday).`);
  }
  const [seconds, ...rest] = fields;
  if (seconds !== "0") {
    throw new Error(`Schedule "${schedule}" runs at second ${seconds}; ${firedBy} fire on whole minutes.`);
  }
  if (/\d/.test(rest[4])) {
    throw new Error(`Schedule "${schedule}" names weekdays by number; use day names (MON-FRI) so the meaning carries over.`);
  }
  return rest.join(" ");
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  /** Names for the values from `min` up (months, weekdays). */
  names?: readonly string[];
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "weekday", min: 0, max: 6, names: WEEKDAYS },
];

/** The values one field allows: `*`, `a`, `a-b`, each optionally `/step`, comma-separated. */
function fieldValues(field: string, spec: FieldSpec, schedule: string): Set<number> {
  const fail = (why: string): never => {
    throw new Error(`Schedule "${schedule}": ${spec.name} field "${field}" ${why}.`);
  };
  const value = (text: string): number => {
    const named = spec.names?.indexOf(text.toUpperCase()) ?? -1;
    const n = named >= 0 ? spec.min + named : /^\d+$/.test(text) ? Number(text) : NaN;
    if (!(n >= spec.min && n <= spec.max)) fail(`has "${text}", outside ${spec.min}-${spec.max}`);
    return n;
  };
  const values = new Set<number>();
  for (const item of field.split(",")) {
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(item);
    if (!m) return fail("isn't a cron field");
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) fail("has a step of 0");
    let from: number;
    let to: number;
    if (m[1] === "*") {
      [from, to] = [spec.min, spec.max];
    } else {
      const [a, b, extra] = m[1].split("-");
      if (extra !== undefined) fail("has a range with more than two ends");
      from = value(a);
      // `a/step` runs from a to the end, as in Vixie cron.
      to = b !== undefined ? value(b) : m[2] !== undefined ? spec.max : from;
      if (from > to) fail("has a range that wraps around");
    }
    for (let n = from; n <= to; n += step) values.add(n);
  }
  return values;
}

/**
 * Whether a schedule is due at a minute (UTC), for a host woken every
 * minute. Parses once; throws as `minuteCron` does, and also for a schedule
 * that restricts both the day of the month and the weekday, where cron
 * dialects disagree on whether both must match.
 */
export function cronMatcher(schedule: string, firedBy: string): (at: Date) => boolean {
  const fields = minuteCron(schedule, firedBy).split(" ");
  if (fields[2] !== "*" && fields[4] !== "*") {
    throw new Error(
      `Schedule "${schedule}" restricts both the day of the month and the weekday; ` +
        "cron dialects disagree on whether both must match, so use one.",
    );
  }
  const [minutes, hours, days, months, weekdays] = fields.map((field, i) => fieldValues(field, FIELDS[i], schedule));
  return (at) =>
    minutes.has(at.getUTCMinutes()) &&
    hours.has(at.getUTCHours()) &&
    days.has(at.getUTCDate()) &&
    months.has(at.getUTCMonth() + 1) &&
    weekdays.has(at.getUTCDay());
}

import test from "node:test";
import assert from "node:assert/strict";
import { cronMatcher, minuteCron } from "./cron.js";

const at = (iso: string) => new Date(iso);

test("a six-field schedule becomes five whole-minute fields only when the meaning carries over", () => {
  assert.equal(minuteCron("0 */15 * * * *", "ticks"), "*/15 * * * *");
  assert.equal(minuteCron("0 30 9 * * MON-FRI", "ticks"), "30 9 * * MON-FRI");
  assert.throws(() => minuteCron("30 * * * * *", "Ticks"), /second 30; Ticks fire on whole minutes/);
  assert.throws(() => minuteCron("0 0 9 * * 1-5", "ticks"), /use day names/);
  assert.throws(() => minuteCron("*/5 * * * *", "ticks"), /six fields/);
});

test("a schedule is due at the minutes (UTC) its fields allow", () => {
  const every5 = cronMatcher("0 */5 * * * *", "ticks");
  assert.equal(every5(at("2026-10-05T10:00:00Z")), true);
  assert.equal(every5(at("2026-10-05T10:05:59Z")), true, "any second of a due minute");
  assert.equal(every5(at("2026-10-05T10:07:00Z")), false);

  const weekdayMornings = cronMatcher("0 30 9 * * MON-FRI", "ticks");
  assert.equal(weekdayMornings(at("2026-10-05T09:30:00Z")), true, "a Monday");
  assert.equal(weekdayMornings(at("2026-10-04T09:30:00Z")), false, "a Sunday");
  assert.equal(weekdayMornings(at("2026-10-05T09:31:00Z")), false);

  const lists = cronMatcher("0 0,30 8-10/2 1 JAN,jul *", "ticks");
  assert.equal(lists(at("2026-07-01T10:30:00Z")), true);
  assert.equal(lists(at("2026-07-01T09:30:00Z")), false, "8-10/2 is 8 and 10");
  assert.equal(lists(at("2026-08-01T08:00:00Z")), false);

  const fromStep = cronMatcher("0 10/20 * * * SAT,SUN", "ticks");
  assert.deepEqual(
    [10, 30, 50, 0, 20].map((m) => fromStep(at(`2026-10-04T12:${String(m).padStart(2, "0")}:00Z`))),
    [true, true, true, false, false],
  );
});

test("schedules a whole-minute host can't read the same way are refused", () => {
  assert.throws(() => cronMatcher("0 0 9 1 * MON", "ticks"), /both the day of the month and the weekday/);
  assert.throws(() => cronMatcher("0 60 * * * *", "ticks"), /minute field "60" has "60", outside 0-59/);
  assert.throws(() => cronMatcher("0 0 22-2 * * *", "ticks"), /wraps around/);
  assert.throws(() => cronMatcher("0 */0 * * * *", "ticks"), /step of 0/);
  assert.throws(() => cronMatcher("0 0 0 * FOO *", "ticks"), /month field/);
  assert.throws(() => cronMatcher("0 0 0 L * *", "ticks"), /day field/);
});

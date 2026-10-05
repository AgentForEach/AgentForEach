/**
 * The Lambda schedule host: runs the gateway's schedules from one
 * EventBridge Scheduler tick a minute.
 *
 * Azure registers each schedule as its own timer trigger, and Cloudflare
 * each distinct cron as a trigger. On AWS one schedule (`rate(1 minute)`)
 * invokes this handler, which runs every schedule due in that minute, UTC:
 * the same whole-minute reading of the gateway's six-field schedules that
 * Cloudflare uses (`cronMatcher` in @agentforeach/platform), so a schedule
 * that can't run on whole minutes is refused here as it is there.
 *
 * The tick's input is `{ "source": "agentforeach.schedule", "version": 1,
 * "scheduledTime": "<aws.scheduler.scheduled-time>" }`. The scheduled time
 * (not the time the invocation started) picks the minute, so a delayed or
 * retried tick runs the minute it was for. Without it, the current minute.
 *
 * Each due schedule runs in its own scope, at the same time as the others,
 * and its background work is awaited before the handler returns (Lambda
 * freezes the process after), until the function's deadline. A schedule
 * that fails is logged and the others still run, as on the other hosts.
 */

import { consoleContext, cronMatcher, openScope, type ScheduleDef } from "@agentforeach/platform";
import { lambdaDeadline, settleBeforeReturn, type LambdaContext } from "./lambda.js";

/** The tick's input (the Scheduler target's `Input`). */
export interface ScheduleTickEvent {
  source: "agentforeach.schedule";
  version: 1;
  /** ISO time the tick was scheduled for: `<aws.scheduler.scheduled-time>`. */
  scheduledTime?: string;
}

export interface LambdaScheduleOptions {
  /** The schedules, read once on the first tick. */
  schedules: () => readonly ScheduleDef[];
}

export const SCHEDULE_EVENT_SOURCE = "agentforeach.schedule";
const FIRED_BY = "EventBridge Scheduler ticks";

/** The `schedule` handler of a Lambda entry point. Returns the names of the schedules it ran. */
export function createLambdaScheduleHandler(options: LambdaScheduleOptions) {
  let compiled: Array<{ schedule: ScheduleDef; due: (at: Date) => boolean }> | undefined;
  // Every schedule is checked on the first tick, so one that can't run here fails loudly at once.
  const table = () => (compiled ??= options.schedules().map((schedule) => ({ schedule, due: cronMatcher(schedule.schedule, FIRED_BY) })));

  return async (event: ScheduleTickEvent, context: LambdaContext): Promise<{ ran: string[] }> => {
    if (event?.source !== SCHEDULE_EVENT_SOURCE || event.version !== 1) {
      throw new Error(`Not a schedule tick: expected source "${SCHEDULE_EVENT_SOURCE}", version 1`);
    }
    const at = event.scheduledTime === undefined ? new Date() : new Date(event.scheduledTime);
    if (Number.isNaN(at.getTime())) throw new Error(`Not a schedule tick: scheduledTime "${event.scheduledTime}" isn't a time`);
    const deadlineAt = lambdaDeadline(context);
    const minute = Math.floor(at.getTime() / 60_000) * 60_000;
    const due = table()
      .filter((entry) => entry.due(at))
      .map((entry) => entry.schedule);

    await Promise.all(
      due.map(async (schedule) => {
        const invocationId = `${schedule.name}-${minute}`;
        const opened = openScope({ invocationId, kind: "schedule" });
        try {
          await opened.run(() => schedule.handler(consoleContext(invocationId, deadlineAt)));
        } catch (err) {
          console.error(`[host] schedule ${schedule.name} failed:`, err);
        } finally {
          await settleBeforeReturn(opened, deadlineAt, `schedule ${schedule.name}`);
        }
      }),
    );
    return { ran: due.map((s) => s.name) };
  };
}

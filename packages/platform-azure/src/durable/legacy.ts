/**
 * Orchestrations from before the durable port, kept for one release so
 * instances already in flight when this version deploys can finish: a chat
 * or channel turn mid-run, a HITL form waiting for its answer, a force-run.
 * Each keeps its old shape (so Durable Functions can replay it) and runs
 * the registry's handler for the matching kind. New work never starts them.
 *
 * The old CronScheduler is kept only as an orchestration that ends at once:
 * `ensureAlarm` terminates a running one and starts the generic alarm in its
 * place, and the host needs the function to exist to process that
 * termination (without it the instance fails, and the alarm waits for the
 * next health check).
 *
 * Remove after the next release.
 */

import * as df from "durable-functions";
import type { DurableRegistry, HandlerContext } from "@agentforeach/platform";
import type { InvocationContext } from "@azure/functions";
import { inScope } from "../host.js";
import type { DurableApp } from "./durable.js";

/** The gateway's kinds these orchestrations ran before. */
export const LEGACY_KINDS = {
  chatTurn: "ChatTurn",
  channelTurn: "ChannelInboundTurn",
  hitl: "HitlAwaitInput",
  cronRun: "CronRun",
  cronScheduler: "CronScheduler",
} as const;

function ctxFor(context: HandlerContext, instanceId: string) {
  return {
    instanceId,
    invocationId: context.invocationId,
    log: (...a: unknown[]) => context.log(...a),
    warn: (...a: unknown[]) => context.warn(...a),
    error: (...a: unknown[]) => context.error(...a),
    trace: (...a: unknown[]) => context.trace(...a),
  };
}

function legacyActivity(app: DurableApp, name: string, run: (input: any, context: InvocationContext) => Promise<unknown>) {
  app.activity(name, {
    extraInputs: [df.input.durableClient()],
    handler: (input: unknown, context: InvocationContext) => inScope(context, "job", () => run(input, context)),
  });
}

export function registerLegacyOrchestrations(registry: DurableRegistry, app: DurableApp = df.app): void {
  const { jobs, waits, alarms } = registry.kinds();

  if (alarms.includes(LEGACY_KINDS.cronScheduler)) {
    // Ends at once: the generic alarm replaces it (see ensureAlarm).
    app.orchestration("CronScheduler", function* () {});
  }

  if (jobs.includes(LEGACY_KINDS.chatTurn)) {
    app.orchestration("ChatTurn", function* (ctx) {
      return yield ctx.df.callActivity("RunChatTurn", ctx.df.getInput());
    });
    legacyActivity(app, "RunChatTurn", (input, context) =>
      registry.job(LEGACY_KINDS.chatTurn).run(input, ctxFor(context, "legacy-chat-turn")),
    );
  }

  if (jobs.includes(LEGACY_KINDS.channelTurn)) {
    app.orchestration("ChannelInboundTurn", function* (ctx) {
      yield ctx.df.callActivity("ProcessChannelInboundTurn", ctx.df.getInput());
    });
    legacyActivity(app, "ProcessChannelInboundTurn", (input, context) =>
      registry.job(LEGACY_KINDS.channelTurn).run(input, ctxFor(context, "legacy-channel-turn")),
    );
  }

  if (waits.includes(LEGACY_KINDS.hitl)) {
    const wait = registry.wait(LEGACY_KINDS.hitl);
    app.orchestration("HitlAwaitInput", function* (ctx) {
      const oc = ctx.df;
      const input = oc.getInput() as { inputRequest: unknown; requestId: string; userId: string; timeoutSeconds?: number };
      yield oc.callActivity("HitlPushInputRequest", { inputRequest: input.inputRequest, userId: input.userId });
      const timerTask = oc.createTimer(new Date(oc.currentUtcDateTime.getTime() + (input.timeoutSeconds ?? 300) * 1000));
      const eventTask = oc.waitForExternalEvent(wait.event);
      yield oc.Task.any([timerTask, eventTask]);
      if (!timerTask.isCompleted) timerTask.cancel();
      if (eventTask.isCompleted) {
        yield oc.callActivity("HitlResumeRun", { requestId: input.requestId, userId: input.userId, response: eventTask.result });
      } else {
        yield oc.callActivity("HitlTimeout", { requestId: input.requestId, userId: input.userId });
      }
    });
    legacyActivity(app, "HitlPushInputRequest", (input, context) =>
      wait.start ? wait.start(input, ctxFor(context, "legacy-hitl")) : Promise.resolve(),
    );
    legacyActivity(app, "HitlResumeRun", (input, context) =>
      wait.onEvent({ requestId: input.requestId, userId: input.userId }, input.response, ctxFor(context, "legacy-hitl")),
    );
    legacyActivity(app, "HitlTimeout", (input, context) =>
      wait.onTimeout({ requestId: input.requestId, userId: input.userId }, ctxFor(context, "legacy-hitl")),
    );
  }

  if (jobs.includes(LEGACY_KINDS.cronRun)) {
    app.orchestration("CronForceRunExecution", function* (ctx) {
      yield ctx.df.callActivity("ExecuteAndRecordJob", ctx.df.getInput());
      yield ctx.df.callActivity("SignalJobsChanged", {});
    });
    legacyActivity(app, "ExecuteAndRecordJob", (input, context) =>
      registry.job(LEGACY_KINDS.cronRun).run(input, ctxFor(context, "legacy-cron-run")),
    );
    legacyActivity(app, "SignalJobsChanged", async () => undefined);
  }
}

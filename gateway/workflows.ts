/**
 * AgentForEach Gateway — Durable work
 *
 * Every kind of durable work the gateway runs, defined once for every cloud
 * (see `@agentforeach/platform`'s Durable port). A platform's entry point
 * hands this registry to its pack, which runs the kinds, and installs the
 * pack's Durable implementation (runtime/durable.ts).
 */

import { DurableRegistry } from "@agentforeach/platform";
import { chatTurnJob } from "./handlers/chat-turn.js";
import { channelTurnJob } from "./handlers/channel-webhook.js";
import { hitlWait } from "./hitl/orchestrator.js";
import { cronRunJob, cronSchedulerAlarm } from "./cron/orchestrator.js";

export const workflows = new DurableRegistry()
  .defineJob(chatTurnJob)
  .defineJob(channelTurnJob)
  .defineWait(hitlWait)
  .defineAlarm(cronSchedulerAlarm)
  .defineJob(cronRunJob);

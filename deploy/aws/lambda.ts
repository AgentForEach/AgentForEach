/**
 * AgentForEach on AWS Lambda: the entry point. One deployment package, one
 * file of named handlers; each function (deploy/aws/infra) runs one:
 *
 *   http                API Gateway HTTP API (payload 2.0): the gateway's routes
 *   schedule            EventBridge Scheduler, every minute: the route table's
 *                       schedules, the database sweep and the durable sweep
 *   durable             Lambda durable functions: every durable kind (jobs, waits, alarms)
 *   realtimeAuthorizer  AppSync Events' Lambda authorizer
 *   migrate             applies the database schema, once per release
 *   conformance         the durable conformance suite, by hand
 *
 * `npm run build:aws` bundles this file into dist/deploy/aws/lambda.mjs, so a
 * function's handler is `dist/deploy/aws/lambda.<export>`. The bundle never
 * contains Azure or Cloudflare code: `npm run check:bundle` fails if it
 * would (scripts/check-lambda-bundle.mjs).
 *
 * Every handler loads the release first (bootstrap.ts: the manifest, secrets
 * and config), then the gateway, once per process.
 */

// First: the host and the release loader, before any gateway module loads.
import { loadRelease } from "./bootstrap.js";

import {
  createLambdaHttpHandler,
  createLambdaScheduleHandler,
  createLambdaDurable,
  createLambdaDurableHandler,
  durableSweepSchedule,
  defineDurableConformanceKinds,
  createDurableConformanceHandler,
  createAppSyncAuthorizer,
  appSyncRealtime,
  AwsAgentCoreSandbox,
  AWS_AGENTCORE_PROVIDER,
  type HttpApiV2Event,
  type LambdaContext,
  type ScheduleTickEvent,
} from "@agentforeach/platform-aws";
import type { RouteTable } from "../../gateway/routes.js";
import { awsS3Defaults } from "@agentforeach/platform-aws/objects";
import { createMigrateHandler } from "./migrate.js";

let durableHandler: ReturnType<typeof createLambdaDurableHandler>;
let conformanceHandler: ReturnType<typeof createDurableConformanceHandler> | undefined;
const authorizerHandler = createAppSyncAuthorizer();
const migrateHandler = createMigrateHandler();

/** The gateway's routes and schedules, once its modules are loaded. */
let loading: Promise<RouteTable> | undefined;

async function loadGateway(): Promise<RouteTable> {
  await loadRelease();
  // As in the Azure entry point (gateway/index.ts): Node polyfills first, then safeFetch's Node transport.
  await import("../../gateway/polyfills.js");
  await import("../../gateway/utils/safe-fetch-node.js");
  const [
    { buildRouteTable }, { databaseSweepSchedule }, { backgroundTurnsEnabled },
    { getSharedStorage }, { installDurable, durable: durableRuntime }, { workflows },
    { installRealtimeProvider }, { installS3Defaults }, { registerSandboxProvider, agentcoreSandboxOptions },
  ] = await Promise.all([
    import("../../gateway/routes.js"),
    import("../../gateway/database/catalog.js"),
    import("../../gateway/handlers/chat-turn.js"),
    import("../../gateway/database/storage.js"),
    import("../../gateway/runtime/durable.js"),
    import("../../gateway/workflows.js"),
    import("../../gateway/websocket/providers/index.js"),
    import("../../gateway/objects/index.js"),
    import("../../gateway/skills/sandbox/index.js"),
  ]);
  const options = {
    functionArn: process.env.DURABLE_FUNCTION_ARN ?? "",
    executionPrefix: process.env.DURABLE_EXECUTION_PREFIX ?? "",
    storage: getSharedStorage,
  };
  if (process.env.DURABLE_CONFORMANCE_KINDS === "1") {
    defineDurableConformanceKinds(workflows, { storage: getSharedStorage, durable: durableRuntime });
    conformanceHandler = createDurableConformanceHandler(workflows, options);
  }
  installDurable(createLambdaDurable(workflows, options));
  durableHandler = createLambdaDurableHandler(workflows, options);
  installRealtimeProvider(appSyncRealtime());
  installS3Defaults(awsS3Defaults());
  registerSandboxProvider(AWS_AGENTCORE_PROVIDER, config =>
    new AwsAgentCoreSandbox({ ...agentcoreSandboxOptions(config), storage: getSharedStorage() }));

  // Chat turns always run in the background here; this logs, once at startup,
  // if the configuration says otherwise (CHAT_ASYNC_TURNS=false).
  backgroundTurnsEnabled();

  const table = buildRouteTable();
  return {
    routes: table.routes,
    schedules: [
      ...table.schedules,
      // A Lambda process is frozen between invocations, so Postgres can't sweep on a timer.
      databaseSweepSchedule,
      durableSweepSchedule(options),
    ],
  };
}

/** The gateway, loaded once per process; a failed load (a secret that can't be read) is tried again next time. */
function gateway(): Promise<RouteTable> {
  return (loading ??= loadGateway().catch((err) => {
    loading = undefined;
    throw err;
  }));
}

let httpHandler: ReturnType<typeof createLambdaHttpHandler> | undefined;
let scheduleHandler: ReturnType<typeof createLambdaScheduleHandler> | undefined;

/** API Gateway HTTP API (payload 2.0). */
export async function http(event: HttpApiV2Event, context: LambdaContext) {
  const table = await gateway();
  httpHandler ??= createLambdaHttpHandler({ routes: () => table.routes });
  return httpHandler(event, context);
}

/** EventBridge Scheduler, every minute. */
export async function schedule(event: ScheduleTickEvent, context: LambdaContext) {
  const table = await gateway();
  scheduleHandler ??= createLambdaScheduleHandler({ schedules: () => table.schedules });
  return scheduleHandler(event, context);
}

/** Every gateway workflow, on its pinned Lambda durable-function version. */
export async function durable(...args: Parameters<ReturnType<typeof createLambdaDurableHandler>>) {
  await gateway();
  return durableHandler(...args);
}

/** AppSync needs only its release settings and signing secret, never the database. */
export async function realtimeAuthorizer(...args: Parameters<ReturnType<typeof createAppSyncAuthorizer>>) {
  await loadRelease();
  return authorizerHandler(...args);
}

/** Apply the release's schema before any application version serves. */
export async function migrate() {
  await loadRelease();
  return migrateHandler();
}

/** IAM-only test control; production releases keep the test kinds disabled. */
export async function conformance(...args: Parameters<ReturnType<typeof createDurableConformanceHandler>>) {
  await gateway();
  if (!conformanceHandler) throw new Error("Durable conformance kinds are not enabled for this release");
  return conformanceHandler(...args);
}

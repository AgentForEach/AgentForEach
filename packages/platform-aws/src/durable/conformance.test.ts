/**
 * Connect mode on the local runner: the suite drives the `conformance`
 * handler's control API (each request and response through JSON, as through
 * Lambda's Invoke), and the conformance kinds record to the database, as
 * they do against the deployed durable function.
 */

import { after, before } from "node:test";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import { DurableRegistry, type Durable } from "@agentforeach/platform";
import { runDurableConformance } from "@agentforeach/platform/durable/conformance";
import { InMemoryStorage } from "@agentforeach/storage";
import {
  CONFORMANCE_UNIT_MS,
  connectDurableConformance,
  createDurableConformanceHandler,
  defineDurableConformanceKinds,
} from "./conformance.js";
import { createLambdaDurable } from "./durable.js";
import { createLambdaDurableHandler } from "./handler.js";
import type { LambdaDurableOptions } from "./instances.js";
import { LOCAL_FUNCTION_ARN, LocalDurableControl } from "./local.testkit.js";

const control = new LocalDurableControl();

before(() => LocalDurableTestRunner.setupTestEnvironment({ skipTime: false }));
after(async () => {
  await control.settled(10_000);
  await LocalDurableTestRunner.teardownTestEnvironment();
});

function deployed() {
  const storage = new InMemoryStorage();
  const options: LambdaDurableOptions = {
    functionArn: LOCAL_FUNCTION_ARN,
    executionPrefix: "test-stack",
    storage: () => storage,
    control,
    logger: { log() {}, warn() {}, error() {}, debug() {} },
  };
  let durable: Durable;
  const registry = defineDurableConformanceKinds(new DurableRegistry(), { storage: () => storage, durable: () => durable });
  durable = createLambdaDurable(registry, options);
  control.handler = createLambdaDurableHandler(registry, options);
  const handler = createDurableConformanceHandler(registry, options);
  return connectDurableConformance(async (request) => JSON.parse(JSON.stringify(await handler(JSON.parse(JSON.stringify(request))))));
}

const connection = deployed();

runDurableConformance({
  name: "aws connect mode (the conformance handler, on the SDK's local runner)",
  connect: async () => connection,
  unitMs: CONFORMANCE_UNIT_MS,
  patienceMs: 20_000,
  interrupt: async (instanceId, release) => {
    await connection.interrupt(instanceId);
    await release();
  },
});

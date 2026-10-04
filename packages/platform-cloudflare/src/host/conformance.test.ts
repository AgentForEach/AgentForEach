/** The host conformance suite on the Worker host, in process (Node). The same suite runs on workerd: conformance/host/run.mjs. */
import { hostConformanceTable, runHostConformance } from "@agentforeach/platform/host/conformance";
import { createWorkerHandler } from "./worker.js";

const host = createWorkerHandler({ table: hostConformanceTable });
// Node keeps running after a response, so waitUntil only has to let the work run.
const ctx = { waitUntil: (work: Promise<unknown>) => void work.catch(() => {}) };

runHostConformance({ name: "Worker host (Node)", fetch: (request) => host.fetch(request, {}, ctx) });

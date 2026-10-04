// The host conformance suite against the test Worker (see run.mjs).
import { runHostConformance } from "@agentforeach/platform/host/conformance";

const base = process.env.HOST_WORKER_URL;
if (!base) throw new Error("Set HOST_WORKER_URL, or use run.mjs");

runHostConformance({ name: "Worker host (workerd)", baseUrl: base, fetch: (request) => fetch(request) });

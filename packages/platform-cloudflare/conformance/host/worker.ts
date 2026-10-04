/**
 * Test Worker for the host conformance suite on workerd: the conformance
 * route table served by the Worker host, as deploy/cloudflare/worker.ts
 * serves the gateway's.
 */

import { hostConformanceTable } from "@agentforeach/platform/host/conformance-table";
import { createWorkerHandler } from "../../dist/host/worker.js";

export default createWorkerHandler({ table: hostConformanceTable });

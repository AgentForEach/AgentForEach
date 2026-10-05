// The durable conformance suite against the deployed conformance function (see run.mjs).
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { runDurableConformance } from "@agentforeach/platform/durable/conformance";
import { CONFORMANCE_UNIT_MS, connectDurableConformance } from "../../dist/durable/conformance.js";

const functionName = process.env.DURABLE_CONFORMANCE_FUNCTION;
if (!functionName) throw new Error("Set DURABLE_CONFORMANCE_FUNCTION, or use run.mjs");

const client = new LambdaClient({});
const connection = connectDurableConformance(async (request) => {
  const out = await client.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(request)) }));
  const body = out.Payload ? Buffer.from(out.Payload).toString() : "";
  if (out.FunctionError) throw new Error(`${request.area}/${request.op}: ${out.FunctionError} ${body}`);
  return JSON.parse(body);
});

runDurableConformance({
  name: "aws (deployed)",
  connect: async () => connection,
  unitMs: CONFORMANCE_UNIT_MS,
  patienceMs: 60_000,
  // Stops the instance's execution, as a Lambda timeout would; the sweep starts it again.
  interrupt: async (instanceId, release) => {
    await connection.interrupt(instanceId);
    await release();
  },
});

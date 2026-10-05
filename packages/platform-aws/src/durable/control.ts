/**
 * What the Durable port needs from Lambda's durable executions API, behind
 * one small interface (`DurableControl`), so the same engine runs on Lambda
 * (`lambdaControl`) and in tests on the SDK's local runner.
 *
 * Validated on AWS by the reference work (docs/AWS-Workflows.md there):
 * - executions are started with an asynchronous `Invoke` of a numeric
 *   published version, named by `DurableExecutionName`; AWS deduplicates a
 *   repeated invoke with the same name and payload, so an uncertain dispatch
 *   is retried with exactly the same name;
 * - a waiting execution is resumed with `SendDurableExecutionCallbackSuccess`,
 *   carrying no data (what arrived is in the database);
 * - status reads (`GetDurableExecution`) and stops are limited to the
 *   function's own executions.
 */

import {
  GetDurableExecutionCommand,
  InvokeCommand,
  LambdaClient,
  SendDurableExecutionCallbackSuccessCommand,
  StopDurableExecutionCommand,
} from "@aws-sdk/client-lambda";

/** Where a durable execution is, as Lambda reports it. */
export type ExecutionStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "STOPPED";

/** The invocation payload: a reference to the instance row, never its input. */
export interface DurableReference {
  /** The instance id. */
  id: string;
  /** The instance's kind (for logs; the row is authoritative). */
  kind: string;
  /** The execution's own name: it acts only while the row still names it. */
  execution: string;
}

export interface DurableControl {
  /** Start (or, with the same name and payload, find) an execution. Returns its ARN. */
  start(name: string, reference: DurableReference): Promise<string>;
  /** The execution's status, or undefined when Lambda doesn't know it. */
  status(executionArn: string): Promise<ExecutionStatus | undefined>;
  /** Complete a waiting callback, waking its execution. */
  sendCallback(callbackId: string): Promise<void>;
  /** Stop a running execution. Optional: the local runner can't. */
  stop?(executionArn: string, reason: string): Promise<void>;
}

/** `arn:aws:lambda:<region>:<account>:function:<name>:<version>`, the version numeric. */
const PUBLISHED_VERSION_ARN = /^arn:[a-z0-9-]+:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]+:[1-9]\d*$/;

export function isPublishedVersionArn(arn: string): boolean {
  return PUBLISHED_VERSION_ARN.test(arn);
}

/** Lambda's limit on a durable execution name. */
export const EXECUTION_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** References are a few hundred bytes; anything near Lambda's async limit is a bug. */
const MAX_REFERENCE_BYTES = 16 * 1024;

const RETURNED_STATUSES = new Set<string>(["RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "STOPPED"]);

function notFound(err: unknown): boolean {
  return (err as { name?: string })?.name === "ResourceNotFoundException";
}

/**
 * The control for a durable function's published version (its numeric
 * version ARN). Unqualified ARNs, aliases and `$LATEST` are refused: an
 * in-flight execution must keep running the code it started with.
 */
export function lambdaControl(
  functionArn: string,
  client: Pick<LambdaClient, "send"> = new LambdaClient({
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 5000 },
  }),
): DurableControl {
  if (!isPublishedVersionArn(functionArn)) {
    throw new Error("The durable function ARN must be a Lambda ARN qualified by a numeric published version");
  }
  // Execution ARNs of any version of this function: arn:...:function:<name>:<version>/durable-execution/...
  const ownFunction = functionArn.replace(/:[1-9]\d*$/, ":");
  const own = (executionArn: string) => {
    if (!executionArn.startsWith(ownFunction) || !executionArn.includes("/durable-execution/")) {
      throw new Error("Unexpected durable execution ARN");
    }
  };
  return {
    async start(name, reference) {
      if (!EXECUTION_NAME.test(name)) throw new Error(`Invalid durable execution name "${name}"`);
      const payload = Buffer.from(JSON.stringify(reference));
      if (payload.byteLength > MAX_REFERENCE_BYTES) throw new Error("Durable execution reference is too large");
      const result = await client.send(
        new InvokeCommand({ FunctionName: functionArn, InvocationType: "Event", DurableExecutionName: name, Payload: payload }),
      );
      if (result.StatusCode !== 202 || !result.DurableExecutionArn || result.FunctionError) {
        throw new Error("Lambda did not acknowledge the durable execution");
      }
      return result.DurableExecutionArn;
    },
    async status(executionArn) {
      own(executionArn);
      try {
        const { Status } = await client.send(new GetDurableExecutionCommand({ DurableExecutionArn: executionArn }));
        return Status && RETURNED_STATUSES.has(Status) ? (Status as ExecutionStatus) : undefined;
      } catch (err) {
        if (notFound(err)) return undefined;
        throw err;
      }
    },
    async sendCallback(callbackId) {
      await client.send(
        new SendDurableExecutionCallbackSuccessCommand({ CallbackId: callbackId, Result: Buffer.from("{}") }),
      );
    },
    async stop(executionArn, reason) {
      own(executionArn);
      await client.send(
        new StopDurableExecutionCommand({
          DurableExecutionArn: executionArn,
          Error: { ErrorType: "Terminated", ErrorMessage: reason.slice(0, 256) },
        }),
      );
    },
  };
}

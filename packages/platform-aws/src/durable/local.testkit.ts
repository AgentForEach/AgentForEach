/**
 * A `DurableControl` over the durable execution SDK's local runner
 * (`LocalDurableTestRunner`), so the pack's Durable and its durable handler
 * run in one process with real checkpoints, callbacks and timeouts, no AWS
 * involved. Tests only (not shipped): call
 * `LocalDurableTestRunner.setupTestEnvironment()` before and
 * `teardownTestEnvironment()` after.
 *
 * Like Lambda, starting a name that already exists returns that execution.
 * `interrupt` stands in for Lambda closing an execution early (its timeout):
 * its status becomes TIMED_OUT, and the sweep starts the instance again.
 */

import { randomUUID } from "node:crypto";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import type { DurableLambdaHandler } from "@aws/durable-execution-sdk-js";
import type { DurableControl, DurableReference, ExecutionStatus } from "./control.js";

const FUNCTION_ARN = "arn:aws:lambda:us-east-1:123456789012:function:durable:1";

interface LocalExecution {
  name: string;
  reference: DurableReference;
  status: ExecutionStatus;
  done: Promise<void>;
}

/** The runner's callback API, which its public surface only offers per operation. */
type CallbackApi = { sendCallbackSuccess(request: { CallbackId: string; Result?: Uint8Array }): Promise<unknown> };

export class LocalDurableControl implements DurableControl {
  /** Set once the handler exists (it is built with this control). */
  handler: DurableLambdaHandler | undefined;
  readonly executions = new Map<string, LocalExecution>();
  private readonly names = new Map<string, string>();

  async start(name: string, reference: DurableReference): Promise<string> {
    const existing = this.names.get(name);
    if (existing) return existing;
    if (!this.handler) throw new Error("LocalDurableControl: no handler set");
    const arn = `${FUNCTION_ARN}/durable-execution/${name}/${randomUUID()}`;
    const execution: LocalExecution = { name, reference, status: "RUNNING", done: Promise.resolve() };
    execution.done = new LocalDurableTestRunner({ handlerFunction: this.handler }).run({ payload: reference }).then(
      (result) => {
        if (execution.status === "RUNNING") execution.status = (result.getStatus() as ExecutionStatus | undefined) ?? "FAILED";
      },
      () => {
        if (execution.status === "RUNNING") execution.status = "FAILED";
      },
    );
    this.names.set(name, arn);
    this.executions.set(arn, execution);
    return arn;
  }

  async status(executionArn: string): Promise<ExecutionStatus | undefined> {
    return this.executions.get(executionArn)?.status;
  }

  async sendCallback(callbackId: string): Promise<void> {
    const api = (LocalDurableTestRunner as unknown as { createDurableApi(): CallbackApi }).createDurableApi();
    await api.sendCallbackSuccess({ CallbackId: callbackId, Result: Buffer.from("{}") });
  }

  /** Stop an execution: its status becomes STOPPED (the local runner can't end it; the row's guard makes it inert). */
  async stop(executionArn: string, _reason: string): Promise<void> {
    const execution = this.executions.get(executionArn);
    if (execution?.status === "RUNNING") execution.status = "STOPPED";
  }

  /** Report an execution as timed out, as Lambda does when one outlives its execution timeout. */
  interrupt(executionArn: string): void {
    const execution = this.executions.get(executionArn);
    if (execution) execution.status = "TIMED_OUT";
  }

  /** Wait (up to `ms`) for every execution started so far to end. */
  async settled(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...this.executions.values()].map((e) => e.done)),
      new Promise((resolve) => (timer = setTimeout(resolve, ms))),
    ]);
    clearTimeout(timer);
  }
}

export { FUNCTION_ARN as LOCAL_FUNCTION_ARN };

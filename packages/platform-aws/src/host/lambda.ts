/**
 * What the AWS host needs from Lambda: the context every handler gets, the
 * time left in it, and the `HostInfo` a Lambda entry point installs.
 */

import type { HostInfo, OpenedScope } from "@agentforeach/platform";

/** The parts of Lambda's context object the host uses. */
export interface LambdaContext {
  readonly awsRequestId: string;
  getRemainingTimeInMillis(): number;
}

/** API Gateway HTTP APIs end a request after 30 s, whatever the function's own timeout. */
export const API_GATEWAY_MAX_REQUEST_MS = 30_000;

/**
 * Kept back from the time Lambda gives an invocation: the deadline handlers
 * see is this much before Lambda stops the function, so the host can still
 * log what was cut off and return.
 */
export const RETURN_MARGIN_MS = 1_000;

/** The deadline for an invocation: `budgetMs` from now, but never later than Lambda allows. */
export function lambdaDeadline(context: LambdaContext, budgetMs = Infinity): number {
  return Date.now() + Math.max(0, Math.min(budgetMs, context.getRemainingTimeInMillis() - RETURN_MARGIN_MS));
}

/**
 * Lambda freezes the process once a handler returns, so background work is
 * awaited first, until the deadline. What is still running then is logged:
 * it stays frozen with the process and may never finish.
 */
export async function settleBeforeReturn(opened: OpenedScope, deadlineAt: number, name: string): Promise<void> {
  const { settled, pending } = await opened.settleBy(deadlineAt);
  if (!settled) {
    console.warn(`[host] ${name}: cut off at the deadline with ${pending} background task(s) still running`);
  }
}

/**
 * The host Lambda entry points install (`installHost`). A Lambda process is
 * persistent (pools and sockets are reused by the next invocation) but runs
 * nothing between invocations, so background work is awaited before
 * returning; behind API Gateway a request lasts 30 s at most.
 */
export function lambdaHostInfo(env: Record<string, string | undefined> = process.env): HostInfo {
  return {
    platform: "aws",
    isProductionHost: true,
    // Read on each use, as the release bootstrap sets them after the host is installed.
    get publicBaseUrl() {
      return env.PUBLIC_BASE_URL || undefined;
    },
    get label() {
      return `aws:${env.AWS_LAMBDA_FUNCTION_NAME || "agentforeach"}`;
    },
    persistent: true,
    backgroundAfterResponse: false,
    maxRequestMs: API_GATEWAY_MAX_REQUEST_MS,
  };
}

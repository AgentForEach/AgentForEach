/**
 * @agentforeach/platform-aws: the AWS platform pack.
 *
 * Each port lives in its own folder, as in platform-azure and
 * platform-cloudflare: src/host (Lambda behind an API Gateway HTTP API, and
 * EventBridge schedules), src/durable (Lambda durable functions), src/objects
 * (the shared `s3` provider with the AWS credential chain), src/realtime
 * (AppSync Events) and src/sandbox (Bedrock AgentCore Runtime). The AWS SDKs
 * are imported only here, never by the gateway's shared modules, so the
 * Cloudflare Worker and the Azure Function App never load them.
 *
 * The collection definitions the pack stores (sandbox sessions and
 * workspaces) are in "@agentforeach/platform-aws/collections", which imports
 * no SDK, so the database catalog can include them anywhere.
 */

/** The name the AgentCore sandbox backend registers under (skills.sandbox.provider). */
export const AWS_AGENTCORE_PROVIDER = "aws-agentcore";

// Realtime: AppSync Events (the provider's registration and the Lambda authorizer).
export * from "./realtime/index.js";

// Host: the gateway's routes behind an API Gateway HTTP API, its schedules from
// an EventBridge Scheduler tick, and the release bootstrap (deploy/aws/lambda.ts).
export * from "./host/index.js";

// Durable: jobs, waits and alarms on Lambda durable functions, the instance
// table, and the minute sweep (deploy/aws/lambda.ts wires the handler).
export * from "./durable/index.js";
// Sandbox: Bedrock AgentCore Runtime.
export * from "./sandbox/index.js";

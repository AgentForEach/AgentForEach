/**
 * IAM for the application's functions: one role per function, each with only
 * what its handler needs (docs/AWS.md#permissions).
 *
 * Every Lambda resource is a published version, never `$LATEST`: callers get
 * `function:<name>:*`, which matches version-qualified ARNs only, and durable
 * execution actions get the executions of those versions
 * (`function:<name>:<version>/durable-execution/<id>`). Old versions
 * stay covered, so executions started by a previous release can finish while
 * the next one rolls out.
 */

export type Statement = {
  Effect: "Allow" | "Deny";
  Action: string | string[];
  /** Absent only in trust policies. */
  Resource?: string | string[];
  Principal?: unknown;
  Condition?: Record<string, unknown>;
};

export const allow = (Action: string[], Resource: string | string[], Condition?: Record<string, unknown>): Statement => ({
  Effect: "Allow",
  Action,
  Resource,
  ...(Condition ? { Condition } : {}),
});

export const policy = (Statement: Statement[]) => JSON.stringify({ Version: "2012-10-17", Statement });

/** The functions of one deployment, each a handler of the one Lambda package (deploy/aws/lambda.ts). */
export type FunctionKind = "http" | "schedule" | "durable" | "realtimeAuthorizer" | "migrate" | "conformance";

/** The gateway's own work: serving requests, running schedules, and running durable work. */
export const APPLICATION_KINDS: readonly FunctionKind[] = ["http", "schedule", "durable"];

/** Functions that start or answer durable executions (the durable function itself included). */
const DURABLE_CALLERS: readonly FunctionKind[] = ["http", "schedule", "durable", "conformance"];

/** Functions in the VPC: everything that reaches the database. */
export const VPC_KINDS: readonly FunctionKind[] = ["http", "schedule", "durable", "migrate", "conformance"];

/** The Lambda function name of a kind: `<prefix>-<kebab-case kind>`. */
export const functionName = (prefix: string, kind: FunctionKind) =>
  `${prefix}-${kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

export const functionArn = (region: string, account: string, name: string) => `arn:aws:lambda:${region}:${account}:function:${name}`;

/** What one function's role may do. Inputs are resolved ARNs; empty ones are features that are off. */
export interface FunctionGrantInputs {
  kind: FunctionKind;
  region: string;
  account: string;
  prefix: string;
  /** The function's own log group. */
  logGroupArn: string;
  /** The artifacts bucket: each function reads only its own release manifests. */
  artifactsBucketArn: string;
  /** The Secrets Manager secrets in the function's manifest. */
  secretArns: string[];
  /** Customer-managed keys encrypting those secrets. */
  secretKmsKeyArns: string[];
  skillsBucketArn?: string;
  exportsBucketArn?: string;
  /** The sandbox workspace checkpoint bucket (workspacePersistence). */
  workspaceBucketArn?: string;
  /** The AppSync Events API, whose chat namespace the gateway publishes to. */
  eventsApiArn?: string;
  eventsNamespace?: string;
  /** The AgentCore sandbox runtime. */
  sandboxRuntimeArn?: string;
  bedrockModelArns: string[];
  /** Where the schedule function's failed invocations go. */
  deadLetterQueueArn?: string;
}

export function functionGrants(g: FunctionGrantInputs): Statement[] {
  const grants: Statement[] = [
    allow(["logs:CreateLogStream", "logs:PutLogEvents"], `${g.logGroupArn}:*`),
    allow(["s3:GetObject"], `${g.artifactsBucketArn}/releases/*/${g.kind}.json`),
  ];
  if (g.secretArns.length) {
    grants.push(allow(["secretsmanager:GetSecretValue"], g.secretArns));
    if (g.secretKmsKeyArns.length) {
      grants.push(
        allow(["kms:Decrypt"], g.secretKmsKeyArns, { StringEquals: { "kms:ViaService": `secretsmanager.${g.region}.amazonaws.com` } }),
      );
    }
  }
  if (VPC_KINDS.includes(g.kind)) {
    // Lambda's own network interfaces in the private subnets (AWSLambdaVPCAccessExecutionRole).
    grants.push(
      allow(
        [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DescribeSubnets",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
        ],
        "*",
      ),
    );
  }

  const durable = functionArn(g.region, g.account, functionName(g.prefix, "durable"));
  const executions = `${durable}:*/durable-execution/*`;
  if (g.kind === "durable") {
    grants.push(allow(["lambda:CheckpointDurableExecution", "lambda:GetDurableExecutionState"], executions));
  }
  if (DURABLE_CALLERS.includes(g.kind)) {
    grants.push(allow(["lambda:InvokeFunction"], `${durable}:*`));
    grants.push(allow(["lambda:GetDurableExecution", "lambda:SendDurableExecutionCallbackSuccess", "lambda:StopDurableExecution"], executions));
  }

  if (APPLICATION_KINDS.includes(g.kind)) {
    // The s3 object store with the role's credentials: it never creates buckets. Erasure lists
    // and deletes every version (OBJECT_STORE_S3_DELETE_VERSIONS defaults to true on AWS).
    // Both buckets are dedicated to the gateway, so the grants cover the whole bucket.
    if (g.skillsBucketArn) {
      grants.push(allow(["s3:ListBucket", "s3:ListBucketVersions"], g.skillsBucketArn));
      grants.push(allow(["s3:GetObject", "s3:DeleteObjectVersion"], `${g.skillsBucketArn}/*`));
    }
    if (g.exportsBucketArn) {
      grants.push(allow(["s3:ListBucketVersions"], g.exportsBucketArn));
      grants.push(allow(["s3:GetObject", "s3:PutObject", "s3:DeleteObjectVersion"], `${g.exportsBucketArn}/*`));
    }
    if (g.workspaceBucketArn) {
      // Checkpoints refuse a versioned bucket, so they read its versioning state.
      grants.push(allow(["s3:GetBucketVersioning"], g.workspaceBucketArn));
      grants.push(allow(["s3:GetObject", "s3:PutObject"], `${g.workspaceBucketArn}/*`));
    }
    if (g.eventsApiArn && g.eventsNamespace) {
      grants.push(allow(["appsync:EventPublish"], `${g.eventsApiArn}/channelNamespace/${g.eventsNamespace}`));
    }
    if (g.sandboxRuntimeArn) {
      grants.push(
        allow(
          ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"],
          [g.sandboxRuntimeArn, `${g.sandboxRuntimeArn}/runtime-endpoint/*`],
        ),
      );
    }
    if (g.bedrockModelArns.length) {
      grants.push(allow(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], g.bedrockModelArns));
    }
  }
  if (g.kind === "schedule" && g.deadLetterQueueArn) {
    grants.push(allow(["sqs:SendMessage"], g.deadLetterQueueArn));
  }
  return grants;
}

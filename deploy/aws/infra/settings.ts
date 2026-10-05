/**
 * The application stack's settings (Pulumi config, see Pulumi.example.yaml),
 * checked before anything is provisioned, and the AWS choices applied to a
 * copy of agentforeach.json.
 */

import { createHash } from "node:crypto";
import type { FunctionKind } from "./policies.js";

/**
 * The deployment's phases, in order (deploy/aws/deploy.sh runs them):
 *   bootstrap    the artifacts bucket and the sandbox image repository, so the image can be pushed
 *   migrate      plus the network and the `migrate` function, so the schema exists before anything serves
 *   application  everything
 * A stack only moves forward: going back removes what the later phase created.
 */
export type Phase = "bootstrap" | "migrate" | "application";

export interface SecretRef {
  arn: string;
  /** The field to read when the secret is JSON; otherwise the whole SecretString. */
  jsonKey?: string;
}

export interface AwsSettings {
  /** Prefix of every resource name: 3 to 25 lowercase letters, digits or hyphens (S3 bucket prefixes allow 37 characters). */
  prefix: string;
  phase: Phase;
  /** The Lambda package (deploy/aws/package.sh). */
  artifactPath?: string;
  /** Sandboxes on Bedrock AgentCore Runtime. Off: no runtime, and no image to build. */
  sandboxEnabled: boolean;
  /** The pushed sandbox image, pinned by digest (`sha256:...`). */
  sandboxImageDigest?: string;
  /** Keep each sandbox's /mnt/data in S3 checkpoints (otherwise it is lost when the session ends). */
  workspacePersistence: boolean;
  /** The browser, in the sandbox: the image has Chromium, and its relay reaches AppSync. */
  browserEnabled: boolean;
  /** HTTPS destinations the sandbox's browser may reach (IPv4 CIDRs), including the AppSync endpoints. */
  browserEgressCidrs: string[];

  vpcId?: string;
  /** At least two private subnets (no public IP on launch), with a route to the internet or the endpoints the gateway uses. */
  privateSubnetIds?: string[];
  databaseSecurityGroupId?: string;
  databasePort: number;
  /** The runtime's PostgreSQL URL (TLS on), as the whole secret or one JSON field. */
  databaseSecret?: SecretRef;
  /**
   * Optional: an owner role for the `migrate` function, as JSON with `username` and
   * `password` (the format RDS manages a master user's secret in). Without it,
   * `migrate` uses the runtime's URL, whose role must then own the schema.
   */
  migrationSecretArn?: string;
  /** Customer-managed keys that encrypt the secrets above. */
  secretKmsKeyArns: string[];
  /** Model and tool credentials, by the name agentforeach.json refers to them (`$OPENAI_API_KEY`). */
  providerSecrets: Record<string, SecretRef>;
  /** Bedrock models the gateway may invoke (when agentforeach.json selects the `bedrock` provider). */
  bedrockModelArns: string[];

  /** The `jwt` provider: tokens from your identity provider, checked against its JWKS (RS256). */
  jwtIssuer?: string;
  jwtAudience?: string;
  jwtJwksUri?: string;
  /** Exact https origins of the browser clients (CORS). */
  allowedOrigins: string[];

  schedulerEnabled: boolean;
  /** Only to match an existing deployment's CRON_SCHEDULER_SHARDS; changing it needs a migration. */
  schedulerShards?: number;
  poolSize: number;
  /** Reserved concurrency per function: -1 leaves it unreserved (low-quota accounts). Never 0. */
  reservedConcurrency: number;
  /**
   * The longest one durable execution may run. Longer work (a HITL form waits up to 6 days, an
   * alarm ticks forever) hands over to a fresh execution every 6 hours, so 8 hours leaves room
   * for the longest handler run.
   */
  durableExecutionTimeoutSeconds: number;
  /** Register the durable conformance suite's own kinds (on the durable and conformance functions). */
  conformanceKinds: boolean;
  /** API Gateway's throttle for the whole API. */
  apiThrottleRate: number;
  apiThrottleBurst: number;
  logRetentionDays: number;
  /** Pulumi protection for the buckets, repository, secrets and log key. */
  protectData: boolean;
  /** Change it to roll a new release without other changes (for example to reload rotated secrets). */
  releaseNonce: string;
  /** The agentforeach.json this deployment starts from (it is never modified). */
  applicationConfigPath: string;
}

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/**
 * The Lambda entry inside the package, and so the prefix of every function's
 * handler (`<module>.<export>`): deploy/aws/lambda.ts, bundled by
 * `npm run build:aws` into dist/deploy/aws/lambda.mjs.
 */
export const LAMBDA_HANDLER_MODULE = "dist/deploy/aws/lambda";

/** Each function: its handler export in deploy/aws/lambda.ts, and its limits. */
export const functionSpecs: Record<FunctionKind, { handler: string; timeout: number; memory: number; phase: Phase }> = {
  // Behind API Gateway, whose integration timeout is 29 s.
  http: { handler: "http", timeout: 30, memory: 1024, phase: "application" },
  // EventBridge Scheduler, every minute: the route table's schedules and the durable sweep.
  schedule: { handler: "schedule", timeout: 120, memory: 1024, phase: "application" },
  // Every durable kind (jobs, waits, alarms). An invocation runs at most 15 minutes; the
  // execution as a whole is bounded by durableExecutionTimeoutSeconds.
  durable: { handler: "durable", timeout: 900, memory: 2048, phase: "application" },
  realtimeAuthorizer: { handler: "realtimeAuthorizer", timeout: 15, memory: 256, phase: "application" },
  // Applies the schema; deploy.sh invokes it once per release.
  migrate: { handler: "migrate", timeout: 300, memory: 512, phase: "migrate" },
  // Durable conformance against the deployed durable function, run by hand.
  conformance: { handler: "conformance", timeout: 900, memory: 1024, phase: "application" },
};

export const PHASES: readonly Phase[] = ["bootstrap", "migrate", "application"];
export const reached = (s: Pick<AwsSettings, "phase">, phase: Phase) => PHASES.indexOf(s.phase) >= PHASES.indexOf(phase);

/** Secret names a deployment can't bind: AWS's and the release bootstrap's own, and what the stack sets. */
const RESERVED_SECRET_NAMES =
  /^(AWS_|AFE_|LAMBDA_|NODE_|_HANDLER$|_X_AMZN_|CONFIG_FILE_JSON$|AGENTFOREACH_RELEASE_(BUCKET|KEY)$|DATABASE_|WEBSOCKET_|APPSYNC_|OBJECT_STORE_|SANDBOX_|DURABLE_|REALTIME_|PUBLIC_BASE_URL$|CORS_|CRON_SCHEDULER_SHARDS$)/;

const SECRET_ARN = /^arn:[^:]+:secretsmanager:[^:]+:\d{12}:secret:.+$/;
const LOG_RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365];

export function validateSettings(s: AwsSettings): AwsSettings {
  if (!/^[a-z][a-z0-9-]{1,23}[a-z0-9]$/.test(s.prefix)) throw new Error("prefix must be 3 to 25 lowercase letters, digits or hyphens");
  if (!PHASES.includes(s.phase)) throw new Error("phase must be bootstrap, migrate or application");
  if (s.phase === "bootstrap") return s;

  for (const field of ["artifactPath", "vpcId", "databaseSecurityGroupId", "databaseSecret"] as const) {
    if (!s[field]) throw new Error(`${field} is required from the migrate phase on`);
  }
  if (!/^vpc-[a-f0-9]+$/.test(s.vpcId!) || !/^sg-[a-f0-9]+$/.test(s.databaseSecurityGroupId!)) {
    throw new Error("Invalid VPC or database security group id");
  }
  if (!s.privateSubnetIds || new Set(s.privateSubnetIds).size < 2 || s.privateSubnetIds.some((id) => !/^subnet-[a-f0-9]+$/.test(id))) {
    throw new Error("At least two distinct private subnets are required");
  }
  if (!Number.isInteger(s.databasePort) || s.databasePort < 1 || s.databasePort > 65535) throw new Error("Invalid databasePort");
  if (!Number.isInteger(s.poolSize) || s.poolSize < 1 || s.poolSize > 10) throw new Error("poolSize must be 1 to 10");
  if (s.reservedConcurrency !== -1 && (!Number.isInteger(s.reservedConcurrency) || s.reservedConcurrency < 1 || s.reservedConcurrency > 1000)) {
    throw new Error("reservedConcurrency must be -1 (unreserved) or 1 to 1000; 0 would stop every invocation");
  }
  if (!LOG_RETENTION_DAYS.includes(s.logRetentionDays)) throw new Error(`logRetentionDays must be one of ${LOG_RETENTION_DAYS.join(", ")}`);
  for (const [name, ref] of Object.entries({ DATABASE_URL: s.databaseSecret!, ...s.providerSecrets })) {
    if (!SECRET_ARN.test(ref.arn)) throw new Error(`Invalid secret ARN for ${name}`);
  }
  if (s.migrationSecretArn && !SECRET_ARN.test(s.migrationSecretArn)) throw new Error("Invalid migrationSecretArn");
  for (const name of Object.keys(s.providerSecrets)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || RESERVED_SECRET_NAMES.test(name)) throw new Error(`Reserved or invalid provider secret name: ${name}`);
  }
  if (s.phase === "migrate") return s;

  for (const field of ["jwtIssuer", "jwtAudience", "jwtJwksUri"] as const) {
    if (!s[field]) throw new Error(`${field} is required for the application phase`);
  }
  for (const uri of [s.jwtIssuer!, s.jwtJwksUri!, ...s.allowedOrigins]) {
    const url = new URL(uri);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error("The JWT issuer, the JWKS URL and the allowed origins must be https, without credentials");
    }
  }
  if (!s.allowedOrigins.length || s.allowedOrigins.some((origin) => new URL(origin).origin !== origin)) {
    throw new Error("allowedOrigins must list exact https origins");
  }
  if (s.sandboxEnabled && !/^sha256:[a-f0-9]{64}$/.test(s.sandboxImageDigest ?? "")) {
    throw new Error("sandboxImageDigest must pin the pushed image by its sha256 digest");
  }
  if (!s.sandboxEnabled && (s.browserEnabled || s.workspacePersistence)) {
    throw new Error("browserEnabled and workspacePersistence need sandboxEnabled");
  }
  if (s.browserEnabled && !s.browserEgressCidrs.length) {
    throw new Error("browserEnabled needs browserEgressCidrs: the HTTPS destinations the browser may reach, AppSync's included");
  }
  for (const cidr of s.browserEgressCidrs) {
    const [address, bits, extra] = cidr.split("/");
    const octets = address.split(".");
    if (
      extra !== undefined ||
      !/^\d+$/.test(bits ?? "") ||
      Number(bits) > 32 ||
      octets.length !== 4 ||
      octets.some((v) => !/^\d+$/.test(v) || Number(v) > 255)
    ) {
      throw new Error(`Invalid browser egress IPv4 CIDR: ${cidr}`);
    }
  }
  if (s.schedulerShards !== undefined && (!Number.isInteger(s.schedulerShards) || s.schedulerShards < 1 || s.schedulerShards > 128)) {
    throw new Error("schedulerShards must be 1 to 128");
  }
  if (!Number.isInteger(s.durableExecutionTimeoutSeconds) || s.durableExecutionTimeoutSeconds <= 6 * 3600 + functionSpecs.durable.timeout || s.durableExecutionTimeoutSeconds > 31_622_400) {
    throw new Error("durableExecutionTimeoutSeconds must be whole seconds exceeding the six-hour handover interval plus the handler budget, at most 31622400 (366 days)");
  }
  for (const value of [s.apiThrottleRate, s.apiThrottleBurst]) {
    if (!Number.isFinite(value) || value < 1) throw new Error("apiThrottleRate and apiThrottleBurst must be at least 1");
  }
  return s;
}

/** The chat namespace (IAM publish only) and the browser relay's (Lambda-authorized both ways). */
export const EVENTS_NAMESPACE = "agentforeach";
export const BROWSER_EVENTS_NAMESPACE = "agentforeach-browser";

/**
 * The AWS choices, applied to a copy of agentforeach.json: PostgreSQL, the
 * `jwt` provider, AppSync Events and the AgentCore sandbox. The source file
 * is never changed; `$NAME` values are resolved from the release's
 * environment and secrets when the function starts.
 */
export function awsApplicationConfig(base: Record<string, any>, s: AwsSettings): Record<string, unknown> {
  const sandbox = base.skills?.sandbox ?? {};
  return {
    ...base,
    database: { ...base.database, provider: "postgres", connectionString: "$DATABASE_URL", poolSize: s.poolSize, provisionContainers: false },
    auth: {
      ...base.auth,
      providers: [
        { type: "jwt", enabled: true, algorithm: "RS256", issuer: s.jwtIssuer, audience: s.jwtAudience, jwksUri: s.jwtJwksUri, requireExp: true, userIdClaim: "sub" },
      ],
    },
    websocket: { ...base.websocket, provider: "aws-appsync-events" },
    skills: {
      ...base.skills,
      sandbox: s.sandboxEnabled
        ? {
            ...sandbox,
            enabled: true,
            provider: "aws-agentcore",
            // No egress proxy on AWS: the sandbox reaches only what its security group allows.
            networkAccess: s.browserEnabled ? "enabled" : "disabled",
            browser: { ...sandbox.browser, enabled: s.browserEnabled },
            aws: {
              ...sandbox.aws,
              runtimeArn: "$AWS_SANDBOX_RUNTIME_ARN",
              qualifier: "$AWS_SANDBOX_QUALIFIER",
              storageMode: s.workspacePersistence ? "s3-checkpoint" : "ephemeral",
              serverToken: "$AWS_SANDBOX_SERVER_TOKEN",
              browser: s.browserEnabled,
              ...(s.workspacePersistence ? { persistenceLimits: { maxBytes: 32 * 1024 * 1024, maxFiles: 10000 } } : {}),
              ...(s.workspacePersistence ? { workspaceBucket: "$AWS_SANDBOX_WORKSPACE_BUCKET" } : {}),
            },
          }
        : { ...sandbox, enabled: false },
    },
  };
}

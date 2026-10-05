/**
 * The AgentForEach application stack on AWS (Pulumi project `agentforeach-aws`).
 * Settings are this project's stack config: see Pulumi.example.yaml and docs/AWS.md.
 *
 *   npm run build --workspace @agentforeach/deploy-aws
 *   pulumi -C deploy/aws/infra preview
 *
 * deploy/aws/deploy.sh runs the phases in order (bootstrap, migrate, application).
 */

import { fileURLToPath } from "node:url";
import * as pulumi from "@pulumi/pulumi";
import { createAwsStack } from "./stack.js";
import type { Phase, SecretRef } from "./settings.js";

const cfg = new pulumi.Config();
const databaseSecretArn = cfg.get("databaseSecretArn");
const databaseSecretJsonKey = cfg.get("databaseSecretJsonKey");

const stack = createAwsStack({
  prefix: cfg.get("prefix") ?? `afe-${pulumi.getStack()}`,
  phase: (cfg.get("phase") as Phase | undefined) ?? "bootstrap",
  artifactPath: cfg.get("artifactPath"),
  sandboxEnabled: cfg.getBoolean("sandboxEnabled") ?? true,
  sandboxImageDigest: cfg.get("sandboxImageDigest"),
  workspacePersistence: cfg.getBoolean("workspacePersistence") ?? false,
  browserEnabled: cfg.getBoolean("browserEnabled") ?? false,
  browserEgressCidrs: cfg.getObject<string[]>("browserEgressCidrs") ?? [],
  vpcId: cfg.get("vpcId"),
  privateSubnetIds: cfg.getObject<string[]>("privateSubnetIds"),
  databaseSecurityGroupId: cfg.get("databaseSecurityGroupId"),
  databasePort: cfg.getNumber("databasePort") ?? 5432,
  databaseSecret: databaseSecretArn ? { arn: databaseSecretArn, ...(databaseSecretJsonKey ? { jsonKey: databaseSecretJsonKey } : {}) } : undefined,
  migrationSecretArn: cfg.get("migrationSecretArn"),
  secretKmsKeyArns: cfg.getObject<string[]>("secretKmsKeyArns") ?? [],
  providerSecrets: cfg.getObject<Record<string, SecretRef>>("providerSecrets") ?? {},
  bedrockModelArns: cfg.getObject<string[]>("bedrockModelArns") ?? [],
  jwtIssuer: cfg.get("jwtIssuer"),
  jwtAudience: cfg.get("jwtAudience"),
  jwtJwksUri: cfg.get("jwtJwksUri"),
  allowedOrigins: cfg.getObject<string[]>("allowedOrigins") ?? [],
  schedulerEnabled: cfg.getBoolean("schedulerEnabled") ?? true,
  schedulerShards: cfg.getNumber("schedulerShards"),
  poolSize: cfg.getNumber("poolSize") ?? 2,
  reservedConcurrency: cfg.getNumber("reservedConcurrency") ?? -1,
  durableExecutionTimeoutSeconds: cfg.getNumber("durableExecutionTimeoutSeconds") ?? 8 * 3600,
  conformanceKinds: cfg.getBoolean("conformanceKinds") ?? false,
  apiThrottleRate: cfg.getNumber("apiThrottleRate") ?? 50,
  apiThrottleBurst: cfg.getNumber("apiThrottleBurst") ?? 100,
  logRetentionDays: cfg.getNumber("logRetentionDays") ?? 30,
  protectData: cfg.getBoolean("protectData") ?? true,
  releaseNonce: cfg.get("releaseNonce") ?? "",
  applicationConfigPath:
    cfg.get("applicationConfigPath") ?? fileURLToPath(new URL("../../../../gateway/config/agentforeach.json", import.meta.url)),
});

export const artifactBucket = stack.artifactBucket;
export const sandboxRepository = stack.sandboxRepository;
export const release = stack.release;
export const migrateFunctionArn = stack.migrateFunctionArn;
export const conformanceFunctionArn = stack.conformanceFunctionArn;
export const httpFunctionName = stack.httpFunctionName;
export const durableFunctionArn = stack.durableFunctionArn;
export const apiUrl = stack.apiUrl;
export const realtimeUrl = stack.realtimeUrl;
export const sandboxRuntimeArn = stack.sandboxRuntimeArn;
export const skillsBucket = stack.skillsBucket;
export const exportsBucket = stack.exportsBucket;
export const workspaceBucket = stack.workspaceBucket;
export const gatewaySecurityGroupId = stack.gatewaySecurityGroupId;

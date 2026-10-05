/**
 * The evaluation foundation (see stack.ts and docs/AWS.md): a VPC, RDS
 * PostgreSQL and a Cognito pool for an account that has none. Its outputs are
 * the application stack's network, database and sign-in settings.
 */

import * as pulumi from "@pulumi/pulumi";
import { createFoundation } from "./stack.js";

const cfg = new pulumi.Config();
const foundation = createFoundation({
  prefix: cfg.get("prefix") ?? "afe-eval",
  engineVersion: cfg.get("engineVersion") ?? "17.11",
  instanceClass: cfg.get("instanceClass") ?? "db.t4g.small",
});

export const vpcId = foundation.vpcId;
export const privateSubnetIds = foundation.privateSubnetIds;
export const databaseSecurityGroupId = foundation.databaseSecurityGroupId;
export const databaseHost = foundation.databaseHost;
export const databaseSecretArn = foundation.databaseSecretArn;
export const migrationSecretArn = foundation.migrationSecretArn;
export const jwtIssuer = foundation.jwtIssuer;
export const jwtAudience = foundation.jwtAudience;
export const jwtJwksUri = foundation.jwtJwksUri;
export const userPoolId = foundation.userPoolId;

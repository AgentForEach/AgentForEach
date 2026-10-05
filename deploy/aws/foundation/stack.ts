/**
 * The evaluation foundation (Pulumi project `agentforeach-aws-foundation`):
 * what the application stack expects to exist, for an account that has none
 * of it. A new VPC with two private subnets and one NAT gateway, an S3
 * gateway endpoint, a private RDS PostgreSQL (TLS required, deletion
 * protected), the runtime's database credential in Secrets Manager, and a
 * Cognito pool whose users only an administrator can create (for the live
 * tests).
 *
 * It is a single-AZ evaluation design, not a production one: one NAT, one
 * database instance. Everything here is billable while it exists.
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { policy } from "../infra/policies.js";

export interface FoundationSettings {
  /** Prefix of the resource names (3 to 25 lowercase letters, digits or hyphens). */
  prefix: string;
  /** PostgreSQL engine version; its major version picks the parameter group family. */
  engineVersion: string;
  instanceClass: string;
}

/** The runtime's database role. The application's `migrate` function creates it and grants it the tables. */
export const APPLICATION_DATABASE_USER = "afe_app";

export function createFoundation(s: FoundationSettings) {
  if (!/^[a-z][a-z0-9-]{1,23}[a-z0-9]$/.test(s.prefix)) throw new Error("prefix must be 3 to 25 lowercase letters, digits or hyphens");
  if (!/^\d+(\.\d+)?$/.test(s.engineVersion)) throw new Error("engineVersion must look like 17 or 17.4");
  const region = aws.getRegionOutput().region;
  const account = aws.getCallerIdentityOutput().accountId;
  const zones = aws.getAvailabilityZonesOutput({ state: "available" }).names;
  const tags = { Application: "AgentForEach", Environment: "evaluation", ManagedBy: "Pulumi", Stack: pulumi.getStack() };

  // ==========================================================================
  // Network: private subnets for the functions, the sandboxes and the database
  // ==========================================================================

  const vpc = new aws.ec2.Vpc("eval-vpc", { cidrBlock: "10.82.0.0/16", enableDnsHostnames: true, enableDnsSupport: true, tags });
  const internet = new aws.ec2.InternetGateway("eval-internet", { vpcId: vpc.id, tags });
  const publicSubnet = new aws.ec2.Subnet("eval-public", {
    vpcId: vpc.id,
    cidrBlock: "10.82.0.0/24",
    availabilityZone: zones.apply((z) => z[0]),
    mapPublicIpOnLaunch: false,
    tags,
  });
  const privateSubnets = [0, 1].map(
    (i) =>
      new aws.ec2.Subnet(`eval-private-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.82.${i + 10}.0/24`,
        availabilityZone: zones.apply((z) => z[i]),
        mapPublicIpOnLaunch: false,
        tags,
      }),
  );
  const publicRoutes = new aws.ec2.RouteTable("eval-public-routes", { vpcId: vpc.id, routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: internet.id }], tags });
  new aws.ec2.RouteTableAssociation("eval-public-routes", { subnetId: publicSubnet.id, routeTableId: publicRoutes.id });
  // The functions reach model providers and JWKS through it. The sandboxes have no route out:
  // their security group allows only the private endpoints and S3.
  const natAddress = new aws.ec2.Eip("eval-nat-ip", { domain: "vpc", tags });
  const nat = new aws.ec2.NatGateway("eval-nat", { subnetId: publicSubnet.id, allocationId: natAddress.id, tags }, { dependsOn: [internet] });
  const privateRoutes = new aws.ec2.RouteTable("eval-private-routes", { vpcId: vpc.id, routes: [{ cidrBlock: "0.0.0.0/0", natGatewayId: nat.id }], tags });
  privateSubnets.forEach((subnet, i) => new aws.ec2.RouteTableAssociation(`eval-private-routes-${i}`, { subnetId: subnet.id, routeTableId: privateRoutes.id }));
  // S3 without the NAT: ECR's image layers (AWS's own bucket) and this account's buckets only.
  new aws.ec2.VpcEndpoint("eval-s3", {
    vpcId: vpc.id,
    serviceName: pulumi.interpolate`com.amazonaws.${region}.s3`,
    vpcEndpointType: "Gateway",
    routeTableIds: [privateRoutes.id],
    policy: pulumi.all([region, account]).apply(([r, a]) =>
      policy([
        { Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::prod-${r}-starport-layer-bucket/*` },
        { Effect: "Allow", Principal: "*", Action: "s3:*", Resource: "*", Condition: { StringEquals: { "aws:PrincipalAccount": a, "s3:ResourceAccount": a } } },
      ]),
    ),
    tags,
  });

  // ==========================================================================
  // PostgreSQL: private, encrypted, TLS required; the application stack adds its own ingress rule
  // ==========================================================================

  const databaseNetwork = new aws.ec2.SecurityGroup(
    "eval-database-network",
    { vpcId: vpc.id, description: "Private PostgreSQL; the application stack grants its functions ingress", ingress: [], egress: [], tags },
    { ignoreChanges: ["ingress"] },
  );
  const databaseSubnets = new aws.rds.SubnetGroup("eval-database-subnets", { subnetIds: privateSubnets.map((subnet) => subnet.id), tags });
  const parameters = new aws.rds.ParameterGroup("eval-database-parameters", {
    family: `postgres${s.engineVersion.split(".")[0]}`,
    parameters: [{ name: "rds.force_ssl", value: "1", applyMethod: "pending-reboot" }],
    tags,
  });
  const database = new aws.rds.Instance(
    "eval-database",
    {
      identifier: `${s.prefix}-postgres`,
      engine: "postgres",
      engineVersion: s.engineVersion,
      instanceClass: s.instanceClass,
      allocatedStorage: 20,
      maxAllocatedStorage: 40,
      storageType: "gp3",
      storageEncrypted: true,
      dbName: "agentforeach",
      // The owner role, for migrations only; RDS keeps its password in Secrets Manager.
      username: "afe_migration",
      manageMasterUserPassword: true,
      dbSubnetGroupName: databaseSubnets.name,
      vpcSecurityGroupIds: [databaseNetwork.id],
      parameterGroupName: parameters.name,
      publiclyAccessible: false,
      multiAz: false,
      backupRetentionPeriod: 1,
      autoMinorVersionUpgrade: true,
      deletionProtection: true,
      skipFinalSnapshot: false,
      finalSnapshotIdentifier: `${s.prefix}-final`,
      copyTagsToSnapshot: true,
      tags,
    },
    { protect: true },
  );
  const applicationPassword = new random.RandomPassword("eval-application-password", { length: 40, special: false });
  const applicationSecret = new aws.secretsmanager.Secret(
    "eval-database-secret",
    { namePrefix: `${s.prefix}-postgres-`, description: "The AgentForEach runtime's PostgreSQL URL", recoveryWindowInDays: 7, tags },
    { protect: true },
  );
  const applicationSecretValue = new aws.secretsmanager.SecretVersion("eval-database-secret-value", {
    secretId: applicationSecret.id,
    secretString: pulumi.all([database.address, applicationPassword.result]).apply(([host, password]) =>
      JSON.stringify({
        username: APPLICATION_DATABASE_USER,
        password,
        host,
        database: "agentforeach",
        port: 5432,
        // Lambda's Node runtime ships the RDS certificate authorities in this bundle.
        DATABASE_URL: `postgresql://${APPLICATION_DATABASE_USER}:${encodeURIComponent(password)}@${host}:5432/agentforeach?sslmode=verify-full&sslrootcert=/var/runtime/ca-cert.pem`,
      }),
    ),
  });

  // ==========================================================================
  // Test identities: only an administrator creates users (the live tests do, and delete them)
  // ==========================================================================

  const users = new aws.cognito.UserPool(
    "eval-users",
    {
      name: `${s.prefix}-users`,
      adminCreateUserConfig: { allowAdminCreateUserOnly: true },
      passwordPolicy: { minimumLength: 16, requireLowercase: true, requireUppercase: true, requireNumbers: true, requireSymbols: true },
      // Off only because the users are synthetic and created by the tests.
      mfaConfiguration: "OFF",
      deletionProtection: "ACTIVE",
      tags,
    },
    { protect: true },
  );
  const client = new aws.cognito.UserPoolClient("eval-client", {
    name: `${s.prefix}-test-runner`,
    userPoolId: users.id,
    generateSecret: false,
    explicitAuthFlows: ["ALLOW_ADMIN_USER_PASSWORD_AUTH"],
    preventUserExistenceErrors: "ENABLED",
    enableTokenRevocation: true,
    accessTokenValidity: 15,
    idTokenValidity: 15,
    refreshTokenValidity: 1,
    tokenValidityUnits: { accessToken: "minutes", idToken: "minutes", refreshToken: "days" },
  });
  const issuer = pulumi.interpolate`https://cognito-idp.${region}.amazonaws.com/${users.id}`;

  return {
    vpcId: vpc.id,
    privateSubnetIds: pulumi.all(privateSubnets.map((subnet) => subnet.id)),
    databaseSecurityGroupId: databaseNetwork.id,
    databaseHost: database.address,
    // Once it has a value: the application stack reads it as soon as it has the ARN.
    databaseSecretArn: pulumi.all([applicationSecret.arn, applicationSecretValue.id]).apply(([arn]) => arn),
    migrationSecretArn: database.masterUserSecrets.apply((secrets) => secrets[0].secretArn),
    jwtIssuer: issuer,
    jwtAudience: client.id,
    jwtJwksUri: pulumi.interpolate`${issuer}/.well-known/jwks.json`,
    userPoolId: users.id,
  };
}

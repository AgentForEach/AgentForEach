/**
 * AgentForEach on AWS: the application stack (docs/AWS.md).
 *
 * One Lambda package, a function per handler of deploy/aws/lambda.ts:
 *   http                API Gateway HTTP API (payload v2), the gateway's routes
 *   schedule            EventBridge Scheduler, every minute: the route table's schedules and the durable sweep
 *   durable             every durable kind (jobs, waits, alarms), as a Lambda durable function
 *   realtimeAuthorizer  AppSync Events' Lambda authorizer (connect and subscribe)
 *   migrate             applies the database schema; deploy.sh invokes it once per release
 *   conformance         the durable conformance suite against the deployed durable function, by hand
 *
 * Plus AppSync Events for realtime (publish with IAM only), S3 for skills and
 * exports, Bedrock AgentCore Runtime for sandboxes, and Secrets Manager. The
 * VPC and PostgreSQL are yours (or the evaluation foundation's): this stack
 * never creates or replaces them.
 *
 * Settings and their checks are in settings.ts, the IAM in policies.ts.
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  awsApplicationConfig,
  BROWSER_EVENTS_NAMESPACE,
  EVENTS_NAMESPACE,
  functionSpecs,
  LAMBDA_HANDLER_MODULE,
  reached,
  sha256,
  validateSettings,
  type AwsSettings,
  type SecretRef,
} from "./settings.js";
import { APPLICATION_KINDS, functionGrants, functionName, policy, VPC_KINDS, type FunctionKind } from "./policies.js";

export interface AwsStackOutputs {
  artifactBucket: pulumi.Output<string>;
  sandboxRepository?: pulumi.Output<string>;
  release?: pulumi.Output<string>;
  /** The published versions deploy.sh and the live checks invoke. */
  migrateFunctionArn?: pulumi.Output<string>;
  conformanceFunctionArn?: pulumi.Output<string>;
  httpFunctionName?: pulumi.Output<string>;
  durableFunctionArn?: pulumi.Output<string>;
  apiUrl?: pulumi.Output<string>;
  realtimeUrl?: pulumi.Output<string>;
  sandboxRuntimeArn?: pulumi.Output<string>;
  skillsBucket?: pulumi.Output<string>;
  exportsBucket?: pulumi.Output<string>;
  workspaceBucket?: pulumi.Output<string>;
  gatewaySecurityGroupId?: pulumi.Output<string>;
  /** Resolves once every function, manifest, route and schedule exists. */
  deploymentReady?: pulumi.Output<boolean>;
}

/** A release manifest: what the release bootstrap (deploy/aws/bootstrap.ts) loads before the gateway starts. */
interface Manifest {
  version: 1;
  config: Record<string, unknown>;
  environment: Record<string, string>;
  secrets: Record<string, SecretRef>;
}

export function createAwsStack(input: AwsSettings): AwsStackOutputs {
  const s = validateSettings(input);
  const prefix = s.prefix;
  const region = aws.getRegionOutput().region;
  const account = aws.getCallerIdentityOutput().accountId;
  const tags = { Application: "AgentForEach", Stack: pulumi.getStack(), ManagedBy: "Pulumi" };
  // Data outlives the stack unless a teardown removes it deliberately (deploy/aws/teardown.sh).
  const keepData = { protect: s.protectData, retainOnDelete: true };

  // ==========================================================================
  // Bootstrap: the artifacts bucket and the sandbox image repository
  // ==========================================================================

  /**
   * A private bucket: public access blocked, owner-enforced, encrypted, TLS
   * only. Application buckets are never versioned, so erasing a user leaves
   * no old versions behind; their policy refuses turning versioning on.
   */
  function privateBucket(name: string, kind: "artifacts" | "application") {
    const bucket = new aws.s3.Bucket(name, { bucketPrefix: `${prefix}-${name}-`, forceDestroy: false, tags }, keepData);
    new aws.s3.BucketPublicAccessBlock(`${name}-private`, {
      bucket: bucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    new aws.s3.BucketOwnershipControls(`${name}-ownership`, { bucket: bucket.id, rule: { objectOwnership: "BucketOwnerEnforced" } });
    new aws.s3.BucketServerSideEncryptionConfiguration(`${name}-encryption`, {
      bucket: bucket.id,
      rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
    });
    if (kind === "artifacts") {
      // Release history: old manifests and packages stay readable while their versions drain.
      new aws.s3.BucketVersioning(`${name}-versions`, { bucket: bucket.id, versioningConfiguration: { status: "Enabled" } });
    }
    new aws.s3.BucketPolicy(`${name}-tls`, {
      bucket: bucket.id,
      policy: bucket.arn.apply((arn) =>
        policy([
          { Effect: "Deny", Principal: "*", Action: "s3:*", Resource: [arn, `${arn}/*`], Condition: { Bool: { "aws:SecureTransport": "false" } } },
          ...(kind === "application" ? [{ Effect: "Deny" as const, Principal: "*", Action: "s3:PutBucketVersioning", Resource: arn }] : []),
        ]),
      ),
    });
    return bucket;
  }

  const artifacts = privateBucket("artifacts", "artifacts");
  const repository = s.sandboxEnabled
    ? new aws.ecr.Repository(
        "sandbox-image",
        {
          name: `${prefix}-sandbox`,
          imageTagMutability: "IMMUTABLE",
          imageScanningConfiguration: { scanOnPush: true },
          encryptionConfigurations: [{ encryptionType: "AES256" }],
          forceDelete: false,
          tags,
        },
        keepData,
      )
    : undefined;
  const outputs: AwsStackOutputs = { artifactBucket: artifacts.bucket, sandboxRepository: repository?.repositoryUrl };
  if (s.phase === "bootstrap") return outputs;

  // ==========================================================================
  // The release: the package, and a release id that changes with anything it depends on
  // ==========================================================================

  const application = reached(s, "application");
  const appConfig = application ? awsApplicationConfig(JSON.parse(readFileSync(s.applicationConfigPath, "utf8")), s) : {};
  const zipHash = sha256(readFileSync(s.artifactPath!));
  const here = dirname(fileURLToPath(import.meta.url));
  const infraHash = sha256(
    readdirSync(here)
      .filter((f) => /\.(ts|js)$/.test(f) && !f.includes(".test."))
      .sort()
      .map((f) => readFileSync(join(here, f), "utf8"))
      .join("\n"),
  );
  const revision = new random.RandomId("release", {
    byteLength: 12,
    keepers: { zipHash, settings: sha256(JSON.stringify(s)), config: sha256(JSON.stringify(appConfig)), infraHash },
  });
  const code = new aws.s3.BucketObjectv2(
    "lambda-package",
    { bucket: artifacts.id, key: pulumi.interpolate`releases/${revision.hex}/package.zip`, source: new pulumi.asset.FileAsset(s.artifactPath!) },
    { retainOnDelete: true },
  );

  // ==========================================================================
  // Network: your VPC and database, checked, never changed beyond one ingress rule
  // ==========================================================================

  const subnetIds = s.privateSubnetIds!.map((id) =>
    aws.ec2.getSubnetOutput({ id }).apply((subnet) => {
      if (subnet.vpcId !== s.vpcId || subnet.mapPublicIpOnLaunch) throw new Error(`Subnet ${id} must be private and in ${s.vpcId}`);
      return id;
    }),
  );
  const databaseGroup = aws.ec2.getSecurityGroupOutput({ id: s.databaseSecurityGroupId }).apply((group) => {
    if (group.vpcId !== s.vpcId) throw new Error("The database security group is in another VPC");
    return group.id;
  });
  const gatewayNetwork = new aws.ec2.SecurityGroup("gateway-network", {
    namePrefix: `${prefix}-gateway-`,
    vpcId: s.vpcId,
    description: "AgentForEach functions: HTTPS out and PostgreSQL; nothing in",
    ingress: [],
    egress: [
      { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"], description: "AWS APIs, model providers and JWKS, through VPC routing" },
      { protocol: "tcp", fromPort: s.databasePort, toPort: s.databasePort, securityGroups: [databaseGroup], description: "PostgreSQL" },
    ],
    tags,
  });
  new aws.ec2.SecurityGroupRule("database-from-gateway", {
    type: "ingress",
    securityGroupId: databaseGroup,
    sourceSecurityGroupId: gatewayNetwork.id,
    protocol: "tcp",
    fromPort: s.databasePort,
    toPort: s.databasePort,
    description: "AgentForEach functions",
  });

  const logKey = new aws.kms.Key(
    "log-key",
    {
      enableKeyRotation: true,
      deletionWindowInDays: 30,
      policy: pulumi.all([region, account]).apply(([r, a]) =>
        policy([
          { Effect: "Allow", Principal: { AWS: `arn:aws:iam::${a}:root` }, Action: "kms:*", Resource: "*" },
          {
            Effect: "Allow",
            Principal: { Service: `logs.${r}.amazonaws.com` },
            Action: ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"],
            Resource: "*",
            Condition: {
              ArnLike: {
                "kms:EncryptionContext:aws:logs:arn": [
                  `arn:aws:logs:${r}:${a}:log-group:/aws/lambda/${prefix}-*`,
                  `arn:aws:logs:${r}:${a}:log-group:/aws/bedrock-agentcore/runtimes/${runtimeName(prefix)}*`,
                ],
              },
            },
          },
        ]),
      ),
      tags,
    },
    keepData,
  );

  // ==========================================================================
  // Application: secrets, buckets, the sandbox runtime
  // ==========================================================================

  function generatedSecret(name: string, description: string) {
    const secret = new aws.secretsmanager.Secret(name, { namePrefix: `${prefix}-${name}-`, description, recoveryWindowInDays: 30, tags }, keepData);
    const value = new random.RandomPassword(`${name}-value`, { length: 64, special: false });
    const version = new aws.secretsmanager.SecretVersion(`${name}-version`, { secretId: secret.id, secretString: value.result });
    return { secret, value, version };
  }

  const signing = application ? generatedSecret("realtime-signing-key", "Signs AgentForEach realtime tokens") : undefined;
  const sandboxToken = application && s.sandboxEnabled ? generatedSecret("sandbox-token", "Authorizes the gateway to the sandbox server") : undefined;
  const skills = application ? privateBucket("skills", "application") : undefined;
  const exports = application ? privateBucket("exports", "application") : undefined;
  const workspaces = application && s.workspacePersistence ? privateBucket("workspaces", "application") : undefined;
  if (exports) {
    new aws.s3.BucketLifecycleConfiguration("export-retention", {
      bucket: exports.id,
      rules: [
        { id: "expire-generated-downloads", status: "Enabled", filter: {}, expiration: { days: 7 }, abortIncompleteMultipartUpload: { daysAfterInitiation: 1 } },
      ],
    });
  }

  const sandbox = application && s.sandboxEnabled ? createSandboxRuntime() : undefined;
  // Schedule ticks EventBridge couldn't deliver, and the schedule function's failed async invocations.
  const deadLetters = application
    ? new aws.sqs.Queue("schedule-dlq", { name: `${prefix}-schedule-dlq`, sqsManagedSseEnabled: true, messageRetentionSeconds: 1_209_600, tags })
    : undefined;

  /**
   * The AgentCore runtime: the shared sandbox image (ARM64) from ECR, invoked
   * with IAM (SigV4) only, in the VPC with no route to the internet. It pulls
   * its image and writes its logs through private endpoints, and reaches S3
   * through the VPC's gateway endpoint. Its role can do nothing else.
   */
  function createSandboxRuntime() {
    const s3Prefixes = aws.ec2.getPrefixListOutput({ name: pulumi.interpolate`com.amazonaws.${region}.s3` });
    const sandboxNetwork = new aws.ec2.SecurityGroup(
      "sandbox-network",
      {
        namePrefix: `${prefix}-sandbox-`,
        vpcId: s.vpcId,
        description: "AgentForEach sandboxes: private AWS endpoints only; no internet",
        ingress: [],
        egress: [{ protocol: "tcp", fromPort: 443, toPort: 443, prefixListIds: [s3Prefixes.id], description: "Image layers, through the S3 gateway endpoint" }],
        tags,
      },
      // AgentCore's network interfaces can outlive a replacement by hours; the rules below are managed separately.
      { retainOnDelete: true, ignoreChanges: ["egress"] },
    );
    if (s.browserEnabled) {
      new aws.ec2.SecurityGroupRule("sandbox-browser-https", {
        type: "egress",
        securityGroupId: sandboxNetwork.id,
        protocol: "tcp",
        fromPort: 443,
        toPort: 443,
        cidrBlocks: s.browserEgressCidrs,
        description: "Browser HTTPS destinations, including AppSync",
      });
    }
    const endpointNetwork = new aws.ec2.SecurityGroup("sandbox-service-network", {
      vpcId: s.vpcId,
      description: "Private endpoints for the sandbox runtime",
      ingress: [{ protocol: "tcp", fromPort: 443, toPort: 443, securityGroups: [sandboxNetwork.id, gatewayNetwork.id] }],
      egress: [],
      tags,
    });
    const endpointAccess = new aws.ec2.SecurityGroupRule("sandbox-to-private-services", {
      type: "egress",
      securityGroupId: sandboxNetwork.id,
      sourceSecurityGroupId: endpointNetwork.id,
      protocol: "tcp",
      fromPort: 443,
      toPort: 443,
    });
    const endpoints = ["ecr.api", "ecr.dkr", "logs"].map(
      (service) =>
        new aws.ec2.VpcEndpoint(`sandbox-${service.replaceAll(".", "-")}`, {
          vpcId: s.vpcId!,
          vpcEndpointType: "Interface",
          serviceName: pulumi.interpolate`com.amazonaws.${region}.${service}`,
          subnetIds,
          securityGroupIds: [endpointNetwork.id],
          privateDnsEnabled: true,
          // A wildcard principal limited to this account: naming the account root alone didn't authorize the roles.
          policy: account.apply((a) =>
            policy([
              { Effect: "Allow", Principal: "*", Action: service === "logs" ? "logs:*" : "ecr:*", Resource: "*", Condition: { StringEquals: { "aws:PrincipalAccount": a } } },
            ]),
          ),
          tags,
        }),
    );

    const role = new aws.iam.Role("sandbox-role", {
      assumeRolePolicy: pulumi.all([region, account]).apply(([r, a]) =>
        policy([
          {
            Effect: "Allow",
            Principal: { Service: "bedrock-agentcore.amazonaws.com" },
            Action: "sts:AssumeRole",
            Condition: { StringEquals: { "aws:SourceAccount": a }, ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:${r}:${a}:runtime/${runtimeName(prefix)}*` } },
          },
        ]),
      ),
      tags,
    });
    const rolePolicy = new aws.iam.RolePolicy("sandbox-policy", {
      role: role.id,
      policy: pulumi.all([region, account, repository!.arn]).apply(([r, a, ecr]) =>
        policy([
          { Effect: "Allow", Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource: ecr },
          { Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
          {
            Effect: "Allow",
            Action: ["logs:DescribeLogStreams", "logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: `arn:aws:logs:${r}:${a}:log-group:/aws/bedrock-agentcore/runtimes/${runtimeName(prefix)}*:*`,
          },
        ]),
      ),
    });

    const runtime = new aws.bedrock.AgentcoreAgentRuntime(
      "sandbox",
      {
        agentRuntimeName: runtimeName(prefix),
        roleArn: role.arn,
        agentRuntimeArtifact: { containerConfiguration: { containerUri: pulumi.interpolate`${repository!.repositoryUrl}@${s.sandboxImageDigest}` } },
        networkConfiguration: { networkMode: "VPC", networkModeConfig: { subnets: subnetIds, securityGroups: [sandboxNetwork.id] } },
        // No authorizerConfiguration: inbound calls are signed with IAM (SigV4).
        protocolConfiguration: { serverProtocol: "HTTP" },
        lifecycleConfigurations: [{ idleRuntimeSessionTimeout: 900, maxLifetime: 3600 }],
        filesystemConfigurations: [],
        environmentVariables: {
          SANDBOX_SERVER_TOKEN: sandboxToken!.value.result,
          SANDBOX_ENV_FILE: "memory",
          ...(s.workspacePersistence ? { SANDBOX_ARCHIVE_MAX_BYTES: String(32 * 1024 * 1024), SANDBOX_ARCHIVE_MAX_FILES: "10000" } : {}),
        },
        tags,
      },
      { dependsOn: [rolePolicy, endpointAccess, ...endpoints] },
    );
    // One endpoint per runtime version, reused by application-only releases: sessions keep
    // the endpoint they started on, and AgentCore limits endpoints per runtime.
    const endpoint = new aws.bedrock.AgentcoreAgentRuntimeEndpoint(
      "sandbox-endpoint",
      { agentRuntimeId: runtime.agentRuntimeId, agentRuntimeVersion: runtime.agentRuntimeVersion, name: runtime.agentRuntimeVersion.apply((v) => `version_${v}`), tags },
      { retainOnDelete: true },
    );
    const logs = new aws.cloudwatch.LogGroup(
      "sandbox-logs",
      { name: pulumi.interpolate`/aws/bedrock-agentcore/runtimes/${runtime.agentRuntimeId}-${endpoint.name}`, kmsKeyId: logKey.arn, retentionInDays: s.logRetentionDays, tags },
      { retainOnDelete: true },
    );
    return { runtime, endpoint, logs };
  }

  // ==========================================================================
  // Functions: one role, log group and policy each; every caller uses published versions
  // ==========================================================================

  const kinds = (Object.keys(functionSpecs) as FunctionKind[]).filter((kind) => reached(s, functionSpecs[kind].phase));
  /** The Secrets Manager secrets each function's manifest binds, by environment name. */
  const secretsOf = (kind: FunctionKind): Record<string, pulumi.Input<SecretRef>> => {
    const database = { DATABASE_URL: s.databaseSecret! };
    if (kind === "migrate") {
      return {
        ...database,
        ...(s.migrationSecretArn
          ? { DATABASE_MIGRATION_USER: { arn: s.migrationSecretArn, jsonKey: "username" }, DATABASE_MIGRATION_PASSWORD: { arn: s.migrationSecretArn, jsonKey: "password" } }
          : {}),
      };
    }
    const realtime = { APPSYNC_TOKEN_SECRET: signing!.secret.arn.apply((arn) => ({ arn })) };
    if (kind === "realtimeAuthorizer") return realtime;
    return {
      ...database,
      ...s.providerSecrets,
      ...realtime,
      ...(sandboxToken ? { AWS_SANDBOX_SERVER_TOKEN: sandboxToken.secret.arn.apply((arn) => ({ arn })) } : {}),
    };
  };

  const eventsHolder: { api?: aws.appsync.Api } = {};
  const functions = {} as Record<FunctionKind, aws.lambda.Function>;
  const http = application ? new aws.apigatewayv2.Api("http-api", { name: `${prefix}-http`, protocolType: "HTTP", tags }) : undefined;
  const manifests: aws.s3.BucketObjectv2[] = [];
  /** The new release's schema migration: nothing serves the new versions until it has run. */
  let migration: aws.lambda.Invocation | undefined;
  // migrate first: everything that switches callers to the new release waits for it. Then the
  // authorizer: the Events API needs it, and the other functions' policies need the API.
  const rank = (kind: FunctionKind) => (kind === "migrate" ? 0 : kind === "realtimeAuthorizer" ? 1 : 2);
  const order = [...kinds].sort((a, b) => rank(a) - rank(b));
  for (const kind of order) {
    const spec = functionSpecs[kind];
    const name = functionName(prefix, kind);
    const role = new aws.iam.Role(`${kind}-role`, {
      assumeRolePolicy: policy([{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }]),
      tags,
    });
    const log = new aws.cloudwatch.LogGroup(`${kind}-logs`, { name: `/aws/lambda/${name}`, retentionInDays: s.logRetentionDays, kmsKeyId: logKey.arn, tags }, { retainOnDelete: true });
    const secretArns = pulumi.all(Object.values(secretsOf(kind))).apply((refs) => [...new Set(refs.map((ref) => ref.arn))]);
    const grants = new aws.iam.RolePolicy(`${kind}-policy`, {
      role: role.id,
      policy: pulumi
        .output({
          r: region,
          a: account,
          logs: log.arn,
          artifactsArn: artifacts.arn,
          secrets: secretArns,
          skillsArn: skills?.arn ?? "",
          exportsArn: exports?.arn ?? "",
          workspaceArn: workspaces?.arn ?? "",
          eventsArn: eventsHolder.api?.apiArn ?? "",
          runtimeArn: sandbox?.runtime.agentRuntimeArn ?? "",
          deadLetters: deadLetters?.arn ?? "",
        })
        .apply((v) =>
          policy(
            functionGrants({
              kind,
              region: v.r,
              account: v.a,
              prefix,
              logGroupArn: v.logs,
              artifactsBucketArn: v.artifactsArn,
              secretArns: v.secrets,
              secretKmsKeyArns: s.secretKmsKeyArns,
              skillsBucketArn: v.skillsArn || undefined,
              exportsBucketArn: v.exportsArn || undefined,
              workspaceBucketArn: v.workspaceArn || undefined,
              eventsApiArn: v.eventsArn || undefined,
              eventsNamespace: EVENTS_NAMESPACE,
              sandboxRuntimeArn: v.runtimeArn || undefined,
              bedrockModelArns: s.bedrockModelArns,
              deadLetterQueueArn: v.deadLetters || undefined,
            }),
          ),
        ),
    });
    const fn = new aws.lambda.Function(
      kind,
      {
        name,
        role: role.arn,
        runtime: "nodejs22.x",
        architectures: ["arm64"],
        handler: `${LAMBDA_HANDLER_MODULE}.${spec.handler}`,
        s3Bucket: artifacts.bucket,
        s3Key: code.key,
        sourceCodeHash: Buffer.from(zipHash, "hex").toString("base64"),
        publish: true,
        timeout: spec.timeout,
        memorySize: spec.memory,
        ...(kind === "durable" ? { durableConfig: { executionTimeout: s.durableExecutionTimeoutSeconds, retentionPeriod: 14 } } : {}),
        ...(s.reservedConcurrency === -1 ? {} : { reservedConcurrentExecutions: s.reservedConcurrency }),
        // The release bootstrap reads the rest (configuration, environment, secrets) from the manifest.
        environment: { variables: { AGENTFOREACH_RELEASE_BUCKET: artifacts.bucket, AGENTFOREACH_RELEASE_KEY: pulumi.interpolate`releases/${revision.hex}/${kind}.json` } },
        vpcConfig: VPC_KINDS.includes(kind) ? { subnetIds, securityGroupIds: [gatewayNetwork.id] } : undefined,
        tags,
      },
      { dependsOn: [grants, log, ...(signing ? [signing.version] : []), ...(sandboxToken ? [sandboxToken.version] : [])] },
    );
    functions[kind] = fn;
    if (kind === "migrate") {
      // The new version of migrate applies the schema during the update (the update fails if it
      // does). The schema only adds, so the old release keeps running on it meanwhile.
      const manifest = writeManifest("migrate");
      manifests.push(manifest);
      migration = new aws.lambda.Invocation(
        "migration",
        {
          functionName: fn.name,
          qualifier: fn.version,
          input: JSON.stringify({ source: "agentforeach.deploy" }),
          triggers: { release: revision.hex, version: fn.version },
        },
        { dependsOn: [manifest] },
      );
    }
    for (const metric of ["Errors", "Throttles"]) {
      new aws.cloudwatch.MetricAlarm(`${kind}-${metric.toLowerCase()}`, {
        comparisonOperator: "GreaterThanThreshold",
        evaluationPeriods: 1,
        metricName: metric,
        namespace: "AWS/Lambda",
        period: 300,
        statistic: "Sum",
        threshold: 0,
        treatMissingData: "notBreaching",
        dimensions: { FunctionName: name },
        tags,
      });
    }

    if (kind === "realtimeAuthorizer") {
      // Clients connect and subscribe with the gateway's tokens; only the gateway's roles publish (IAM).
      const api = new aws.appsync.Api("events", {
        name: `${prefix}-events`,
        eventConfig: {
          authProviders: [
            { authType: "AWS_IAM" },
            { authType: "AWS_LAMBDA", lambdaAuthorizerConfig: { authorizerUri: fn.qualifiedArn, authorizerResultTtlInSeconds: 0 } },
          ],
          connectionAuthModes: [{ authType: "AWS_LAMBDA" }],
          defaultPublishAuthModes: [{ authType: "AWS_IAM" }],
          defaultSubscribeAuthModes: [{ authType: "AWS_LAMBDA" }],
        },
        tags,
      },
      // Its authorizer moves to the new version only once the migration has run.
      { dependsOn: migration ? [migration] : [] },
      );
      eventsHolder.api = api;
      // AppSync may still invoke the prior authorizer while its URI update propagates.
      new aws.lambda.Permission("events-authorizer-invoke", {
        action: "lambda:InvokeFunction",
        function: fn.name,
        qualifier: fn.version,
        principal: "appsync.amazonaws.com",
        sourceArn: api.apiArn,
        sourceAccount: account,
      }, { retainOnDelete: true });
      new aws.appsync.ChannelNamespace("channels", {
        apiId: api.apiId,
        name: EVENTS_NAMESPACE,
        publishAuthModes: [{ authType: "AWS_IAM" }],
        subscribeAuthModes: [{ authType: "AWS_LAMBDA" }],
        tags,
      });
      if (s.browserEnabled) {
        // The browser's live view: the sandbox's driver and the viewer each hold a token for their side.
        new aws.appsync.ChannelNamespace("browser-channels", {
          apiId: api.apiId,
          name: BROWSER_EVENTS_NAMESPACE,
          publishAuthModes: [{ authType: "AWS_LAMBDA" }],
          subscribeAuthModes: [{ authType: "AWS_LAMBDA" }],
          tags,
        });
      }
    }
  }

  // ==========================================================================
  // Manifests: written once every function has a published version, so each can name the others'
  // ==========================================================================

  const events = eventsHolder.api;

  function environmentOf(kind: FunctionKind): pulumi.Output<Record<string, string>> {
    if (kind === "migrate") return pulumi.output<Record<string, string>>({ DATABASE_PROVIDER: "postgres", DATABASE_PROVISION: "false" });
    const realtime = pulumi.all([eventsHolder.api!.dns, eventsHolder.api!.apiId, region]).apply(([dns, apiId, r]): Record<string, string> => ({
      WEBSOCKET_PROVIDER: "aws-appsync-events",
      APPSYNC_HTTP_ENDPOINT: `https://${dns.HTTP}/event`,
      APPSYNC_REALTIME_ENDPOINT: `wss://${dns.REALTIME}/event/realtime`,
      APPSYNC_API_ID: apiId,
      APPSYNC_REGION: r,
      APPSYNC_NAMESPACE: EVENTS_NAMESPACE,
      APPSYNC_RELAY_NAMESPACE: BROWSER_EVENTS_NAMESPACE,
    }));
    if (kind === "realtimeAuthorizer") return realtime;
    return pulumi
      .output({
        realtime,
        r: region,
        a: account,
        api: http!.apiEndpoint,
        skills: skills!.bucket,
        exports: exports!.bucket,
        workspace: workspaces?.bucket ?? "",
        runtime: sandbox?.runtime.agentRuntimeArn ?? "",
        qualifier: sandbox?.endpoint.name ?? "",
        durable: functions.durable.qualifiedArn,
      })
      .apply((v): Record<string, string> => ({
        ...v.realtime,
        DATABASE_PROVIDER: "postgres",
        DATABASE_PROVISION: "false",
        DATABASE_POOL_SIZE: String(s.poolSize),
        // The s3 provider with the role's credentials (no keys); links last at most an hour
        // (OBJECT_STORE_S3_MAX_SIGNED_URL_SECONDS), since role credentials report no expiry.
        OBJECT_STORE_PROVIDER: "s3",
        OBJECT_STORE_S3_REGION: v.r,
        OBJECT_STORE_S3_BUCKETS: JSON.stringify({ skills: v.skills, "user-exports": v.exports }),
        OBJECT_STORE_S3_EXPECTED_BUCKET_OWNER: v.a,
        // Its own published version too: the durable function starts executions on itself.
        DURABLE_FUNCTION_ARN: v.durable,
        DURABLE_EXECUTION_PREFIX: prefix,
        ...(s.conformanceKinds && (kind === "durable" || kind === "conformance") ? { DURABLE_CONFORMANCE_KINDS: "1" } : {}),
        PUBLIC_BASE_URL: v.api,
        CORS_ALLOWED_ORIGINS: s.allowedOrigins.join(","),
        ...(s.schedulerShards === undefined ? {} : { CRON_SCHEDULER_SHARDS: String(s.schedulerShards) }),
        ...(s.sandboxEnabled
          ? {
              SANDBOX_PROVIDER: "aws-agentcore",
              SANDBOX_BROWSER_ENABLED: String(s.browserEnabled),
              AWS_SANDBOX_RUNTIME_ARN: v.runtime,
              AWS_SANDBOX_QUALIFIER: v.qualifier,
              ...(v.workspace ? { AWS_SANDBOX_WORKSPACE_BUCKET: v.workspace } : {}),
            }
          : {}),
      }));
  }

  /** A function's release manifest. Old releases keep theirs: their versions may still be running. */
  function writeManifest(kind: FunctionKind) {
    return new aws.s3.BucketObjectv2(
      `manifest-${kind}`,
      {
        bucket: artifacts.id,
        key: pulumi.interpolate`releases/${revision.hex}/${kind}.json`,
        content: pulumi
          .output({ environment: environmentOf(kind), secrets: secretsOf(kind) })
          .apply(({ environment, secrets }) =>
            JSON.stringify({ version: 1, config: APPLICATION_KINDS.includes(kind) || kind === "conformance" ? appConfig : {}, environment, secrets } satisfies Manifest),
          ),
        contentType: "application/json",
      },
      { retainOnDelete: true, dependsOn: sandbox ? [sandbox.logs] : [] },
    );
  }
  for (const kind of kinds) if (kind !== "migrate") manifests.push(writeManifest(kind));

  outputs.release = revision.hex;
  outputs.migrateFunctionArn = functions.migrate.qualifiedArn;
  outputs.gatewaySecurityGroupId = gatewayNetwork.id;
  if (!application) {
    outputs.deploymentReady = pulumi.all([...manifests.map((m) => m.id), migration!.id]).apply(() => true);
    return outputs;
  }

  // ==========================================================================
  // Entry points: API Gateway, the minute schedule
  // ==========================================================================

  // Keep the previous version authorized while API Gateway's integration update propagates.
  // The statement stays scoped to this API and account; deleting the function removes its policies.
  const invoke = new aws.lambda.Permission("api-invoke", {
    action: "lambda:InvokeFunction",
    function: functions.http.name,
    qualifier: functions.http.version,
    principal: "apigateway.amazonaws.com",
    sourceArn: pulumi.interpolate`${http!.executionArn}/*/*`,
    sourceAccount: account,
  }, { retainOnDelete: true });
  const integration = new aws.apigatewayv2.Integration(
    "http-integration",
    { apiId: http!.id, integrationType: "AWS_PROXY", integrationUri: functions.http.qualifiedArn, payloadFormatVersion: "2.0", timeoutMilliseconds: 29000 },
    { dependsOn: [...manifests, migration!, invoke] },
  );
  new aws.apigatewayv2.Route("http-routes", { apiId: http!.id, routeKey: "$default", target: pulumi.interpolate`integrations/${integration.id}` });
  const stage = new aws.apigatewayv2.Stage(
    "http-stage",
    {
      apiId: http!.id,
      name: "$default",
      autoDeploy: true,
      defaultRouteSettings: { throttlingBurstLimit: s.apiThrottleBurst, throttlingRateLimit: s.apiThrottleRate },
      tags,
    },
    { dependsOn: [...manifests, migration!] },
  );

  const group = new aws.scheduler.ScheduleGroup("schedules", { name: `${prefix}-schedules`, tags });
  const schedulerRole = new aws.iam.Role("scheduler-role", {
    assumeRolePolicy: pulumi.all([account, group.arn]).apply(([a, arn]) =>
      policy([
        { Effect: "Allow", Principal: { Service: "scheduler.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": a }, ArnEquals: { "aws:SourceArn": arn } } },
      ]),
    ),
    tags,
  });
  // Every version of the schedule function, so a tick aimed at the old version still lands while the target moves.
  const schedulerPolicy = new aws.iam.RolePolicy("scheduler-invoke", {
    role: schedulerRole.id,
    policy: pulumi.all([functions.schedule.arn, deadLetters!.arn]).apply(([fn, queue]) =>
      policy([
        { Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: `${fn}:*` },
        { Effect: "Allow", Action: ["sqs:SendMessage"], Resource: queue },
      ]),
    ),
  });
  const delivery = new aws.lambda.FunctionEventInvokeConfig("schedule-delivery", {
    functionName: functions.schedule.name,
    qualifier: functions.schedule.version,
    maximumEventAgeInSeconds: 300,
    maximumRetryAttempts: 2,
    destinationConfig: { onFailure: { destination: deadLetters!.arn } },
  });
  const schedule = new aws.scheduler.Schedule(
    "minute-tick",
    {
      name: `${prefix}-minute`,
      groupName: group.name,
      scheduleExpression: "rate(1 minute)",
      flexibleTimeWindow: { mode: "OFF" },
      state: s.schedulerEnabled ? "ENABLED" : "DISABLED",
      target: {
        arn: functions.schedule.qualifiedArn,
        roleArn: schedulerRole.arn,
        // The minute the tick is for, so a delayed or retried tick runs that minute's work.
        input: JSON.stringify({ source: "agentforeach.schedule", version: 1, scheduledTime: "<aws.scheduler.scheduled-time>" }),
        retryPolicy: { maximumEventAgeInSeconds: 300, maximumRetryAttempts: 3 },
        deadLetterConfig: { arn: deadLetters!.arn },
      },
    },
    { dependsOn: [schedulerPolicy, delivery, ...manifests, migration!] },
  );
  new aws.cloudwatch.MetricAlarm("schedule-dlq-alarm", {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 1,
    metricName: "ApproximateNumberOfMessagesVisible",
    namespace: "AWS/SQS",
    period: 300,
    statistic: "Maximum",
    threshold: 0,
    treatMissingData: "notBreaching",
    dimensions: { QueueName: deadLetters!.name },
    tags,
  });

  return {
    ...outputs,
    conformanceFunctionArn: functions.conformance.qualifiedArn,
    httpFunctionName: functions.http.name,
    durableFunctionArn: functions.durable.qualifiedArn,
    apiUrl: http!.apiEndpoint,
    realtimeUrl: events!.dns.apply((dns) => `wss://${dns.REALTIME}/event/realtime`),
    sandboxRuntimeArn: sandbox?.runtime.agentRuntimeArn,
    skillsBucket: skills!.bucket,
    exportsBucket: exports!.bucket,
    workspaceBucket: workspaces?.bucket,
    deploymentReady: pulumi
      .all([stage.id, schedule.id, ...manifests.map((m) => m.id), ...kinds.map((k) => functions[k].qualifiedArn)])
      .apply(() => true),
  };
}

/** AgentCore runtime names allow letters, digits and underscores. */
export const runtimeName = (prefix: string) => `${prefix.replaceAll("-", "_")}_sandbox`;

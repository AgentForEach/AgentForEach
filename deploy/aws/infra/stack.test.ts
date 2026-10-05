/**
 * The application stack's resource graph, with Pulumi's mocks: nothing is
 * created and no AWS account is used. What these tests can't prove is that
 * AWS accepts the graph or authorizes the calls; that is the live checks'
 * job (docs/AWS.md#what-was-validated).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as pulumi from "@pulumi/pulumi";
import { appSyncConfigFromEnv, validateAppSyncConfig } from "@agentforeach/platform-aws";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAwsStack } from "./stack.js";
import { awsApplicationConfig, LAMBDA_HANDLER_MODULE, validateSettings, type AwsSettings } from "./settings.js";
import { functionGrants, type FunctionGrantInputs, type Statement } from "./policies.js";

const ACCOUNT = "123456789012";
const REGION = "us-west-2";

type MockResource = { type: string; name: string; inputs: any };
const resources: MockResource[] = [];

pulumi.runtime.setMocks(
  {
    newResource(args) {
      resources.push({ type: args.type, name: args.name, inputs: args.inputs });
      const state: any = { ...args.inputs };
      state.arn ??= `arn:aws:test:${REGION}:${ACCOUNT}:${args.name}`;
      switch (args.type) {
        case "random:index/randomId:RandomId":
          state.hex = "1234567890abcdef";
          break;
        case "random:index/randomPassword:RandomPassword":
          state.result = "a".repeat(64);
          break;
        case "aws:s3/bucket:Bucket":
          state.bucket = `${args.name}-test`;
          state.arn = `arn:aws:s3:::${state.bucket}`;
          break;
        case "aws:ecr/repository:Repository":
          state.repositoryUrl = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/afe-test-sandbox`;
          break;
        case "aws:lambda/function:Function":
          state.version = "7";
          state.arn = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${state.name}`;
          state.qualifiedArn = `${state.arn}:7`;
          break;
        case "aws:iam/role:Role":
          state.arn = `arn:aws:iam::${ACCOUNT}:role/${args.name}`;
          break;
        case "aws:appsync/api:Api":
          state.apiId = "events123";
          state.apiArn = `arn:aws:appsync:${REGION}:${ACCOUNT}:apis/events123`;
          state.dns = { HTTP: "events.example", REALTIME: "realtime.example" };
          break;
        case "aws:bedrock/agentcoreAgentRuntime:AgentcoreAgentRuntime":
          state.agentRuntimeId = "afe_test_sandbox-abc";
          state.agentRuntimeArn = `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:runtime/afe_test_sandbox-abc`;
          state.agentRuntimeVersion = "1";
          break;
        case "aws:secretsmanager/secret:Secret":
          state.arn = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${args.name}-abc`;
          break;
        case "aws:apigatewayv2/api:Api":
          state.apiEndpoint = `https://example.execute-api.${REGION}.amazonaws.com`;
          state.executionArn = `arn:aws:execute-api:${REGION}:${ACCOUNT}:example`;
          break;
        case "aws:sqs/queue:Queue":
          state.arn = `arn:aws:sqs:${REGION}:${ACCOUNT}:${state.name}`;
          break;
      }
      return { id: `${args.name}_id`, state };
    },
    call(args) {
      if (args.token.includes("getRegion")) return { region: REGION, name: REGION };
      if (args.token.includes("getCallerIdentity")) return { accountId: ACCOUNT };
      if (args.token.includes("getPrefixList")) return { ...args.inputs, id: "pl-s3test" };
      if (args.token.includes("getSubnet")) return { ...args.inputs, vpcId: "vpc-abc", mapPublicIpOnLaunch: false };
      if (args.token.includes("getSecurityGroup")) return { ...args.inputs, vpcId: "vpc-abc" };
      return args.inputs;
    },
  },
  "agentforeach-aws",
  "test",
  false,
);

const dir = mkdtempSync(join(tmpdir(), "afe-deploy-aws-test-"));
writeFileSync(join(dir, "package.zip"), "test archive");
writeFileSync(
  join(dir, "agentforeach.json"),
  JSON.stringify({ auth: { providers: [{ type: "easy-auth" }] }, skills: { sandbox: { provider: "aca-sandboxes" } }, cron: { enabled: true } }),
);

const settings: AwsSettings = {
  prefix: "afe-test",
  phase: "application",
  artifactPath: join(dir, "package.zip"),
  applicationConfigPath: join(dir, "agentforeach.json"),
  sandboxEnabled: true,
  sandboxImageDigest: `sha256:${"a".repeat(64)}`,
  workspacePersistence: true,
  browserEnabled: true,
  browserEgressCidrs: ["203.0.113.1/32"],
  vpcId: "vpc-abc",
  privateSubnetIds: ["subnet-abc", "subnet-def"],
  databaseSecurityGroupId: "sg-abc",
  databasePort: 5432,
  databaseSecret: { arn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:database-abc`, jsonKey: "DATABASE_URL" },
  migrationSecretArn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:rds-master-abc`,
  secretKmsKeyArns: [],
  providerSecrets: { OPENAI_API_KEY: { arn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:openai-abc`, jsonKey: "OPENAI_API_KEY" } },
  bedrockModelArns: [],
  jwtIssuer: "https://identity.example",
  jwtAudience: "afe",
  jwtJwksUri: "https://identity.example/keys",
  allowedOrigins: ["https://app.example"],
  schedulerEnabled: true,
  poolSize: 2,
  reservedConcurrency: -1,
  durableExecutionTimeoutSeconds: 28800,
  conformanceKinds: true,
  apiThrottleRate: 50,
  apiThrottleBurst: 100,
  logRetentionDays: 30,
  protectData: true,
  releaseNonce: "",
};

async function deploy(input: AwsSettings) {
  resources.length = 0;
  await pulumi.runtime.runInPulumiStack(async () => {
    const outputs = createAwsStack(input);
    await new Promise<void>((resolve) => pulumi.all([outputs.artifactBucket, outputs.deploymentReady ?? true]).apply(() => resolve()));
  });
  const all = (type: string) => resources.filter((r) => r.type === type);
  const one = (type: string, name: string) => {
    const found = resources.find((r) => r.type === type && r.name === name);
    assert.ok(found, `${type} ${name} exists`);
    return found.inputs;
  };
  const statements = (name: string): Statement[] => JSON.parse(one("aws:iam/rolePolicy:RolePolicy", name).policy).Statement;
  const manifest = (kind: string) => JSON.parse(one("aws:s3/bucketObjectv2:BucketObjectv2", `manifest-${kind}`).content);
  return { all, one, statements, manifest };
}

const actions = (s: Statement) => [s.Action].flat();
const resourcesOf = (s: Statement) => [s.Resource ?? []].flat();

test("settings that can't work fail before anything is provisioned", () => {
  assert.equal(validateSettings({ ...settings }).phase, "application");
  assert.throws(() => validateSettings({ ...settings, prefix: "A" }), /prefix/);
  assert.throws(() => validateSettings({ ...settings, prefix: "a-prefix-that-is-much-too-long" }), /prefix/);
  assert.throws(() => validateSettings({ ...settings, reservedConcurrency: 0 }), /never|0 would/);
  assert.throws(() => validateSettings({ ...settings, allowedOrigins: ["*"] }));
  assert.throws(() => validateSettings({ ...settings, allowedOrigins: ["https://app.example/path"] }), /exact/);
  assert.throws(() => validateSettings({ ...settings, sandboxImageDigest: "latest" }), /digest/);
  assert.throws(() => validateSettings({ ...settings, privateSubnetIds: ["subnet-abc", "subnet-abc"] }), /two distinct/);
  assert.throws(() => validateSettings({ ...settings, jwtJwksUri: "http://identity.example/keys" }), /https/);
  assert.throws(() => validateSettings({ ...settings, durableExecutionTimeoutSeconds: 60 }), /durableExecutionTimeoutSeconds/);
  assert.throws(() => validateSettings({ ...settings, durableExecutionTimeoutSeconds: 21600 }), /handover/, "an execution must live past its six-hour handover");
  assert.throws(
    () => validateSettings({ ...settings, providerSecrets: { AWS_ACCESS_KEY_ID: settings.databaseSecret! } }),
    /Reserved/,
    "a provider secret can't override the platform's own settings",
  );
  assert.throws(() => validateSettings({ ...settings, providerSecrets: { AGENTFOREACH_RELEASE_KEY: settings.databaseSecret! } }), /Reserved/);
  assert.throws(() => validateSettings({ ...settings, providerSecrets: { REALTIME_SIGNING_KEY: settings.databaseSecret! } }), /Reserved/);
  assert.throws(() => validateSettings({ ...settings, browserEgressCidrs: [] }), /browserEgressCidrs/);
  assert.throws(() => validateSettings({ ...settings, browserEgressCidrs: ["999.0.0.1/32"] }), /CIDR/);
  assert.throws(() => validateSettings({ ...settings, sandboxEnabled: false }), /need sandboxEnabled/);
  // The migrate phase needs the network and the database, not sign-in or the image.
  assert.equal(validateSettings({ ...settings, phase: "migrate", jwtIssuer: undefined, sandboxImageDigest: undefined }).phase, "migrate");
  assert.throws(() => validateSettings({ ...settings, phase: "migrate", databaseSecret: undefined }), /databaseSecret/);
  assert.equal(validateSettings({ prefix: "afe-test", phase: "bootstrap" } as AwsSettings).phase, "bootstrap");
});

test("the AWS choices go into a copy of agentforeach.json, never the source", () => {
  const base = { auth: { providers: [{ type: "easy-auth" }] }, skills: { sandbox: { provider: "aca-sandboxes", defaultTimeoutSec: 90 } } };
  const config = awsApplicationConfig(base, settings) as any;
  assert.equal(base.skills.sandbox.provider, "aca-sandboxes");
  assert.equal(base.auth.providers[0].type, "easy-auth");
  assert.equal(config.auth.providers.length, 1, "only the jwt provider: Easy Auth is never trusted off Azure");
  assert.equal(config.auth.providers[0].type, "jwt");
  assert.equal(config.database.provider, "postgres");
  assert.equal(config.database.connectionString, "$DATABASE_URL");
  assert.equal(config.websocket.provider, "aws-appsync-events");
  assert.equal(config.skills.sandbox.provider, "aws-agentcore");
  assert.equal(config.skills.sandbox.defaultTimeoutSec, 90, "the rest of the sandbox settings are kept");
  assert.equal(config.skills.sandbox.aws.storageMode, "s3-checkpoint");
  assert.equal(config.skills.sandbox.aws.workspaceBucket, "$AWS_SANDBOX_WORKSPACE_BUCKET");
  const off = awsApplicationConfig(base, { ...settings, sandboxEnabled: false, browserEnabled: false, workspacePersistence: false }) as any;
  assert.equal(off.skills.sandbox.enabled, false);
});

test("bootstrap creates only the artifacts bucket and the image repository", async () => {
  const { all } = await deploy({ ...settings, phase: "bootstrap" });
  assert.deepEqual(all("aws:s3/bucket:Bucket").map((r) => r.name), ["artifacts"]);
  assert.equal(all("aws:ecr/repository:Repository").length, 1);
  assert.equal(all("aws:ecr/repository:Repository")[0].inputs.imageTagMutability, "IMMUTABLE");
  assert.equal(all("aws:lambda/function:Function").length, 0);
});

test("the migrate phase adds the network and the migrate function, and nothing that serves", async () => {
  const { all, one, statements, manifest } = await deploy({ ...settings, phase: "migrate" });
  assert.deepEqual(all("aws:lambda/function:Function").map((r) => r.name), ["migrate"]);
  for (const type of ["aws:apigatewayv2/api:Api", "aws:appsync/api:Api", "aws:scheduler/schedule:Schedule", "aws:bedrock/agentcoreAgentRuntime:AgentcoreAgentRuntime"]) {
    assert.equal(all(type).length, 0, `${type} waits for the application phase`);
  }
  const fn = one("aws:lambda/function:Function", "migrate");
  assert.equal(fn.handler, `${LAMBDA_HANDLER_MODULE}.migrate`);
  assert.ok(fn.vpcConfig.subnetIds.length === 2, "in the VPC, to reach the private database");
  assert.equal(one("aws:lambda/invocation:Invocation", "migration").functionName, "afe-test-migrate", "the update applies the schema");
  const m = manifest("migrate");
  assert.deepEqual(Object.keys(m.secrets).sort(), ["DATABASE_MIGRATION_PASSWORD", "DATABASE_MIGRATION_USER", "DATABASE_URL"]);
  assert.deepEqual(m.secrets.DATABASE_MIGRATION_USER, { arn: settings.migrationSecretArn, jsonKey: "username" });
  assert.deepEqual(m.config, {});
  const grants = statements("migrate-policy");
  assert.deepEqual(grants.find((s) => actions(s).includes("secretsmanager:GetSecretValue"))!.Resource, [settings.databaseSecret!.arn, settings.migrationSecretArn]);
  assert.ok(!grants.some((s) => actions(s).some((a) => /^(lambda|appsync|bedrock|bedrock-agentcore):/.test(a))));
});

test("the application: one package, a function per handler, wired to its entry point", async () => {
  const { all, one, manifest } = await deploy(settings);
  const urns = resources.map((r) => `${r.type}::${r.name}`);
  assert.deepEqual(urns.filter((urn, i) => urns.indexOf(urn) !== i), [], "every resource has its own name (Pulumi refuses duplicates)");
  const functions = all("aws:lambda/function:Function");
  assert.deepEqual(functions.map((r) => r.name).sort(), ["conformance", "durable", "http", "migrate", "realtimeAuthorizer", "schedule"]);
  for (const fn of functions) {
    assert.equal(fn.inputs.handler, `${LAMBDA_HANDLER_MODULE}.${fn.name}`, "each function runs its own export of deploy/aws/lambda.ts");
    assert.equal(fn.inputs.s3Key, "releases/1234567890abcdef/package.zip", "and every function runs the same package");
    assert.equal(fn.inputs.publish, true);
    assert.equal(fn.inputs.runtime, "nodejs22.x");
    assert.deepEqual(fn.inputs.architectures, ["arm64"]);
    assert.deepEqual(Object.keys(fn.inputs.environment.variables).sort(), ["AGENTFOREACH_RELEASE_BUCKET", "AGENTFOREACH_RELEASE_KEY"], "settings live in the manifest");
    assert.equal(fn.inputs.environment.variables.AGENTFOREACH_RELEASE_KEY, `releases/1234567890abcdef/${fn.name}.json`);
    assert.equal(fn.inputs.reservedConcurrentExecutions, undefined, "-1 leaves concurrency unreserved");
    assert.equal(!!fn.inputs.vpcConfig, fn.name !== "realtimeAuthorizer", "the authorizer needs no database, so no VPC");
  }
  const durable = functions.filter((fn) => fn.inputs.durableConfig);
  assert.deepEqual(durable.map((fn) => fn.name), ["durable"], "one durable function runs every durable kind");
  assert.equal(durable[0].inputs.durableConfig.executionTimeout, 28800);
  assert.equal(durable[0].inputs.timeout, 900);

  // Every caller gets a published version, never $LATEST.
  const integration = all("aws:apigatewayv2/integration:Integration")[0].inputs;
  assert.equal(integration.integrationUri, `arn:aws:lambda:${REGION}:${ACCOUNT}:function:afe-test-http:7`);
  assert.equal(integration.payloadFormatVersion, "2.0");
  assert.equal(integration.timeoutMilliseconds, 29000);
  assert.equal(all("aws:apigatewayv2/route:Route")[0].inputs.routeKey, "$default");
  const schedule = all("aws:scheduler/schedule:Schedule")[0].inputs;
  assert.equal(schedule.scheduleExpression, "rate(1 minute)");
  assert.equal(schedule.flexibleTimeWindow.mode, "OFF");
  assert.deepEqual(JSON.parse(schedule.target.input), {
    source: "agentforeach.schedule",
    version: 1,
    scheduledTime: "<aws.scheduler.scheduled-time>",
  });
  assert.equal(schedule.target.arn, `arn:aws:lambda:${REGION}:${ACCOUNT}:function:afe-test-schedule:7`);
  assert.ok(schedule.target.deadLetterConfig.arn);
  assert.equal(one("aws:lambda/functionEventInvokeConfig:FunctionEventInvokeConfig", "schedule-delivery").qualifier, "7");
  const api = all("aws:appsync/api:Api")[0].inputs;
  assert.equal(api.eventConfig.authProviders[1].lambdaAuthorizerConfig.authorizerUri, `arn:aws:lambda:${REGION}:${ACCOUNT}:function:afe-test-realtime-authorizer:7`);

  const http = manifest("http");
  assert.equal(http.environment.DURABLE_FUNCTION_ARN, `arn:aws:lambda:${REGION}:${ACCOUNT}:function:afe-test-durable:7`, "durable executions start on a published version");
  assert.equal(http.environment.DURABLE_EXECUTION_PREFIX, "afe-test");
  assert.equal(http.environment.DATABASE_PROVISION, "false");
  assert.equal(http.environment.WEBSOCKET_PROVIDER, "aws-appsync-events");
  assert.equal(http.environment.APPSYNC_HTTP_ENDPOINT, "https://events.example/event");
  const realtimeConfig = validateAppSyncConfig(appSyncConfigFromEnv({ ...http.environment, APPSYNC_TOKEN_SECRET: "a".repeat(64) }));
  assert.equal(realtimeConfig.apiId, "events123");
  assert.equal(realtimeConfig.region, REGION);
  assert.equal(http.environment.APPSYNC_NAMESPACE, "agentforeach");
  assert.equal(http.environment.APPSYNC_RELAY_NAMESPACE, "agentforeach-browser");
  assert.deepEqual(JSON.parse(http.environment.OBJECT_STORE_S3_BUCKETS), { skills: "skills-test", "user-exports": "exports-test" });
  assert.equal(http.environment.OBJECT_STORE_S3_EXPECTED_BUCKET_OWNER, ACCOUNT);
  assert.equal(http.environment.OBJECT_STORE_PROVIDER, "s3", "explicit: the gateway fails closed on AWS without it");
  assert.ok(!Object.keys(http.environment).some((k) => /ACCESS_KEY|SECRET_ACCESS/.test(k)), "the role's credentials, never static keys");
  assert.equal(http.environment.SANDBOX_PROVIDER, "aws-agentcore");
  assert.equal(http.environment.AWS_SANDBOX_QUALIFIER, "version_1");
  assert.equal(http.environment.AWS_SANDBOX_WORKSPACE_BUCKET, "workspaces-test");
  assert.equal(http.environment.PUBLIC_BASE_URL, `https://example.execute-api.${REGION}.amazonaws.com`);
  assert.equal(http.environment.CRON_SCHEDULER_SHARDS, undefined, "unset: the application config decides");
  assert.deepEqual(Object.keys(http.secrets).sort(), ["APPSYNC_TOKEN_SECRET", "AWS_SANDBOX_SERVER_TOKEN", "DATABASE_URL", "OPENAI_API_KEY"]);
  assert.equal(http.config.skills.sandbox.provider, "aws-agentcore");
  assert.equal(manifest("durable").environment.DURABLE_FUNCTION_ARN, http.environment.DURABLE_FUNCTION_ARN, "the durable function knows its own version");
  assert.equal(manifest("durable").environment.DURABLE_CONFORMANCE_KINDS, "1");
  assert.equal(manifest("conformance").environment.DURABLE_CONFORMANCE_KINDS, "1");
  assert.equal(http.environment.DURABLE_CONFORMANCE_KINDS, undefined, "only where the suite runs");
  const { DURABLE_CONFORMANCE_KINDS: _kinds, ...durableEnvironment } = manifest("durable").environment;
  assert.deepEqual(durableEnvironment, http.environment, "otherwise the application functions share one environment");

  // Upgrades: the new migrate version runs before callers switch to the new versions.
  const migration = one("aws:lambda/invocation:Invocation", "migration");
  assert.equal(migration.qualifier, "7", "the new version of migrate");
  assert.deepEqual(migration.triggers, { release: "1234567890abcdef", version: "7" }, "once per release");

  for (const kind of ["http", "schedule", "durable", "realtimeAuthorizer", "migrate", "conformance"]) {
    const names = [...Object.keys(manifest(kind).environment), ...Object.keys(manifest(kind).secrets)];
    assert.deepEqual(names.filter((n) => n.startsWith("AWS_") && !n.startsWith("AWS_SANDBOX_")), [], `${kind}: no AWS_* names but AWS_SANDBOX_*`);
  }
  assert.equal(one("aws:lambda/function:Function", "http").timeout, 30, "API Gateway ends a request at 29 s");

  const authorizer = manifest("realtimeAuthorizer");
  assert.deepEqual(Object.keys(authorizer.secrets), ["APPSYNC_TOKEN_SECRET"]);
  assert.deepEqual(authorizer.config, {});
  assert.equal(authorizer.environment.DATABASE_URL, undefined);
});

test("each function's role holds only what its handler needs, on published versions only", async () => {
  const { statements } = await deploy(settings);
  const durableFn = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:afe-test-durable`;
  const executions = `${durableFn}:*/durable-execution/*`;
  const kinds = ["http", "schedule", "durable", "realtimeAuthorizer", "migrate", "conformance"];
  for (const kind of kinds) {
    const grants = statements(`${kind}-policy`);
    for (const grant of grants) {
      if (resourcesOf(grant).includes("*")) {
        assert.ok(actions(grant).every((a) => a.startsWith("ec2:")), `${kind}: only Lambda's network interfaces are on "*"`);
      }
    }
    const checkpoint = grants.filter((s) => actions(s).includes("lambda:CheckpointDurableExecution"));
    assert.equal(checkpoint.length, kind === "durable" ? 1 : 0, `${kind}: only the durable function checkpoints`);
    if (checkpoint.length) {
      assert.equal(checkpoint[0].Resource, executions);
      assert.deepEqual(actions(checkpoint[0]), ["lambda:CheckpointDurableExecution", "lambda:GetDurableExecutionState"]);
    }
    for (const grant of grants.filter((s) => actions(s).some((a) => a.startsWith("lambda:")))) {
      for (const resource of resourcesOf(grant)) {
        assert.ok(resource === `${durableFn}:*` || resource === executions, `${kind}: ${resource} is a version of the durable function`);
      }
    }
    const invokes = grants.some((s) => actions(s).includes("lambda:InvokeFunction"));
    assert.equal(invokes, ["http", "schedule", "durable", "conformance"].includes(kind), `${kind}: starts durable executions`);
    const callbacks = grants.find((s) => actions(s).includes("lambda:SendDurableExecutionCallbackSuccess"));
    if (callbacks) {
      assert.deepEqual(actions(callbacks), ["lambda:GetDurableExecution", "lambda:SendDurableExecutionCallbackSuccess", "lambda:StopDurableExecution"]);
      assert.equal(callbacks.Resource, executions);
    }

    const publish = grants.find((s) => actions(s).includes("appsync:EventPublish"));
    assert.equal(!!publish, ["http", "schedule", "durable"].includes(kind), `${kind}: publishes realtime events`);
    if (publish) assert.equal(publish.Resource, `arn:aws:appsync:${REGION}:${ACCOUNT}:apis/events123/channelNamespace/agentforeach`);

    const sandbox = grants.find((s) => actions(s).includes("bedrock-agentcore:InvokeAgentRuntime"));
    assert.equal(!!sandbox, ["http", "schedule", "durable"].includes(kind), `${kind}: calls the sandbox`);
    if (sandbox) {
      assert.deepEqual(actions(sandbox), ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"]);
      assert.ok(resourcesOf(sandbox).every((r) => r.startsWith(`arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:runtime/afe_test_sandbox-abc`)));
    }

    const objects = grants.filter((s) => actions(s).some((a) => a.startsWith("s3:") && a !== "s3:GetObject"));
    if (!["http", "schedule", "durable"].includes(kind)) {
      assert.equal(objects.length, 0, `${kind}: no application buckets`);
      const reads = grants.filter((s) => actions(s).includes("s3:GetObject"));
      assert.deepEqual(reads.map((s) => s.Resource), [`arn:aws:s3:::artifacts-test/releases/*/${kind}.json`], `${kind}: reads only its own manifests`);
    } else {
      const buckets = objects.flatMap(resourcesOf);
      assert.ok(buckets.every((r) => /^arn:aws:s3:::(skills|exports|workspaces)-test(\/\*)?$/.test(r)), `${kind}: only the application buckets`);
      const workspace = objects.find((s) => resourcesOf(s).includes("arn:aws:s3:::workspaces-test/*"))!;
      assert.deepEqual(actions(workspace), ["s3:GetObject", "s3:PutObject"]);
      const on = (resource: string) => objects.filter((s) => resourcesOf(s).includes(resource)).flatMap(actions).sort();
      assert.deepEqual(on("arn:aws:s3:::skills-test/*"), ["s3:DeleteObjectVersion", "s3:GetObject"], "skills: read, and erase");
      assert.deepEqual(on("arn:aws:s3:::exports-test/*"), ["s3:DeleteObjectVersion", "s3:GetObject", "s3:PutObject"]);
      assert.ok(!objects.flatMap(actions).includes("s3:CreateBucket"), "the gateway never creates buckets");
    }
  }

  const secretsOf = (kind: string) => statements(`${kind}-policy`).find((s) => actions(s).includes("secretsmanager:GetSecretValue"))!.Resource;
  assert.deepEqual(secretsOf("realtimeAuthorizer"), [`arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:realtime-signing-key-abc`]);
  assert.deepEqual(
    [secretsOf("http")].flat().sort(),
    [
      settings.databaseSecret!.arn,
      settings.providerSecrets.OPENAI_API_KEY.arn,
      `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:realtime-signing-key-abc`,
      `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:sandbox-token-abc`,
    ].sort(),
  );
  assert.ok(![secretsOf("http")].flat().includes(settings.migrationSecretArn!), "the owner role's secret is the migration's alone");

  // The sandbox's own role: its image and its logs, nothing else.
  const sandbox = statements("sandbox-policy");
  assert.ok(sandbox.every((s) => actions(s).every((a) => a.startsWith("ecr:") || a.startsWith("logs:"))));
  // The scheduler's role invokes every version of the schedule function, and only it.
  const scheduler = statements("scheduler-invoke").find((s) => actions(s).includes("lambda:InvokeFunction"))!;
  assert.equal(scheduler.Resource, `arn:aws:lambda:${REGION}:${ACCOUNT}:function:afe-test-schedule:*`);
});

test("buckets are private, encrypted and TLS-only; application buckets are never versioned", async () => {
  const { all } = await deploy(settings);
  const buckets = all("aws:s3/bucket:Bucket").map((r) => r.name).sort();
  assert.deepEqual(buckets, ["artifacts", "exports", "skills", "workspaces"]);
  for (const name of buckets) {
    const block = all("aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock").find((r) => r.name === `${name}-private`)!.inputs;
    assert.deepEqual(
      [block.blockPublicAcls, block.blockPublicPolicy, block.ignorePublicAcls, block.restrictPublicBuckets],
      [true, true, true, true],
      `${name}: public access blocked`,
    );
    const encryption = all("aws:s3/bucketServerSideEncryptionConfiguration:BucketServerSideEncryptionConfiguration").find((r) => r.name === `${name}-encryption`)!;
    assert.equal(encryption.inputs.rules[0].applyServerSideEncryptionByDefault.sseAlgorithm, "AES256");
    const ownership = all("aws:s3/bucketOwnershipControls:BucketOwnershipControls").find((r) => r.name === `${name}-ownership`)!;
    assert.equal(ownership.inputs.rule.objectOwnership, "BucketOwnerEnforced", `${name}: no ACLs`);
    const rules: Statement[] = JSON.parse(all("aws:s3/bucketPolicy:BucketPolicy").find((r) => r.name === `${name}-tls`)!.inputs.policy).Statement;
    assert.deepEqual(rules[0].Condition, { Bool: { "aws:SecureTransport": "false" } });
    assert.equal(rules[0].Effect, "Deny");
    assert.ok(rules.every((rule) => rule.Effect === "Deny"), `${name}: the policy grants nobody anything`);
    const refusesVersioning = rules.some((rule) => actions(rule).includes("s3:PutBucketVersioning"));
    assert.equal(refusesVersioning, name !== "artifacts", `${name}: versioning ${name === "artifacts" ? "allowed" : "refused"}`);
  }
  assert.deepEqual(all("aws:s3/bucketVersioning:BucketVersioning").map((r) => r.name), ["artifacts-versions"]);
  const retention = all("aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration")[0].inputs;
  assert.equal(retention.rules[0].expiration.days, 7);

  const without = await deploy({ ...settings, workspacePersistence: false });
  assert.ok(!without.all("aws:s3/bucket:Bucket").some((r) => r.name === "workspaces"), "no workspace bucket unless asked for");
});

test("nothing is exposed but the API: no function URLs, no inbound rules, IAM-only sandbox and publishing", async () => {
  const { all, one } = await deploy(settings);
  const networkRules = [
    ...all("aws:ec2/securityGroup:SecurityGroup").flatMap((g) => [...(g.inputs.ingress ?? []), ...(g.inputs.egress ?? [])]),
    ...all("aws:ec2/securityGroupRule:SecurityGroupRule").map((r) => r.inputs),
  ];
  for (const rule of networkRules) {
    assert.match(rule.description ?? "", /^[0-9A-Za-z_ .:/()#,@\[\]+=&;{}!$*-]*$/, "EC2 accepts the rule description");
  }
  assert.equal(all("aws:lambda/functionUrl:FunctionUrl").length, 0);
  for (const permission of all("aws:lambda/permission:Permission")) {
    assert.ok(["apigateway.amazonaws.com", "appsync.amazonaws.com"].includes(permission.inputs.principal));
    assert.ok(permission.inputs.sourceArn, `${permission.name}: scoped to its caller`);
    assert.equal(permission.inputs.sourceAccount, ACCOUNT);
    assert.equal(permission.inputs.qualifier, "7", `${permission.name}: on the published version`);
  }
  for (const group of all("aws:ec2/securityGroup:SecurityGroup")) {
    for (const rule of group.inputs.ingress ?? []) {
      assert.ok(!(rule.cidrBlocks ?? []).includes("0.0.0.0/0"), `${group.name}: no inbound rule from anywhere`);
    }
  }
  for (const rule of all("aws:ec2/securityGroupRule:SecurityGroupRule").filter((r) => r.inputs.type === "ingress")) {
    assert.ok(rule.inputs.sourceSecurityGroupId && !rule.inputs.cidrBlocks, `${rule.name}: inbound only from a security group`);
  }
  const sandboxEgress = one("aws:ec2/securityGroup:SecurityGroup", "sandbox-network").egress;
  assert.deepEqual(sandboxEgress, [{ protocol: "tcp", fromPort: 443, toPort: 443, prefixListIds: ["pl-s3test"], description: sandboxEgress[0].description }]);
  assert.deepEqual(one("aws:ec2/securityGroupRule:SecurityGroupRule", "sandbox-browser-https").cidrBlocks, ["203.0.113.1/32"]);
  assert.ok(all("aws:ec2/vpcEndpoint:VpcEndpoint").every((r) => r.inputs.privateDnsEnabled && r.inputs.vpcEndpointType === "Interface"));

  const runtime = one("aws:bedrock/agentcoreAgentRuntime:AgentcoreAgentRuntime", "sandbox");
  assert.equal(runtime.authorizerConfiguration, undefined, "invoked with IAM (SigV4) only");
  assert.equal(runtime.networkConfiguration.networkMode, "VPC");
  assert.deepEqual(runtime.filesystemConfigurations, []);
  assert.equal(runtime.agentRuntimeArtifact.containerConfiguration.containerUri, `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/afe-test-sandbox@sha256:${"a".repeat(64)}`);
  assert.equal(runtime.environmentVariables.SANDBOX_SERVER_TOKEN, "a".repeat(64), "the server refuses calls without the token");
  assert.equal(runtime.environmentVariables.SANDBOX_ARCHIVE_MAX_BYTES, String(32 * 1024 * 1024));

  const api = all("aws:appsync/api:Api")[0].inputs.eventConfig;
  assert.deepEqual(api.defaultPublishAuthModes, [{ authType: "AWS_IAM" }]);
  assert.deepEqual(api.defaultSubscribeAuthModes, [{ authType: "AWS_LAMBDA" }]);
  assert.deepEqual(api.connectionAuthModes, [{ authType: "AWS_LAMBDA" }]);
  const chat = one("aws:appsync/channelNamespace:ChannelNamespace", "channels");
  assert.deepEqual(chat.publishAuthModes, [{ authType: "AWS_IAM" }], "only the gateway publishes chat events");
  const browser = one("aws:appsync/channelNamespace:ChannelNamespace", "browser-channels");
  assert.deepEqual(browser.publishAuthModes, [{ authType: "AWS_LAMBDA" }]);
  assert.deepEqual(browser.subscribeAuthModes, [{ authType: "AWS_LAMBDA" }]);
  assert.ok(!resources.some((r) => r.type.startsWith("azure") || r.type.startsWith("aws:rds/")), "the database is yours: never created here");
});

test("sandboxes off: no runtime, no repository, no sandbox grants", async () => {
  const off = { ...settings, sandboxEnabled: false, browserEnabled: false, workspacePersistence: false, sandboxImageDigest: undefined };
  const { all, statements, manifest } = await deploy(off);
  assert.equal(all("aws:bedrock/agentcoreAgentRuntime:AgentcoreAgentRuntime").length, 0);
  assert.equal(all("aws:ecr/repository:Repository").length, 0);
  assert.ok(!statements("http-policy").some((s) => actions(s).some((a) => a.startsWith("bedrock-agentcore:"))));
  assert.equal(manifest("http").environment.SANDBOX_PROVIDER, undefined);
  assert.equal(manifest("http").secrets.AWS_SANDBOX_SERVER_TOKEN, undefined);
});

test("functionGrants: secrets encrypted with your own key are decrypted only through Secrets Manager", () => {
  const base: FunctionGrantInputs = {
    kind: "realtimeAuthorizer",
    region: REGION,
    account: ACCOUNT,
    prefix: "afe-test",
    logGroupArn: "arn:aws:logs:x",
    artifactsBucketArn: "arn:aws:s3:::artifacts",
    secretArns: ["arn:aws:secretsmanager:x"],
    secretKmsKeyArns: [`arn:aws:kms:${REGION}:${ACCOUNT}:key/abc`],
    bedrockModelArns: [`arn:aws:bedrock:${REGION}::foundation-model/amazon.nova-lite-v1:0`],
  };
  const kms = functionGrants(base).find((s) => actions(s).includes("kms:Decrypt"))!;
  assert.deepEqual(kms.Condition, { StringEquals: { "kms:ViaService": `secretsmanager.${REGION}.amazonaws.com` } });
  assert.ok(!functionGrants(base).some((s) => actions(s).some((a) => a.startsWith("bedrock:"))), "the authorizer never calls a model");
  const http = functionGrants({ ...base, kind: "http" }).find((s) => actions(s).includes("bedrock:InvokeModel"))!;
  assert.deepEqual(http.Resource, base.bedrockModelArns, "only the models named");
});

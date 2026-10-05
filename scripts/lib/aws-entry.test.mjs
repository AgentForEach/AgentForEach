import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { lambdaBuildOptions, root } from "../lambda-bundle.mjs";

test("the deployed Lambda entry loads its release and installs AppSync before serving tokens", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "afe-aws-entry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = JSON.parse(await readFile(join(root, "gateway/config/agentforeach.json"), "utf8"));
  const manifest = {
    version: 1,
    secrets: {},
    environment: {
      DURABLE_FUNCTION_ARN: "arn:aws:lambda:us-west-2:123456789012:function:fixture-durable:7",
      DURABLE_EXECUTION_PREFIX: "fixture",
      WEBSOCKET_PROVIDER: "aws-appsync-events",
      OBJECT_STORE_PROVIDER: "s3",
      APPSYNC_HTTP_ENDPOINT: "https://events.example/event",
      APPSYNC_REALTIME_ENDPOINT: "wss://realtime.example/event/realtime",
      APPSYNC_API_ID: "fixture-api",
      APPSYNC_REGION: "us-west-2",
      APPSYNC_TOKEN_SECRET: "fixture-signing-key-".repeat(4),
    },
    config: {
      ...base,
      auth: { providers: [{ type: "api-key", keys: { "fixture-key": { userId: "alice" } } }] },
      cron: { ...base.cron, enabled: false },
      skills: { ...base.skills, enabled: false },
    },
  };
  // Only the release-loader boundary is simulated; invoke the real bundled handlers below.
  const server = createServer((req, res) => {
    assert.equal(req.url.split("?")[0], "/release-test/http.json");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(manifest));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const bindings = {
    AWS_ACCESS_KEY_ID: "fixture-access-key",
    AWS_SECRET_ACCESS_KEY: "fixture-secret-key",
    AWS_SESSION_TOKEN: "fixture-session-token",
    AWS_REGION: "us-west-2",
    AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${server.address().port}`,
    AWS_LAMBDA_FUNCTION_NAME: "fixture-http",
    AGENTFOREACH_RELEASE_BUCKET: "release-test",
    AGENTFOREACH_RELEASE_KEY: "http.json",
  };
  const previous = { ...process.env };
  Object.assign(process.env, bindings);
  t.after(() => {
    for (const name of [...Object.keys(bindings), ...Object.keys(manifest.environment)]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  const outfile = join(dir, "lambda.mjs");
  await build(lambdaBuildOptions({ outfile }));
  const lambda = await import(pathToFileURL(outfile).href);
  const context = { awsRequestId: "fixture-request", getRemainingTimeInMillis: () => 900000 };
  const event = {
    version: "2.0", rawPath: "/api/token", rawQueryString: "",
    headers: { "x-api-key": "fixture-key" },
    requestContext: { requestId: "fixture-request", domainName: "gateway.example", http: { method: "POST" } },
  };
  assert.equal((await lambda.http({ ...event, headers: {} }, context)).statusCode, 401);
  const response = await lambda.http(event, context);
  assert.equal(response.statusCode, 200);
  const access = JSON.parse(response.body);
  assert.equal(access.descriptor.protocol, "appsync-events");
  assert.equal(access.url, manifest.environment.APPSYNC_REALTIME_ENDPOINT);
  const requestContext = {
    apiId: "fixture-api", operation: "EVENT_SUBSCRIBE",
    channelNamespaceName: "agentforeach", channel: access.descriptor.channels[0],
  };
  const authorizationToken = access.descriptor.authorization.Authorization;
  assert.equal((await lambda.realtimeAuthorizer({ authorizationToken, requestContext })).isAuthorized, true);
  assert.equal((await lambda.realtimeAuthorizer({
    authorizationToken, requestContext: { ...requestContext, apiId: "another-api" },
  })).isAuthorized, false);
  await assert.rejects(lambda.conformance({ area: "durable", op: "status", args: ["fixture"] }), /not enabled/);
});

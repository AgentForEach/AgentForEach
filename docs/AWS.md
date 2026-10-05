# AWS

Deploy AgentForEach on AWS: the gateway on Lambda, durable work on Lambda durable functions, realtime on AppSync Events, files on S3, sandboxes on Bedrock AgentCore Runtime, and your PostgreSQL with pgvector. The gateway's code is the same as on Azure and Cloudflare; only the platform pack (`packages/platform-aws`) and the deployment (`deploy/aws`) change ([Platforms](Platforms.md)).

> **Status: preview.** The consolidated implementation (one package, one durable function) passed fresh AWS live validation on 5 October 2026. [Validation results and remaining gaps](AWS-Validation.md) record the functional checks, targeted resilience tests and account limitations.

Prerequisites:
- Node 22, the [Pulumi CLI](https://www.pulumi.com/docs/install/) signed in to a backend (`pulumi login`, or `pulumi login --local`), the AWS CLI with credentials, and Docker with `buildx` (for the sandbox image).
- An AWS region with Lambda durable functions, AppSync Events and Bedrock AgentCore Runtime. The evaluation used `us-west-2`.
- A **PostgreSQL** 13+ with [pgvector](https://github.com/pgvector/pgvector), reachable from private subnets of a VPC, or none: the [foundation](#the-evaluation-foundation) creates a VPC and RDS PostgreSQL for you.
- An identity provider that issues RS256 JWTs with a JWKS (Cognito, Auth0, Entra ID, ...). The foundation creates a Cognito pool for testing.
- A model provider: a key for OpenAI, Anthropic or Azure OpenAI in Secrets Manager, or Amazon Bedrock with the role's credentials.

One script does the work, with Pulumi: `deploy/aws/deploy.sh`. [By hand](#by-hand) lists what it runs.

## What runs where

One Lambda package serves every function. Each function runs one export of [`deploy/aws/lambda.ts`](../deploy/aws/lambda.ts):

| Piece | On AWS | Instead of (Azure) |
|---|---|---|
| The gateway's routes | Lambda `<prefix>-http` (`http`) behind an API Gateway HTTP API (payload v2), at the same paths | Function App |
| Schedules | EventBridge Scheduler every minute → `<prefix>-schedule` (`schedule`): the route table's schedules, the database sweep and the durable sweep. Failed ticks go to a dead-letter queue with an alarm | Timer triggers |
| Chat turns, channel turns, HITL waits, cron runs and scheduler shards | One Lambda durable function, `<prefix>-durable` (`durable`), for every durable kind (jobs, waits, alarms). Callers start executions on its published version | Durable Functions |
| WebSockets to clients | AppSync Events: clients connect and subscribe with the gateway's tokens through a Lambda authorizer (`<prefix>-realtime-authorizer`); only the gateway publishes, with IAM | Web PubSub |
| The browser's live view | A second AppSync namespace, `agentforeach-browser`, where the sandbox's driver and the viewer each hold a token for their side | Web PubSub (relay hub) |
| Database | Your PostgreSQL in your VPC (or the foundation's RDS). The schema is applied by `<prefix>-migrate` (`migrate`), once per release, before the release serves | Cosmos DB or PostgreSQL |
| Skill files and sandbox exports | S3 buckets `skills` and `exports`, through the `s3` provider with the function role's credentials | Blob Storage |
| Sandboxes | Bedrock AgentCore Runtime: the [shared sandbox image](Sandbox.md#the-shared-image) (ARM64) in your VPC, invoked with IAM only. Optional S3 checkpoints of `/mnt/data` | ACA Sandboxes |
| Secrets | Secrets Manager, read once per cold start | Key Vault |
| Durable conformance | `<prefix>-conformance` (`conformance`), run by hand against the deployed durable function | |

**Following a turn.** API Gateway ends a request after 29 s, so a Lambda host can't hold a chat turn open: `POST /api/chat` with `wait: true` is refused (400), and every turn runs in the background. The client follows it over AppSync, and, after a reconnect or instead, with `GET /api/chat/runs/{runId}`, which returns the run's status. Pending forms are listed by `GET /api/hitl/pending`.

**Realtime.** `/negotiate` and `/api/token` return a connection descriptor, `{ protocol: "appsync-events", url, authorization, channels, expiresAtMs }`, and the portable client in `packages/platform/src/realtime/client` connects with it; the web chat sample uses that client on every cloud. AppSync Events has no inbound messages, presence or forced disconnect, and says so in its capabilities ([Realtime protocol](Realtime-Protocol.md)): messages from the client go over HTTP.

## Deploy

```bash
# An account with nothing yet: the foundation, then the application
AWS_REGION=us-west-2 deploy/aws/deploy.sh --stack dev --foundation dev-foundation --config path/to/agentforeach.json

# Your own VPC and PostgreSQL: set the network, database and sign-in settings first (below)
deploy/aws/deploy.sh --stack dev --config path/to/agentforeach.json

# Build, package and run the stacks against Pulumi's mocks: no account used
deploy/aws/deploy.sh --dry-run
```

What it does:
1. Builds, then packages the Lambda zip with `deploy/aws/package.sh` (into `deploy/aws/.release/`, git-ignored).
2. With `--foundation`, deploys the [foundation](#the-evaluation-foundation) and copies its outputs (VPC, subnets, database security group and secrets, the Cognito issuer, audience and JWKS) into the application stack's config.
3. **Bootstrap:** the artifacts bucket and the sandbox image repository.
4. **Image:** builds the sandbox image and pushes it, when sandboxes are on and the stack has no image yet (or with `--new-image`), and pins its digest in the stack.
5. **Migrate:** the functions' network access to the database and the `migrate` function, which the update runs: it applies `infra/postgres-schema.sql` (the current one, including the `chat-runs` collection behind `GET /api/chat/runs/{runId}`).
6. **Application:** everything else, then checks `/api/health`.

Each Pulumi step shows its preview and waits for your yes (Pulumi's own prompt); the image push asks first. `DEPLOY_YES=1` answers yes to all of it. A stack moves only forward through the phases (`bootstrap`, `migrate`, `application`): setting an earlier phase would remove what a later one created.

It is safe to run again, and that is how you upgrade. Within one `pulumi up`, the new release's functions are published as new versions, then **the new version of `migrate` applies the schema** (a Pulumi `aws.lambda.Invocation`, rerun for every release; the update stops if it fails), and only then do API Gateway, the schedule and AppSync's authorizer switch to the new versions. Until the switch the old release keeps serving: the schema only adds (`CREATE … IF NOT EXISTS`), so old code runs on it unchanged.

| Variable | What it does |
|---|---|
| `AWS_REGION` | The region for new stacks (default: the AWS CLI's) |
| `AWS_PROFILE` | The AWS CLI profile, if not the default |
| `DEPLOY_YES=1` | Don't ask (`pulumi up --yes`) |
| `IMAGE_PLATFORMS` | Must be `linux/arm64` (the default); the AgentCore deploy command rejects multi-architecture indexes. Build other architectures separately for CI and other clouds |
| `SANDBOX_IMAGE_BROWSER=1` | Include Chromium and the browser driver (set for you when the stack has `browserEnabled`) |

Options: `--stack <name>` (the application stack), `--foundation <stack>`, `--config <agentforeach.json>`, `--prefix <prefix>` (default `afe-<stack>`), `--new-image`, `--dry-run`.

### Settings

The application stack's settings are its Pulumi config (project `agentforeach-aws`, in `deploy/aws/infra`); [`Pulumi.example.yaml`](../deploy/aws/infra/Pulumi.example.yaml) lists them all. Set them with `pulumi -C deploy/aws/infra config set <key> <value> --stack <name>`. They are checked before anything is provisioned.

| Setting | What it is |
|---|---|
| `prefix` | Every resource name starts with it (3 to 25 characters). Default `afe-<stack>` |
| `vpcId`, `privateSubnetIds` | Your VPC and at least two private subnets (no public IP on launch). The functions need a route out to your model provider and JWKS (NAT, or endpoints) |
| `databaseSecurityGroupId`, `databasePort` | Your database's security group; the stack adds one inbound rule from the functions |
| `databaseSecretArn`, `databaseSecretJsonKey` | The runtime's PostgreSQL URL (TLS on) in Secrets Manager: the whole secret, or one JSON field |
| `migrationSecretArn` | Optional: an owner role for `migrate`, as JSON with `username` and `password` (how RDS keeps a master user's secret). `migrate` then creates the runtime's role with the URL's password and grants it reading and writing rows only. Without it, the runtime's role must own the schema |
| `jwtIssuer`, `jwtAudience`, `jwtJwksUri`, `allowedOrigins` | Sign-in and CORS ([below](#let-users-sign-in)) |
| `providerSecrets` | Model and tool keys, by the name `agentforeach.json` uses: `{ OPENAI_API_KEY: { arn, jsonKey } }` |
| `bedrockModelArns` | The Bedrock models the gateway may invoke, if `agentforeach.json` selects `bedrock` |
| `secretKmsKeyArns` | Customer-managed keys that encrypt those secrets |
| `sandboxEnabled` | Default true. False: no AgentCore runtime and no image |
| `workspacePersistence` | `/mnt/data` kept in S3 checkpoints between sessions (32 MiB compressed, 10,000 files at most) |
| `browserEnabled`, `browserEgressCidrs` | The [browser](Browser.md), and the IPv4 ranges it may reach over HTTPS, AppSync's included |
| `schedulerEnabled` | The minute schedule (default on) |
| `schedulerShards` | Only to match an existing deployment's `CRON_SCHEDULER_SHARDS`: changing it needs a migration |
| `poolSize` | PostgreSQL connections per function instance (default 2) |
| `reservedConcurrency` | Per function; `-1` (default) leaves it unreserved. Never 0, which stops every call |
| `durableExecutionTimeoutSeconds` | The longest one durable execution may run (default 8 hours; must exceed 6 hours plus the 15-minute handler budget). Longer work (a HITL form waits up to 6 days, an alarm ticks forever) hands over to a fresh execution every 6 hours |
| `conformanceKinds` | Registers the durable conformance suite's own kinds on the durable and conformance functions (`DURABLE_CONFORMANCE_KINDS=1`). Default off; on only for stacks that run the suite |
| `apiThrottleRate`, `apiThrottleBurst` | API Gateway's throttle for the whole API (default 50 a second, bursts of 100) |
| `logRetentionDays`, `protectData`, `releaseNonce` | Log retention; Pulumi protection for data (default on); change the nonce to roll a release without other changes |
| `applicationConfigPath` | The `agentforeach.json` to start from (default the repository's) |

**What the stack changes in your configuration.** It deploys a copy of `agentforeach.json` with the AWS choices applied: PostgreSQL, the `jwt` provider from the settings above (and only it), AppSync Events, and the AgentCore sandbox. The file itself is never changed. `$NAME` references in it resolve to `providerSecrets`.

**Secrets.** `DATABASE_URL`, the realtime signing key, the sandbox server's token and every `providerSecrets` entry reach the functions from Secrets Manager when a function starts, never through Pulumi config or Lambda environment variables. The stack generates the signing key and the sandbox token. A rotated secret reaches running functions on their next cold start; set a new `releaseNonce` to roll them all.

### The evaluation foundation

`deploy/aws/foundation` (Pulumi project `agentforeach-aws-foundation`) is for an account that has no VPC or database to use: a VPC with two private subnets, one NAT gateway, an S3 gateway endpoint (ECR's image layers, and this account's buckets only), a private RDS PostgreSQL (encrypted, TLS required, deletion-protected, `db.t4g.small` by default), the runtime's database URL in Secrets Manager, and a Cognito pool whose users only an administrator creates. RDS keeps the owner role's password itself; the application's `migrate` creates the runtime's role (`afe_app`).

It is a single-AZ evaluation design: one NAT gateway, one database instance. It is billable while it exists ([costs](#costs)).

### By hand

The same steps without the script, from the repository root:

```bash
npm ci
npm run build --workspace @agentforeach/deploy-aws
deploy/aws/package.sh "$PWD/deploy/aws/.release/agentforeach-lambda.zip"

cd deploy/aws/infra
pulumi stack init dev && pulumi config set aws:region us-west-2
pulumi config set phase bootstrap && pulumi up

../build-image.sh "$(pulumi stack output sandboxRepository)" r1     # prints the digest
pulumi config set sandboxImageDigest sha256:...
pulumi config set artifactPath "$PWD/../.release/agentforeach-lambda.zip"
# ...the network, database and sign-in settings...
pulumi config set phase migrate && pulumi up      # the update runs migrate: the schema
pulumi config set phase application && pulumi up
curl "$(pulumi stack output apiUrl)/api/health"
```

## Let users sign in

Only the `jwt` provider is deployed: tokens from your identity provider, checked against its JWKS (RS256), with `exp` required and the `sub` claim as the user id. **Until the settings point at a real issuer, every API call returns 401.** With the foundation, the issuer is its Cognito pool, whose users only an administrator creates (the live checks create and delete theirs). Easy Auth is never trusted off Azure, and `x-user-id` is refused.

## Permissions

Each function has its own role, and every Lambda it calls is a published version: callers get `function:<name>:*` (version-qualified ARNs only), never `$LATEST`. Old versions stay covered, so executions started by a previous release finish while the next one rolls out.

| Role | May do |
|---|---|
| Every function | Write its own logs; read its own release manifests (`releases/*/<kind>.json` in the artifacts bucket); read the secrets its manifest names (and decrypt them through Secrets Manager with `secretKmsKeyArns`) |
| In the VPC (all but the authorizer) | Lambda's network interfaces (the actions of `AWSLambdaVPCAccessExecutionRole`) |
| `durable` | `lambda:CheckpointDurableExecution`, `lambda:GetDurableExecutionState` on its own executions |
| `http`, `schedule`, `durable`, `conformance` | `lambda:InvokeFunction` on the durable function's versions (`function:<prefix>-durable:*`); `lambda:GetDurableExecution`, `lambda:SendDurableExecutionCallbackSuccess` and `lambda:StopDurableExecution` on their executions (`function:<prefix>-durable:*/durable-execution/*`; an unqualified ARN doesn't match) |
| `http`, `schedule`, `durable` | `appsync:EventPublish` on the chat namespace; `bedrock-agentcore:InvokeAgentRuntime` and `StopRuntimeSession` on the runtime and its endpoints; skills: `s3:ListBucket`, `s3:GetObject`; exports: `s3:GetObject`, `s3:PutObject`; erasure: `s3:ListBucketVersions`, `s3:DeleteObjectVersion` on both; workspace checkpoints: `s3:GetBucketVersioning`, `s3:GetObject`, `s3:PutObject`; Bedrock: `bedrock:InvokeModel*` on `bedrockModelArns` only |
| `schedule` | `sqs:SendMessage` to the dead-letter queue |
| `realtimeAuthorizer` | Only the signing key (no VPC, no database) |
| `migrate` | Only the database secrets: the runtime's URL and the owner role's |
| The sandbox runtime | Pull its image from its repository; write its logs. Nothing else: no secrets, no buckets, no functions |
| EventBridge Scheduler | Invoke the schedule function's versions; send to the dead-letter queue |

**Who deploys** needs, besides creating these resources, `lambda:InvokeFunction` on the migrate function (Pulumi runs it during the update) and `iam:PassRole` on the stack's roles. **Who runs the durable conformance suite** needs `lambda:InvokeFunction` on the conformance function.

No role can create a bucket. The S3 buckets are private (public access blocked, owner-enforced, AES-256, a policy that refuses anything but TLS), and the application buckets refuse versioning, so an erased user leaves no old versions behind. The sandbox runtime has no inbound authorizer: only IAM-signed calls reach it, and its server refuses any call without its token. The token protects `/invocations` from code inside the sandbox (a page open in its Chromium, say), not from the account's principals: it is in the runtime's environment, so anyone with `bedrock-agentcore:GetAgentRuntime` can read it. Grant that only to administrators. API Gateway and AppSync may invoke only their own function's published version, and nothing else is reachable from outside: no function URLs, no inbound security group rules.

`deploy/aws/audit-iam.sh` regenerates `iam-sdk-baseline.json`, the actions the AWS pack's SDK calls could use, with IAM Policy Autopilot. It is an audit aid; the roles get the narrower grants above.

## Network

- **The functions** run in your private subnets with one security group: HTTPS out, and your database's port to its security group. They need a route to AWS APIs, your model provider and your JWKS: a NAT gateway (the foundation's), or VPC endpoints plus whatever else your providers need.
- **The sandboxes** run in the same subnets with no route out: their security group allows HTTPS only to the S3 prefix list (ECR's image layers, through the VPC's S3 gateway endpoint) and to private endpoints for `ecr.api`, `ecr.dkr` and `logs`, which the stack creates with private DNS. An empty egress also stops the runtime from starting: it must reach those. Existing private-DNS endpoints for these services in the VPC conflict with the stack's; remove or reconcile them first.
- **The S3 gateway endpoint** on the private route tables must allow `s3:GetObject` on `arn:aws:s3:::prod-<region>-starport-layer-bucket/*` (ECR's layers) and the application's buckets. The foundation's allows those and nothing outside the account (`aws:PrincipalAccount` and `s3:ResourceAccount`).
- **With the browser**, the sandbox may also reach `browserEgressCidrs` over HTTPS: the sites it should open, and AppSync's endpoints for the live view.
- There is **no egress proxy** on AWS: `networkAccess` is `disabled` unless the browser is on, and credentials aren't injected at an egress as on Azure. Skills that call the internet from the sandbox don't work on AWS today.

## Releases and upgrades

A release is the package plus a manifest per function in the artifacts bucket (`releases/<release id>/<kind>.json`): the deployed copy of `agentforeach.json`, the environment, and which secrets to read. A function's environment holds only where its manifest is (`AGENTFOREACH_RELEASE_BUCKET`, `AGENTFOREACH_RELEASE_KEY`); a manifest sets no `AWS_*` name but `AWS_SANDBOX_*`. The release id changes with the package, the settings, `agentforeach.json`, the stack's code or `releaseNonce`.

- Every function is published as a new version; manifests name the others' versions, so nothing points at a mutable alias.
- The new versions serve only after the new `migrate` version has applied the schema ([Deploy](#deploy)).
- The minute schedule passes the minute each tick is for (`scheduledTime`), so a delayed or retried tick runs that minute's work.
- Old versions, manifests and packages are kept (the artifacts bucket is versioned, and they are retained on delete), so a durable execution started by an old release resumes on the old code.
- The sandbox runtime gets one endpoint per runtime version (`version_<n>`), reused by releases that don't change the image. **AgentCore limits endpoints per runtime**: before pushing many images, remove endpoints no session uses. Sessions keep the endpoint they started on.
- The sandbox security group is kept when replaced: AgentCore's network interfaces can outlive a runtime update by hours.

## Limits and differences from Azure

| | AWS | What it means |
|---|---|---|
| Requests | API Gateway ends a request at 29 s; the `http` function at 30 s | `wait: true` is refused; turns run in the background ([following a turn](#what-runs-where)) |
| Turns | A durable step runs at most 15 minutes per invocation; the turn deadline (9 minutes) fits | The step's remaining time bounds the turn |
| Work after a response | Lambda freezes after it returns, so the host waits for background work before returning, bounded by the deadline | A response can take a little longer while usage records are written |
| Realtime | AppSync Events: no inbound messages, no presence, no forced disconnect | Clients send over HTTP; `isUserOnline` isn't available |
| Download links | The role's credentials report no expiry, so links are capped at `OBJECT_STORE_S3_MAX_SIGNED_URL_SECONDS` (default 1 hour) | Raise it only with credentials that report their expiry |
| Exports | Deleted after 7 days by a lifecycle rule | Links never outlive them |
| Sandboxes | No egress proxy; ARM64 only; a session stops after 15 minutes idle and lives at most 1 hour | `/mnt/data` survives only with `workspacePersistence` (32 MiB compressed, 10,000 files); processes never do |
| Database | PostgreSQL only. **Cosmos DB isn't deployed** on AWS | |
| Package | One esbuild bundle (`dist/deploy/aws/lambda.mjs`, from `npm run build:aws`) with the config and the schema; no `node_modules`. The only external is the optional `pg-native` | A dependency that can't be bundled needs a change to the build |
| Easy Auth | Never trusted | Use the `jwt` provider |

## Costs

What runs all the time, at approximate us-west-2 list prices (October 2026; check [AWS pricing](https://aws.amazon.com/pricing/) for your region):

| | About |
|---|---|
| The sandbox runtime's three interface endpoints, in two subnets | $44 a month |
| The foundation's NAT gateway and its public address | $37 a month, plus $0.045 per GB through it |
| The foundation's RDS `db.t4g.small` with 20 GB | $26 a month, plus backups |
| Secrets Manager (the signing key, the sandbox token, the database's, plus yours) and the log key | $0.40 a secret and $1 a key, a month |

Everything else is paid per use: Lambda requests and duration, API Gateway requests, AppSync connection minutes and messages, EventBridge Scheduler (about 43,000 invocations a month), S3, CloudWatch Logs, and AgentCore Runtime per vCPU-second and GB-second while sessions run. An idle deployment without the foundation costs about the endpoints and the secrets. [What it costs](costs.md) models the per-user costs.

## What was validated

The consolidated implementation was deployed to a fresh foundation in `us-west-2` on 5 October 2026. Application acceptance passed 21 checks; the real durable suite passed 25; sandbox conformance passed 10 with one unsupported-capability skip; the shared Chromium/AppSync handoff passed five checks; real S3 passed 19. Node 22/24 gates and Cloudflare conformance passed. Azure AI Foundry supplied the models; this account's Bedrock model quotas remain zero.

[The validation record](AWS-Validation.md) lists the fixes, evidence, retained test deployment, and remaining limitations. It supersedes the earlier prototype's results for the current one-package implementation. A pending form resumed across a real deployment, an AWS-enforced worker timeout retried successfully, and an active model/tool turn survived client reconnection. An eight-minute browser handoff preserved viewer input; cookies and workspace files recovered on a new AgentCore image version. See the record for the precise scope of these tests.

The stacks' resource graphs are tested against Pulumi's mocks in CI (`npm run test:deploy:aws`): the phases, the handler wiring, the IAM above, the bucket rules and that nothing is public. Mocks don't show that AWS accepts the graph or authorizes the calls.

## Check a deployment

Against a deployed stack, never in CI:

```bash
pulumi -C deploy/aws/foundation stack output --json --stack dev-foundation > /tmp/afe-foundation.json
pulumi -C deploy/aws/infra stack output --json --stack dev > /tmp/afe-application.json

# Two Cognito users against the API and AppSync; they and their data are deleted at the end
AWS_APPLICATION_LIVE=1 node scripts/test-aws-application-live.mjs /tmp/afe-foundation.json /tmp/afe-application.json
# Also require the model: the sandbox tool and HITL answers end to end
AWS_APPLICATION_LIVE=1 AWS_LIVE_MODEL_FLOWS=1 node scripts/test-aws-application-live.mjs /tmp/afe-foundation.json /tmp/afe-application.json

# From inside the VPC: the migration again, and the durable conformance suite on the deployed function
AWS_APPLICATION_LIVE=1 node scripts/test-aws-private-probe.mjs /tmp/afe-application.json

# The sandbox suite against AgentCore
node scripts/test-sandbox-conformance-live.mjs aws-agentcore
```

## Teardown

```bash
deploy/aws/teardown.sh --stack dev [--foundation dev-foundation] [--delete-data]
```

It shows the account and stacks and asks; pauses every function (reserved concurrency 0); exports each stack's state to `deploy/aws/.teardown/` (git-ignored); previews and destroys the application, then the foundation. Without `--delete-data`, protected data (buckets, the image repository, secrets, the log key, the database) stays. With it, you type the stack's name, and the script turns off RDS's and Cognito's own deletion protection after asking. The database keeps a final snapshot.

A destroy doesn't remove everything: buckets and their versions, old release manifests, images, sandbox endpoints and security groups, log groups, secrets and the KMS key are retained on purpose. The script lists each with the command that removes it, and runs none of them. AgentCore's network interfaces can hold the VPC for up to eight hours after the runtime is gone; wait, then destroy the foundation again. Never force-detach them, and never run `pulumi up` during a teardown. Billing lags deletion.

## Troubleshooting

`aws logs tail /aws/lambda/<prefix>-http --follow` streams a function's logs (likewise `-durable`, `-schedule`, `-migrate`).

| Symptom | Cause |
|---|---|
| Every API call returns 401 | The `jwt` settings don't match your tokens' issuer, audience or keys |
| `POST /api/chat` returns 400 with `wait: true` | Expected on Lambda: follow the turn over AppSync or `GET /api/chat/runs/{runId}` |
| `relation "…" does not exist` | The schema wasn't applied: run `deploy.sh` again (the update runs `migrate`), or invoke `migrateFunctionArn` |
| `pulumi up` fails at `migration` | `migrate` returned an error, so nothing switched to the new release. Its message says why; `aws logs tail /aws/lambda/<prefix>-migrate` has the rest |
| `migrate: applying the schema failed (42501)` | The migration's role can't create the `vector` extension or the tables: set `migrationSecretArn` to an owner role |
| The functions time out reaching the database | The database security group or the subnets' routes: the stack adds one inbound rule; NACLs and route tables are yours |
| Sandbox calls fail to start | The runtime can't pull its image: the S3 gateway endpoint, its policy, or the private endpoints. AgentCore needs them even with no other egress |
| A new image doesn't deploy: endpoint limit | AgentCore limits endpoints per runtime. Remove `version_<n>` endpoints no session uses |
| Ticks in the dead-letter queue | The schedule function failed or was throttled; the alarm fires. Replay a message only after fixing the cause |

## Next

- [Platforms](Platforms.md): the ports, and how each pack implements them
- [Database](Database.md): PostgreSQL settings and pooling
- [Sandboxes on AWS](AWS_Evaluation.md): the AgentCore evaluation against the other platforms

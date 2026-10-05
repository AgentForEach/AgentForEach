# AWS platform live validation — 5 October 2026

The consolidated `platform/aws-pack` implementation was deployed to a fresh, isolated test foundation in `us-west-2`. The starting revision was `a8c0f06`, with the fixes below applied and deployed during validation. This checks the current shared platform implementation, rather than the older AWS prototype. Nothing was merged into `main` or published.

## Results

| Check | Observed result |
|---|---|
| Foundation and application | Private RDS PostgreSQL 17.11, Cognito, API Gateway, six Lambda functions from one package, one durable function, AppSync Events, S3 and the shared ARM64 AgentCore image deployed successfully |
| Migration | The published migration function applied the schema and application-role grants; an explicit rerun succeeded |
| Application acceptance | 21 passed, 0 failed, no suite blockers; includes cleanup checks |
| Deployed durable contract suite | 25 passed, 0 failed, 0 skipped: jobs, waits, alarms and instance lifecycle on the real AWS durable function |
| AgentCore sandbox contract suite | 10 passed, 0 failed, 1 skipped: commands, binary files, timeouts, concurrent calls, environment replacement, S3 persistence across session stop, archive limits and account erasure. Proxy credential injection is skipped because AWS advertises it as unsupported |
| Shared Chromium and portable AppSync relay | Five checks passed: navigation to a private synthetic S3 page, PNG screenshot, browser frames and viewer typing over AppSync, cookies after session stop/S3 restore, and reset clearing cookies. The synthetic workspace and fixture version were deleted |
| Real S3 using the AWS platform credential chain | 19 passed, 0 failed, 0 skipped: bytes, metadata, key validation, pagination, isolated deletion, signed downloads, reported expiry, and the default one-hour cap. Unique test prefixes and all their versions were erased |
| Node 24 and Node 22 | Builds, gateway/infra/Worker/Lambda type checks, 2,159 tests each (2,140 passed, 18 skipped, 1 existing TODO, 0 failed), bundle guards, and Cloudflare realtime/durable/host conformance passed |
| Actual Lambda worker interruption | AWS terminated a worker at its temporary 30-second timeout; the same durable execution retried (recorded attempts 1 and 2), completed its job, and ended `SUCCEEDED`. The timeout is confirmed by AWS's `platform.report` log, rather than a simulated stop request |
| Reconnect during an active model/tool turn | The client disconnected while a real sandbox tool was running, reconnected through a fresh descriptor, and received completion. Retrying the original key returned the same run; exactly one assistant reply was stored |
| Pending form across a release | The form was recovered once after a real release, its answer resumed successfully, and retrying that answer returned the same continuation. All 167 health observations during the corrected rollout returned HTTP 200; the previous HTTP version retained its scoped invocation policy |
| Long handoff and image-version recovery | Six checks passed with an actual eight-minute AppSync handoff: viewer input, cookie and workspace-file recovery from S3 on AgentCore runtime version 2 with a distinct image digest, and reset clearing cookies. Both the synthetic workspace and fixture version were removed |
| Deployment fix on both Node versions | All 18 existing infrastructure contract tests passed on Node 22 and 24; the deployment type check passed |

The known TODO is the browser Web Worker WebSocket guard documented in [Browser.md](Browser.md); it remains unresolved. The skipped local suites require live services. The deployment used Node 22 Lambda runtimes; Node 24 is a local/CI gate, not a claim of testing a Node 24 Lambda runtime.

Chat and tool execution used the existing Azure AI Foundry `mcp-servers-7853` configuration, discovered with Azure CLI. Its recovered AWS secret reference matched the current Azure account key. Embeddings were configured for `text-embedding-3-small` on the same endpoint; a standalone embedding request was not checked. No key was printed or placed in source. Bedrock inference remains blocked by this AWS account's zero model quotas; an actual Nova invocation was throttled. AgentCore sandbox execution does not require a Bedrock model quota and passed separately.

## Fixes found by live validation

- EC2 rejected apostrophes in security-group rule descriptions. Both descriptions now use accepted characters; the existing infrastructure contract test checks AWS's description character set.
- PostgreSQL rejected untyped variadic `format()` parameters during role provisioning. String parameters are explicitly cast to `text`; the real migration now succeeds, including its idempotent rerun. Passwords remain parameterized.
- Pulumi's secret heuristic rejected foundation secret ARNs. The deployment script explicitly stores these references as plaintext configuration; secret contents continue to come from Secrets Manager.
- The shared HTTP chat handler accepted an unknown, closed or another user's form answer as an ordinary new message. It now returns 404, or 503 when the form store is unavailable, before starting a turn. The regression failed before the fix and passed afterward on both Node versions; the corrected live foreign-user request also passed.
- The application probe used obsolete realtime callback and form-answer fields. It now uses the portable client's `onMessage` callback and the current direct-form continuation contract, including a valid message/session and idempotency key.
- A release removed the prior HTTP Lambda invocation permission while API Gateway could still use that version: answering a recovered form received a gateway 500 without a matching Lambda invocation. The deployment now creates the new permission before switching the integration and retains the old, API/account-scoped version permission. AppSync authorizer version permissions are retained for the same propagation window. A subsequent real rollout passed the pending-form continuation and continuous API health checks. Function deletion removes its version policies.
- The long-browser probes initially treated a failed test-page load as a lost cookie. An instrumented rerun confirmed that the old signed S3 fixture returned `ExpiredToken` after its temporary credentials expired, even though the restored checkpoint contained the cookie. Renewing the fixture URL produced a valid page with the cookie intact; the full eight-minute handoff, image-version recovery and reset then passed without changing production browser code. The initial failures and corrected evidence are retained.
- The object-store contract test assumed temporary credentials could always sign for a full hour. It now checks that the reported link is still valid, ends no later than requested, and matches the signed URL's actual expiry. The real credential chain shortened links correctly; signed downloads succeeded.

Production fixes use existing platform and gateway boundaries. Regression coverage extends existing test files. The browser and S3 probes reuse the shared handlers, portable client and conformance suite; no duplicate production AWS browser or object-store implementation was added.

## Limits of this run

These are targeted functional and resilience checks of a preview, not production load or resilience certification. Worker interruption was an actual AWS-enforced invocation timeout during a held durable conformance job, rather than an arbitrary process kill or a model-turn kill test. The image update used a distinct ARM64 image digest and AgentCore runtime version, with a test-only label change; the shared sandbox server binaries were unchanged. Azure validation was completed separately, as confirmed by the maintainer. This AWS run did not redeploy Azure. Bedrock inference remains blocked by account quotas; a standalone embedding request remains unverified as described above.

## Evidence and retained deployment

Private logs, JSON reports, before/after reproductions and the small live probes (including the initial failures and corrected runs in the `resilience/` subdirectory) are retained locally under `deploy/aws/.release/live-validation/2026-10-05/` (git-ignored). The sandbox suite's observed summary is recorded above; its stdout was not saved as a full transcript. No secret-bearing manifest or secret value is included in the evidence directory.

Both Pulumi projects use stack `aws-pack-live-20261005`, prefix `afe-pack-live`, with an encrypted local backend at `deploy/aws/.release/live-state/`. Preserve that backend and its private passphrase file for resuming or tearing down the test. The local backend was used because the configured Pulumi Cloud organization lacked an active subscription.

At the initial pause, eight remaining synthetic durable executions were stopped. After the resilience checks, the schedule was disabled and all six Lambda functions were paused with reserved concurrency zero. The test NAT gateway, its routes, and three interface endpoints were removed; the fresh test NAT address was released. The reused model-key secret was returned to scheduled deletion with a 30-day recovery window. Older evaluation VPCs and addresses were left alone.

RDS is confirmed `stopped`; AWS reports automatic restart at **12 October 2026, 06:52 UTC**. The private pause report records its state. Storage, backups, ECR images, keys, secrets and retained logs can still incur charges. A stopped RDS instance automatically restarts after seven days ([AWS documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html)).

To resume, restore the model secret if necessary, start RDS, refresh the foundation stack to recreate the deleted NAT/address/routes, and refresh the application stack to recreate its private endpoints and restore Lambda concurrency. Re-resolve the test browser's AppSync destination addresses before enabling handoffs; the temporary IPv4 allowlist is not a stable production DNS policy. Review every Pulumi preview. Enable only the test schedule when needed and clean up synthetic users afterward.

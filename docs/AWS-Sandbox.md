# AWS sandbox (Bedrock AgentCore Runtime)

The `aws-agentcore` sandbox backend runs each user's sandbox as a session of an Amazon Bedrock AgentCore Runtime. The runtime runs the same sandbox image as every other cloud ([`gateway/sandbox-container/Dockerfile`](../gateway/sandbox-container/Dockerfile)), and the gateway reaches its server (`server.mjs`) through the shared `SandboxServerClient`, over `InvokeAgentRuntime`. The agent loop stays in the gateway: AgentCore runs only the sandbox, and no model is called through it.

Code: [`packages/platform-aws/src/sandbox/`](../packages/platform-aws/src/sandbox). The port it implements, and the other backends: [Sandboxes](Sandbox.md).

## What it does

| Sandbox call | On AgentCore |
|---|---|
| `exec`, files, `setEnv` | One `InvokeAgentRuntime` per call, carrying the server's `/invocations` envelope `{ token, path, method, body }`; the server answers `{ status, body }` |
| Identity | Runtime session ids are SHA-256 hashes, scoped to the owner (a hash of the user id); no user id reaches AWS. One sandbox per user, or per conversation (`identifierStrategy: "sessionId"`) |
| Concurrent calls | One owner's calls run one at a time in a gateway instance; in `s3-checkpoint` mode the owner's lease does the same across instances (a call waits up to 30 s for it) |
| Persistence | `ephemeral`: files live as long as the runtime session (`persistence: "disk"`). `s3-checkpoint`: `/mnt/data` is kept in S3 between sessions (`persistence: "data"`, with `persistenceLimits`) |
| Credentials | Environment variables in the sandbox (`egressCredentials: false`): code in the sandbox can read them. There is no egress proxy to inject them outside |
| Account erasure | A new generation for the owner, checkpoints overwritten, every session the owner started stopped (`StopRuntimeSession`) |
| Browser | When the image is built with it (`aws.browser: true`); its cookies, localStorage and IndexedDB are saved before every checkpoint |

The AWS SDK's retries are off for `InvokeAgentRuntime`: after an ambiguous failure (a timeout, a reset connection) a command may already have run, so the failure is reported and the command is never sent again. A client timeout doesn't prove a command didn't run.

## Configuration

`skills.sandbox` in `agentforeach.json`:

```json
{
  "enabled": true,
  "provider": "aws-agentcore",
  "identifierStrategy": "userId",
  "aws": {
    "runtimeArn": "$AWS_SANDBOX_RUNTIME_ARN",
    "serverToken": "$AWS_SANDBOX_SERVER_TOKEN",
    "storageMode": "ephemeral"
  }
}
```

Every `aws` field also falls back to an environment variable, so the deployment can inject it:

| Field | Env var | Default |
|---|---|---|
| `runtimeArn` | `AWS_SANDBOX_RUNTIME_ARN` | Required |
| `qualifier` | `AWS_SANDBOX_QUALIFIER` | The runtime's DEFAULT endpoint |
| `region` | `AWS_SANDBOX_REGION` | The ARN's (and it must match) |
| `serverToken` | `AWS_SANDBOX_SERVER_TOKEN` | Required: the runtime's `SANDBOX_SERVER_TOKEN` |
| `storageMode` | `AWS_SANDBOX_STORAGE_MODE` | `ephemeral` |
| `workspaceBucket` | `AWS_SANDBOX_WORKSPACE_BUCKET` | Required for `s3-checkpoint` |
| `persistenceLimits.maxBytes` | `AWS_SANDBOX_ARCHIVE_MAX_BYTES` | 32 MiB (at most 64 MiB) |
| `persistenceLimits.maxFiles` | `AWS_SANDBOX_ARCHIVE_MAX_FILES` | 10,000 |
| `browser` | | `false` |
| `defaultTimeoutSec`, `maxTimeoutSec` | | 60, 200 |

`SANDBOX_PROVIDER=aws-agentcore` picks the provider, as on the other clouds. The gateway uses the default AWS credential chain (its execution role); no static keys. The AWS entry point registers the provider:

```ts
registerSandboxProvider(AWS_AGENTCORE_PROVIDER, (config) =>
  new AwsAgentCoreSandbox({ ...agentcoreSandboxOptions(config), storage: getSharedStorage() }));
```

The backend stores its records in two collections, `aws-sandbox-sessions` and `aws-sandbox-workspaces` (in the generated catalog, so `infra/postgres-schema.sql` creates them). They hold hashes (owner, session ids, runtime ARN and qualifier), never commands, files or credentials. They are keyed by `owner`, not `userId`, on purpose: the generic account erasure must not delete the only handles to running sessions before they are stopped; the backend removes each record once its session has stopped.

## The runtime

What the deployment must create (no part of the gateway creates or inspects it):

- **Image.** The one sandbox image, for `linux/arm64` (AgentCore runs arm64 only): `scripts/build-aws-sandbox.sh <ecr repository url> <tag>` builds it and pushes it to a private ECR repository, and prints the digest. `SANDBOX_IMAGE_BROWSER=1` adds the browser.
- **Protocol.** HTTP, port 8080: the server answers `GET /ping` (`Healthy`, or `HealthyBusy` while a request runs) and `POST /invocations`. Inbound auth is IAM (SigV4); never expose these routes without it.
- **Environment.**
  - `SANDBOX_SERVER_TOKEN`: a random secret of at least 16 characters (32 or more recommended), the same value the gateway has as `AWS_SANDBOX_SERVER_TOKEN`. Every envelope carries it, and the server compares it in constant time; without it, or with the wrong one, every envelope is refused with 401. The server drops it from its environment, so commands don't inherit it. An image with the browser refuses to start without it, since a page in Chromium could otherwise reach the server.
  - `s3-checkpoint` only: `SANDBOX_ARCHIVE_MAX_BYTES` and `SANDBOX_ARCHIVE_MAX_FILES`, equal to the gateway's `persistenceLimits`.
- **No filesystem configuration** in either mode: no managed session storage, capacity-provider volumes, EFS or S3 Files mounts. Compute stays ephemeral; `s3-checkpoint` keeps files through the gateway instead. Managed session storage was measured to reset when the runtime version changes, so it can't hold users' files across deployments.
- **Lifecycle.** Set the idle timeout and maximum lifetime on the runtime. `ephemeral` files go with the session; export what matters with `sandbox_file_export`.
- **Network.** The runtime's network mode is the sandbox's egress policy; the backend declares nothing about it. For no general internet access, run it in a VPC whose outbound rules allow only what image start-up and logging need (private ECR API and DKR endpoints, S3 for the image layers, CloudWatch Logs). Per-host allowlists and header injection, as on Azure and Cloudflare, don't exist here.
- **Execution role.** Only image pull and logging. No access to the database, the export or workspace buckets, or the gateway's secrets: code in a session can use the runtime's credentials. Restrict its trust policy to AgentCore with `aws:SourceAccount` and `aws:SourceArn`. Keep CloudWatch logs encrypted with a retention, and never log request bodies: `setEnv` calls carry credentials.

The gateway's role needs, on the runtime and its endpoints:

- `bedrock-agentcore:InvokeAgentRuntime`
- `bedrock-agentcore:StopRuntimeSession`

and nothing on the control plane.

## Storage modes

### `ephemeral`

Each sandbox is a runtime session; its files, installed packages and environment last as long as the session. An idle timeout, the maximum lifetime, an unhealthy replacement or a new runtime version ends it, and the same sandbox then starts empty.

### `s3-checkpoint`

Each sandbox's `/mnt/data` is kept in S3, one object per sandbox (`workspaces/v1/<key>.json`), and every operation:

1. takes the owner's lease (one operation at a time per owner, across instances; a lease lasts 10 minutes);
2. fences the checkpoint: rewrites the object conditionally, so an older operation can no longer save over it;
3. restores the checkpoint onto the lease's compute (a runtime session); the server skips it when that compute already holds it, so a running browser keeps its files;
4. runs the call;
5. for a call that may change files (`exec`, a file write), archives `/mnt/data` (the server's bounded `/archive`) and commits it to S3, conditionally on the fenced version.

The compute is reused only when the last operation on it committed cleanly; any failure moves the next operation to new compute, restored from the last commit. A failure after the command ran (a lost connection, a failed save) is reported, and the command's changes are not kept; side effects outside the sandbox can't be undone.

What a checkpoint keeps:

- Regular files, directories and symlinks under `/mnt/data`, with their permission bits and file times. Hard links become copies. Sockets, FIFOs and devices are left out, and so are Chromium's caches under `.browser/` (they rebuild themselves).
- At most `persistenceLimits.maxBytes` of file contents, `persistenceLimits.maxFiles` files, directories and links, and an archive of at most `maxBytes` plus 1 MiB compressed. Over any of these the call fails with `SandboxPersistenceLimitError`, and the sandbox is back to its last saved files. Nothing is ever saved cut short.
- Not processes, nothing outside `/mnt/data` (packages installed elsewhere are gone with the compute), not the environment. Environment variables are kept in the gateway instance's memory and applied again whenever files are restored onto new compute; a new gateway instance applies them on its next turn, as every turn does.

The archive travels whole in one `InvokeAgentRuntime` payload (100 MB at most), base64, which is why `maxBytes` is at most 64 MiB. Restoring and saving it on every operation adds latency and S3 traffic: this mode suits small working sets, not repositories or datasets.

**The workspace bucket.** One bucket for every user, used by nothing else:

- It must never have had versioning: enabled or suspended, the backend refuses it (it checks `GetBucketVersioning` once per instance). Erasure overwrites checkpoints, and an older version would keep the erased files. Deny `s3:PutBucketVersioning` in the bucket policy.
- Block public access, deny non-TLS requests, encrypt with SSE-S3 (every write sets it). The backend sends `ExpectedBucketOwner` (the runtime ARN's account) on every request.
- No lifecycle expiry, replication or backup of the objects: deletion markers fence stale writers, and copies would escape erasure.
- The gateway's role needs only `s3:GetBucketVersioning` on the bucket and `s3:GetObject` and `s3:PutObject` on `workspaces/*`. No `s3:ListBucket` (a missing object is found with a conditional create), no `s3:DeleteObject`. The sandbox gets neither credentials nor signed URLs for it.

Every write is conditional (S3 conditional writes): a checkpoint is created only if absent (`If-None-Match: *`) and replaced only at the version this operation fenced (`If-Match`). A writer that lost its lease, or whose account was erased, fails at its next write.

## Account erasure

`deleteUserSandboxes` (called by account erasure):

1. starts the owner's next **generation**: their next call gets new runtime session ids and an empty sandbox, so an erased user can start again;
2. in `s3-checkpoint` mode, overwrites each of the owner's checkpoints with a deletion marker for the erased generation (never a newer generation's). A writer of the erased generation then finds the marker and stops, and its conditional writes fail; the next generation finds it and starts empty;
3. stops every runtime session the owner started (`StopRuntimeSession` on the qualifier each was recorded with, so endpoints of earlier releases are covered too) and removes each record once stopped. A session recorded on another runtime ARN is refused rather than stopped through this one: erase again with that runtime configured.

A failed stop keeps its record and makes the erasure report an error; erasing again retries it. If an operation held the owner's lease during the erasure, its data is fenced at once, but it may still be running remotely for up to 15 minutes (its lease and a 5-minute allowance): the erasure reports that, and erasing again after it stops anything that operation started. What stays in the bucket is one small deletion marker per erased sandbox, and the database keeps the hashed owner records; deleting either would undo the fencing.

## Tests

- `npm test --workspace @agentforeach/platform-aws`: the sandbox conformance suite in both modes against a stand-in runtime that runs the real `server.mjs` per session (with sleep, persistence limits and erasure in `s3-checkpoint` mode), plus the identifier, retry, erasure, lease, generation and checkpoint cases on a fake S3.
- `npm test --workspace @agentforeach/gateway`: the server's `/ping`, `/invocations` (401 cases) and bounded `/archive`, the archive format's checks, and the configuration.
- Live, billable: `node scripts/test-sandbox-conformance-live.mjs aws-agentcore` against a deployed runtime (its header lists the settings).
- The image: `scripts/smoke-sandbox-image.sh <image> linux/arm64` runs it as AgentCore calls it.

## AWS references

- [InvokeAgentRuntime](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html) and [StopRuntimeSession](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_StopRuntimeSession.html)
- [Runtime service contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html) (`/ping`, `/invocations`, port 8080, arm64)
- [Session isolation and lifecycle](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html)
- [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- What we measured on AgentCore before building this: [AWS evaluation](AWS_Evaluation.md)

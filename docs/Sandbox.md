# Sandboxes

AgentForEach can give each user a private sandbox where the agent runs code. The brain (the Function App) never runs model-written or skill code itself; it sends commands to a sandbox over REST.

There are two backends:

| | ACA Sandboxes (primary) | ACA Dynamic Sessions (fallback) |
|---|---|---|
| Unit | One microVM per user (or per conversation) | A session in a shared pool |
| When idle | **Suspends**: disk snapshot kept, no CPU/memory billing | **Destroyed** after the cooldown; files are lost |
| Egress | Deny by default with full inspection, per-host allow rules | On or off for the whole pool |
| Credentials | Injected by the egress proxy for declared hosts; never in the sandbox | Set as environment variables in the session |
| Image | Private disk image built by `scripts/build-aca-sandbox-image.mjs` | Azure's PythonLTS, or a custom container in ACR |

Why ACA Sandboxes became the default, measurements from a live group, costs, risks and how to switch an existing stack: [Sandbox-Migration.md](Sandbox-Migration.md). ACA Sandboxes is a **preview** Azure service.

## What the model gets

When `skills.sandbox.enabled` is true and a backend is configured, each turn offers these tools (`skills/sandbox/handler.ts`):

| Tool | Does |
|---|---|
| `sandbox_exec` | Runs `bash -c "<command>"` in `/mnt/data`, with a timeout the server caps |
| `sandbox_file_write` / `sandbox_file_read` / `sandbox_file_list` | Text files in `/mnt/data/` |
| `sandbox_file_export` | Uploads a file to Blob Storage (`user-exports`) and returns a read-only, time-limited (24 h by default) download link |
| `sandbox_skill_load` | Unpacks a skill's zip into `/mnt/data/<skill_id>/` and returns its `SKILL.md` |

Output is truncated to `maxOutputChars` (50,000 by default). With the default `identifierStrategy: "userId"`, every conversation of a user shares one sandbox; `"sessionId"` gives each conversation its own.

## Choosing the backend

`createSandboxBackend` (`skills/sandbox/factory.ts`) picks the backend:

1. The provider is the `SANDBOX_PROVIDER` app setting if set (Pulumi sets it), else `skills.sandbox.provider` in `agentforeach.json`, else `aca-sandboxes`. `aca` is accepted as a legacy name for `aca-sessions`.
2. With `aca-sandboxes`, the client needs a subscription, resource group and sandbox group (the `ACA_SANDBOX_*` settings). If they're missing but a session pool endpoint (`ACA_POOL_MANAGEMENT_ENDPOINT`) is set, AgentForEach logs a warning and falls back to Dynamic Sessions with the `aca` timeouts. If neither is set, the sandbox tools are disabled.
3. With `aca-sessions`, the Dynamic Sessions client is used.

Both authenticate with the Function App's managed identity (audience `https://dynamicsessions.io`), or your `az login` locally.

## ACA Sandboxes

**Lifecycle.** On a user's first sandbox call, `AcaSandboxesClient` finds their sandbox by label or creates one. Labels hold hashes (`agentforeach-owner` = hash of the owner identifier, `agentforeach-user` = hash of the user id), never user ids, and the owner label is checked on every lookup and state read; a sandbox whose label doesn't match is never used. A stopped sandbox is resumed on the next call. After `autoSuspendSec` idle seconds (300 by default) it suspends; `autoDeleteDays` after it stopped (30 by default) it is deleted. If two instances create a sandbox for the same user at once, both converge on the older one.

**Suspend mode.** `Disk` (default) keeps files; processes restart on resume. `Memory` is documented to keep processes too, but a live test found background processes gone after an auto-suspend in both modes, so don't rely on it.

**Commands.** Each command runs in `/mnt/data`, sources the env file written by the brain, and is wrapped in `timeout(1)` inside the sandbox. Defaults: 120 s, capped at 200 s (below the 230 s HTTP front-end limit).

**Egress.** With `networkAccess: "disabled"` (default) the policy is deny-by-default with `trafficInspection: "Full"`, so raw TCP/UDP is blocked too. Hosts you trust go in `sandboxes.egressAllowHosts` (for example `pypi.org`). `"enabled"` allows all egress.

**Credentials.** A skill can bind each credential to hosts in its `SKILL.md`:

```yaml
credentials: [{"key":"GITHUB_TOKEN","label":"GitHub token","required":true,"hosts":["api.github.com","*.githubusercontent.com"],"header":"Authorization","format":"Bearer {value}"}]
```

On the first sandbox call of each turn, the brain rewrites the sandbox's egress policy and env file:

- A credential with `hosts` and `header` becomes an egress-proxy `Transform` rule that sets that header on requests to those hosts only. The secret never enters the sandbox; the env var holds the placeholder `injected-by-egress-proxy`, so a script sending `Authorization: Bearer $GITHUB_TOKEN` still works because the proxy overwrites the header.
- Any other credential is written to an env file (created with `umask 077`) that every command sources, so sandbox code can read it.
- Both are rewritten even when the user has no credentials, so a revoked secret doesn't linger in a sandbox that outlives the turn.

Separately, `http_fetch` (which runs in the brain) refuses to send a host-bound credential to any other host, and refuses credentials with no declared hosts unless `skills.requireCredentialHosts` is `false`.

**Account deletion.** Erasing a user's data (`DELETE /api/me/data`, or the admin route) deletes all their sandboxes, and with them their snapshots and files (`deleteUserSandboxes`, called from `account/erase.ts`).

### Configuration

`skills.sandbox.sandboxes` in `agentforeach.json` (defaults in `skills/config.ts`):

| Key | Default | Notes |
|---|---|---|
| `subscriptionId`, `resourceGroup`, `sandboxGroup`, `region` | from `ACA_SANDBOX_SUBSCRIPTION_ID`, `ACA_SANDBOX_RESOURCE_GROUP`, `ACA_SANDBOX_GROUP`, `ACA_SANDBOX_REGION` | The region selects the regional data-plane endpoint; `endpoint` overrides it |
| `diskImageId` | `ACA_SANDBOX_DISK_IMAGE_ID` | Private image; unset means the public `diskImage` (`ubuntu`), which has no `pip` or `node` |
| `cpu`, `memory`, `disk` | `1000m`, `2048Mi`, service default | The disk must be at least the image's size |
| `autoSuspendSec`, `suspendMode`, `autoDeleteDays` | 300, `Disk`, 30 | `autoDeleteDays: 0` never deletes |
| `egressAllowHosts` | `[]` | Only used when `networkAccess` is `disabled` |
| `defaultTimeoutSec`, `maxTimeoutSec` | 120, 200 | |

### Infrastructure

With `agentforeach:sandboxEnabled true` and `agentforeach:sandboxProvider aca-sandboxes` (the default provider), `pulumi up` creates a sandbox group (through an ARM deployment, as Pulumi has no type for it yet), gives the Function App's managed identity the built-in **Container Apps SandboxGroup Data Owner** role (`c24cf47c-5077-412d-a19c-45202126392c`) on it, and sets `SANDBOX_PROVIDER` and the `ACA_SANDBOX_*` app settings. Other keys:

- `agentforeach:sandboxGroupLocation` — region for the group, if your stack's region doesn't offer Sandboxes yet.
- `agentforeach:sandboxGroupMaxCount` — cap on sandboxes in the group.
- `agentforeach:sandboxDiskImageId` — the image id from the build script; sets `ACA_SANDBOX_DISK_IMAGE_ID`.

Running sandboxes count against the subscription's regional "Sandbox Cores" quota; check it before a launch.

For local development, `az login`, give your user the same role on the group, and fill the `ACA_SANDBOX_*` keys in `local.settings.json`.

### Building the disk image

No container registry is involved. `scripts/build-aca-sandbox-image.mjs` starts a build sandbox from the public `ubuntu` image with egress open, runs `packages/gateway/sandbox-container/provision-aca.sh` in it (Python with pip, Node and npm, git, jq, zip, compilers; `SANDBOX_IMAGE_FULL=1` adds Java, PHP, Ruby and Go), commits it to a private disk image, boots a verification sandbox from the image at production size with egress denied, and prints the image id.

```bash
npx tsc -p packages/gateway     # the script imports the compiled client
ACA_SANDBOX_SUBSCRIPTION_ID=<subscription-id> ACA_SANDBOX_RESOURCE_GROUP=<resource-group> \
ACA_SANDBOX_GROUP=<sandbox-group> ACA_SANDBOX_REGION=<region> \
  node scripts/build-aca-sandbox-image.mjs
pulumi config set agentforeach:sandboxDiskImageId <printed id>
```

Build at production size (`ACA_SANDBOX_CPU`, `ACA_SANDBOX_MEMORY`, `ACA_SANDBOX_DISK`; defaults 1 vCPU / 2 GiB): an image keeps the build sandbox's disk size, and a smaller sandbox can't boot it.

`.github/workflows/sandbox-image.yml` rebuilds the image weekly (and on demand) so sandboxes get OS and runtime updates. It is skipped until you set the repository variables it lists (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `ACA_SANDBOX_RESOURCE_GROUP`, `ACA_SANDBOX_GROUP`, `ACA_SANDBOX_REGION`); it signs in with GitHub OIDC, so no secrets are stored. If `AGENTFOREACH_FUNCTION_APP` is set, it also points that app's `ACA_SANDBOX_DISK_IMAGE_ID` at the new image; update `agentforeach:sandboxDiskImageId` too, or the next `pulumi up` sets it back.

## Dynamic Sessions (fallback)

Set `agentforeach:sandboxProvider aca-sessions` to use a session pool instead. `pulumi up` then creates a Container Apps environment and a session pool, gives the Function App the built-in **Azure ContainerApps Session Executor** role (`0fb8eba5-a2bb-4abe-b1c1-49dfad359bb0`) on it, and sets `ACA_POOL_MANAGEMENT_ENDPOINT`.

- `agentforeach:sandboxContainerType` — `PythonLTS` (default; Azure's Python code interpreter, no image) or `CustomContainer` (the multi-runtime image from `packages/gateway/sandbox-container/Dockerfile`, which serves `/exec` and `/files` from `server.mjs`). `CustomContainer` also creates a container registry and needs a workload-profile environment, which carries a fixed monthly management fee.
- `agentforeach:sandboxContainerImage`, `sandboxContainerCpu`, `sandboxContainerMemory`, `sandboxContainerPort` — CustomContainer only.
- `agentforeach:sandboxMaxConcurrentSessions` (10), `sandboxReadyInstances` (0), `sandboxCooldownSec` (600), `sandboxNetworkStatus` (`EgressDisabled`).

Runtime settings are in `skills.sandbox.aca` in `agentforeach.json` (timeouts default to 60 s, capped at 220 s). A session and its files are destroyed after the cooldown, there is no per-host egress control, and there is no egress proxy, so credentials are set as environment variables that code in the session can read.

## Code

`packages/gateway/skills/sandbox/`: `factory.ts` (backend choice), `aca-sandboxes-client.ts` (primary), `client.ts` (Dynamic Sessions), `handler.ts` (tools and credential injection), `export-store.ts` (download links). Infrastructure: `packages/infra/sandbox.ts`. Live test against a real group: `scripts/test-aca-sandboxes-live.mjs`.

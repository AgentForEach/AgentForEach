# Sandboxes

AgentForEach can give each user a private sandbox where the agent runs code. The brain (the Function App, or the Worker on Cloudflare) never runs model-written or skill code itself; it sends commands to a sandbox over REST.

There are three backends, two on Azure and one on Cloudflare:

| | ACA Sandboxes (Azure, primary) | ACA Dynamic Sessions (Azure, fallback) | Cloudflare Containers |
|---|---|---|---|
| Unit | One microVM per user (or per conversation) | A session in a shared pool | One container per user (or per conversation), run by its own Durable Object |
| When idle | **Suspends**: disk snapshot kept, no CPU/memory billing | **Destroyed** after the cooldown; files are lost | **Snapshots its disk and stops**; the next call restores it |
| Egress | Deny by default with full inspection, per-host allow rules | On or off for the whole pool | Deny by default; every HTTP(S) request goes through the Worker's egress handler; raw TCP blocked |
| Credentials | Injected by the egress proxy for declared hosts; never in the sandbox | Set as environment variables in the session | Injected by the egress handler for declared hosts; never in the sandbox |
| Image | Private disk image built by `scripts/build-aca-sandbox-image.mjs` | Azure's PythonLTS, or a custom container in ACR | [The shared image](#the-shared-image), built and pushed by `wrangler deploy` |

Why ACA Sandboxes became the default, measurements from a live group, costs, risks and how to switch an existing stack: [Sandbox-Migration.md](Sandbox-Migration.md). ACA Sandboxes is a **preview** Azure service.

## What the model gets

When `skills.sandbox.enabled` is true and a backend is configured, each turn offers these tools (`skills/sandbox/handler.ts`):

| Tool | Does |
|---|---|
| `sandbox_exec` | Runs `bash -c "<command>"` in `/mnt/data`, with a timeout the server caps |
| `sandbox_file_write` / `sandbox_file_read` / `sandbox_file_list` | Text files in `/mnt/data/` |
| `sandbox_file_export` | Uploads a file to object storage (`user-exports`: Blob Storage on Azure, R2 on Cloudflare) and returns a read-only, time-limited (24 h by default) download link |
| `sandbox_skill_load` | Unpacks a skill's zip into `/mnt/data/<skill_id>/` and returns its `SKILL.md` |

With `skills.sandbox.browser.enabled`, the model also gets a `browser` tool: a real Chromium inside the same sandbox ([Browser.md](Browser.md)).

Output is truncated to `maxOutputChars` (50,000 by default). With the default `identifierStrategy: "userId"`, every conversation of a user shares one sandbox; `"sessionId"` gives each conversation its own.

## Choosing the backend

`createSandboxBackend` (`skills/sandbox/factory.ts`) picks the backend:

1. The provider is the `SANDBOX_PROVIDER` setting if set (Pulumi sets it on Azure, `wrangler.jsonc` sets `cloudflare-containers` on Cloudflare), else `skills.sandbox.provider` in `agentforeach.json`, else `aca-sandboxes`. `aca` is accepted as a legacy name for `aca-sessions`. Providers are a registry (`skills/sandbox/registry.ts`): the Cloudflare entry point registers `cloudflare-containers`.
2. With `aca-sandboxes`, the client needs a subscription, resource group and sandbox group (the `ACA_SANDBOX_*` settings). If they're missing but a session pool endpoint (`ACA_POOL_MANAGEMENT_ENDPOINT`) is set, AgentForEach logs a warning and falls back to Dynamic Sessions with the `aca` timeouts. If neither is set, the sandbox tools are disabled.
3. With `aca-sessions`, the Dynamic Sessions client is used.
4. With `cloudflare-containers`, the Worker's `SANDBOX` Durable Object binding is used.

The two ACA backends authenticate with the Function App's managed identity (audience `https://dynamicsessions.io`), or your `az login` locally.

What a backend can do is in its `capabilities`, which callers check instead of the backend's type:

| Capability | ACA Sandboxes | Dynamic Sessions | Cloudflare Containers |
|---|---|---|---|
| `browser`: the [browser](Browser.md) can run in it | Yes | No | When the image is built with the browser (`containers.browser: true`) |
| `egressCredentials`: secrets injected outside the sandbox | Yes | No: environment variables instead | Yes |
| `persistence`: what survives idle | `disk` (`memory` with `suspendMode: "Memory"`) | `none` | `disk` |

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

- A credential with `hosts` and `header` becomes an egress-proxy `Transform` rule that sets that header on requests to those hosts only. The secret never enters the sandbox. Azure's rules match host, path and method, not headers, so a WebSocket upgrade to those hosts gets the header too (what that means for the browser: [Browser.md](Browser.md#security)). The env var holds the placeholder `injected-by-egress-proxy`, and a script sending `Authorization: Bearer $GITHUB_TOKEN` still works because the proxy overwrites the header.
- Any other credential is written to an env file (created with `umask 077`) that every command sources, so sandbox code can read it.
- Both are rewritten even when the user has no credentials, so a revoked secret doesn't linger in a sandbox that outlives the turn.

Separately, `http_fetch` (which runs in the brain) refuses to send a host-bound credential to any other host, and refuses credentials with no declared hosts unless `skills.requireCredentialHosts` is `false`.

**Account deletion.** Erasing a user's data (`DELETE /api/me/data`, or the admin route) deletes all their sandboxes, and with them their snapshots and files (`deleteUserSandboxes`, called from `account/erase.ts`). It runs in both erasure passes, so a sandbox a still-running turn started during the first is deleted by the second. One started after the second pass (a turn that ignored the abort for over 10 s) survives until the next erasure.

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

- `agentforeach:sandboxGroupLocation`: region for the group, if your stack's region doesn't offer Sandboxes yet.
- `agentforeach:sandboxGroupMaxCount`: cap on sandboxes in the group.
- `agentforeach:sandboxDiskImageId`: the image id from the build script; sets `ACA_SANDBOX_DISK_IMAGE_ID`.

Running sandboxes count against the subscription's regional "Sandbox Cores" quota; check it before a launch.

For local development, `az login`, give your user the same role on the group, and fill the `ACA_SANDBOX_*` keys in `local.settings.json`.

### Building the disk image

No container registry is involved. `scripts/build-aca-sandbox-image.mjs` starts a build sandbox from the public `ubuntu` image with egress open, runs `gateway/sandbox-container/provision-aca.sh` in it (Python with pip, Node and npm, git, jq, zip, compilers; `SANDBOX_IMAGE_FULL=1` adds Java, PHP, Ruby and Go), commits it to a private disk image, boots a verification sandbox from the image at production size with egress denied, and prints the image id.

```bash
npm run build --workspace @agentforeach/gateway     # the script imports the compiled client
ACA_SANDBOX_SUBSCRIPTION_ID=<subscription-id> ACA_SANDBOX_RESOURCE_GROUP=<resource-group> \
ACA_SANDBOX_GROUP=<sandbox-group> ACA_SANDBOX_REGION=<region> \
  node scripts/build-aca-sandbox-image.mjs
pulumi config set agentforeach:sandboxDiskImageId <printed id>
```

Build at production size (`ACA_SANDBOX_CPU`, `ACA_SANDBOX_MEMORY`, `ACA_SANDBOX_DISK`; defaults 1 vCPU / 2 GiB): an image keeps the build sandbox's disk size, and a smaller sandbox can't boot it.

`.github/workflows/sandbox-image.yml` rebuilds the image weekly (and on demand) so sandboxes get OS and runtime updates. It is skipped until you set the repository variables it lists (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `ACA_SANDBOX_RESOURCE_GROUP`, `ACA_SANDBOX_GROUP`, `ACA_SANDBOX_REGION`); it signs in with GitHub OIDC, so no secrets are stored. If `AGENTFOREACH_FUNCTION_APP` is set, it also points that app's `ACA_SANDBOX_DISK_IMAGE_ID` at the new image; update `agentforeach:sandboxDiskImageId` too, or the next `pulumi up` sets it back.

## Dynamic Sessions (fallback)

Set `agentforeach:sandboxProvider aca-sessions` to use a session pool instead. `pulumi up` then creates a Container Apps environment and a session pool, gives the Function App the built-in **Azure ContainerApps Session Executor** role (`0fb8eba5-a2bb-4abe-b1c1-49dfad359bb0`) on it, and sets `ACA_POOL_MANAGEMENT_ENDPOINT`.

- `agentforeach:sandboxContainerType`: `PythonLTS` (default; Azure's Python code interpreter, no image) or `CustomContainer` (the multi-runtime image from `gateway/sandbox-container/Dockerfile`, which serves `/exec` and `/files` from `server.mjs`). `CustomContainer` also creates a container registry and needs a workload-profile environment, which carries a fixed monthly management fee.
- `agentforeach:sandboxContainerImage`, `sandboxContainerCpu`, `sandboxContainerMemory`, `sandboxContainerPort`: CustomContainer only.
- `agentforeach:sandboxMaxConcurrentSessions` (10), `sandboxReadyInstances` (0), `sandboxCooldownSec` (600), `sandboxNetworkStatus` (`EgressDisabled`).

Runtime settings are in `skills.sandbox.aca` in `agentforeach.json` (timeouts default to 60 s, capped at 220 s). A session and its files are destroyed after the cooldown, there is no per-host egress control, and there is no egress proxy, so credentials are set as environment variables that code in the session can read.

## Cloudflare Containers

On Cloudflare, each user's sandbox is a Cloudflare Container run by its own Durable Object (`ContainerSandbox`, bound as `SANDBOX`), from [the shared image](#the-shared-image). `wrangler deploy` builds the image and pushes it, and `wrangler.jsonc` sets `SANDBOX_PROVIDER=cloudflare-containers`, so turning sandboxes on takes `skills.sandbox.enabled: true`.

**Lifecycle.**
- After `autoSuspendSec` idle seconds (300 by default), an alarm snapshots the sandbox's whole disk and stops the container. The next call restores it.
- **The Durable Object stays awake while its container runs.** Cloudflare stops a container some time after its Durable Object goes inactive, without a snapshot: we saw idle sandboxes vanish 3.5 to 5 minutes in, before their idle check. So, as Cloudflare's own `Container` class does, an alarm waits in its handler for up to 3 minutes at a time, then arms the next. Durable Object duration is billed for that time, on top of the container's own. If the snapshot fails, the container keeps running and the snapshot is retried (after 30 s, doubling up to 10 minutes, never giving up), with a `SNAPSHOT FAILED` error in the log. This object never stops it without one. A stop it didn't make (the container crashed or was killed) loses the files written since the last snapshot, and is logged as `CONTAINER STOPPED WITHOUT A SNAPSHOT`.
- Files survive; memory and running processes don't, like ACA Sandboxes' `Disk` mode.
- **The environment survives, but never on disk.** The sandbox server keeps the env vars it is given (including credentials without hosts) in memory only, so none of them reach a snapshot. The Durable Object stores them and applies them again after every start and restore.

**Egress.** Deny by default. Every HTTP(S) request from the sandbox goes through the Worker's `SandboxEgress` handler:

| Rule | What it means |
|---|---|
| **Allow entries** in `containers.egressAllowHosts` | `pypi.org` (that host), `*.example.com` (its subdomains, not the domain itself), or `host/path`: only paths under `/path` on that host |
| **Ports 80 and 443 only** | With `networkAccess: "disabled"` (the default), a host on any other port is refused, even if it is allowed. A package mirror on a custom port (`:8081`, `:8443`) won't work; put it behind 443, or use `networkAccess: "enabled"` |
| **Credentials only over HTTPS, to port 443** | They are injected outside the sandbox, for the hosts a skill declares, as on ACA Sandboxes, and only on `https://` requests to port 443. A credential also opens its hosts there. Plain `http://` to the same host gets no header, and neither does a WebSocket upgrade, which a credential doesn't open its host to. Credentials are matched on the request's host as the egress handler sees it, the `Host` header. The TLS server name (SNI) the sandbox sent isn't visible to it, so a mismatched SNI isn't refused. The handler re-sends the request to the `Host`-named host, so a credential only ever reaches the host it is bound to |
| **Raw TCP and outside DNS** | Blocked |
| **`networkAccess: "enabled"`** | Every host and port is allowed, but credentials still go only over HTTPS to 443 |
| **Never local or private targets** | Local names (`localhost`, `*.local`, `*.internal`, `metadata`) and loopback, private, link-local, carrier-grade NAT and metadata IP addresses are refused in every mode, even if listed. Every name in the sandbox resolves to the interceptor's placeholder address, so this check happens here, not in the sandbox |

**The browser's live view.** With the handoff on, the sandbox gets one more allow entry, the relay's path on the gateway's own host: `<worker host>/realtime/relay`. It doesn't get the rest of the gateway. If `PUBLIC_BASE_URL` has a port (as in local development, `http://localhost:8787`), that entry never matches, so the relay is refused. It fails closed, and the live view needs a deployed Worker on 443.

**Account deletion.**
- Erasing a user's data stops their sandboxes and drops their snapshot references.
- **Snapshot deletion is opt-in.** Set the Worker secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_IMAGES_API_TOKEN` (an account API token with Containers write permission). The backend then deletes a user's snapshots from the registry when their sandboxes are deleted (account erasure). Each snapshot has two tags, `rootfs-snapshot-<sha256 of the snapshot id>` and `rootfs-set-<sha256 of its snapshot_set_id>`, the set id being in the snapshot's config. The backend reads the config, deletes both tags (the registry honours deletes by tag; a delete by digest does nothing), then asks for a layer garbage collection, as `wrangler containers images delete` does (verified live). The deploy script uploads both when `CLOUDFLARE_IMAGES_API_TOKEN` is set in your shell.
- **A sandbox's snapshots are a chain, and it grows.** Each snapshot is a delta on the one before (its parent), so none is deleted while the sandbox lives: deleting a parent would break the next restore. Every sleep adds one, until the user's data is erased or Cloudflare expires them. Cloudflare keeps a snapshot 30 days from its creation or most recent restore. It documents nothing about chains, compaction or chain length, nor whether a parent that is never restored itself can expire while its child is still in use.
- If the registry refuses or times out, the erasure fails (HTTP 500, with the error in its report) and keeps the snapshot list. Erasing again retries those snapshots.
- **Without it, snapshots stay in the registry for up to 30 days** after their last use, with the user's files. The erasure report says so under `skipped`. Snapshots taken before env vars moved into memory (commit 3ae0ae1) also hold `~/.agentforeach/env.json`, which has the values of credentials without hosts.

**Image upgrades.** A snapshot holds the whole disk, operating system included, so restoring one always runs the image it was taken on. After you deploy a new image, new sandboxes get it. A sleeping sandbox is moved on its first start:
1. its old snapshot is restored;
2. `/mnt/data` is copied out as a compressed tar (the sandbox server's `/archive`, which needs the per-start token);
3. the container is stopped, and a fresh one starts on the new image;
4. the files go back in, and a snapshot of the new container starts a new chain.

The old chain is no longer used: it expires, or goes with an erasure.

| What survives an upgrade | What doesn't |
|---|---|
| Everything under `/mnt/data`, including the browser's profile (`/mnt/data/.browser`: cookies, logins) | Anything outside `/mnt/data`: packages installed system-wide, files in `/root` or `/tmp` |
| Env vars and egress credentials, applied again from the Durable Object (they never travel in the archive) | Running processes |

`/mnt/data` must fit in 1 GiB compressed. That upgrade call takes longer than a normal start, by the time it takes to copy the files. If any step fails, the old snapshot is restored again, nothing is lost, `IMAGE UPGRADE FAILED` is logged, and the upgrade is tried again a day later. Until then the sandbox stays on its old image, and its snapshots are recorded under that image.

**Starts are bounded.** A start, egress rules included, that takes longer than 90 s fails the call with "The sandbox didn't start within 90 s … Try again." We once saw a start stuck for 8 minutes on Cloudflare's side. After such a failure the old container can report stopped while it is still going away, so the next start waits 10 s first. A start that still meets it, or loses its connection, is tried again (3 attempts, within 2 minutes in all). A command that finds its container gone never reached it, so it is sent again once on a fresh start.

Start times, restore times and what we observed about start reliability are in [Cloudflare](Cloudflare.md#sandboxes-on-cloudflare-containers).

### Configuration

`skills.sandbox.containers` in `agentforeach.json` (defaults in `skills/config.ts`). The backend also takes `networkAccess`, `identifierStrategy`, `maxOutputChars` and `maxExportBytes` from `skills.sandbox`, as the other backends do (`containersSandboxOptions` in `skills/sandbox/containers.ts`):

| Key | Default | Notes |
|---|---|---|
| `instance` | `standard-2` | A Cloudflare Containers instance type |
| `autoSuspendSec` | 300 | Idle seconds before the snapshot and stop |
| `egressAllowHosts` | `[]` | Exact hosts, `*.domain`, or `host/path`; ports 80 and 443. Only used when `networkAccess` is `disabled` |
| `browser` | `false` | `true` when the image is built with `SANDBOX_IMAGE_BROWSER=1` |
| `defaultTimeoutSec`, `maxTimeoutSec` | 120, 200 | |

## The shared image

[`gateway/sandbox-container/Dockerfile`](../gateway/sandbox-container/Dockerfile) is the sandbox image for every container backend: Cloudflare Containers, Dynamic Sessions custom containers and plain Docker.
- **Tools.** It runs [`provision-aca.sh`](../gateway/sandbox-container/provision-aca.sh), the script ACA Sandboxes builds its disk image with, so every backend has the same tools: Python, Node, git, jq, build tools, and with `SANDBOX_IMAGE_FULL=1` (the default in the image) Java, PHP, Ruby and Go.
- **The sandbox server.** It adds the server (`server.mjs`, port 8080: `/exec`, `/files`, `/env`, `/health`) that the container backends talk to.
- **The browser.** `SANDBOX_IMAGE_BROWSER=1` adds Chromium and the browser driver.

## Conformance

Every backend passes the same suite, `@agentforeach/platform/sandbox/conformance` (`runSandboxConformance`):
- exec, with exit codes, output and timeouts;
- files;
- environment;
- egress denied by default, with credentials added outside the sandbox and cleared;
- persistence across sleep;
- deleting a user's sandboxes.

Checks a backend can't support are skipped by its capabilities. `npm test` runs it against the sandbox server locally (`gateway/skills/sandbox/server-conformance.test.ts`), which has no egress proxy and no sleep, so those checks skip there. `scripts/test-sandbox-conformance-live.mjs <aca-sandboxes|aca-sessions|cloudflare-containers>` runs the whole suite against a real backend (its header lists the settings; Cloudflare uses the test Worker in `scripts/test-fixtures/cloudflare-sandbox-worker`).

## Code

- `gateway/skills/sandbox/`:
  - `factory.ts` and `registry.ts`: choosing the backend;
  - `containers.ts`: the Cloudflare options;
  - `handler.ts`: the tools and credential injection;
  - `export-store.ts`: download links.
- Azure: `packages/platform-azure/src/sandbox/`: `aca-sandboxes-client.ts` (ACA Sandboxes, the primary backend) and `dynamic-sessions-client.ts` (Dynamic Sessions).
- Cloudflare: `packages/platform-cloudflare/src/sandbox/`.
- Infrastructure: `infra/sandbox.ts`.
- Live test against a real ACA group: `scripts/test-aca-sandboxes-live.mjs`.

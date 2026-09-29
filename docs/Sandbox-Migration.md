# From Dynamic Sessions to ACA Sandboxes

> **Status (September 2026):** ACA Sandboxes is AgentForEach's default sandbox backend. ACA Dynamic Sessions is still supported as a fallback. ACA Sandboxes is a **preview** Azure service; read [Risks](#risks-and-trade-offs) before you depend on it.

## TL;DR

AgentForEach runs one shared, serverless "brain" for all users. A sandbox is only a tool: it exists when the agent needs to run code, and costs nothing otherwise.

Dynamic Sessions fit the "only when needed" part but not the "keep my work" part. A session is **destroyed** after its cooldown, so a user's files, installed packages and half-finished work vanish between conversations.

An ACA Sandbox **suspends** instead. When it is idle, it takes a snapshot and stops using CPU and memory:
- In `Disk` mode (AgentForEach's default) the files survive. Processes restart on resume, like a reboot.
- In `Memory` mode the running processes are meant to survive too; Microsoft quotes sub-second restores. In our tests a background process did *not* survive an auto-suspend even in `Memory` mode (see [Verified on a real sandbox group](#verified-on-a-real-sandbox-group)), so AgentForEach treats processes as restarting in both modes.

Either way, you pay for compute only while code runs, not for a VM per user that stays on. And the agent can keep working on something across days.

## What AgentForEach needs from a sandbox

1. **Strong isolation for untrusted code.** The model writes the code, and skills come from users. It must never run in the brain's process, which holds every tenant's data and the API keys.
2. **Per-user state that survives idle time.** A user's files should still be there tomorrow.
3. **Scale to zero, per user.** Most turns never touch a sandbox. An idle user should cost nothing.
4. **Scale out without a pool ceiling.** "Thousands of users" can't depend on a fixed pool size.
5. **Control over egress and credentials.** Code in the sandbox should reach only what it needs, and ideally never see the secrets it uses.
6. **Lifecycle control.** We must be able to delete a user's sandbox when they delete their account.

## Where Dynamic Sessions fell short

These come from running AgentForEach on Dynamic Sessions, as recorded in [Sandbox.md](Sandbox.md).

| # | Limitation | Effect on AgentForEach |
|---|---|---|
| 1 | **Sessions are destroyed after the cooldown** (300–3600 s) | Files in `/mnt/data`, installed packages and running work are lost. We added "export to Blob" to save results, and multi-day tasks were impossible. |
| 2 | **A fixed pool ceiling** (`maxConcurrentSessions`, 50 in our dev stack) | When the pool is full, the error goes straight to the model. Raising the cap raises the worst-case bill. |
| 3 | **Custom images need a Dedicated workload profile** | About **$73/month in management fees** while the environment exists, even with zero sessions (see [Sandbox.md → Billing](Sandbox.md)). |
| 4 | **Cold start versus always paying** | With `readySessionInstances: 0`, the first request waits for a node to start. Pre-warming means paying 24/7. |
| 5 | **Synchronous execution capped at 220 s** | Builds, data jobs and scraping hit the limit. |
| 6 | **Two incompatible APIs** | PythonLTS only accepts Python (`/code/execute`), so shell commands are wrapped in `subprocess` and env vars are set via `os.environ`. CustomContainer uses our own `/exec` server. We maintained both. |
| 7 | **Egress is all or nothing** (`EgressEnabled` / `EgressDisabled`) | There is no per-host allowlist. Skill credentials are injected as environment variables, so code in the sandbox can read them and, with egress on, send them anywhere. |
| 8 | **No suspend or snapshot** | A session is either running or gone. AgentForEach addresses sessions by an identifier string and relies on the cooldown to clean them up. |

## What ACA Sandboxes changes

Everything in this table is from Microsoft's [overview](https://learn.microsoft.com/azure/container-apps/sandboxes-overview) and its egress and snapshot docs.

| Need | ACA Sandboxes |
|---|---|
| Isolation | Each sandbox "runs in its own secure boundary". The portal docs describe microVMs with their own kernel. |
| State across idle time | **Auto-suspend** after N idle seconds. `Disk` mode keeps the disk, and processes restart on resume. `Memory` mode is documented to keep disk and memory ("sub-second restore times"). |
| Scale to zero | "You pay no CPU or memory fees when sandboxes are stopped." No Dedicated profile is needed. |
| Scale out | "The service bursts to thousands of concurrent sandboxes on demand." There is no pool for us to size. |
| Egress | Deny by default, host and CIDR rules, **full traffic inspection** (non-HTTP traffic blocked too), and **header-transform credential injection**: the egress proxy adds the token, so it never enters the sandbox. VNet integration is optional. |
| Lifecycle | Explicit create, stop, resume, snapshot and delete. **Auto-delete** removes a sandbox N days after it stopped. |
| Images | Any OCI image can be converted to a disk image. Snapshots can be cloned. |
| Persistent storage | Blob volumes (shared) and Data Disk volumes (one sandbox). |

## How AgentForEach uses it

```
 user turn ──► AgentForEach brain (Azure Functions, shared, stateless)
                  │  model calls sandbox_exec / sandbox_file_*
                  ▼
           AcaSandboxesClient ── managed identity token (audience dynamicsessions.io)
                  │
                  │ 1. find the sandbox labelled agentforeach-owner=sha256(owner)[0..32]
                  │    or create it (image, cpu/memory, auto-suspend, egress, labels),
                  │    then set auto-delete via POST /lifecycle
                  │ 2. GET it: owner label must match; if Suspended/Stopped → resume
                  │ 3. POST /executeShellCommand, PUT/GET /files
                  ▼
        ACA Sandboxes data plane ── one microVM per user
                  │  idle for autoSuspendSec → snapshot, CPU/memory billing stops
                  │  stopped for autoDeleteDays → deleted
```

**Ownership**
- There is one sandbox per user, or per conversation with `identifierStrategy: "sessionId"`.
- Sandboxes are found by label, so no extra database is needed. Labels hold hashes, never user IDs.
- The owner label is checked strictly, when listing and again on every state read. A sandbox whose label is missing or different is never used (fail closed).

**Commands and files**
- Commands run in `/mnt/data`, as before, so the model sees no difference.
- The timeout is enforced *inside* the sandbox with `timeout(1)`. The cap is 200 s, below the 230 s HTTP front-end limit.

**Network**
- Egress defaults to deny, with `trafficInspection: "Full"` so raw TCP and UDP are blocked too.
- Hosts you trust go in `sandboxes.egressAllowHosts`.

**Credentials**
- **Credentials whose skill declares their hosts never enter the sandbox.** They become egress-proxy `Transform` rules that set the auth header on requests to those hosts only. The env var holds the placeholder `injected-by-egress-proxy`. Scripts that send `Authorization: Bearer $GITHUB_TOKEN` still work, because the proxy overwrites the header. See [Declaring credential hosts](#declaring-credential-hosts).
- Other credentials are written to an env file that each command sources. The value never appears on a command line.
- Both the proxy rules and the env file are **rewritten on the first sandbox call of every turn**, even when the user has no credentials, so a revoked secret doesn't linger.
- Tokens come from the Function App's managed identity through the App Service identity endpoint, or from `az account get-access-token` locally. No extra npm dependency is needed.

**Reliability**
- **Retries:**
  - 403s are retried for up to 90 s, as Microsoft's SDK does, because a new role assignment takes a while to propagate.
  - 429, 408 and 5xx responses are retried for idempotent calls.
  - A command is never retried after the service may have started it.
- **Races:** if two Function instances create a sandbox for the same user at once, both converge on the older one, and the newer one is deleted.
- **Error messages** only name the path inside the sandbox group. The subscription and resource group don't leak to the model.

**Backend choice and account deletion**
- **Fallback:** the IaC sets `SANDBOX_PROVIDER`, which overrides `agentforeach.json`. If the provider is `aca-sandboxes` but no sandbox group is configured while a session pool is, AgentForEach logs a warning and uses Dynamic Sessions with *its* own timeouts.
- **Account deletion:** `AcaSandboxesClient.deleteUserSandboxes(userId)` removes all of a user's sandboxes, and with them their snapshots and files, across every conversation. Erasing a user's data (`DELETE /api/me/data` or the admin route, `account/erase.ts`) calls it.

Code: `packages/gateway/skills/sandbox/aca-sandboxes-client.ts`, `factory.ts`, `token.ts`, `shared.ts`. Tests: `aca-sandboxes-client.test.ts`, `factory.test.ts`.

## Verified on a real sandbox group

`scripts/test-aca-sandboxes-live.mjs` runs the real client against a real group. Results from a Central India group (29 Sept 2026, 1 vCPU / 2 GiB). All 17 steps passed in both suspend modes, on the public `ubuntu` image and on the AgentForEach image:

| What | Result |
|---|---|
| Create a sandbox | **0.7–0.8 s** |
| Resume from a stop, plus one command | **1.2–1.9 s** (`Disk` and `Memory` alike) |
| Auto-suspend | Fires on schedule; state becomes `Stopped` with `stoppedReason: Idle` |
| Files and env file after suspend/resume | Kept in both modes |
| Background process after auto-suspend | **Gone in both modes**, including `Memory` |
| Egress with deny + `Full` inspection | HTTPS gets a 403 from the egress proxy; raw TCP is refused |
| Owner-label filter on list | Honoured; labels are returned on list and GET |
| Two instances creating for one user at once | Converged on the older sandbox; the newer one was deleted |
| Command against a stopped sandbox | `409 GlobalSandboxNotRunning`; the client resumes and retries |
| Credential injected at the egress proxy | Upstream received the secret, the sandbox saw only the placeholder, and no copy was found on disk; clearing the rule blocks the host again |

Things the live run caught that unit tests could not:

- **`POST /lifecycle` replaces the whole lifecycle policy.** Setting only auto-delete removed auto-suspend, so sandboxes would have run and billed forever. The client now always sends both.
- **`files/list` returns `isDir` and `modifiedTime`** (Unix seconds), not the SDK's `isDirectory` and `modifiedAt`. The client accepts both.
- **A committed disk image keeps the build sandbox's disk size,** and a sandbox can't boot an image bigger than its own disk. An image built on a 2 vCPU / 40 GiB sandbox fails to boot on the default 1 vCPU / 20 GiB sandbox. The image builder now builds at production size and verifies at production size.

## Security: persistence changes the threat model

Ephemeral sessions forgot everything, including anything malicious. Persistent sandboxes don't:
- Code planted by a prompt injection in one conversation can still be in `/mnt/data` (or elsewhere on the disk) in later conversations, for as long as the sandbox lives (up to `autoDeleteDays` after it stops).
- Snapshots contain whatever the disk held, including the env file with any credentials that aren't host-bound, until the sandbox is deleted.
- Anything running in the sandbox runs as the same user as your commands, so file permissions don't protect secrets from sandbox code.

What limits the damage:
- Sandboxes are per user (or per conversation), so a compromise can't cross to another user.
- Egress is deny-by-default with full inspection.
- Host-bound credentials never enter the sandbox, and the egress proxy only adds them for their declared hosts.
- Credentials are rewritten every turn.
- You can shorten `autoDeleteDays`, or use `identifierStrategy: "sessionId"` for a fresh sandbox per conversation.

Declare hosts for every credential your skills use; env-var credentials are the remaining exposure.

## Declaring credential hosts

In a skill's `SKILL.md`, give each credential the hosts it may be sent to and how it authenticates:

```yaml
credentials: [{"key":"GITHUB_TOKEN","label":"GitHub token","required":true,"hosts":["api.github.com","*.githubusercontent.com"],"header":"Authorization","format":"Bearer {value}"}]
```

- `hosts`: exact host names, or `*.example.com` for any subdomain.
- `header` and `format`: how the proxy authenticates. `{value}` is replaced by the secret; the default format is the bare value.

What this does:
- **`http_fetch`** (runs in the brain) refuses to put a host-bound credential into a request for any other host, whether in the URL, headers or body. This stops a prompt-injected "send `$GITHUB_TOKEN` to attacker.example".
- **ACA Sandboxes** inject the header at the egress proxy for those hosts only; the sandbox never holds the secret.
- **Dynamic Sessions** have no proxy, so there the credential is still set as an env var.

Credentials without `hosts` are **refused** by `http_fetch` by default (`skills.requireCredentialHosts: true`), so a prompt injection can't send them anywhere. For skills you trust that don't declare hosts yet, set it to `false`: they are then substituted anywhere and set as env vars, as before.

## Cost model

Both backends scale with usage, not with the number of users. The difference is what happens between bursts of work:

| Between tool calls | Dynamic Sessions | ACA Sandboxes |
|---|---|---|
| Within the idle window | Session kept (billed) until the cooldown | Sandbox running (billed) until `autoSuspendSec` |
| After it | Session destroyed, **work lost** | Snapshot kept, **no CPU/memory fees**, work kept |
| Fixed monthly cost | About $73 management fee with custom images | None known |

An always-on personal agent, such as one VM per user, pays for every idle hour. AgentForEach on ACA Sandboxes pays for compute while it runs, plus snapshot storage.

Azure's Retail Prices API had no Sandboxes-specific meters on 29 Sept 2026. If Sandboxes bill like Container Apps Consumption, as preview material states (vCPU $0.000024/s, memory $0.000003/GiB-s in Central India), a 1 vCPU / 2 GiB sandbox costs about **$0.11 per running hour**. With a 5-minute idle window, a user who runs code in ten separate bursts a day pays for roughly an hour, about $3.30 a month. That's before snapshot storage, whose price isn't published yet. Check your own bill; it's the only authoritative figure until Microsoft publishes prices.

**Quota:** the subscription had a **"Sandbox Cores" quota of 200 per region**, which caps running sandboxes at 200 at 1 vCPU each. Check yours with `az quota list --scope /subscriptions/<sub>/providers/Microsoft.App/locations/<region>`, and request an increase before a launch.

## Risks and trade-offs

- **Preview service.** The data plane is `2026-02-01-preview`, and the SDKs are beta (Python `azure-containerapps-sandbox` 0.1.0b4, npm `@azure/containerapps-sandbox` 1.0.0-beta.1). Expect breaking changes. Our client is plain `fetch` against the REST API, taken from the Python SDK, so it is easy to follow.
- **No Pulumi type yet.** The sandbox group is deployed through an ARM template (`resources.Deployment`). Deleting that Pulumi resource does not delete the group.
- **Default image.** The public `ubuntu` image (Ubuntu 26.04 in our tests) has `bash`, `python3`, `curl` and `unzip`, but no `pip` or `node`. With egress denied, nothing more can be installed. Build the AgentForEach image (see [Building the AgentForEach disk image](#building-the-agentforeach-disk-image)) and set `sandboxes.diskImageId`.
- **Suspend mode.**
  - `Disk` (our default) keeps files, but a background process started in one turn won't be running after a suspend.
  - `Memory` is documented to keep processes too, but that didn't hold in our auto-suspend test. Don't rely on it until Microsoft's behaviour matches the docs.
- **One group for everyone.** The group holds a sandbox for every user active in the last `autoDeleteDays`, times conversations if you use `sessionId`. Running sandboxes count against the regional "Sandbox Cores" quota; set `sandboxGroupMaxCount` and watch the count.

## Building the AgentForEach disk image

No container registry is needed. `scripts/build-aca-sandbox-image.mjs`:
1. starts a build sandbox from the public `ubuntu` image, with egress open;
2. runs `packages/gateway/sandbox-container/provision-aca.sh` (Python with pip, Node, git, jq, zip/unzip and build tools; `SANDBOX_IMAGE_FULL=1` adds Java, PHP, Ruby and Go);
3. **commits** the sandbox to a private disk image;
4. boots a verification sandbox from the image at production size with egress denied, and checks every tool;
5. prints the image id.

```bash
ACA_SANDBOX_SUBSCRIPTION_ID=... ACA_SANDBOX_RESOURCE_GROUP=... ACA_SANDBOX_GROUP=... ACA_SANDBOX_REGION=... \
  node scripts/build-aca-sandbox-image.mjs
pulumi config set agentforeach:sandboxDiskImageId <printed id>     # sets ACA_SANDBOX_DISK_IMAGE_ID
```

Build at the same CPU, memory and disk as production (`ACA_SANDBOX_CPU`, `ACA_SANDBOX_MEMORY`, `ACA_SANDBOX_DISK`). The image keeps the build sandbox's disk size, and a smaller sandbox can't boot it. In our test the image was Ready as soon as the commit returned.

## Migrating a deployment

**What switching an existing stack does.** Changing `sandboxProvider` from `aca-sessions` to `aca-sandboxes` makes `pulumi up`:
- **delete** the session pool, the Container Apps environment that hosted it and, for CustomContainer, the container registry and its image;
- create the sandbox group and its role assignment.

Users' old session files were already gone after the cooldown, so no data needs moving. But the next deploy of your custom image has to go through a disk image instead.

**Network behaviour changes too.** `sandboxNetworkStatus: EgressEnabled` doesn't carry over. ACA Sandboxes defaults to deny-all, so `pip install` and `npm install` stop working unless you allow those hosts or set `"networkAccess": "enabled"`.

Steps:

1. **Pick a region** that offers `sandboxGroups`:
   ```bash
   az provider show -n Microsoft.App --query "resourceTypes[?resourceType=='sandboxGroups'].locations"
   ```
2. **Pulumi:**
   ```bash
   pulumi config set agentforeach:sandboxEnabled true
   pulumi config set agentforeach:sandboxProvider aca-sandboxes     # the default
   pulumi config set agentforeach:sandboxGroupLocation westus2      # only if your stack region lacks it
   pulumi up
   ```
   This creates the sandbox group and gives the Function App's managed identity the **Container Apps SandboxGroup Data Owner** role (`c24cf47c-5077-412d-a19c-45202126392c`) on it. It also sets `SANDBOX_PROVIDER` and the `ACA_SANDBOX_*` app settings. A `pulumi preview` of a fresh stack shows 22 resources, including the group deployment and the role assignment, and no session pool.
3. **Build the AgentForEach image** and set `agentforeach:sandboxDiskImageId` (see [Building the AgentForEach disk image](#building-the-agentforeach-disk-image)), then `pulumi up` again.
4. **Runtime config** (`skills.sandbox` in `agentforeach.json`) needs a `sandboxes` block. The shipped `agentforeach.json` has one, reading the `ACA_SANDBOX_*` settings.
5. **Local dev:** `az login`, give your user the same role on the group, and fill the `ACA_SANDBOX_*` keys in `local.settings.json`.
6. **Rollback:** `pulumi config set agentforeach:sandboxProvider aca-sessions` and `pulumi up`. The session pool and its environment are recreated; for CustomContainer, push your image to the new registry again. The role assignment is removed. The sandbox group itself stays, because removing the ARM deployment doesn't delete it. Delete it with `az resource delete --ids <group id>` when you no longer want users' sandbox files.

## What's next

- **Long-running tasks:** a Durable Functions orchestration drives the steps, and the sandbox suspends between them. Each step resumes from files on disk, so tasks checkpoint to `/mnt/data`.

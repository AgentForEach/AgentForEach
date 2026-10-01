# Evaluating Google Cloud for AgentForEach sandboxes

> **Status (October 2026):** GKE Agent Substrate (Tests 0–2) and GKE Agent Sandbox (Test 3) have both been installed and tested. Nothing here changes AgentForEach's default backend, which is still ACA Sandboxes ([Sandbox.md](Sandbox.md)). This page records what we researched, installed and tested, in order, so anyone can repeat it or pick it up.

## Verdict on GKE Agent Substrate

**Not usable for AgentForEach in production today. Worth watching.**

The core mechanics are good: our sandbox container ran unchanged, and suspend and resume kept more state than ACA Sandboxes does. What stops it:

1. **Not production-supported.** Google offers it for evaluation and non-production use; production support is allowlist-only, and the open-source project says it is not ready for production.
2. **Egress is open, and the cloud metadata server answered sandboxes.** For a product that runs model-written code, this alone rules it out until it is locked down.
3. **No built-in destination allowlist or credential injection.** Both need an experimental TLS-interception mode plus a policy service we would write and maintain.
4. **No idle suspend or age-based clean-up.** We would build both in the brain.

Smaller, fixable issues are in [Findings](#findings). We will revisit Substrate when it reaches GA with egress authorization, the milestone its egress README names as the follow-up.

## Verdict on GKE Agent Sandbox

**A usable foundation, not a drop-in backend.** It is production-supported and secure by default where Substrate is not, but AgentForEach would have to build the lifecycle around it.

What it gets right ([Test 3](#test-3-gke-agent-sandbox)):

- **Network isolation by default, per sandbox.** The generated NetworkPolicy blocks the metadata server (`169.254.0.0/16`), private ranges and cluster DNS, and only the router may connect in.
- **Enforced hardening.** Admission policies require gVisor, non-root and no capabilities. The router refuses to start without an auth token.
- **Full-state snapshots.** Files, memory and a running background process survived suspend and resume, as on Substrate. Claiming a warm sandbox took about 4 s; resuming took about 5 s.

What AgentForEach would have to build:

1. **Per-user snapshot scoping. This is critical.** With the setup in Google's guide, a resuming sandbox restored **another user's** snapshot: files, memory and processes. Each sandbox must have its own snapshot scope and pin its restore (`podsnapshot.gke.io/ps-name`).
2. **Suspend and resume orchestration.** Nothing suspends idle sandboxes, and a request to a suspended sandbox fails (`502`) instead of resuming it.
3. **Egress allowlist and credential injection.** Public egress is open; host allowlists and injected credentials need a proxy we run.
4. **Working within Autopilot's limits.** Capacity stock-outs and small default quotas stopped sandboxes from scheduling until we changed the machine family and boot-disk size.

## TL;DR

We looked for a Google Cloud equivalent of ACA Sandboxes: one isolated sandbox per user that runs any shell command, keeps its files while idle, costs nothing while suspended, and controls egress.

- **Nothing on Google Cloud is a drop-in match.** The closest is **GKE Agent Substrate**, an open-source system that runs on a GKE cluster, suspends idle agents to a snapshot and resumes them in under a second. It is offered for **evaluation and non-production use**; production support is allowlist-only.
- **GKE Agent Sandbox** is production-supported (v1.0, open source, a managed GKE add-on). In [Test 3](#test-3-gke-agent-sandbox) it isolated network access by default and restored full state, but snapshots were not scoped per user, and suspend, resume and egress control are left to us.
- We installed Substrate on a small GKE cluster and ran **AgentForEach's own sandbox container** (`gateway/sandbox-container`, unmodified `server.mjs`) on it. Exec, file I/O and env vars all worked through Substrate's router, and **everything survived suspend and resume, including a running background process**, which ACA Sandboxes did not keep in our tests.
- Resuming a suspended sandbox added about **0.4 s** to a request.
- **Egress is the blocker.** With the default install a sandbox can reach the whole internet (HTTP, HTTPS, WebSockets, DNS to outside resolvers), and **the cloud metadata server answered it**. This release has no destination allowlist and no credential injection; both need an experimental TLS-interception mode plus a policy service you write yourself. We built that service ([Test 2](#test-2-egress)); attaching it is still open.
- Other gaps before this could replace ACA: no built-in idle detection (we would call suspend ourselves), a 10-second request limit in the router by default, a readiness probe that our `/health` endpoint fails, and a first boot of our large image that took about 10 minutes.

## Contents

- [Verdict on GKE Agent Substrate](#verdict-on-gke-agent-substrate)
- [Verdict on GKE Agent Sandbox](#verdict-on-gke-agent-sandbox)
- [What we needed](#what-we-needed)
- [The market: which products are comparable](#the-market-which-products-are-comparable)
- [Google Cloud options](#google-cloud-options)
- [GKE Agent Sandbox in detail](#gke-agent-sandbox-in-detail)
- [GKE Agent Substrate in detail](#gke-agent-substrate-in-detail)
- [Mapping to what AgentForEach uses today](#mapping-to-what-agentforeach-uses-today)
- [Preparing a project](#preparing-a-project)
- [What the installer actually does](#what-the-installer-actually-does)
- [Installing Substrate](#installing-substrate)
- [Test 0: the counter demo](#test-0-the-counter-demo)
- [Test 1: AgentForEach's sandbox container](#test-1-agentforeachs-sandbox-container)
- [Test 2: egress](#test-2-egress)
- [Test 3: GKE Agent Sandbox](#test-3-gke-agent-sandbox)
- [Findings](#findings)
- [What a Substrate backend would look like](#what-a-substrate-backend-would-look-like)
- [Cost](#cost)
- [Tearing everything down](#tearing-everything-down)
- [Next tests](#next-tests)
- [Sources](#sources)

## What we needed

The requirements are the same six as in [Sandbox-Migration.md](Sandbox-Migration.md#what-agentforeach-needs-from-a-sandbox), made concrete by what the ACA Sandboxes backend (`gateway/skills/sandbox/aca-sandboxes-client.ts`) relies on:

| # | Need | How ACA Sandboxes provides it today |
|---|---|---|
| 1 | Strong isolation | A microVM per sandbox |
| 2 | One sandbox per user, found again later | Labels holding hashes of the user id |
| 3 | Files survive idle time | Auto-suspend after 300 s idle; the disk is kept |
| 4 | Scale to zero | No CPU or memory billing while suspended |
| 5 | Run any command, read and write files | `executeShellCommand` and a files API |
| 6 | Custom image | A private disk image with Python, Node, compilers |
| 7 | Deny-by-default egress with per-host rules | Egress policy with full traffic inspection |
| 8 | Secrets never enter the sandbox | The egress proxy injects credential headers for declared hosts |
| 9 | Clean-up | Auto-delete N days after stopping; delete on account erasure |
| 10 | A real browser | Chromium inside the same sandbox ([Browser.md](Browser.md)) |

## The market: which products are comparable

We started from a pricing table that put four products side by side. They look alike, but they are three different kinds of product:

| Kind | Products | What it is |
|---|---|---|
| **Agent runtimes** | AWS AgentCore Runtime, Google Agent Platform runtime (formerly Vertex AI Agent Engine) | Hosts the agent's own loop. Idle time waiting on the model is not billed. |
| **Managed sandboxes** | Azure Container Apps Sandboxes, AgentCore Code Interpreter and Browser, Google Agent Platform Code Execution | Where the agent runs code or a browser. |
| **Self-managed building block** | GKE Agent Sandbox | Open-source Kubernetes controller; you pay for your own nodes. |

Two things make the headline prices misleading:

- **Billing model.** Azure bills a sandbox for the whole time it runs; AWS and Google bill active CPU only. At nearly the same list price, a sandbox that is idle most of the time costs several times more on Azure.
- **Lifespan.** An ACA Sandbox stops and resumes with its files, paying storage only while stopped. AgentCore sessions end after at most 8 hours. For a per-user sandbox that keeps files, this matters more than the hourly rate.

For AgentForEach the relevant comparison is the managed-sandbox row plus GKE Agent Sandbox. The agent runtimes do a different job: our brain already runs the agent loop.

## Google Cloud options

| | GKE Agent Sandbox | GKE Agent Substrate | Agent Platform Code Execution | A VM per user |
|---|---|---|---|---|
| Isolation | gVisor or Kata | gVisor, optional microVM | Managed | A full VM |
| Any shell command | Yes | Yes | Code execution only | Yes |
| Custom image | Yes | Yes | No | Yes |
| Suspend and resume with state | Manual, via Pod Snapshots | Yes, under a second | Files kept until a TTL | Slow VM suspend |
| Idle auto-suspend | Roadmap | No (you call suspend) | n/a | You build it |
| Egress with credential injection | You build it | TLS-intercepting egress gateway | No | You build it |
| Maturity | v1.0, production | Evaluation only | Managed service | Mature |

A VM per user works but is slow to resume and has a fixed cost per VM, which conflicts with scaling to many users. Code Execution is roughly Google's equivalent of ACA Dynamic Sessions with PythonLTS, our old fallback. That leaves the two GKE projects.

## GKE Agent Sandbox in detail

Checked against the docs on 1 October 2026. This section summarises the documentation; [Test 3](#test-3-gke-agent-sandbox) records what we saw on a running install, which differs in places (the `v1beta1` API needs warm pools, the router needs a token, and the default network policy is stricter than described here).

- **Status.** Open-source Kubernetes SIG project, v1.0.4 (24 September 2026), API `v1beta1`. Also offered as a managed GKE add-on on Autopilot and Standard, GKE 1.35.2-gke.1269000 or later.
- **Resources.** `Sandbox` (one stateful pod with a stable hostname and storage), plus `SandboxTemplate`, `SandboxClaim` and `SandboxWarmPool`. Warm pools give starts under a second.
- **Exec and files.** A daemon inside the pod, `sandboxd`, runs commands over gRPC (run or stream output, stdin, signals, a terminal; with `cwd` and `env`) and serves files over REST under `/workspace`. `sandboxd` has no authentication of its own; it relies on NetworkPolicy.
- **SDKs.** Python, Go and TypeScript.
- **Router.** The Sandbox Router forwards traffic with scoped tokens bound to one sandbox, port and path.
- **Persistence.** A persistent volume per sandbox (`volumeClaimTemplates`).
- **Suspend and resume.** Manual, through GKE Pod Snapshots, gVisor only, and **Python SDK only** for now. A snapshot captures memory, processes and the container's own files, stored in Cloud Storage. It **does not** capture persistent volumes.
- **Idle auto-suspend, scale to zero, TTL deletion.** Listed as *planned* on the project roadmap. Today a sandbox can only be deleted at a fixed time (`shutdownTime` with `shutdownPolicy: Delete`).
- **Egress.** Standard Kubernetes NetworkPolicy in the template; host allowlists need Cilium FQDN policies (the project has an example). No TLS inspection or credential injection.
- **Browser.** Computer-use examples exist, and the router supports browser-friendly routing with session cookies.

## GKE Agent Substrate in detail

- **Status.** "Available to all Google Cloud customers for evaluation and non-production use. Production support is offered on an allowlist basis under a private GA program." The open-source project is pre-1.0 and says it is "not ready for production use."
- **Model.** Many **actors** (agent instances) are multiplexed onto fewer **workers** (pre-warmed sandbox pods). An **ActorTemplate** names the image, resources and snapshot policy; a **WorkerPool** supplies workers; an **atespace** groups actors and templates.
- **Suspend and resume.** Suspend snapshots memory and local files to Cloud Storage. A request to a suspended actor resumes it automatically, possibly on a different worker. Google quotes under 500 ms and 500+ activations per second.
- **No idle detection.** "Substrate doesn't currently detect idleness on its own." The orchestrator calls suspend.
- **Per-agent storage.** Optional Filestore volumes per actor at `/mnt/shared` that survive suspend.
- **Egress.** An egress gateway. Its docs say non-TCP/UDP traffic is blocked, UDP other than DNS is dropped, WebSockets and CONNECT are blocked, and DNS is not filtered (in [Test 2](#test-2-egress) a WebSocket upgrade and DNS to an outside resolver both worked). With TLS interception enabled, the gateway can inject headers; actors must trust its CA.
- **Requirements.** GKE **Standard** only (not Autopilot), 1.36 with beta flags or 1.37+, `c3-standard-4` or larger, Workload Identity, Cloud Storage for snapshots.
- **Cost.** No extra charge; you pay for the GKE resources.

## Mapping to what AgentForEach uses today

Both columns are from our tests ([Tests 1–2](#test-1-agentforeachs-sandbox-container) for Substrate, [Test 3](#test-3-gke-agent-sandbox) for Agent Sandbox) unless marked "docs".

| Need (from the table above) | GKE Agent Sandbox | GKE Agent Substrate |
|---|---|---|
| 1 Isolation | ✅ gVisor, enforced by admission policy | ✅ gVisor (microVM optional) |
| 2 One sandbox per user | ✅ a claim per user | ✅ an actor per user |
| 3 State survives idle | ✅ files, memory and processes, **but snapshots are not scoped per user by default** | ✅ files, memory and processes |
| 4 Scale to zero | ⚠️ manual suspend **and** manual resume (a request to a suspended sandbox fails) | ⚠️ manual suspend, automatic resume on request |
| 5 Any command, files | ✅ `server.mjs` unchanged, as a non-root user | ✅ `server.mjs` unchanged, as root |
| 6 Custom image | ✅ | ✅ pinned by digest |
| 7 Deny-by-default egress | ⚠️ metadata, private ranges and cluster DNS blocked by default; public internet open | ❌ everything open, metadata server included; an allowlist needs an experimental mode plus your own policy service |
| 8 Credential injection | ❌ build your own proxy | ⚠️ possible only through the same experimental hook |
| 9 Clean-up | ⚠️ fixed-time delete only (docs) | ⚠️ explicit delete only |
| 10 Browser | Not tested | Not tested |
| Production support | ✅ managed GKE add-on | ❌ evaluation only |

We tested **Substrate** first because it is the only option that resumes on request and keeps memory and files. Agent Sandbox turned out to be safer by default, but it leaves more of the lifecycle to us.

## Preparing a project

Everything here uses the `gcloud` CLI.

1. **A project with billing.** A billing account can only be linked to a limited number of projects (our account's limit was 5). If `gcloud billing projects link` fails with `Cloud billing quota exceeded`, free a slot or request an increase. A dedicated project is easiest to clean up, because deleting the project removes everything in it.
2. **APIs.** Enable `container.googleapis.com`. The installer enables the rest (Artifact Registry, Network Connectivity, Storage, Logging, Monitoring, Trace, Telemetry).
3. **Check GKE versions and machine types in your region:**
   ```bash
   gcloud container get-server-config --location=<REGION> --format="yaml(channels)"
   gcloud compute machine-types list --filter="name=c3-standard-4 AND zone~^<REGION>"
   ```
   In October 2026, 1.36.4 was on the Regular and Extended channels and 1.37.0 on Rapid, in the regions we checked.
4. **Check quotas.** New projects have small regional quotas. Ours had **8 C3 vCPUs** (exactly the 2 nodes the installer creates, no room to autoscale) and **250 GB of SSD**, which turned out to be too little (see [Installing Substrate](#installing-substrate)):
   ```bash
   gcloud compute regions describe <REGION> --format=json \
     | jq -r '.quotas[] | select(.metric|test("C3_CPUS|SSD_TOTAL_GB|^CPUS$")) | "\(.metric): \(.usage)/\(.limit)"'
   ```
5. **Local tools.** `gcloud` (updated), `gke-gcloud-auth-plugin`, `kubectl`, `git`, `make`, Go 1.27+, and application-default credentials:
   ```bash
   gcloud components install gke-gcloud-auth-plugin && gcloud components update
   gcloud auth application-default login
   ```
   Docker with buildx is only needed to build Substrate from source.

## What the installer actually does

The documented install is `curl -sSL https://raw.githubusercontent.com/ai-on-gke/substrate-gke/main/install.sh | bash`. Before running it, we read the code. The shell script only clones `ai-on-gke/substrate-gke` into `~/.substrate-gke` and runs a Go wizard (`make run`). The wizard calls Substrate's own `setup-gcp bootstrap` and `ate-setup deploy`, pinned to Substrate commit `fa6d949`.

**What it creates:**

| Resource | Details |
|---|---|
| GKE Standard cluster | Zonal. One pool, `substrate-node-pool`, **2 × `c3-standard-4`**. Dataplane V2, Workload Identity, managed OpenTelemetry, PodCertificate beta APIs set at creation. |
| Snapshot bucket | One Cloud Storage bucket per cluster |
| Project-level IAM grants | Default compute service account: `storage.objectViewer`, `artifactregistry.reader`. The `atelet` Workload Identity principal: **`storage.objectAdmin` on the whole project** (the code has a TODO to narrow this). |
| Monitoring dashboards | Cloud Monitoring |
| Control plane | CRDs, API server, controller, `atenet` (router, egress, DNS), `atelet` DaemonSet, and **PostgreSQL inside the cluster**, which requests a **500 GiB** persistent disk |

Because the `atelet` grant covers every bucket in the project, a dedicated project is safer.

**Useful installer modes:** `make doctor` (preflight checks, no cloud calls) and `make dry-run` (walks every prompt without touching the cloud).

**What the teardown covers.** The wizard prints a `tools/cleanup-gcp` command, which runs Substrate's `hack/teardown.sh --all`. It deletes the dashboards, the IAM grants, the snapshot bucket and the cluster. It does **not** delete:

- the PostgreSQL persistent disk (GKE does not delete dynamically provisioned disks with the cluster),
- Filestore instances created for actors,
- the enabled APIs (free),
- anything you created yourself, such as an image repository.

See [Tearing everything down](#tearing-everything-down).

## Installing Substrate

**Two settings to fix before you start:**

- **GKE version.** The installer passes no version, so GKE picks the channel default (1.35 at the time), which is too old. The wizard passes your shell environment through to `setup-gcp`, so set it on launch:
  ```bash
  git clone https://github.com/ai-on-gke/substrate-gke.git && cd substrate-gke
  make doctor
  CLUSTER_VERSION=1.37.0-gke.3503000 make run
  ```
  1.37 also avoids the node replacement that 1.36 needs after enabling the beta APIs.
- **Zone.** The default is `us-west1-c`. Pick a zone where you checked C3 availability and quota.

**Wizard answers we used:** Quickstart track; pre-built images (`us-docker.pkg.dev/gke-substrate-release/substrate`, tag `v0.1.0-gke.1`); create a new cluster; `c3-standard-4`; default bucket; Filestore CSI driver on; autoscaling skipped (no C3 quota headroom); gVisor runtime; counter demo on. Run the wizard in a normal terminal: it is a full-screen program.

**What failed and how we fixed it.** Step 6 ("Turn on Substrate") failed waiting for `statefulset/postgres`:

```
Error: waiting for statefulset/postgres in ate-system: client rate limiter Wait returned an error:
rate: Wait(n=1) would exceed context deadline (last status: 0/1 replicas ready)
```

The cause was the SSD quota. The two node boot disks already used 200 of the region's 250 GB, and PostgreSQL asks for 500 GiB (`manifests/ate-install/postgres/postgres.yaml`). The disk was never created (`Quota 'SSD_TOTAL_GB' exceeded`), PostgreSQL stayed `Pending`, and the API server crash-looped because it could not reach it.

Either raise the regional SSD quota (for example to 1,000 GB) and press **[r]** to retry, or, as we did, give PostgreSQL a smaller disk. The statefulset reuses a claim with the expected name if it already exists:

```bash
kubectl -n ate-system scale statefulset postgres --replicas=0
kubectl -n ate-system delete pvc data-postgres-0      # still Pending, so there is no data
kubectl -n ate-system apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: data-postgres-0, namespace: ate-system }
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: standard-rwo
  resources: { requests: { storage: 40Gi } }
EOF
kubectl -n ate-system scale statefulset postgres --replicas=1
```

40 GiB is plenty for an evaluation: snapshots go to the Cloud Storage bucket, not this disk. After PostgreSQL came up, the API server recovered on its own, and **[r]** in the wizard completed the install.

**Result.** GKE `1.37.0-gke.3503000` on the Rapid channel, 2 nodes, and every `ate-system` component running: `postgres`, `ate-api-server` (2), `ate-controller`, `atelet` (one per node), `atenet-router`, `atenet-egress`, `dns`.

## Test 0: the counter demo

The installer deploys a demo whose server keeps two counters, one in memory and one in a file. We built the CLI from the pinned commit and drove the demo through the router:

```bash
go install ./cmd/kubectl-ate          # from a checkout of agent-substrate/substrate at fa6d949
kubectl port-forward -n ate-system svc/atenet-router 8000:80
kubectl ate create actor my-counter-1 -a ate-demo-counter --template-ref counter
curl -X POST -H "Host: my-counter-1.ate-demo-counter.actors.resources.substrate.ate.dev" http://localhost:8000/
kubectl ate suspend actor my-counter-1 -a ate-demo-counter
```

| Step | Result | Round trip |
|---|---|---|
| Create | Starts suspended, from the template's golden snapshot | – |
| Request 1 | memory 1, file 1 | 3.2 s |
| Requests 2–3 | 2, then 3 | 0.9–1.0 s |
| Suspend | `SUSPENDED`, no worker | – |
| Request while suspended | **memory 4, file 4**, resumed automatically on a different worker | 1.3 s |

## Test 1: AgentForEach's sandbox container

**Goal.** Run `gateway/sandbox-container` (Debian with Python, Node, Java, PHP, Ruby, Go, and `server.mjs` serving `/exec`, `/files`, `/env`, `/health`) as a Substrate actor, and check that the calls AgentForEach makes work across suspend and resume.

**Build.** We built the image with Cloud Build (amd64, so no emulation on an ARM laptop) into an Artifact Registry repository. It took about 3 minutes.

```bash
gcloud artifacts repositories create agentforeach --repository-format=docker --location=<REGION>
cd gateway/sandbox-container
gcloud builds submit . --region <REGION> --tag <REGION>-docker.pkg.dev/<PROJECT_ID>/agentforeach/sandbox:substrate-test1
```

The default nodes' service account already has `artifactregistry.reader` from the installer, so workers can pull the image.

**Worker pool** (a Kubernetes resource). The worker image is the pre-built gVisor worker from the same release:

```yaml
apiVersion: v1
kind: Namespace
metadata: { name: ate-agentforeach }
---
apiVersion: ate.dev/v1alpha1
kind: WorkerPool
metadata:
  name: sandbox
  namespace: ate-agentforeach
  labels: { workload: agentforeach-sandbox }
spec:
  replicas: 2
  sandboxClass: gvisor
  workerImage: us-docker.pkg.dev/gke-substrate-release/substrate/ateom-gvisor:v0.1.0-gke.1@sha256:acdf303671a2668a80dbc08af0c92fab86c4947bc94e3fe28ff69ca15ea605b5
  template:
    nodeSelector: { ate.dev/substrate-version: v0.1.0-gke.1 }
    resources:
      limits: { cpu: "1", memory: 3Gi }
      requests: { cpu: 250m, memory: 3Gi }
```

**Actor template** (created through the Substrate API with `kubectl ate create atespace ate-agentforeach` and `kubectl ate create actor-template -f template.yaml`). `server.mjs` reads its port from `SANDBOX_PORT`, so no code change was needed to serve on the router's default port 80. `/mnt/data` is a `durableDir` volume:

```yaml
metadata: { atespace: ate-agentforeach, name: sandbox }
workerSelector: { matchLabels: { workload: agentforeach-sandbox } }
containers:
- name: sandbox
  image: <REGION>-docker.pkg.dev/<PROJECT_ID>/agentforeach/sandbox:substrate-test1@sha256:<DIGEST>
  env:
  - { name: SANDBOX_PORT, value: "80" }
  readyz: { httpGet: { path: /files, port: 80 } }
  volumeMounts:
  - { name: data, mountPath: /mnt/data }
resources:
  limits:
  - { name: cpu, quantity: "1" }
  - { name: memory, quantity: 2Gi }
snapshotsConfig:
  onCommit: SNAPSHOT_CONTENT_SCOPE_FULL
  onPause: SNAPSHOT_CONTENT_SCOPE_FULL
  storageLocation: gs://<SNAPSHOT_BUCKET>/ate-agentforeach/
sandboxConfig: { sandboxClass: SANDBOX_CLASS_GVISOR, configName: gvisor-default }
volumes:
- { name: data, durableDir: {} }
```

**First attempt: the readiness probe.** With `readyz` pointed at `/health`, the template's golden snapshot never finished. The worker restarted our server every 30 seconds. Substrate's probe gives each request **250 ms** (`internal/readyz/readyz.go`: `RequestTimeout = 250 * time.Millisecond`, overall default 30 s). Our `/health` synchronously runs `python3`, `node`, `java`, `php`, `ruby` and `go --version`, which takes seconds under gVisor, so every probe timed out. Pointing the probe at `/files` (a directory listing) fixed it. Templates are immutable, so this meant deleting and recreating the template.

**Golden snapshot.** The first boot took about **10 minutes**, almost all of it pulling our large multi-runtime image onto the worker. With the image cached, the recreated template's golden snapshot was ready in **33 s**.

**The test.** Each call goes through the router with a `Host: <actor>.<atespace>.actors.resources.substrate.ate.dev` header, exactly as the brain would send it:

```bash
kubectl ate create actor user-1 -a ate-agentforeach --template-ref sandbox
H="Host: user-1.ate-agentforeach.actors.resources.substrate.ate.dev"
curl -H "$H" -X POST localhost:8000/exec -d '{"command":"uname -srm; id; df -h /mnt/data"}'
curl -H "$H" -X POST localhost:8000/files/write -d '{"filename":"notes/hello.txt","content":"written before suspend"}'
curl -H "$H" -X POST localhost:8000/env -d '{"vars":{"AFE_TOKEN":"placeholder-123"}}'
curl -H "$H" -X POST localhost:8000/exec -d '{"command":"echo x > /root/outside.txt; nohup sh -c \"while true; do date +%s >> /mnt/data/bg.log; sleep 1; done\" &"}'
kubectl ate suspend actor user-1 -a ate-agentforeach
curl -H "$H" -X POST localhost:8000/exec -d '{"command":"cat /mnt/data/notes/hello.txt /root/outside.txt; echo $AFE_TOKEN; pgrep -af \"while true\""}'
```

**Results:**

| Check | Result |
|---|---|
| Runtimes reported by `/health` | Python 3.11, Node 22, Java 17, PHP 8.2, Ruby 3.1, Go 1.23 |
| Environment | Kernel `4.19.0-gvisor`, root, 2 GiB memory as set |
| `/exec`, `/files/write`, `/files/read`, `/env` | All HTTP 200, `server.mjs` unmodified |
| **After suspend and resume:** | |
| File in `/mnt/data` | ✅ kept |
| Files outside `/mnt/data` (`/root`, `/tmp`) | ✅ kept |
| Env var set through `/env` (held in the server's memory) | ✅ kept |
| Background process | ✅ **still running with the same PID**, and it kept writing after resume |
| Clock | Correct after resume |
| Egress | `curl https://pypi.org` returned 200: **open by default** |

**Timings** (through `kubectl port-forward` from a laptop, which adds most of the ~0.8 s floor):

| Operation | Round trip |
|---|---|
| First request on a new actor (from the golden snapshot) | 1.34 s |
| First request after suspend (automatic resume) | 1.23 s |
| Warm request | 0.83–0.85 s |
| Suspend | about 5 s |

Resuming adds about **0.4 s**.

## Test 2: egress

**Goal.** Find out what code in a sandbox can reach, and whether Substrate can give AgentForEach what ACA's egress policy does: deny by default, allow named hosts, and inject credentials at the proxy so they never enter the sandbox.

### How egress works in Substrate

Actor traffic never leaves the worker directly. Inside the worker pod, `nftables` redirects the actor's outbound TCP into `atunnel`, which wraps it in mTLS and an HTTP `CONNECT` to the shared egress gateway (`atenet-egress`, an Envoy forward proxy). The gateway checks the actor's certificate against the API server (is this a real, running actor?) and then connects to the destination. Each worker pool also gets a NetworkPolicy, but it only restricts **ingress** (only the router may reach workers).

The egress demo's README is explicit about the scope of this release:

> This milestone **authenticates** identity (is this a real, running actor?). **Authorizing** egress by destination and injecting upstream credentials/tokens is a follow-up.

### A limit found first: the router's 10-second timeout

Our first probe run came back as `504 upstream request timeout`. Every request through `atenet-router`, including the `CONNECT` listener, is cut off after **10 seconds** by default (`defaultRouteTimeout` in `cmd/atenet/internal/router/xds.go`). AgentForEach lets `sandbox_exec` run for up to 200 s, so any longer command failed.

The router takes a `--route-timeout` flag. We added it to the deployment:

```bash
kubectl -n ate-system patch deploy atenet-router --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--route-timeout=240s"}]'
```

A 30-second command then returned 200. Re-running the installer (or `ate-setup deploy atenet`) resets it. The source notes that a longer route timeout should be paired with a longer `--drain-timeout` if in-flight requests must survive a router restart.

### What a sandbox can reach with the default install

We ran a probe script through `/exec` in a running actor:

| Check | Result |
|---|---|
| HTTPS and HTTP to public hosts | Allowed |
| Source IP seen by the internet | The cluster's egress address, not the sandbox's |
| WebSocket upgrade (`wss://`) | Allowed (`101`) |
| DNS to an outside resolver (UDP to `8.8.8.8`) | Allowed: an unfiltered DNS channel out |
| ICMP | Blocked |
| DNS resolution of cluster names | Works (`*.svc.cluster.local` resolves) |
| **Cloud metadata server** (`169.254.169.254`, service-account email and token endpoints) | **Both returned HTTP 200** |
| Kubernetes API server | Answered (`401` on `/version`) |
| Raw TCP to other in-cluster addresses | Inconclusive: because traffic is transparently redirected, a TCP connect succeeds locally whatever the destination, so a plain connect test proves nothing |

**The metadata result matters most.** Code in a sandbox can ask the metadata server for credentials. We did not go further and test what the returned identity can access; that depends on the node pool's service account and on whether the GKE metadata server (Workload Identity) is in front of it. Anyone running untrusted code on this stack should block `169.254.169.254` for sandbox workers and make sure node service accounts have minimal roles before doing anything else.

Protocol-level checks of the other in-cluster services (PostgreSQL, kubelet, other workers) are still open.

### Allowlists and credential injection: the experimental hook

Substrate has two experimental install flags that together make an ACA-style policy possible:

- `--experimental-use-sdsmint` switches the egress gateway to TLS interception. It terminates each TLS connection, mints a certificate for the requested name, and re-originates the request. Actors must trust the gateway's CA, which a template projects with a `systemInfo` volume (`trustBundle: egress-mitm.ate.dev`), and each runtime has to be pointed at it (`SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, and so on).
- `--experimental-additional-egress-extproc-service NS/SVC:PORT` inserts an Envoy `ext_proc` filter on those **decrypted** requests. The service receives each request's headers (including `:authority`) and the calling actor's identity (`filter_state['dev.ate.actor.identity']`). It can reject the request or set headers; only system headers are protected from changes.

No policy service ships with Substrate. We wrote a minimal one (about 180 lines of Go using Envoy's `ext_proc` API):

- A host not on `ALLOW_HOSTS` (exact names or `*.suffix`) gets an immediate `403` with a clear message.
- For hosts on `INJECT_HOSTS`, it overwrites one header (for example `Authorization`) with a value read from a Kubernetes Secret, so the sandbox only ever holds a placeholder. This is the same shape as AgentForEach's ACA header-transform rules ([Sandbox.md → Credentials](Sandbox.md#aca-sandboxes)).
- It logs one line per decision with the host, path and actor identity.

It serves gRPC over TLS 1.3, using a certificate from Substrate's `servicedns.podcert.ate.dev/identity` signer (a projected `podCertificate` volume). The gateway checks that the certificate names `<service>.<namespace>.svc`, and the signer issues a name for each Service that selects the pod, so the Service must exist before the pod. The service is deployed and running on the test cluster.

**Still open:** attaching it. That means redeploying Substrate's network components with both flags, then recreating the template with the trust bundle and CA variables:

```bash
# from a checkout of agent-substrate/substrate at the installed commit
go run ./cmd/ate-setup create egress-mitm-ca-pool <flags>
go run ./cmd/ate-setup deploy atenet <flags>
# <flags>: --experimental-use-sdsmint
#          --experimental-additional-egress-extproc-service=<ns>/<svc>:<port>
#          --image-repo=us-docker.pkg.dev/gke-substrate-release/substrate --image-tag=v0.1.0-gke.1
```

`deploy atenet` also replaces the router, so the `--route-timeout` patch has to be applied again. Two practical notes: `ate-setup` wants its flags **after** the subcommand, and in zsh a flag list kept in a plain variable is not split into words (use an array).

Once attached, the test is: an allowed host works, any other host gets the policy's `403`, `postman-echo.com/headers` shows the injected `Authorization` value while the sandbox sent a placeholder, and the metadata server and in-cluster addresses are refused.

## Test 3: GKE Agent Sandbox

**Goal.** Run the same checks as Tests 1 and 2 on GKE Agent Sandbox, the production-supported option: our container unchanged, exec and files through its router, suspend and resume, and egress.

### Cluster

We used a GKE **Autopilot** cluster with the managed add-on and Pod Snapshots:

```bash
gcloud container clusters create-auto <CLUSTER> --location <REGION> \
  --release-channel rapid --enable-agent-sandbox --enable-pod-snapshots
```

- On the **Regular** channel this failed with `Addons {"pod-snapshot"} are not supported for Autopilot clusters`. On **Rapid** it worked (GKE 1.36.4).
- The `v1beta1` API needs **1.36.3-gke.1767000 or later**, so the Regular channel's 1.35 would have been too old anyway.
- Creation took about 9 minutes.

The add-on installs:
- the `Sandbox`, `SandboxTemplate`, `SandboxClaim` and `SandboxWarmPool` resources;
- the `podsnapshot.gke.io` resources;
- a `gvisor` runtime class (and a `microvm` one);
- two admission policies: `sandbox-core-policy`, which requires gVisor and forbids host access, and `sandbox-hardening-policy`, which requires non-root, dropped capabilities and resource limits and can be edited.

It does **not** install the Sandbox Router.

### Snapshot storage

Following Google's guide:
- a Cloud Storage bucket (hierarchical namespace, soft delete off) with a managed folder;
- a custom role limited to `storage.objects.get`, `create` and `delete` and `storage.folders.create`;
- Workload Identity bindings for the sandbox namespace and service account, plus `roles/storage.objectUser` for the GKE service agent.

A new custom role can take a few seconds to become usable in bindings. Then a `PodSnapshotStorageConfig` and a `PodSnapshotPolicy` selecting the sandbox pods, with manual triggers:

```yaml
apiVersion: podsnapshot.gke.io/v1
kind: PodSnapshotPolicy
metadata: { name: afe-psp, namespace: afe-sandbox }
spec:
  storageConfigName: afe-pssc-gcs
  selector: { matchLabels: { app: agent-sandbox-workload } }
  triggerConfig: { type: manual, postCheckpoint: resume }
```

This policy is the one from Google's guide, and it causes the cross-user restore described below.

### The sandbox template

Our container runs as root, but the admission policies require non-root. So the template sets user 1000, drops all capabilities, and mounts a writable `emptyDir` at `/mnt/data` (the image's `/mnt/data` is owned by root). Snapshots need a non-E2 machine, so a custom compute class picks N2 or N2D:

```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxTemplate
metadata: { name: afe-sandbox, namespace: afe-sandbox }
spec:
  service: true          # off by default; the router needs the per-sandbox Service
  podTemplate:
    metadata:
      labels: { app: agent-sandbox-workload }
    spec:
      serviceAccountName: afe-sandbox-ksa
      runtimeClassName: gvisor
      automountServiceAccountToken: false
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 }
      nodeSelector:
        sandbox.gke.io/runtime: gvisor
        cloud.google.com/compute-class: non-e2-class
      tolerations:
      - { key: sandbox.gke.io/runtime, value: gvisor, effect: NoSchedule }
      containers:
      - name: sandbox
        image: <REGION>-docker.pkg.dev/<PROJECT_ID>/agentforeach/sandbox@sha256:<DIGEST>
        env: [{ name: HOME, value: /mnt/data }]
        ports: [{ containerPort: 8080 }]
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
        resources:
          requests: { cpu: "1", memory: 2Gi }
          limits: { cpu: "1", memory: 2Gi }
        readinessProbe: { httpGet: { path: /files, port: 8080 } }
        volumeMounts: [{ name: data, mountPath: /mnt/data }]
      volumes:
      - { name: data, emptyDir: {} }
```

`server.mjs` needed no change: it serves on its default port 8080.

**Claims come from warm pools.** In `v1beta1`, a `SandboxClaim` requires `warmPoolRef`. The `sandboxTemplateRef` form in Google's snapshot guide is rejected (`unknown field "spec.sandboxTemplateRef"`). We created a `SandboxWarmPool` with one replica and claimed from it.

### Getting a node: capacity and quota

The first sandbox pod stayed `Pending` for about 20 minutes:

- **Capacity.** N2 scale-ups failed with `GCE out of resources` in two zones.
- **SSD quota.** Every Autopilot node gets a 100 GB `pd-balanced` boot disk by default. The region's 250 GB SSD quota was full after the system nodes, so the scale-up failed with `GCE quota exceeded`.
- **Only `pd-balanced` is allowed.** Autopilot rejects `pd-standard` boot disks in a compute class.

What worked: allowing N2D as well as N2, and setting `storage: { bootDiskType: pd-balanced, bootDiskSize: 50 }` in the compute class. Before relying on Autopilot, raise the regional **SSD Total GB** and **N2/N2D CPU** quotas.

### The router

Google's guide deploys the router from a staging image (`k8s-staging-images/agent-sandbox/sandbox-router:latest-main`); we found no released image. As written, it **crash-looped**:

```
RuntimeError: ROUTER_AUTH_TOKEN must be set to start the sandbox router securely.
```

It now requires a shared bearer token (`Authorization: Bearer <token>`, compared in constant time). Setting `ALLOW_UNAUTHENTICATED_ROUTER=true` disables that. The token is **one secret for the whole router**: anyone holding it can reach any sandbox, including unclaimed warm ones.

The router:
- must run in the `agent-sandbox-system` namespace with label `app: sandbox-router`, because that's the only ingress the generated NetworkPolicy allows;
- picks the sandbox from the headers `X-Sandbox-ID`, `X-Sandbox-Namespace` and `X-Sandbox-Port`;
- has a request timeout of **180 s** by default (`PROXY_TIMEOUT_SECONDS`; we set 240).

### Functional results

Through the router, with the same calls as Test 1:

| Check | Result |
|---|---|
| Request without the token | `401` |
| `/health`, `/exec`, `/files/write`, `/files/read`, `/env` | All `200`, `server.mjs` unmodified |
| Environment | Kernel `4.19.0-gvisor`, `uid=1000`, 2 GiB memory |
| 30-second command | `200` (Substrate's router needed its 10-second limit raised) |
| Background process | Starts and runs |
| `pip download` as the non-root user | Works |
| `/mnt/data` size | `emptyDir` under gVisor reports 8.0 EB; it is likely memory-backed and counted against the sandbox's memory limit (not verified) |
| Warm request latency | 0.83 s through `kubectl port-forward` (same floor as Substrate) |
| Claiming a warm sandbox | About 4 s |

### Suspend and resume

Sequence, with the timings we saw:

1. Snapshot the pod with a `PodSnapshotManualTrigger` (`targetPod: <sandbox>`). It took about **2 s**, including the copy to Cloud Storage.
2. Set the Sandbox's `spec.operatingMode: Suspended`. The pod was deleted within **5 s**.
3. Set `operatingMode: Running`. A new pod was Ready in **5.1 s**, restored from the snapshot.

| After resume | Result |
|---|---|
| File in `/mnt/data` | ✅ kept |
| File in `/tmp` | ✅ kept |
| Env var set through `/env` (server memory) | ✅ kept |
| Background process | ✅ still running, same PID |

**Nothing resumes on demand.** A request to a suspended sandbox returns `502 Could not connect to the backend sandbox`, and the sandbox stays suspended. Nothing suspends idle sandboxes either. Both would be the brain's job.

### Cross-user restore: the critical finding

A second user's sandbox (`user-2`) had never held any of `user-1`'s data. After its first plain suspend and resume, it came back with **`user-1`'s** files, `/tmp` contents, in-memory env var and running background process.

The cause is how GKE chooses a snapshot. A new pod covered by a `PodSnapshotPolicy` restores the **latest compatible snapshot** under that policy, and compatibility is keyed to the pod template (the snapshot is labelled `podsnapshot.gke.io/pod-template-hash`), not to the sandbox. Every sandbox from one template is interchangeable, so:

- resuming any user's sandbox can restore another user's state;
- fresh warm-pool pods can start from the latest user's state.

To use snapshots per user, AgentForEach would have to give each sandbox its own snapshot scope. For example, a policy that selects only that sandbox's pod, plus the `podsnapshot.gke.io/ps-name: <snapshot>` annotation on resume so it restores its own snapshot explicitly. It would then have to test that a fresh pod never restores anything. The Python SDK's suspend and resume may already do this; we did not test it.

### Egress

The generated NetworkPolicy, per sandbox:

```yaml
egress:
- to:
  - ipBlock:
      cidr: 0.0.0.0/0
      except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16]
  - ipBlock: { cidr: ::/0, except: [fc00::/7, fe80::/10] }
ingress:
- from:
  - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: agent-sandbox-system } }
    podSelector: { matchLabels: { app: sandbox-router } }
```

Cluster DNS is unreachable, so sandboxes resolve names through public resolvers (`8.8.8.8`, `1.1.1.1` in `/etc/resolv.conf`).

From inside a sandbox:

| Check | Result |
|---|---|
| HTTPS and HTTP to public hosts | Allowed |
| WebSocket upgrade | Allowed (`101`) |
| DNS to an outside resolver | Allowed |
| Metadata server, private ranges, cluster DNS | Blocked **by the policy above**. We did not probe these from inside the sandbox. |

So the internal side is locked down by default, unlike Substrate, but the internet is open: there is no host allowlist and no credential injection. Those would need Cilium FQDN policies (if available on the cluster) or an egress proxy we run.

## Findings

### GKE Agent Substrate

1. **State survives better than on ACA Sandboxes.** A background process kept running across suspend with the same PID. On ACA Sandboxes, background processes were gone after an auto-suspend in both `Disk` and `Memory` modes ([Sandbox.md](Sandbox.md#aca-sandboxes)).
2. **Our `/health` endpoint is too slow for Substrate's readiness probe** (250 ms per request). A Substrate backend needs a cheap `/readyz` route in `server.mjs`.
3. **Large images are slow on first use.** Our image took about 10 minutes to pull onto a fresh worker. Pre-pulling onto nodes or a slimmer image would be needed.
4. **Egress is open by default, and the metadata server answers sandboxes.** ACA Sandboxes denies by default. Substrate's released egress only checks *who* is calling; allowlists and credential injection need an experimental TLS-interception mode plus a policy service you write ([Test 2](#test-2-egress)).
5. **Idle detection is ours to build.** Substrate resumes automatically but never suspends on its own; the brain would call suspend after 300 s idle, as ACA does for us today.
6. **`/mnt/data` lives on the node's disk.** `df` showed the node's 95 GB disk. Suspend copies it into the snapshot, but there is no per-user size limit like an ACA sandbox's own disk.
7. **Deleting a template can leave its golden actor behind.** The golden actor from our failed first attempt stayed `RESUMING` and could not be deleted (`not in a deletable state`), holding one worker until the cluster was deleted.
8. **The installer's defaults did not fit a new project's quotas.** The 500 GiB PostgreSQL disk exceeded the default 250 GB SSD quota, and 2 × `c3-standard-4` used the whole 8-vCPU C3 quota.
9. **Deleting a Substrate install leaves billable pieces.** The PostgreSQL disk and any Filestore instances outlive `cleanup-gcp`.
10. **The router cuts requests off after 10 seconds by default.** Raise it with `--route-timeout` (we used 240 s) for anything like `sandbox_exec`.

### GKE Agent Sandbox

1. **Snapshots are not scoped per user by default.** With the policy from Google's guide, a resuming sandbox restored another user's files, memory and processes. Each sandbox needs its own snapshot scope and an explicit restore target (`podsnapshot.gke.io/ps-name`).
2. **Secure network defaults.** The generated per-sandbox NetworkPolicy blocks the metadata server, private ranges and cluster DNS, and allows ingress only from the router. Public egress stays open.
3. **Nothing suspends or resumes on its own.** A request to a suspended sandbox returns `502`; the brain would drive both directions.
4. **Hardening is enforced.** Sandboxes must use gVisor and run as non-root with no capabilities, so a root image like ours needs a writable volume at its work directory, and packages cannot be installed system-wide.
5. **The router needs a token, and it is one token for everything.** The current router refuses to start without `ROUTER_AUTH_TOKEN`; Google's guide does not set one. Only a staging `latest-main` router image is published.
6. **The documentation lags the release.** `v1beta1` claims require a warm pool (`warmPoolRef`), Pod Snapshots on Autopilot needed the Rapid channel, and the per-sandbox Service is off unless `service: true`.
7. **Autopilot capacity and quota.** Zone stock-outs and a full 250 GB SSD quota (100 GB boot disk per node by default, `pd-balanced` only) kept the first sandbox pending for about 20 minutes.
8. **Fast once warm.** Claiming a warm sandbox took about 4 s, a snapshot about 2 s, and resuming about 5 s.

## What a Substrate backend would look like

AgentForEach's `SandboxBackend` interface (`gateway/skills/sandbox/types.ts`) maps directly:

| `SandboxBackend` | Substrate |
|---|---|
| `resolveIdentifier(userId)` | Actor name derived from a hash of the user id, in one atespace |
| First call for a user | `CreateActor` from the template (the API server's gRPC API, which `kubectl ate` uses) |
| `exec`, `fileWrite`, `fileRead`, `fileList`, `setEnv` | HTTP to `server.mjs` through `atenet-router` with the actor's `Host` header. A suspended actor resumes on its own. |
| Auto-suspend after idle | The brain tracks last use and calls `SuspendActor` |
| Delete on account erasure | `DeleteActor` |
| Auto-delete after N days | A scheduled job in the brain |

It would be a new client beside `aca-sandboxes-client.ts`, picked in `factory.ts`. `handler.ts` and the browser skill should not need to change, except that credential injection would target Substrate's egress gateway instead of ACA egress-policy rules. Moving the brain itself off Azure is a separate question.

## Cost

Estimates, not quoted prices.

**GKE Agent Substrate** (the installer's cluster):

| Item | Approximate cost |
|---|---|
| 2 × `c3-standard-4` nodes | about $0.40/hr |
| GKE cluster management | about $0.10/hr (free for one zonal cluster per billing account) |
| Node boot disks (2 × 100 GB) and the PostgreSQL disk | about $0.07/hr |
| **Total while the cluster exists** | **about $0.55–0.60/hr** (roughly $400/month) |

Suspended actors cost only their snapshot storage in Cloud Storage. The cluster costs the same whether actors are running or not, so the saving comes from packing many suspended users onto a few nodes.

**GKE Agent Sandbox** (Autopilot): about $0.10/hr of cluster management, plus the nodes Autopilot starts. Sandboxes on a custom compute class are billed as the underlying node (our N2D node was about $0.35/hr), and every warm-pool or running sandbox holds its full CPU and memory. A suspended sandbox has no pod and costs only its snapshot storage.

## Tearing everything down

**Substrate:**

1. From your `substrate-gke` clone, run the command the wizard printed, adding `--yes` to skip the typed confirmation:
   ```bash
   ./tools/cleanup-gcp --project <PROJECT_ID> --cluster <CLUSTER> --location <ZONE> --bucket <SNAPSHOT_BUCKET> --yes
   ```
   It removed the cluster, the snapshot bucket, the IAM grants and the dashboards in about 10 minutes.
2. Delete what it leaves behind: the PostgreSQL disk (named `pvc-…`, detached once the cluster is gone) and any Filestore instances:
   ```bash
   gcloud compute disks list --filter="name~^pvc-"
   gcloud compute disks delete <DISK> --zone <ZONE>
   gcloud filestore instances list
   ```

**Agent Sandbox:**

1. `gcloud container clusters delete <CLUSTER> --location <REGION>`.
2. Delete the snapshot bucket, the custom `podSnapshotGcsReadWriter` role, and any `pvc-…` disks left behind.

**Both:** delete the Artifact Registry repository holding the sandbox and policy images (`gcloud artifacts repositories delete agentforeach --location <REGION>`) and the Cloud Build source bucket (`gs://<PROJECT_ID>_cloudbuild`). With a dedicated project, deleting the project removes everything.

## Next tests

1. **Per-user snapshot scoping on Agent Sandbox.** A policy per sandbox plus `podsnapshot.gke.io/ps-name` on resume, then prove that neither a fresh pod nor another user's resume restores someone else's state. Also check whether the Python SDK's suspend and resume already do this.
2. **Egress control on Agent Sandbox.** Whether Cilium FQDN policies are available on the cluster for host allowlists, and an egress proxy for credential injection.
3. **Finish Substrate egress.** Attach the policy service ([Test 2](#test-2-egress)) and verify the allowlist, header injection, and that the metadata server and in-cluster addresses are refused.
4. **Browser.** Chromium inside a sandbox on either system. WebSocket upgrades worked on both.
5. **Scale.** Many sandboxes on a small node pool, and resume latency from inside the cluster rather than through `port-forward`.

## Sources

- GKE Agent Sandbox: [concepts](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox), [GitHub](https://github.com/kubernetes-sigs/agent-sandbox), [releases](https://github.com/kubernetes-sigs/agent-sandbox/releases), [roadmap](https://github.com/kubernetes-sigs/agent-sandbox/blob/main/roadmap.md), [lifecycle](https://agent-sandbox.sigs.k8s.io/docs/sandbox/lifecycle/), [snapshots](https://agent-sandbox.sigs.k8s.io/docs/sandbox/snapshots/), [runtime API](https://agent-sandbox.sigs.k8s.io/docs/api/runtime/), [Cilium egress example](https://agent-sandbox.sigs.k8s.io/docs/use-cases/examples/demo-cilium-egress/)
- [GKE Pod Snapshots](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/pod-snapshots)
- GKE Agent Substrate: [overview](https://docs.cloud.google.com/kubernetes-engine/ai-ml/about-agent-substrate), [install](https://docs.cloud.google.com/kubernetes-engine/ai-ml/install-overview-substrate), [Filestore agent volumes](https://docs.cloud.google.com/filestore/docs/agent-substrate), [agent-substrate/substrate](https://github.com/agent-substrate/substrate), [ai-on-gke/substrate-gke](https://github.com/ai-on-gke/substrate-gke)
- [DoiT: Your agents are idle, your Kubernetes bill isn't](https://www.doit.com/blog/your-agents-are-idle-your-kubernetes-bill-isnt), [InfoQ: Next '26 announcement](https://www.infoq.com/news/2026/05/gke-agent-sandbox-hypercluster/)

# Skills

A skill is a `SKILL.md` instruction file that teaches the agent how to do something (call an API, run a script). There is no per-skill TypeScript: the agent reads the file with `skill_read` and follows it using two general tools, `http_fetch` for HTTP calls and `sandbox_exec` for everything else. Per-user settings and credentials live in Cosmos DB. The server substitutes the credentials; they are not written into prompts.

Code: `gateway/skills/`. Sandbox details: [Sandbox.md](Sandbox.md).

## Where skills live

| What | Where |
|---|---|
| Skill files | Blob container `skills` (`skills.storageContainerName`) in the Function App's storage account, created by Pulumi. One folder per skill: `<skillId>/SKILL.md`, optionally `<skillId>/skill.zip` |
| Per-user state | Cosmos container `user-skills` (`skills.containerId`), partition key `/userId`. One document per user and skill (`{userId}:{skillId}`: `enabled`, `credentials`), plus audit entries |
| Example skill | `gateway/skills/skill-files/weather/SKILL.md` |

The gateway deployment doesn't upload skill files. Upload each skill folder to the `skills` container yourself (your identity needs a blob data role on the account):

```bash
az storage blob upload-batch --auth-mode login --account-name <storage-account> \
  -d skills -s gateway/skills/skill-files
```

Skill and sandbox tools are offered only when the gateway can reach this storage account (`AzureWebJobsStorage`, or `AzureWebJobsStorage__accountName` with a managed identity); otherwise it logs `[skills] ... skills and sandboxes are off`. The gateway lists the container, parses every `*/SKILL.md` and caches the manifests in memory for 5 minutes (`skills.blobStore.cacheTtlMs`). Files over 256 KB (`maxSkillFileBytes`) and zips over 10 MB (`maxZipFileBytes`) are refused; a malformed `SKILL.md` is skipped.

## SKILL.md format

Frontmatter is flat `key: value` lines; `credentials` and `requiredBins` are single-line JSON.

```markdown
---
id: github
name: GitHub
description: Read issues and pull requests
category: productivity
credentials: [{"key":"GITHUB_TOKEN","label":"GitHub token","required":true,"hosts":["api.github.com"],"header":"Authorization","format":"Bearer {value}"}]
requiredBins: ["curl", "jq"]
---

# GitHub

Call `https://api.github.com/...` with `Authorization: Bearer $GITHUB_TOKEN`.
```

`id`, `name`, `description` and `category` are required. Each credential takes:

| Field | Meaning |
|---|---|
| `key` | Variable name the skill body refers to as `$KEY` |
| `label`, `helpText` | Shown to the user when the skill needs setup |
| `required` | Defaults to `true` |
| `hosts` | Hosts the credential may be sent to (exact, or `*.example.com` for subdomains). Credential names are one namespace across skills: the first skill that supplies a value owns the name |
| `header`, `format` | With `hosts`: the header the sandbox egress proxy sets, and its value template (`{value}` is the secret; default `{value}`) |

Skill bodies may use `exec: ["curl", ...]` shorthand; the prompt tells the model to translate curl into `http_fetch` and other commands into `sandbox_exec`.

## Per-user resolution

At the start of every turn the runner resolves the user's skills (`skills/registry.ts`):

1. Load the manifests (cached) and the user's `user-skills` documents.
2. If the agent's `TOOLS` prompt document has a non-empty `enabledSkills` list, keep only those skills.
3. A skill is **enabled** if the user enabled it, or, with no user document, if it needs no required credentials (credential-free skills are on by default). It is **ready** when it is enabled and every required credential is set.
4. Credentials of ready skills are merged into one map for the turn, together with the host bindings of those that declare `hosts`.

The prompt's Skills section lists ready skills in `<available_skills>` (`id: description [path]`) and names the ones that still need setup. The section's text comes from `prompt.skills` in `agentforeach.json`.

## Tools

Registered when `skills.enabled` is true:

| Tool | What it does |
|---|---|
| `skill_list` | Every skill with its status and the labels of its required credentials (never values) |
| `skill_setup` | `enable`, `disable` or `set_credentials` for one skill. Only keys the manifest declares are accepted. Calls for the same skill are limited to one per 30 s (`skills.setupMinIntervalMs`). Each change writes an audit entry with the keys set, never the values |
| `skill_read` | Returns a skill's `SKILL.md`; refuses skills that are not enabled or lack required credentials |
| `http_fetch` | In-process HTTP request (GET, POST, PUT, PATCH, DELETE, HEAD; 30 s default, 120 s max; response body capped at 1 MB) through the SSRF-safe client, which checks every address and redirect. A request that uses a credential must be https |

With a sandbox configured, the sandbox tools are added: `sandbox_exec`, `sandbox_file_write`, `sandbox_file_read`, `sandbox_file_list`, `sandbox_file_export` (uploads a file to the `user-exports` container and returns a link that expires after 24 h), and `sandbox_skill_load` (unpacks `<skillId>/skill.zip` into `/mnt/data/<skillId>/`). See [Sandbox.md](Sandbox.md).

Operators can hide any tool with `prompt.hiddenTools`, or limit it to some channels with `prompt.toolChannels`.

## Credentials

Your users provide credentials through `skill_setup`, so a value passes through the conversation once, when the user supplies it. After that the model only ever writes `$KEY`:

- **`http_fetch`** substitutes `$KEY` in the URL, headers and body on the server. A credential whose skill declares `hosts` is substituted only when the request goes to one of those hosts; otherwise the call is refused. With `skills.requireCredentialHosts` (default `true`), a credential whose skill declares no `hosts` is refused everywhere, so a prompt-injected request can't send it to an attacker's server.
- **Sandboxes** get credentials on the first `sandbox_exec` or `sandbox_skill_load` of a turn. On ACA Sandboxes, a credential with `hosts` and `header` is injected by the sandbox's egress proxy on requests to those hosts: the secret never enters the sandbox, and the environment variable holds the placeholder `injected-by-egress-proxy`. Other credentials, and all credentials on the Dynamic Sessions fallback, are set as environment variables inside the sandbox.

Credential values are excluded from the `user-skills` indexing policy. `http_fetch` does not redact response bodies, so an API that echoes a secret back would show it to the model.

## Configuration

`skills` in `gateway/config/agentforeach.json`:

| Key | Default | |
|---|---|---|
| `enabled` | `false` (the shipped config sets `true`) | Registers the skill tools |
| `containerId` | `user-skills` | Cosmos container |
| `storageContainerName` | `skills` | Blob container for skill files |
| `storageConnectionString` | `AzureWebJobsStorage` | Blob storage for skills |
| `requireCredentialHosts` | `true` | See above |
| `setupMinIntervalMs` | `30000` | `skill_setup` rate limit per skill |
| `blobStore.cacheTtlMs`, `.maxSkillFileBytes`, `.maxZipFileBytes` | 5 min, 256 KB, 10 MB | |
| `sandbox` | None | Sandbox backend; see [Sandbox.md](Sandbox.md) |

## Related

- MCP servers (`mcp` in `agentforeach.json`, `gateway/mcp/`) are a separate source of tools and don't use this mechanism.
- Code runs only in sandboxes; there is no local command runner.

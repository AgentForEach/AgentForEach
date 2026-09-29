# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security → Advisories) on this repository, not in public issues or discussions. Include what you found, how to reproduce it, and what an attacker could do with it. We aim to acknowledge reports within 3 working days and to agree a disclosure date with you.

Only the `main` branch is supported while the project is in preview.

## Security model

AgentForEach serves many users from one deployment, so most of its security is about keeping tenants apart. What it relies on and what it enforces:

**Identity.** Every request is authenticated by a configured provider (App Service authentication, JWT with pinned algorithm and required expiry, API keys, or a trusted proxy). The `x-user-id` header provider exists for local development only and is refused on Azure. Operator actions (cron control, identity links, backfills) need the admin role.

**Tenant isolation.** Data is partitioned by user: session messages are keyed by `user:session:instance`, and every read, write and delete loads the owning session first. Channel accounts map to users through an index written only by pairing or an admin. Scheduled jobs deliver only to the owner's own accounts. HITL answers are accepted only from the request's owner.

**Channels.** Telegram and WhatsApp webhooks must be signed (`TELEGRAM_WEBHOOK_SECRET`, WhatsApp `appSecret`); a channel whose fallback would let strangers act as the default user refuses to start. Web PubSub upstream calls must carry a valid `ce-signature`.

**Tools.** Every fetch of a user- or model-controlled URL goes through an SSRF-safe client: internal addresses are refused when the connection is made (not only at DNS lookup), on every redirect. Skill credentials are bound to the hosts a skill declares: `http_fetch` sends them nowhere else, and on ACA Sandboxes a credential with a declared `header` is added by the sandbox's egress proxy, so it never enters the sandbox. Credential values are redacted from tool results. The model can call only the tools offered in that turn, and approval-gated tools fail closed where no one can approve.

**Abuse and cost.** Per-user rate limits (per minute and per day) on messages, on scheduled runs (jobs and heartbeats) and on force-runs, a cap on jobs per user, one run at a time per conversation, run deadlines, and a model allowlist (only priced or default models).

**Secrets and access.** The runtime reaches Cosmos DB and Storage with managed identities (account keys are disabled or kept out of app settings); other secrets live in Key Vault and are referenced by version. Logs pseudonymise user, session and chat ids with a keyed HMAC and record message lengths, not content.

## Known limitations

Accepted for now and documented so you can decide for your deployment:

- **Public endpoints.** Cosmos DB, Storage, Key Vault and Web PubSub use public network access (no VNet or private endpoints yet).
- **Keys that remain.** Azure AI Search uses a query key (in Key Vault); Web PubSub keeps access keys (needed to sign client tokens and verify upstream calls); the optional Dynamic Sessions fallback pool uses an ACR admin user.
- **JWT without issuer/audience.** Accepted with a warning; with a shared JWKS (Entra `common`, Firebase) always set both.
- **Off Azure App Service.** Some checks default to "on" only when the app detects it runs on Azure (`WEBSITE_SITE_NAME`). If you host it elsewhere, set `WEBPUBSUB_REQUIRE_UPSTREAM_SECRET=true` and never set `AUTH_ALLOW_INSECURE_USER_ID_HEADER`.
- **Model providers see conversation content.** Prompts, tool results and memories go to the configured model provider; user and session ids are sent only as pseudonyms.
- **Credentials inside sandboxes.** A credential without a `header` in its binding, or any credential on the Dynamic Sessions fallback, is an environment variable in the user's own sandbox. Code the model runs there can read it, and redaction only catches it verbatim, not encoded. Give such credentials least privilege, and keep sandbox egress disabled unless skills need it.
- **Storage roles.** The runtime identity is Storage Blob Data Owner on the Function App's storage account (the Functions host needs it), which also holds the deployment package.
- **Skill credentials entered in chat.** A user who pastes an API key so the agent can call `skill_setup` sends it through the model provider and the conversation history (7-day TTL). Tool results are scrubbed of stored credential values, but the message that carried the key is not. An API for setting credentials outside the conversation is planned.
- **Sandboxes** are isolated per user by Azure Container Apps Sandboxes; their egress policy is yours to set (see [docs/Sandbox.md](docs/Sandbox.md)).

The full list of behaviour changes made for security is in [docs/UPGRADING.md](docs/UPGRADING.md).

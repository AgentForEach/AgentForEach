#!/usr/bin/env bash
#
# Deploy a trial AgentForEach stack with one command and print a working
# login for the web chat sample.
#
# The trial signs users in with tokens this script makes (HS256 JWTs), not
# with a real identity provider. Set up real sign-in (docs/Identity.md)
# before you give it to real users.
#
# Usage:
#   ./scripts/quickstart.sh [stack]          # default stack name: trial
#   ./scripts/quickstart.sh [stack] --token  # print a fresh login for a stack you deployed
#
# Optional environment:
#   OPENAI_API_KEY               the model key (otherwise it asks)
#   QUICKSTART_OPENAI_BASE_URL   an OpenAI-compatible endpoint instead of OpenAI, e.g.
#                                Azure OpenAI: https://<resource>.openai.azure.com/openai/v1/
#   QUICKSTART_MODEL             the model, or with Azure OpenAI the deployment name
#   QUICKSTART_YES=1             don't ask before creating the Azure resources
#
# Remove everything it created:
#   cd infra && pulumi destroy --stack <stack>
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK="${1:-trial}"
CONFIG_NAME="agentforeach.quickstart.json"
TRIAL_USER="quickstart-user"
ISSUER="agentforeach-quickstart"
AUDIENCE="agentforeach"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
has_setting() { pulumi config get "$@" --stack "$STACK" >/dev/null 2>&1; }

mint_token() {
  QUICKSTART_JWT_SECRET="$1" node --input-type=module -e '
    import { createHmac } from "node:crypto";
    const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const [sub, iss, aud] = process.argv.slice(1);
    const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, iss, aud, iat: now, exp: now + 30 * 86400 })}`;
    const sig = createHmac("sha256", process.env.QUICKSTART_JWT_SECRET).update(body).digest("base64url");
    console.log(`${body}.${sig}`);
  ' "$TRIAL_USER" "$ISSUER" "$AUDIENCE"
}

print_login() {
  local secret host token
  secret="$(pulumi config get --path 'agentforeach:extraAppSettings.QUICKSTART_JWT_SECRET' --stack "$STACK")"
  host="$(pulumi stack output functionAppDefaultHostname --stack "$STACK")"
  token="$(mint_token "$secret")"
  cat <<EOF

Your agent is running.

  API URL:  https://${host}
  Token:    ${token}
            (user "${TRIAL_USER}", valid for 30 days; anyone with it can use this agent)

Talk to it:
  1. npx serve examples/web-chat
  2. Open the page, paste the API URL and the token, and say hi.

Or from the command line:
  curl -X POST https://${host}/api/chat -H "authorization: Bearer <token>" \\
       -H 'content-type: application/json' -d '{"message":"hi"}'
  (the reply streams over Web PubSub, so the web chat is the easier way to see it)

Next:
  - Before real users, set up sign-in: docs/Identity.md and docs/getting-started.md
  - A new token:    ./scripts/quickstart.sh ${STACK} --token
  - Remove it all:  cd infra && pulumi destroy --stack ${STACK}
EOF
}

# ----------------------------------------------------------------------------
# Tools and sign-ins
# ----------------------------------------------------------------------------
for tool in node npm az pulumi func openssl; do
  command -v "$tool" >/dev/null ||
    die "$tool is not installed. Open this repo in GitHub Codespaces or the dev container (.devcontainer), which have every tool, or see docs/getting-started.md."
done

if ! pulumi whoami >/dev/null 2>&1; then
  say "Pulumi keeps a record of what it deployed, so it can update or remove it later. Where should it keep it?"
  echo "  1) Pulumi Cloud: a free account; the record outlives this machine"
  echo "  2) A folder on this machine (~/.pulumi-state)"
  [[ -n "${CODESPACES:-}" ]] && echo "     (in Codespaces the folder is lost when the codespace is deleted)"
  read -rp "Choose 1 or 2 [1]: " choice
  if [[ "${choice:-1}" == "2" ]]; then
    mkdir -p "$HOME/.pulumi-state"
    pulumi login "file://$HOME/.pulumi-state"
  else
    pulumi login
  fi
fi
backend="$(pulumi whoami --json | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).url')"
if [[ "$backend" == file://* && -z "${PULUMI_CONFIG_PASSPHRASE:-}" ]]; then
  read -rsp "Passphrase that protects this stack's secrets (you'll need it again later): " PULUMI_CONFIG_PASSPHRASE
  echo
  export PULUMI_CONFIG_PASSPHRASE
fi

cd "$ROOT/infra"

if [[ "${2:-}" == "--token" ]]; then
  print_login
  exit 0
fi

if ! az account show >/dev/null 2>&1; then
  say "Signing in to Azure"
  if [[ -n "${CODESPACES:-}" ]]; then az login --use-device-code >/dev/null; else az login >/dev/null; fi
fi
say "Deploying to Azure subscription: $(az account show --query name -o tsv)"
echo "    (another one? az account set --subscription <name-or-id>, then run this again)"

[[ -d "$ROOT/node_modules" ]] || { say "Installing dependencies"; (cd "$ROOT" && npm ci); }

# ----------------------------------------------------------------------------
# Stack settings (anything already set is kept)
# ----------------------------------------------------------------------------
say "Configuring stack \"$STACK\""
pulumi stack select "$STACK" --create >/dev/null

if ! has_setting azure-native:location; then
  read -rp "Azure region [eastus]: " region
  pulumi config set azure-native:location "${region:-eastus}" --stack "$STACK"
fi
has_setting agentforeach:nameSuffix ||
  pulumi config set agentforeach:nameSuffix "$(openssl rand -hex 3)" --stack "$STACK"
if ! has_setting agentforeach:openaiApiKey; then
  key="${OPENAI_API_KEY:-}"
  if [[ -z "$key" ]]; then
    read -rsp "OpenAI API key (sk-...): " key
    echo
  fi
  [[ -n "$key" ]] || die "A model API key is needed (OpenAI, or Azure OpenAI with QUICKSTART_OPENAI_BASE_URL)."
  printf '%s' "$key" | pulumi config set --secret agentforeach:openaiApiKey --stack "$STACK"
fi
# The free Web PubSub tier (20 connections) costs nothing while you try it.
has_setting agentforeach:webPubSubSku ||
  pulumi config set agentforeach:webPubSubSku Free_F1 --stack "$STACK"

# Trial sign-in: a runtime config that trusts tokens signed with this secret.
if ! has_setting --path 'agentforeach:extraAppSettings.QUICKSTART_JWT_SECRET'; then
  openssl rand -hex 32 | tr -d '\n' |
    pulumi config set --secret --path 'agentforeach:extraAppSettings.QUICKSTART_JWT_SECRET' --stack "$STACK"
fi
pulumi config set --secret --path 'agentforeach:extraAppSettings.CONFIG_FILE_JSON' "$CONFIG_NAME" --stack "$STACK"

node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const [dir, name, iss, aud] = process.argv.slice(1);
  const config = JSON.parse(readFileSync(`${dir}/agentforeach.json`, "utf8"));
  config.auth = {
    ...config.auth,
    providers: [{ type: "jwt", enabled: true, algorithm: "HS256", secret: "$QUICKSTART_JWT_SECRET", issuer: iss, audience: aud, userIdClaim: "sub" }],
  };
  // The trial stack has no AI Search index.
  config.knowledge = { ...config.knowledge, enabled: false };
  // Only one model key: failing over to Anthropic would only add errors.
  config.llms.providers.anthropic = { ...config.llms.providers.anthropic, enabled: false };
  config.llms.failover = { ...config.llms.failover, enabled: false };
  const baseUrl = process.env.QUICKSTART_OPENAI_BASE_URL;
  const model = process.env.QUICKSTART_MODEL;
  if (baseUrl) {
    // Chat and embeddings both go to the endpoint (same key).
    config.llms.providers.openai = { ...config.llms.providers.openai, baseUrl };
    config.llms.embedding = { ...config.llms.embedding, baseUrl };
  }
  if (model) config.llms.providers.openai = { ...config.llms.providers.openai, defaultModel: model };
  writeFileSync(`${dir}/${name}`, JSON.stringify(config, null, 2) + "\n");
' "$ROOT/gateway/config" "$CONFIG_NAME" "$ISSUER" "$AUDIENCE"

# ----------------------------------------------------------------------------
# Deploy
# ----------------------------------------------------------------------------
say "Creating the Azure resources. Pulumi shows what it will create and asks before it does (about 5-10 minutes)."
pulumi up --stack "$STACK" ${QUICKSTART_YES:+--yes}

say "Deploying the gateway"
"$ROOT/scripts/deploy-gateway.sh" "$STACK"

print_login

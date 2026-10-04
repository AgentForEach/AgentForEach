#!/usr/bin/env bash
#
# Deploy a trial AgentForEach on Cloudflare Workers with one command and
# print a working login for the web chat sample. The Cloudflare twin of
# scripts/quickstart.sh: the same trial sign-in (scripts/lib/trial.mjs),
# deployed with scripts/deploy-cloudflare.sh.
#
# The trial signs users in with tokens this script makes (HS256 JWTs), not
# with a real identity provider. Set up real sign-in (docs/Identity.md)
# before you give it to real users. Sandboxes are off in the trial.
#
# Usage:
#   ./scripts/quickstart-cloudflare.sh [--name <worker>]   # default worker name: agentforeach
#   ./scripts/quickstart-cloudflare.sh --token             # print a fresh login for the trial you deployed
#
# You need a PostgreSQL database with pgvector (a free Neon or Supabase one works).
#
# Optional environment:
#   DATABASE_URL                 the database (otherwise it asks)
#   OPENAI_API_KEY               the model key (otherwise it asks)
#   QUICKSTART_OPENAI_BASE_URL   an OpenAI-compatible endpoint instead of OpenAI
#   QUICKSTART_MODEL             the model, or with Azure OpenAI the deployment name
#   DEPLOY_YES=1                 don't ask before creating the Cloudflare resources
#   and everything scripts/deploy-cloudflare.sh reads (CLOUDFLARE_ACCOUNT_ID, ...)
#
# Remove what it created: delete the Worker, the Hyperdrive config and the two
# R2 buckets in the Cloudflare dashboard (or with wrangler); see docs/Cloudflare.md.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_NAME="agentforeach.quickstart.json"
TRIAL_USER="quickstart-user"   # as in scripts/lib/trial.mjs
# The trial's signing secret, kept so --token can mint a new login later (git-ignored, owner-only).
SECRET_FILE="$ROOT/deploy/cloudflare/.quickstart.env"
STATE="$ROOT/deploy/cloudflare/.deploy-state.json"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

NAME="agentforeach"
TOKEN_ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="${2:?--name needs a value}"; shift 2 ;;
    --token) TOKEN_ONLY=1; shift ;;
    *) echo "usage: quickstart-cloudflare.sh [--name <worker>] | --token" >&2; exit 2 ;;
  esac
done

print_login() {
  [[ -f "$SECRET_FILE" && -f "$STATE" ]] || die "No trial deployed from this checkout yet. Run ./scripts/quickstart-cloudflare.sh"
  local url token
  # shellcheck disable=SC1090
  source "$SECRET_FILE"
  url="$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).publicBaseUrl' "$STATE")"
  token="$(QUICKSTART_JWT_SECRET="$QUICKSTART_JWT_SECRET" node "$ROOT/scripts/lib/trial.mjs" token)"
  cat <<EOF

Your agent is running.

  API URL:  ${url}
  Token:    ${token}
            (user "${TRIAL_USER}", valid for 30 days; anyone with it can use this agent)

Talk to it:
  1. npx serve examples/web-chat
  2. Open the page, paste the API URL and the token, and say hi.

Or from the command line:
  curl -X POST ${url}/api/chat -H "authorization: Bearer <token>" \\
       -H 'content-type: application/json' -d '{"message":"hi"}'
  (the reply streams over the WebSocket, so the web chat is the easier way to see it)

Next:
  - Before real users, set up sign-in: docs/Identity.md and docs/Cloudflare.md
  - A new token:   ./scripts/quickstart-cloudflare.sh --token
  - Redeploy:      ./scripts/quickstart-cloudflare.sh (keeps what exists)
EOF
}

if [[ -n "$TOKEN_ONLY" ]]; then
  print_login
  exit 0
fi

for tool in node npm psql openssl curl; do
  command -v "$tool" >/dev/null || die "$tool is not installed (see docs/Cloudflare.md)."
done

# ----------------------------------------------------------------------------
# The database and the model key
# ----------------------------------------------------------------------------
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "AgentForEach on Cloudflare stores its data in your PostgreSQL (with pgvector). A free Neon or"
  echo "Supabase database works. Use a connection string whose role can create tables."
  read -rsp "PostgreSQL connection string (postgres://...): " DATABASE_URL
  echo
  [[ "$DATABASE_URL" == postgres* ]] || die "That isn't a postgres:// connection string."
fi
export DATABASE_URL

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  read -rsp "OpenAI API key (sk-...): " OPENAI_API_KEY
  echo
  [[ -n "$OPENAI_API_KEY" ]] || die "A model API key is needed (OpenAI, or Azure OpenAI with QUICKSTART_OPENAI_BASE_URL)."
fi
export OPENAI_API_KEY

# ----------------------------------------------------------------------------
# Trial sign-in: a runtime config that trusts tokens signed with this secret
# ----------------------------------------------------------------------------
if [[ ! -f "$SECRET_FILE" ]]; then
  (umask 077 && printf 'QUICKSTART_JWT_SECRET=%s\n' "$(openssl rand -hex 32)" > "$SECRET_FILE")
fi
# shellcheck disable=SC1090
source "$SECRET_FILE"
export QUICKSTART_JWT_SECRET

say "Writing the trial config (gateway/config/$CONFIG_NAME)"
node "$ROOT/scripts/lib/trial.mjs" config "$ROOT/gateway/config" "$CONFIG_NAME" cloudflare

# ----------------------------------------------------------------------------
# Deploy (the secrets the config refers to, OPENAI_API_KEY and
# QUICKSTART_JWT_SECRET, go up with it)
# ----------------------------------------------------------------------------
# --update-secrets: the trial's secret and model key here always win, even over a Worker's older ones.
"$ROOT/scripts/deploy-cloudflare.sh" --name "$NAME" --config "$ROOT/gateway/config/$CONFIG_NAME" --update-secrets

print_login

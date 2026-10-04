#!/usr/bin/env bash
#
# Deploy AgentForEach to Cloudflare Workers (docs/Cloudflare.md): build,
# check the bundle, apply the database schema, create Hyperdrive and the R2
# buckets if they're missing, set the secrets the Worker doesn't have yet,
# deploy, and check the health endpoint. Safe to run again: it finds what
# exists and creates only what is missing.
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/deploy-cloudflare.sh [--name <worker>] [--config <agentforeach.json>] [--update-secrets]
#   ./scripts/deploy-cloudflare.sh --dry-run [--config <agentforeach.json>]   # build and bundle only; no account needed
#
# Environment:
#   DATABASE_URL            Your PostgreSQL with pgvector (required). The schema is applied with it, so
#                           the role must be able to create tables (and the vector extension, the first time).
#   HYPERDRIVE_DATABASE_URL What Hyperdrive connects with, if not DATABASE_URL: a role that only reads and writes rows.
#   CLOUDFLARE_ACCOUNT_ID   When wrangler sees more than one account.
#   PUBLIC_BASE_URL         The Worker's own https origin, if not https://<name>.<subdomain>.workers.dev.
#   R2_BUCKET_PREFIX        Prefix for the two buckets (default: none: skills, user-exports).
#   SKIP_SCHEMA=1           Don't apply infra/postgres-schema.sql (you manage the schema).
#   DEPLOY_YES=1            Don't ask: neither before creating anything, nor before moving an existing
#                           Hyperdrive config to the database DATABASE_URL names.
#
# Secrets the Worker doesn't have yet go up with the deploy:
#   REALTIME_SIGNING_KEY    generated if not set in this shell
#   OBJECT_STORE_S3_ACCESS_KEY_ID, OBJECT_STORE_S3_SECRET_ACCESS_KEY
#                           an R2 API token's S3 keys; asked for if not set in this shell
#   any "$NAME" your agentforeach.json refers to that is set in this shell (e.g. OPENAI_API_KEY)
#   With --update-secrets, every one of these set in this shell is uploaded, replacing the Worker's
#   (values can't be read back to compare): use it after rotating or correcting a secret.
#   CLOUDFLARE_IMAGES_API_TOKEN (and the account id) if set in this shell: an API token with Containers
#                           write permission, so sandboxes delete their snapshots (docs/Sandbox.md)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="$ROOT/deploy/cloudflare"
GENERATED="$DEPLOY_DIR/wrangler.generated.jsonc"
STATE="$DEPLOY_DIR/.deploy-state.json"
HELPER="$ROOT/scripts/lib/cloudflare.mjs"
WRANGLER="${WRANGLER:-npx wrangler}"

NAME="agentforeach"
AGENT_CONFIG=""
DRY_RUN=""
UPDATE_SECRETS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --update-secrets) UPDATE_SECRETS=1; shift ;;
    --name) NAME="${2:?--name needs a value}"; shift 2 ;;
    --config) AGENT_CONFIG="${2:?--config needs a path}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "usage: deploy-cloudflare.sh [--name <worker>] [--config <agentforeach.json>] [--update-secrets] [--dry-run]" >&2; exit 2 ;;
  esac
done
if [[ -n "$AGENT_CONFIG" ]]; then
  [[ -f "$AGENT_CONFIG" ]] || { echo "Error: no such file: $AGENT_CONFIG" >&2; exit 1; }
  AGENT_CONFIG="$(cd "$(dirname "$AGENT_CONFIG")" && pwd)/$(basename "$AGENT_CONFIG")"
fi

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

# Temporary files with secrets in them (the pgpass file, the secrets upload),
# removed however the script ends, Ctrl-C included.
tmpfiles=()
cleanup() { rm -f ${tmpfiles[@]+"${tmpfiles[@]}"}; }
trap cleanup EXIT
trap 'exit 130' INT TERM
cd "$ROOT"

# ----------------------------------------------------------------------------
# Tools
# ----------------------------------------------------------------------------
tools="node npm curl openssl"
[[ -z "$DRY_RUN" && -z "${SKIP_SCHEMA:-}" ]] && tools="$tools psql"
for tool in $tools; do
  command -v "$tool" >/dev/null || die "$tool is not installed (see docs/Cloudflare.md)."
done
[[ -n "$DRY_RUN" || -n "${DATABASE_URL:-}" ]] || die "Set DATABASE_URL to your PostgreSQL (with pgvector). See docs/Cloudflare.md."

# ----------------------------------------------------------------------------
# 1. Build, and check the Worker bundle has no Azure-only code
# ----------------------------------------------------------------------------
[[ -d "$ROOT/node_modules" ]] || { say "Installing dependencies"; npm ci; }
say "Building"
npm run build:platform >/dev/null
npm run build --workspace @agentforeach/gateway >/dev/null
say "Checking the Worker bundle"
npm run --silent check:bundle

config_args=()
[[ -n "$AGENT_CONFIG" ]] && config_args+=(--config-file "$AGENT_CONFIG")
# With sandboxes off, deploy without the sandbox container: no image to build and push.
if [[ "$(node "$HELPER" sandboxes-on "${AGENT_CONFIG:-$ROOT/gateway/config/agentforeach.json}")" != "yes" ]]; then
  config_args+=(--no-containers)
else
  # The image the config asks for (the browser: skills.sandbox.containers.browser).
  while IFS= read -r var; do [[ -n "$var" ]] && config_args+=(--image-var "$var"); done \
    < <(node "$HELPER" image-vars "${AGENT_CONFIG:-$ROOT/gateway/config/agentforeach.json}")
fi

if [[ -n "$DRY_RUN" ]]; then
  say "Dry run: bundling the Worker as it would be deployed (no account is used)"
  node scripts/cloudflare-config.mjs --name "$NAME" "${config_args[@]+"${config_args[@]}"}" \
    --hyperdrive-id 00000000000000000000000000000000 \
    --var OBJECT_STORE_S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com \
    --var PUBLIC_BASE_URL=https://example.workers.dev >/dev/null
  $WRANGLER deploy --config "$GENERATED" --dry-run --outdir "$ROOT/.deploy-staging-cloudflare"
  rm -rf "$ROOT/.deploy-staging-cloudflare"
  say "Dry run done. Nothing was created or deployed."
  exit 0
fi

# ----------------------------------------------------------------------------
# 2. Cloudflare account
# ----------------------------------------------------------------------------
if ! $WRANGLER whoami --json >/dev/null 2>&1; then
  say "Signing in to Cloudflare"
  $WRANGLER login
fi
ACCOUNT_ID="$(node "$HELPER" account)"
say "Deploying the Worker \"$NAME\" to Cloudflare account $ACCOUNT_ID"
echo "    (another one? CLOUDFLARE_ACCOUNT_ID=<id>, then run this again)"

# ----------------------------------------------------------------------------
# 3. Hyperdrive, the R2 buckets and the public URL. Moving an existing Hyperdrive to another
#    database asks first (unless DEPLOY_YES), before anything is written to either database
# ----------------------------------------------------------------------------
if [[ -z "${DEPLOY_YES:-}" && ! -f "$STATE" ]]; then
  echo
  echo "This creates, if they don't exist: a Hyperdrive config \"${HYPERDRIVE_NAME:-$NAME}\", the R2 buckets"
  echo "\"${R2_BUCKET_PREFIX:-}skills\" and \"${R2_BUCKET_PREFIX:-}user-exports\", and the Worker \"$NAME\" with its Durable Objects."
  read -rp "Continue? [y/N] " answer
  [[ "$answer" == [yY]* ]] || die "Stopped; nothing was created."
fi
say "Hyperdrive and R2"
ACCOUNT_ID="$ACCOUNT_ID" WORKER_NAME="$NAME" HYPERDRIVE_NAME="${HYPERDRIVE_NAME:-$NAME}" \
  DATABASE_URL="${HYPERDRIVE_DATABASE_URL:-$DATABASE_URL}" \
  node "$HELPER" ensure "$STATE"

# ----------------------------------------------------------------------------
# 4. Database schema (idempotent: every statement is IF NOT EXISTS), applied once Hyperdrive
#    points at the same database, so a refused move changes nothing
# ----------------------------------------------------------------------------
if [[ -z "${SKIP_SCHEMA:-}" ]]; then
  say "Applying infra/postgres-schema.sql"
  # The password never goes on psql's command line (visible to ps): it goes in a private pgpass
  # file, or, for a URL pgpass can't express (a socket), in psql's environment.
  pgpass_file="$(mktemp "${TMPDIR:-/tmp}/agentforeach-pgpass.XXXXXX")"
  tmpfiles+=("$pgpass_file")
  pg_plan="$(node "$HELPER" pgpass "$pgpass_file")" || exit 1
  pg_mode="${pg_plan%%$'\n'*}"
  pg_url="${pg_plan#*$'\n'}"
  if [[ "$pg_mode" == "file" ]]; then
    PGPASSFILE="$pgpass_file" PGOPTIONS="-c client_min_messages=warning" \
      psql "$pg_url" -v ON_ERROR_STOP=1 -q -f infra/postgres-schema.sql || die "Applying the schema failed (see above)."
  else
    PGPASSWORD="$(node "$HELPER" pg-password)" PGOPTIONS="-c client_min_messages=warning" \
      psql "$pg_url" -v ON_ERROR_STOP=1 -q -f infra/postgres-schema.sql || die "Applying the schema failed (see above)."
  fi
  rm -f "$pgpass_file"
fi

# ----------------------------------------------------------------------------
# 5. This deployment's wrangler config (git-ignored)
# ----------------------------------------------------------------------------
while IFS= read -r arg; do config_args+=("$arg"); done < <(node "$HELPER" config-args "$STATE")
node scripts/cloudflare-config.mjs "${config_args[@]}" >/dev/null
PUBLIC_URL="$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).publicBaseUrl' "$STATE")"

# ----------------------------------------------------------------------------
# 6. Secrets the Worker doesn't have yet
# ----------------------------------------------------------------------------
say "Secrets"
required="REALTIME_SIGNING_KEY OBJECT_STORE_S3_ACCESS_KEY_ID OBJECT_STORE_S3_SECRET_ACCESS_KEY"
# What the agentforeach.json refers to, except what the Worker gets another way and Azure-only settings.
refs="$(node "$HELPER" secret-refs "${AGENT_CONFIG:-$ROOT/gateway/config/agentforeach.json}" |
  grep -vE '^(DATABASE_URL|DATABASE_PROVIDER|WEBSOCKET_PROVIDER|OBJECT_STORE_.*|PUBLIC_BASE_URL|ACA_.*|COSMOS_.*|WEBPUBSUB_.*)$' || true)"
# Opt-in: with an API token that can write Containers, sandboxes delete their snapshots from the registry.
optional=""
if [[ -n "${CLOUDFLARE_IMAGES_API_TOKEN:-}" ]]; then
  optional="CLOUDFLARE_IMAGES_API_TOKEN CLOUDFLARE_ACCOUNT_ID"
  CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
  export CLOUDFLARE_ACCOUNT_ID
fi
# shellcheck disable=SC2086
plan="$(node "$HELPER" secrets-plan "$STATE" ${UPDATE_SECRETS:+--update} $required $refs $optional CLOUDFLARE_IMAGES_API_TOKEN)"

upload=()
unset_refs=()
kept=()
snapshot_deletion_off=""
# Read the plan first: the prompts below read this script's own stdin.
steps=()
while read -r step; do [[ -n "$step" ]] && steps+=("$step"); done <<< "$plan"
for step in ${steps[@]+"${steps[@]}"}; do
  action="${step%% *}"
  name="${step#* }"
  case "$action" in
    upload) upload+=("$name") ;;
    keep) kept+=("$name") ;;
    generate)
      printf -v "$name" '%s' "$(openssl rand -hex 32)"
      export "${name?}"
      upload+=("$name") ;;
    ask)
      if [[ "$name" == "OBJECT_STORE_S3_ACCESS_KEY_ID" ]]; then
        echo "    R2 needs an API token for its S3 API: dashboard, R2, Manage API tokens, Object Read & Write"
        echo "    on the two buckets. Paste its keys (they aren't shown):"
      fi
      read -rsp "    $name: " value
      echo
      [[ -n "$value" ]] || die "$name is needed: skills and file exports use R2 through it."
      printf -v "$name" '%s' "$value"
      export "${name?}"
      upload+=("$name") ;;
    unset)
      if [[ "$name" == "CLOUDFLARE_IMAGES_API_TOKEN" ]]; then snapshot_deletion_off=1; else unset_refs+=("$name"); fi ;;
  esac
done

secrets_file=""
if [[ ${#upload[@]} -gt 0 ]]; then
  secrets_file="$(mktemp "${TMPDIR:-/tmp}/agentforeach-secrets.XXXXXX")"
  tmpfiles+=("$secrets_file")
  chmod 600 "$secrets_file"
  for name in "${upload[@]}"; do export "${name?}"; done
  # JSON, so values with any characters survive; read from the environment, never the command line.
  SECRETS_FILE="$secrets_file" node -e '
    const secrets = Object.fromEntries(process.argv.slice(1).map((n) => [n, process.env[n]]));
    require("fs").writeFileSync(process.env.SECRETS_FILE, JSON.stringify(secrets));
  ' "${upload[@]}"
  echo "    Setting: ${upload[*]}"
else
  echo "    The Worker has every secret it needs."
fi
if [[ ${#kept[@]} -gt 0 ]]; then
  echo "    Kept the Worker's values (also set in this shell; to replace them, run again with --update-secrets):"
  echo "      ${kept[*]}"
fi
if [[ ${#unset_refs[@]} -gt 0 ]]; then
  echo "    Not set (fine if their features are off; to set one: export it and run this again):"
  echo "      ${unset_refs[*]}"
fi
if [[ -n "$snapshot_deletion_off" && "$(node "$HELPER" sandboxes-on "${AGENT_CONFIG:-$ROOT/gateway/config/agentforeach.json}")" == "yes" ]]; then
  echo
  echo "    Warning: sandbox snapshots aren't deleted. When a user's data is erased, their sandbox disk"
  echo "    (files, and any secrets written there) stays in Cloudflare's registry for up to 30 days."
  echo "    To delete snapshots with their sandboxes, create an account API token with Containers write"
  echo "    permission, then: export CLOUDFLARE_IMAGES_API_TOKEN=<token> and run this again."
fi

# ----------------------------------------------------------------------------
# 7. Deploy and check
# ----------------------------------------------------------------------------
say "Deploying"
$WRANGLER deploy --config "$GENERATED" ${secrets_file:+--secrets-file "$secrets_file"}

say "Checking $PUBLIC_URL/api/health"
for _ in $(seq 1 20); do
  if curl -fsS "$PUBLIC_URL/api/health" >/dev/null 2>&1; then
    echo "    healthy"
    break
  fi
  sleep 3
done
curl -fsS "$PUBLIC_URL/api/health" >/dev/null 2>&1 ||
  die "$PUBLIC_URL/api/health didn't answer after a minute. Check: npx wrangler tail --config deploy/cloudflare/wrangler.generated.jsonc"

cat <<EOF

AgentForEach is running at $PUBLIC_URL

  Health:   $PUBLIC_URL/api/health
  Logs:     npx wrangler tail --config deploy/cloudflare/wrangler.generated.jsonc
  Sign-in:  every API call returns 401 until auth.providers in your agentforeach.json trusts someone
            (docs/Cloudflare.md#let-users-sign-in)
  Again:    run this script again after changing agentforeach.json or upgrading: it applies the
            schema, keeps what exists and redeploys.
EOF

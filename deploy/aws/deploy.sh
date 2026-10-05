#!/usr/bin/env bash
#
# Deploy AgentForEach to AWS (docs/AWS.md). Builds and packages, then runs the steps in order:
#
#   1. foundation   (with --foundation) a VPC, RDS PostgreSQL and Cognito test users, for an
#                   account that has none; its outputs become the application stack's settings
#   2. bootstrap    the artifacts bucket and the sandbox image repository
#   3. image        builds and pushes the sandbox image, when sandboxes are on and the stack has
#                   no image yet (or with --new-image)
#   4. migrate      the network and the migrate function, which applies the database schema
#   5. application  everything else, then checks /api/health
#
# Nothing is created without asking: each Pulumi step shows its preview and waits for your yes
# (Pulumi's own prompt), and the image push asks first. Every Pulumi update applies the schema
# with the new release's migrate function before anything serves the new release. Safe to run
# again: that is how you upgrade.
#
# Usage:
#   deploy/aws/deploy.sh --stack <name> [--foundation <stack>] [--config <agentforeach.json>]
#                        [--prefix <prefix>] [--new-image]
#   deploy/aws/deploy.sh --dry-run    # build, package and run the mock tests; no AWS account used
#
# Environment:
#   AWS_REGION              region for new stacks (default: the AWS CLI's)
#   DEPLOY_YES=1            don't ask (pulumi up --yes)
#   IMAGE_PLATFORMS, SANDBOX_IMAGE_BROWSER   passed to build-image.sh
#
# The application stack's other settings (sign-in, model keys, your own VPC and database when
# there is no foundation) are its Pulumi config: see deploy/aws/infra/Pulumi.example.yaml.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_DIR="$ROOT/deploy/aws"
INFRA="$DEPLOY_DIR/infra"
FOUNDATION="$DEPLOY_DIR/foundation"
PACKAGE="$DEPLOY_DIR/.release/agentforeach-lambda.zip"

STACK=""
FOUNDATION_STACK=""
AGENT_CONFIG=""
PREFIX=""
NEW_IMAGE=""
DRY_RUN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack) STACK="${2:?--stack needs a name}"; shift 2 ;;
    --foundation) FOUNDATION_STACK="${2:?--foundation needs a stack name}"; shift 2 ;;
    --config) AGENT_CONFIG="${2:?--config needs a path}"; shift 2 ;;
    --prefix) PREFIX="${2:?--prefix needs a value}"; shift 2 ;;
    --new-image) NEW_IMAGE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "usage: deploy.sh --stack <name> [--foundation <stack>] [--config <agentforeach.json>] [--prefix <prefix>] [--new-image] | --dry-run" >&2; exit 2 ;;
  esac
done
if [[ -n "$AGENT_CONFIG" ]]; then
  [[ -f "$AGENT_CONFIG" ]] || { echo "Error: no such file: $AGENT_CONFIG" >&2; exit 1; }
  AGENT_CONFIG="$(cd "$(dirname "$AGENT_CONFIG")" && pwd)/$(basename "$AGENT_CONFIG")"
fi

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
confirm() {
  [[ -n "${DEPLOY_YES:-}" ]] && return 0
  read -rp "$1 [y/N] " answer
  [[ "$answer" == [yY]* ]] || die "Stopped. Nothing more was changed."
}

trap 'exit 130' INT TERM
cd "$ROOT"

# ----------------------------------------------------------------------------
# Tools, build and package (no account needed)
# ----------------------------------------------------------------------------
tools="node npm zip"
[[ -z "$DRY_RUN" ]] && tools="$tools pulumi aws curl"
for tool in $tools; do
  command -v "$tool" >/dev/null || die "$tool is not installed (see docs/AWS.md)."
done
[[ -n "$DRY_RUN" || -n "$STACK" ]] || die "Name the application stack: --stack <name> (see docs/AWS.md)."

[[ -d "$ROOT/node_modules" ]] || { say "Installing dependencies"; npm ci; }
say "Building and packaging"
"$DEPLOY_DIR/package.sh" "$PACKAGE"
npm run build --workspace @agentforeach/deploy-aws >/dev/null

if [[ -n "$DRY_RUN" ]]; then
  say "Testing the stacks against Pulumi's mocks"
  npm run --silent test:deploy:aws
  say "Dry run done. Nothing was created or deployed."
  exit 0
fi

pulumi whoami >/dev/null 2>&1 || die "Sign in to a Pulumi backend first: pulumi login (or pulumi login --local)."
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" || die "The AWS CLI has no credentials (aws configure, or aws sso login)."
REGION="${AWS_REGION:-$(aws configure get region || true)}"

app() { pulumi -C "$INFRA" "$@" --stack "$STACK"; }
foundation() { pulumi -C "$FOUNDATION" "$@" --stack "$FOUNDATION_STACK"; }
up() {
  local dir="$1" stack="$2"
  if [[ -n "${DEPLOY_YES:-}" ]]; then
    pulumi -C "$dir" up --yes --stack "$stack"
  else
    pulumi -C "$dir" up --diff --stack "$stack"
  fi
}
output() { app stack output "$1" 2>/dev/null || true; }
setting() { app config get "$1" 2>/dev/null || true; }

# Selects a stack, creating it (in REGION) if it doesn't exist.
select_stack() {
  local dir="$1" stack="$2"
  if ! pulumi -C "$dir" stack select "$stack" >/dev/null 2>&1; then
    [[ -n "$REGION" ]] || die "Set AWS_REGION for the new stack $stack."
    pulumi -C "$dir" stack init "$stack" >/dev/null
    pulumi -C "$dir" config set aws:region "$REGION" --stack "$stack"
  fi
}

say "AWS account $ACCOUNT, application stack \"$STACK\""
echo "    (another account? set AWS_PROFILE, then run this again)"

# ----------------------------------------------------------------------------
# 1. Foundation (optional)
# ----------------------------------------------------------------------------
if [[ -n "$FOUNDATION_STACK" ]]; then
  say "Foundation \"$FOUNDATION_STACK\": a VPC with one NAT gateway, RDS PostgreSQL and a Cognito pool"
  echo "    Billable while it exists (the database, the NAT gateway and its public address)."
  select_stack "$FOUNDATION" "$FOUNDATION_STACK"
  npm run build --workspace @agentforeach/deploy-aws >/dev/null
  up "$FOUNDATION" "$FOUNDATION_STACK"
  # Its outputs are the application stack's network, database and sign-in settings.
  select_stack "$INFRA" "$STACK"
  foundation_outputs="$(foundation stack output --json)"
  while IFS=$'\t' read -r key value; do
    [[ -n "$key" ]] && app config set --plaintext --path "$key" "$value" >/dev/null
  done < <(node -e '
    const o = JSON.parse(process.argv[1]);
    const rows = [["vpcId", o.vpcId], ["databaseSecurityGroupId", o.databaseSecurityGroupId],
      ["databaseSecretArn", o.databaseSecretArn], ["databaseSecretJsonKey", "DATABASE_URL"],
      ["migrationSecretArn", o.migrationSecretArn], ["jwtIssuer", o.jwtIssuer],
      ["jwtAudience", o.jwtAudience], ["jwtJwksUri", o.jwtJwksUri],
      ...o.privateSubnetIds.map((id, i) => [`privateSubnetIds[${i}]`, id])];
    for (const [k, v] of rows) console.log(`${k}\t${v}`);
  ' "$foundation_outputs")
  echo "    The application stack now uses the foundation's network, database and Cognito pool."
fi

# ----------------------------------------------------------------------------
# 2. Bootstrap
# ----------------------------------------------------------------------------
select_stack "$INFRA" "$STACK"
[[ -n "$PREFIX" ]] && app config set prefix "$PREFIX" >/dev/null
[[ -n "$AGENT_CONFIG" ]] && app config set applicationConfigPath "$AGENT_CONFIG" >/dev/null
app config set artifactPath "$PACKAGE" >/dev/null
PHASE="$(setting phase)"
SANDBOXES="$(setting sandboxEnabled)"
SANDBOXES="${SANDBOXES:-true}"

if [[ -z "$PHASE" || "$PHASE" == "bootstrap" ]]; then
  say "Bootstrap: the artifacts bucket$([[ "$SANDBOXES" == "true" ]] && echo " and the sandbox image repository")"
  app config set phase bootstrap >/dev/null
  up "$INFRA" "$STACK"
  PHASE="bootstrap"
fi

# ----------------------------------------------------------------------------
# 3. Sandbox image
# ----------------------------------------------------------------------------
if [[ "$SANDBOXES" == "true" && ( -z "$(setting sandboxImageDigest)" || -n "$NEW_IMAGE" ) ]]; then
  command -v docker >/dev/null || die "docker is not installed: the sandbox image needs it (or set sandboxEnabled false)."
  REPOSITORY="$(output sandboxRepository)"
  [[ -n "$REPOSITORY" ]] || die "The stack has no sandbox repository yet."
  TAG="r$(date -u +%Y%m%d%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
  [[ "$(setting browserEnabled)" == "true" ]] && export SANDBOX_IMAGE_BROWSER=1
  say "Sandbox image: $REPOSITORY:$TAG (${IMAGE_PLATFORMS:-linux/arm64}$([[ -n "${SANDBOX_IMAGE_BROWSER:-}" ]] && echo ", with the browser"))"
  echo "    A new image means a new runtime version and endpoint once deployed; AgentCore limits endpoints per runtime."
  confirm "Build and push it?"
  DIGEST="$("$DEPLOY_DIR/build-image.sh" "$REPOSITORY" "$TAG" | tail -n 1)"
  [[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || die "build-image.sh didn't print a digest (got: $DIGEST)."
  app config set sandboxImageDigest "$DIGEST" >/dev/null
  echo "    Pushed $DIGEST"
fi

# ----------------------------------------------------------------------------
# 4 and 5. Migrate, then the application. Each update runs the new migrate version (the schema)
#    before API Gateway, the schedule and AppSync's authorizer switch to the new versions.
# ----------------------------------------------------------------------------
if [[ "$PHASE" != "application" ]]; then
  say "Migrate: the functions' network access to your database, and the schema (infra/postgres-schema.sql)"
  app config set phase migrate >/dev/null
  up "$INFRA" "$STACK"
  say "Application: the functions, API Gateway, AppSync Events, the schedule$([[ "$SANDBOXES" == "true" ]] && echo " and the sandbox runtime")"
  app config set phase application >/dev/null
  up "$INFRA" "$STACK"
else
  say "Upgrade: the new release (the schema first, then the switch)"
  up "$INFRA" "$STACK"
fi

API_URL="$(output apiUrl)"
[[ -n "$API_URL" ]] || die "The stack has no API URL."
say "Checking $API_URL/api/health"
for _ in $(seq 1 20); do
  if curl -fsS "$API_URL/api/health" >/dev/null 2>&1; then
    echo "    healthy"
    break
  fi
  sleep 3
done
curl -fsS "$API_URL/api/health" >/dev/null 2>&1 ||
  die "$API_URL/api/health didn't answer after a minute. Check: aws logs tail /aws/lambda/$(setting prefix)-http --follow"

cat <<EOF

AgentForEach is running at $API_URL

  Health:    $API_URL/api/health
  Realtime:  $(output realtimeUrl)
  Logs:      aws logs tail /aws/lambda/$(setting prefix)-http --follow
  Sign-in:   the jwt provider with the stack's jwtIssuer, jwtAudience and jwtJwksUri
             (docs/AWS.md#let-users-sign-in)
  Again:     run this script again after changing agentforeach.json or upgrading: it packages,
             applies the schema and deploys the release.
EOF

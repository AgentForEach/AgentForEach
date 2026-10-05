#!/usr/bin/env bash
#
# Take an AgentForEach deployment off AWS (docs/AWS.md#teardown). In order:
#
#   1. Shows the account, region and stacks, and asks before anything else.
#   2. Pauses: every function's reserved concurrency goes to 0 (no more requests, ticks or
#      durable steps), so nothing starts while the rest goes.
#   3. Exports each stack's state to deploy/aws/.teardown/ (secrets stay encrypted), for recovery.
#   4. Previews the destroy, then destroys the application stack.
#      Without --delete-data, protected resources (buckets, the image repository, secrets, the log
#      key) are left in place and in the stack. With it, you type the stack's name, and their
#      protection is removed first; retainOnDelete resources still need the commands below.
#   5. Lists what outlives a destroy (retainOnDelete: buckets and their versions, release
#      manifests, images, sandbox endpoints and security groups, log groups, secrets, the KMS key),
#      with the commands that remove each. It runs none of them: check, then run what you approve.
#   6. With --foundation, the same for the foundation, after the application. RDS and Cognito have
#      their own deletion protection, and AgentCore's network interfaces can hold the VPC for up to
#      eight hours after the runtime is gone.
#
# Never use `pulumi up` during a teardown: it can bring back what was paused or removed.
#
# Usage:
#   deploy/aws/teardown.sh --stack <name> [--foundation <stack>] [--delete-data]
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_DIR="$ROOT/deploy/aws"
INFRA="$DEPLOY_DIR/infra"
FOUNDATION="$DEPLOY_DIR/foundation"
EXPORTS="$DEPLOY_DIR/.teardown"

STACK=""
FOUNDATION_STACK=""
DELETE_DATA=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack) STACK="${2:?--stack needs a name}"; shift 2 ;;
    --foundation) FOUNDATION_STACK="${2:?--foundation needs a stack name}"; shift 2 ;;
    --delete-data) DELETE_DATA=1; shift ;;
    *) echo "usage: teardown.sh --stack <name> [--foundation <stack>] [--delete-data]" >&2; exit 2 ;;
  esac
done
[[ -n "$STACK" ]] || { echo "usage: teardown.sh --stack <name> [--foundation <stack>] [--delete-data]" >&2; exit 2; }

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
confirm() {
  read -rp "$1 [y/N] " answer
  [[ "$answer" == [yY]* ]] || die "Stopped. Nothing more was changed."
}
for tool in node pulumi aws; do command -v "$tool" >/dev/null || die "$tool is not installed."; done
pulumi whoami >/dev/null 2>&1 || die "Sign in to the stacks' Pulumi backend first (pulumi login)."

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" || die "The AWS CLI has no credentials."
pulumi -C "$INFRA" stack select "$STACK" >/dev/null 2>&1 || die "No application stack \"$STACK\" in this Pulumi backend."
REGION="$(pulumi -C "$INFRA" config get aws:region --stack "$STACK")"
PREFIX="$(pulumi -C "$INFRA" config get prefix --stack "$STACK" 2>/dev/null || echo "afe-$STACK")"

# ----------------------------------------------------------------------------
# 1. What is about to go
# ----------------------------------------------------------------------------
say "Teardown of AWS account $ACCOUNT, region $REGION"
echo "    Application stack: $STACK (resources named $PREFIX-*)"
[[ -n "$FOUNDATION_STACK" ]] && echo "    Foundation stack:  $FOUNDATION_STACK (destroyed after the application)"
if [[ -n "$DELETE_DATA" ]]; then
  echo "    --delete-data: data resources are unprotected; retained buckets, images, secrets and"
  echo "    the log key still need the removal commands printed below."
else
  echo "    Protected data is kept. Add --delete-data only after deciding to lose it."
fi
echo "    Only destroy a foundation made for this deployment, never shared network or database."
confirm "Is this the right account, region and stack?"

# ----------------------------------------------------------------------------
# 2. Pause
# ----------------------------------------------------------------------------
say "Pausing: reserved concurrency 0 on every function"
for kind in http schedule durable realtime-authorizer migrate conformance; do
  name="$PREFIX-$kind"
  if aws lambda get-function --function-name "$name" --region "$REGION" >/dev/null 2>&1; then
    aws lambda put-function-concurrency --function-name "$name" --reserved-concurrent-executions 0 --region "$REGION" >/dev/null
    echo "    $name paused"
  fi
done
echo "    Running durable executions and sandbox sessions end on their own (sessions within 15 minutes"
echo "    idle). Pending HITL forms and scheduled jobs are not run."

# ----------------------------------------------------------------------------
# 3. Export the state
# ----------------------------------------------------------------------------
mkdir -p "$EXPORTS"
chmod 700 "$EXPORTS"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
app_state="$EXPORTS/$STACK-$stamp.json"
pulumi -C "$INFRA" stack export --stack "$STACK" --file "$app_state"
chmod 600 "$app_state"
echo "    State exported to $app_state (keep it out of git; secrets in it stay encrypted)"

# ----------------------------------------------------------------------------
# 4. Destroy, with the data or without
# ----------------------------------------------------------------------------
destroy() {
  local dir="$1" stack="$2"
  say "Preview: destroying \"$stack\""
  pulumi -C "$dir" destroy --preview-only --stack "$stack" || true
  if [[ -n "$DELETE_DATA" ]]; then
    read -rp "Type the stack's name ($stack) to destroy it with its data: " typed
    [[ "$typed" == "$stack" ]] || die "Stopped. Nothing more was changed."
    pulumi -C "$dir" state unprotect --all --yes --stack "$stack"
    pulumi -C "$dir" destroy --stack "$stack"
  else
    confirm "Destroy \"$stack\", keeping its protected data?"
    pulumi -C "$dir" destroy --exclude-protected --stack "$stack"
  fi
}
destroy "$INFRA" "$STACK"

# ----------------------------------------------------------------------------
# 5. What outlives the destroy, and how to remove it
# ----------------------------------------------------------------------------
say "Left in the account (retainOnDelete, or kept as data), with the commands to remove each"
node - "$app_state" "$REGION" <<'JS'
const fs = require("fs");
const [file, region] = process.argv.slice(2);
const resources = JSON.parse(fs.readFileSync(file, "utf8")).deployment?.resources ?? [];
const r = `--region ${region}`;
const kept = resources.filter((res) => res.retainOnDelete || res.protect);
const lines = [];
for (const res of kept) {
  const o = res.outputs ?? {};
  switch (res.type) {
    case "aws:s3/bucket:Bucket":
      lines.push(`# S3 bucket ${o.bucket}: every object version, delete marker and unfinished upload first`,
        `aws s3api list-object-versions --bucket ${o.bucket} ${r}   # then delete-objects with them`,
        `aws s3 rb s3://${o.bucket} ${r}`);
      break;
    case "aws:ecr/repository:Repository":
      lines.push(`# Image repository (after the sandbox runtime is gone)`, `aws ecr delete-repository --repository-name ${o.name} --force ${r}`);
      break;
    case "aws:bedrock/agentcoreAgentRuntimeEndpoint:AgentcoreAgentRuntimeEndpoint":
      lines.push(`# Sandbox endpoint ${o.name}`, `aws bedrock-agentcore-control delete-agent-runtime-endpoint --agent-runtime-id ${o.agentRuntimeId} --endpoint-name ${o.name} ${r}`);
      break;
    case "aws:ec2/securityGroup:SecurityGroup":
      lines.push(`# Security group ${o.id}: once AgentCore's network interfaces have detached (up to 8 hours)`, `aws ec2 delete-security-group --group-id ${o.id} ${r}`);
      break;
    case "aws:cloudwatch/logGroup:LogGroup":
      lines.push(`aws logs delete-log-group --log-group-name '${o.name}' ${r}`);
      break;
    case "aws:secretsmanager/secret:Secret":
      lines.push(`aws secretsmanager delete-secret --secret-id '${o.arn}' --recovery-window-in-days 7 ${r}`);
      break;
    case "aws:kms/key:Key":
      lines.push(`# Log key: after the log groups`, `aws kms schedule-key-deletion --key-id ${o.id} --pending-window-in-days 7 ${r}`);
      break;
    case "aws:s3/bucketObjectv2:BucketObjectv2":
      break; // Release packages and manifests: they go with their bucket.
    default:
      lines.push(`# ${res.type} ${o.id ?? res.urn}`);
  }
}
console.log(lines.length ? lines.map((l) => `    ${l}`).join("\n") : "    Nothing.");
JS
echo
echo "    Old Lambda versions, network interfaces and logs can take a while to go. Run"
echo "    'pulumi -C deploy/aws/infra refresh --stack $STACK' after removing anything by hand."

# ----------------------------------------------------------------------------
# 6. The foundation
# ----------------------------------------------------------------------------
if [[ -n "$FOUNDATION_STACK" ]]; then
  pulumi -C "$FOUNDATION" stack select "$FOUNDATION_STACK" >/dev/null 2>&1 || die "No foundation stack \"$FOUNDATION_STACK\"."
  foundation_state="$EXPORTS/$FOUNDATION_STACK-$stamp.json"
  pulumi -C "$FOUNDATION" stack export --stack "$FOUNDATION_STACK" --file "$foundation_state"
  chmod 600 "$foundation_state"
  say "Foundation \"$FOUNDATION_STACK\" (state exported to $foundation_state)"
  if [[ -z "$DELETE_DATA" ]]; then
    echo "    The database, its secret and the Cognito pool are data: without --delete-data they stay."
  else
    database="$(pulumi -C "$FOUNDATION" stack output databaseHost --stack "$FOUNDATION_STACK" 2>/dev/null | cut -d. -f1)"
    pool="$(pulumi -C "$FOUNDATION" stack output userPoolId --stack "$FOUNDATION_STACK" 2>/dev/null || true)"
    echo "    RDS and Cognito refuse deletion until their own protection is off. To turn it off:"
    echo "      aws rds modify-db-instance --db-instance-identifier $database --no-deletion-protection --apply-immediately --region $REGION"
    echo "      aws cognito-idp update-user-pool --user-pool-id $pool --deletion-protection INACTIVE --region $REGION"
    echo "    The database gets a final snapshot; delete it, and any retained automated backups, only if you"
    echo "    mean to lose the data."
    confirm "Turn both off now?"
    aws rds modify-db-instance --db-instance-identifier "$database" --no-deletion-protection --apply-immediately --region "$REGION" >/dev/null
    [[ -n "$pool" ]] && aws cognito-idp update-user-pool --user-pool-id "$pool" --deletion-protection INACTIVE --region "$REGION" >/dev/null
  fi
  destroy "$FOUNDATION" "$FOUNDATION_STACK"
  echo
  echo "    If the VPC or its subnets didn't go, AgentCore's network interfaces are still attached: wait"
  echo "    for AWS to release them (up to 8 hours), delete leftover security groups, then run this again."
  echo "    Never force-detach service-owned interfaces."
fi

cat <<EOF

Done. Billing lags deletion: charges for the last hours can still arrive. Secrets and KMS keys
scheduled for deletion cost nothing during their waiting period; retained snapshots and buckets do.
EOF

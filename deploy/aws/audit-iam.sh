#!/usr/bin/env bash
#
# Regenerate the IAM baseline (iam-sdk-baseline.json) from the AWS pack's SDK calls, with IAM
# Policy Autopilot. An audit aid only: the roles get infra/policies.ts, which is narrower. The
# generated policy is never attached to anything.
#
# Usage: deploy/aws/audit-iam.sh [--region <region> --account <account>] > deploy/aws/iam-sdk-baseline.json
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
files=()
while IFS= read -r file; do files+=("$file"); done < <(find "$ROOT/packages/platform-aws/src" -name '*.ts' ! -name '*.test.ts' | sort)
files+=("$ROOT/gateway/llms/providers/bedrock.ts" "$ROOT/gateway/memory/embeddings.ts")
DISABLE_IAM_POLICY_AUTOPILOT_TELEMETRY=true uvx iam-policy-autopilot@latest generate-policies "${files[@]}" --pretty "$@"

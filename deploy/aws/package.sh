#!/usr/bin/env bash
#
# Build the AgentForEach Lambda package (docs/AWS.md): one zip for every function. It holds the
# Lambda entry, deploy/aws/lambda.ts bundled with everything it imports (`npm run build:aws`), the
# default agentforeach.json and the database schema (for the migrate handler). No node_modules:
# the bundle's only external is the optional pg-native. Creates no cloud resources.
#
# Usage: deploy/aws/package.sh [/path/to/agentforeach-lambda.zip]
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="${1:-$ROOT/deploy/aws/.release/agentforeach-lambda.zip}"
case "$OUTPUT" in /*) ;; *) OUTPUT="$PWD/$OUTPUT" ;; esac
# The bundle, at the same path inside the package. It must match LAMBDA_HANDLER_MODULE in infra/settings.ts.
ENTRY="dist/deploy/aws/lambda.mjs"

die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
for tool in node npm zip; do command -v "$tool" >/dev/null || die "$tool is not installed."; done

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/agentforeach-lambda.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
cd "$ROOT"

# The bundle resolves workspace exports from dist; build them on a fresh checkout too.
npm run build >/dev/null
npm run build:aws >/dev/null
[[ -f "$ENTRY" ]] || die "npm run build:aws didn't write $ENTRY."

mkdir -p "$STAGING/$(dirname "$ENTRY")" "$STAGING/dist/gateway/config" "$STAGING/infra"
cp "$(dirname "$ENTRY")"/lambda.mjs* "$STAGING/$(dirname "$ENTRY")/"
cp gateway/config/agentforeach.json "$STAGING/dist/gateway/config/"
cp infra/postgres-schema.sql "$STAGING/infra/"

mkdir -p "$(dirname "$OUTPUT")"
rm -f "$OUTPUT"
(cd "$STAGING" && zip -qr "$OUTPUT" dist infra)

echo "Created $OUTPUT ($(du -k "$OUTPUT" | cut -f1) KB; about $(($(du -sk "$STAGING" | cut -f1) / 1024)) MB unpacked, Lambda allows 250 MB)"
echo "Handlers: ${ENTRY%.mjs}.{http,schedule,durable,realtimeAuthorizer,migrate,conformance}"

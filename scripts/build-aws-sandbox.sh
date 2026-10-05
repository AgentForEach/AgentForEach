#!/usr/bin/env bash
# Documented compatibility entry for the shared AgentCore image builder.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/deploy/aws/build-image.sh" "$@"

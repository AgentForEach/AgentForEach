#!/usr/bin/env bash
# Smoke-test a built sandbox image (gateway/sandbox-container/Dockerfile) the
# way Bedrock AgentCore Runtime calls it: GET /ping, then POST /invocations
# envelopes with the token, and a bounded /archive. With BROWSER=1, also
# checks that Chromium is where the driver looks for it on this architecture.
#
#   scripts/smoke-sandbox-image.sh IMAGE [PLATFORM]   (PLATFORM e.g. linux/arm64)
#   BROWSER=1 scripts/smoke-sandbox-image.sh agentforeach-sandbox:browser
set -euo pipefail

IMAGE="${1:?Usage: smoke-sandbox-image.sh IMAGE [PLATFORM]}"
PLATFORM="${2:-}"
TOKEN="smoke-$(date +%s)-$RANDOM$RANDOM"
NAME="afe-sandbox-smoke-$$"
PORT="${SMOKE_PORT:-18080}"

docker run -d --rm --name "$NAME" ${PLATFORM:+--platform "$PLATFORM"} -p "127.0.0.1:$PORT:8080" \
  -e SANDBOX_SERVER_TOKEN="$TOKEN" -e SANDBOX_ARCHIVE_MAX_BYTES=1048576 -e SANDBOX_ARCHIVE_MAX_FILES=100 \
  "$IMAGE" > /dev/null
trap 'docker logs "$NAME" 2>&1 | tail -20; docker rm -f "$NAME" > /dev/null 2>&1 || true' EXIT

for _ in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$PORT/ping" > /dev/null && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/ping" | grep -q '"Healthy"'

invoke() {
  curl -s -o /dev/stdout -w '\n%{http_code}' -H 'content-type: application/json' \
    --data "$1" "http://127.0.0.1:$PORT/invocations"
}
expect() {
  case "$2" in
    *"$1"*) ;;
    *) echo "expected $1 in: $2" >&2; exit 1 ;;
  esac
}

wrong="$(invoke '{"token":"wrong","path":"/exec","body":{"command":"id"}}')"
expect '401' "$wrong"
check='set -e; uname -m; node --version; python3 --version'
if [ "${BROWSER:-0}" = "1" ]; then
  check="$check; ls -d /opt/ms-playwright/chromium-*/chrome-linux*/chrome; command -v afe-browser Xvfb certutil"
fi
out="$(invoke "{\"token\":\"$TOKEN\",\"path\":\"/exec\",\"method\":\"POST\",\"body\":{\"command\":\"$check\"}}")"
echo "$out"
expect '"exitCode":0' "$out"

invoke "{\"token\":\"$TOKEN\",\"path\":\"/files/write\",\"method\":\"POST\",\"body\":{\"filename\":\"kept.txt\",\"content\":\"kept\"}}" > /dev/null
archive="$(invoke "{\"token\":\"$TOKEN\",\"path\":\"/archive\",\"method\":\"GET\"}")"
expect '"status":200' "$archive"
expect '"archive":"' "$archive"
over="$(invoke "{\"token\":\"$TOKEN\",\"path\":\"/exec\",\"method\":\"POST\",\"body\":{\"command\":\"head -c 2000000 /dev/zero > big.bin\"}}")"
expect '"exitCode":0' "$over"
refused="$(invoke "{\"token\":\"$TOKEN\",\"path\":\"/archive\",\"method\":\"GET\"}")"
expect '"code":"archive_limit"' "$refused"
if [ "${BROWSER:-0}" = "1" ]; then
  # Start the real driver too: an installed Chromium alone doesn't prove its bundled relay imports work.
  browser="$(invoke "{\"token\":\"$TOKEN\",\"path\":\"/exec\",\"body\":{\"command\":\"afe-browser status\"}}")"
  expect '"exitCode":0' "$browser"
fi
echo "sandbox image OK: $IMAGE ${PLATFORM}"

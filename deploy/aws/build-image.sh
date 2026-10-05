#!/usr/bin/env bash
#
# Build the shared sandbox image (gateway/sandbox-container/Dockerfile) and push it to the
# stack's ECR repository, then print its digest (the stack's sandboxImageDigest). AgentCore
# Runtime uses a single linux/arm64 image, not a multi-architecture index.
#
# Usage: deploy/aws/build-image.sh <ecr-repository-url> <new-tag>
#
# Environment:
#   IMAGE_PLATFORMS         default linux/arm64
#   SANDBOX_IMAGE_BROWSER=1 include Chromium and the browser driver (browserEnabled)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPOSITORY="${1:?Usage: build-image.sh <ecr-repository-url> <new-tag>}"
TAG="${2:?Give the image a new tag (tags in the repository are immutable)}"
PLATFORMS="${IMAGE_PLATFORMS:-linux/arm64}"

die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
for tool in docker aws; do command -v "$tool" >/dev/null || die "$tool is not installed."; done
[[ "$REPOSITORY" =~ ^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com/([a-z0-9/_.-]+)$ ]] ||
  die "Expected a private ECR repository URL (<account>.dkr.ecr.<region>.amazonaws.com/<name>)."
REGION="${BASH_REMATCH[2]}"
NAME="${BASH_REMATCH[3]}"
[[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "Invalid image tag: $TAG"
[[ "$PLATFORMS" == linux/arm64 ]] || die "AgentCore Runtime needs IMAGE_PLATFORMS=linux/arm64 (a single-architecture image)."

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${REPOSITORY%%/*}" >/dev/null
docker buildx build \
  --platform "$PLATFORMS" \
  --build-arg SANDBOX_IMAGE_BROWSER="${SANDBOX_IMAGE_BROWSER:-0}" \
  --provenance=false \
  -f "$ROOT/gateway/sandbox-container/Dockerfile" \
  -t "$REPOSITORY:$TAG" \
  --push \
  "$ROOT/gateway/sandbox-container" >&2
aws ecr describe-images --region "$REGION" --repository-name "$NAME" --image-ids "imageTag=$TAG" \
  --query 'imageDetails[0].imageDigest' --output text

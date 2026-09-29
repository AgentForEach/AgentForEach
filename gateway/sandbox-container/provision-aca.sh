#!/usr/bin/env bash
# =============================================================================
# AgentForEach Sandbox — provisioning for an ACA Sandboxes disk image
#
# Run inside a build sandbox started from the public "ubuntu" image (with
# egress open) by scripts/build-aca-sandbox-image.mjs, which then commits the
# sandbox to a private disk image. The Dockerfile in this folder is for the
# Dynamic Sessions CustomContainer fallback; this script installs the same
# core tooling without the HTTP exec server, which ACA Sandboxes don't need.
#
# Set SANDBOX_IMAGE_FULL=1 to add Java, PHP, Ruby and Go as in the Dockerfile.
# =============================================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  bash curl wget git ca-certificates gnupg \
  gcc g++ make cmake \
  python3 python3-pip python3-venv \
  nodejs npm \
  jq unzip zip tar gzip bzip2 xz-utils \
  procps lsof net-tools dnsutils \
  > /dev/null

if [ "${SANDBOX_IMAGE_FULL:-0}" = "1" ]; then
  apt-get install -y -qq --no-install-recommends \
    default-jdk-headless php-cli ruby golang-go > /dev/null
fi

# pip refuses system installs on recent Debian/Ubuntu (PEP 668). Sandboxes are
# single-tenant throwaway VMs, so let `pip install` work as the tools expect.
mkdir -p /etc/pip
printf '[global]\nbreak-system-packages = true\n' > /etc/pip.conf

mkdir -p /mnt/data
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /root/.cache

echo "--- agentforeach image"
for b in bash python3 pip3 node npm git jq curl unzip zip gcc make; do
  printf '%s=%s\n' "$b" "$(command -v "$b" || echo MISSING)"
done
python3 --version
node --version

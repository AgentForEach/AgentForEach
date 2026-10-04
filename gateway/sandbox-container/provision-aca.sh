#!/usr/bin/env bash
# =============================================================================
# AgentForEach Sandbox — provisioning for the sandbox image, on every cloud
#
# One script, two ways to build the same image:
#   - ACA Sandboxes: scripts/build-aca-sandbox-image.mjs runs it inside a build
#     sandbox started from the public "ubuntu" image (with egress open), then
#     commits the sandbox to a private disk image.
#   - Containers (Dynamic Sessions custom containers, Cloudflare Containers,
#     Docker): the Dockerfile in this folder runs it on ubuntu:24.04 and adds
#     the sandbox HTTP server (server.mjs), which ACA Sandboxes don't need.
#
# Set SANDBOX_IMAGE_FULL=1 to add Java, PHP, Ruby and Go as in the Dockerfile.
# Set SANDBOX_IMAGE_BROWSER=1 to add Chromium, Xvfb and the afe-browser driver
# (docs/Browser.md); the build script uploads the driver to $BROWSER_SRC first.
# =============================================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  bash curl wget git ca-certificates gnupg \
  gcc g++ make cmake \
  python3 python3-pip python3-venv \
  jq unzip zip tar gzip bzip2 xz-utils \
  procps lsof net-tools dnsutils \
  > /dev/null

# Node.js 22 (with npm) from NodeSource: the distribution's own is older.
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null
apt-get install -y -qq --no-install-recommends nodejs > /dev/null

if [ "${SANDBOX_IMAGE_FULL:-0}" = "1" ]; then
  apt-get install -y -qq --no-install-recommends \
    default-jdk-headless php-cli ruby golang-go > /dev/null
fi

# pip refuses system installs on recent Debian/Ubuntu (PEP 668). Sandboxes are
# single-tenant throwaway VMs, so let `pip install` work as the tools expect.
mkdir -p /etc/pip
printf '[global]\nbreak-system-packages = true\n' > /etc/pip.conf

if [ "${SANDBOX_IMAGE_BROWSER:-0}" = "1" ]; then
  BROWSER_SRC="${BROWSER_SRC:-/mnt/data/agentforeach-browser}"
  # certutil: the driver imports the egress proxy's CA into Chromium's NSS store on every start.
  apt-get install -y -qq --no-install-recommends \
    xvfb libnss3-tools fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
    > /dev/null
  install -d /opt/agentforeach/browser
  cp "$BROWSER_SRC"/package.json "$BROWSER_SRC"/*.mjs /opt/agentforeach/browser/
  rm -f /opt/agentforeach/browser/*.test.mjs
  (cd /opt/agentforeach/browser && npm install --omit=dev --no-fund --no-audit --loglevel=error)
  # Chromium and the system libraries it needs. No headless shell: the driver runs headed on Xvfb.
  PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    /opt/agentforeach/browser/node_modules/.bin/playwright-core install --with-deps --no-shell chromium \
    > /dev/null
  printf '#!/bin/sh\nexec node /opt/agentforeach/browser/cli.mjs "$@"\n' > /usr/local/bin/afe-browser
  chmod 755 /usr/local/bin/afe-browser
fi

mkdir -p /mnt/data
apt-get clean
rm -rf /var/lib/apt/lists/* /tmp/* /root/.cache

echo "--- agentforeach image"
for b in bash python3 pip3 node npm git jq curl unzip zip gcc make; do
  printf '%s=%s\n' "$b" "$(command -v "$b" || echo MISSING)"
done
python3 --version
node --version
if [ "${SANDBOX_IMAGE_BROWSER:-0}" = "1" ]; then
  for b in afe-browser Xvfb certutil; do
    printf '%s=%s\n' "$b" "$(command -v "$b" || echo MISSING)"
  done
  ls -d /opt/ms-playwright/chromium-*/chrome-linux64/chrome
fi

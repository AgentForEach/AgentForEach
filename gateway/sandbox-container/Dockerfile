# =============================================================================
# AgentForEach Sandbox — the sandbox image for every container backend
#
# The same image on every cloud: ACA Dynamic Sessions custom containers,
# Cloudflare Containers, Bedrock AgentCore Runtime, Docker. It runs
# provision-aca.sh, the script ACA Sandboxes builds its disk image with, so
# every backend has the same tools, and adds the sandbox HTTP server
# (server.mjs) on port 8080: /exec, /files, /env, /health, /archive, and
# AgentCore's /ping and /invocations.
#
# Multi-arch: it builds for linux/amd64 and linux/arm64 (AgentCore Runtime
# runs arm64 only) from the same steps.
#
# Tools: Python 3.12, Node.js 22, git, jq, zip and build tools; Java 21,
# PHP 8.3, Ruby 3.2 and Go 1.22 with SANDBOX_IMAGE_FULL=1 (the default here);
# Chromium and the afe-browser driver with SANDBOX_IMAGE_BROWSER=1
# (docs/Browser.md).
#
# Build:
#   docker build -t agentforeach-sandbox:latest gateway/sandbox-container
#   docker build --build-arg SANDBOX_IMAGE_BROWSER=1 -t agentforeach-sandbox:browser gateway/sandbox-container
#   docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/agentforeach-sandbox:<tag> gateway/sandbox-container
#
# The browser build needs SANDBOX_SERVER_TOKEN at run time (sent by callers
# in x-sandbox-token, or in the /invocations envelope); server.mjs won't
# start without it, since a page in the browser could otherwise reach it.
# The Cloudflare backend sets one; on AgentCore it is the runtime's
# environment. SANDBOX_ARCHIVE_MAX_BYTES / SANDBOX_ARCHIVE_MAX_FILES bound
# /archive where /mnt/data is kept outside the sandbox (docs/Sandbox.md).
#
# Push to ACR:
#   az acr build --registry <ACR_NAME> --image agentforeach-sandbox:latest gateway/sandbox-container
# =============================================================================

FROM ubuntu:24.04

ARG SANDBOX_IMAGE_FULL=1
ARG SANDBOX_IMAGE_BROWSER=0

COPY provision-aca.sh /tmp/provision-aca.sh
COPY browser/ /tmp/agentforeach-browser/
RUN SANDBOX_IMAGE_FULL="$SANDBOX_IMAGE_FULL" \
    SANDBOX_IMAGE_BROWSER="$SANDBOX_IMAGE_BROWSER" \
    BROWSER_SRC=/tmp/agentforeach-browser \
    bash /tmp/provision-aca.sh

# The sandbox HTTP server (Node built-ins only).
COPY server.mjs workspace-archive.mjs browser-checkpoint.mjs /opt/sandbox/

# Files live in /mnt/data, as on every backend.
WORKDIR /mnt/data
EXPOSE 8080

# No sudo, no TTY.
CMD ["node", "/opt/sandbox/server.mjs"]

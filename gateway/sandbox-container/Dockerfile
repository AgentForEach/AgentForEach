# =============================================================================
# AgentForEach Sandbox — Custom Container for ACA Dynamic Sessions
#
# Multi-runtime sandbox based on Debian 12 (bookworm).
# Provides secure, isolated command execution with Hyper-V isolation.
#
# Preinstalled runtimes:
#   - Python 3.11    (system default)
#   - Node.js 22.x   (nodesource)
#   - Java 17        (openjdk-17-jdk-headless)
#   - PHP 8.2        (system default)
#   - Ruby 3.1       (system default)
#   - Go 1.23        (official tarball)
#
# The container runs a lightweight Node.js HTTP server on port 8080
# that accepts command execution and file operation requests.
#
# Build:
#   docker build -t agentforeach-sandbox:latest .
#
# Push to ACR:
#   az acr build --registry <ACR_NAME> --image agentforeach-sandbox:latest .
# =============================================================================

FROM debian:12-slim

# Avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# System packages + language runtimes from Debian repos
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core tools
    bash curl wget git ca-certificates gnupg \
    # Build tools (for native extensions)
    gcc g++ make cmake \
    # Python 3.11
    python3 python3-pip python3-venv \
    # Java 17
    openjdk-17-jdk-headless \
    # PHP 8.2
    php8.2-cli \
    # Ruby 3.1
    ruby \
    # Useful utilities
    jq unzip zip tar gzip bzip2 xz-utils \
    procps lsof net-tools dnsutils \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Node.js 22.x (via nodesource)
# ---------------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Go 1.23 (official tarball)
# ---------------------------------------------------------------------------
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://go.dev/dl/go1.23.6.linux-${ARCH}.tar.gz" \
       | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:$PATH"

# ---------------------------------------------------------------------------
# Python package manager setup
# ---------------------------------------------------------------------------
# Remove PEP 668 externally-managed marker so pip install works without
# --break-system-packages flag (sandbox is an isolated, ephemeral container).
RUN rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED \
    && python3 -m pip install --no-cache-dir --upgrade pip setuptools

# ---------------------------------------------------------------------------
# Working directory (ACA standard persistent path)
# ---------------------------------------------------------------------------
RUN mkdir -p /mnt/data
WORKDIR /mnt/data

# ---------------------------------------------------------------------------
# Sandbox HTTP server
# ---------------------------------------------------------------------------
COPY server.mjs /opt/sandbox/server.mjs

EXPOSE 8080

# No sudo, no TTY — matches hosted shell constraints
CMD ["node", "/opt/sandbox/server.mjs"]

#!/usr/bin/env bash
# Tools for the "Run locally" and "Deploy to Azure" steps in docs/getting-started.md.
set -euo pipefail
npm ci
npm install -g azure-functions-core-tools@4 azurite
curl -fsSL https://get.pulumi.com | sh -s -- --silent
cp -n gateway/local.settings.example.json gateway/local.settings.json || true
echo "Ready: func $(func --version), pulumi $(~/.pulumi/bin/pulumi version), az $(az version --query '"azure-cli"' -o tsv)"

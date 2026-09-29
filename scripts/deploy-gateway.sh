#!/usr/bin/env bash
#
# Build the gateway and deploy it to the Function App of a Pulumi stack
# (Flex Consumption).
#
# Usage:
#   ./scripts/deploy-gateway.sh <stack>            # app name from `pulumi stack output functionAppName`
#   ./scripts/deploy-gateway.sh --app <app-name>   # or name the Function App directly
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GATEWAY_DIR="$ROOT_DIR/packages/gateway"
STAGING_DIR="$ROOT_DIR/.deploy-staging"

if [[ "${1:-}" == "--app" ]]; then
  APP_NAME="${2:?usage: deploy-gateway.sh --app <function-app-name>}"
else
  STACK="${1:?usage: deploy-gateway.sh <pulumi-stack> | --app <function-app-name>}"
  APP_NAME="$(cd "$ROOT_DIR/packages/infra" && pulumi stack output functionAppName --stack "$STACK")"
fi

echo "==> Deploying the gateway to ${APP_NAME}"

# --------------------------------------------------------------------------
# 1. Build TypeScript
# --------------------------------------------------------------------------
echo "==> Building TypeScript..."
cd "$GATEWAY_DIR"
npx tsc

# --------------------------------------------------------------------------
# 2. Stage deployment package
#    Flex Consumption expects: host.json, package.json, node_modules/, dist/
#    rootDir=".." means output lands under dist/gateway/
# --------------------------------------------------------------------------
echo "==> Staging deployment package..."
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# Copy compiled JS + sourcemaps
cp -r "$GATEWAY_DIR/dist" "$STAGING_DIR/dist"

# Copy runtime config (loaded from disk by utils/config.ts; CONFIG_FILE_JSON
# picks a file other than agentforeach.json)
mkdir -p "$STAGING_DIR/dist/gateway/config"
cp "$GATEWAY_DIR"/config/*.json "$STAGING_DIR/dist/gateway/config/"

# Copy Azure Functions config
cp "$GATEWAY_DIR/host.json" "$STAGING_DIR/host.json"

# Create a deployment package.json (main must match compiled entry point)
cat > "$STAGING_DIR/package.json" <<EOF
{
  "name": "@agentforeach/gateway",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/gateway/index.js",
  "dependencies": {}
}
EOF

# Create local.settings.json (required by func CLI to detect runtime)
cat > "$STAGING_DIR/local.settings.json" <<EOF
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": ""
  }
}
EOF

# --------------------------------------------------------------------------
# 3. Install production dependencies
# --------------------------------------------------------------------------
echo "==> Installing production dependencies..."
cd "$STAGING_DIR"

# Copy the real package.json deps into the staging package.json
node -e "
  const gw = require('$GATEWAY_DIR/package.json');
  const pkg = require('./package.json');
  pkg.dependencies = gw.dependencies;
  require('fs').writeFileSync('./package.json', JSON.stringify(pkg, null, 2));
"

npm install --omit=dev --ignore-scripts

# --------------------------------------------------------------------------
# 4. Deploy to Azure Functions
#    Flex Consumption requires zip deployment to its blob container.
#    Do NOT use --nozip — that uploads via Kudu/SCM which Flex ignores.
# --------------------------------------------------------------------------
echo "==> Publishing to ${APP_NAME}..."
func azure functionapp publish "$APP_NAME"

echo ""
echo "==> Deployed successfully to https://${APP_NAME}.azurewebsites.net"
echo "    Health check: https://${APP_NAME}.azurewebsites.net/api/health"

# --------------------------------------------------------------------------
# 5. Cleanup
# --------------------------------------------------------------------------
rm -rf "$STAGING_DIR"
echo "==> Done."

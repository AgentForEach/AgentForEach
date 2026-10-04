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
GATEWAY_DIR="$ROOT_DIR/gateway"
STAGING_DIR="$ROOT_DIR/.deploy-staging"

if [[ "${1:-}" == "--app" ]]; then
  APP_NAME="${2:?usage: deploy-gateway.sh --app <function-app-name>}"
else
  STACK="${1:?usage: deploy-gateway.sh <pulumi-stack> | --app <function-app-name>}"
  APP_NAME="$(cd "$ROOT_DIR/infra" && pulumi stack output functionAppName --stack "$STACK")"
fi

echo "==> Deploying the gateway to ${APP_NAME}"

# --------------------------------------------------------------------------
# 1. Build TypeScript
# --------------------------------------------------------------------------
echo "==> Building TypeScript..."
cd "$GATEWAY_DIR"
# A clean build: compiled files of deleted sources must not ship.
rm -rf "$GATEWAY_DIR/dist" "$ROOT_DIR"/packages/*/dist
# Builds the storage and platform packages the gateway imports, then the gateway.
npm run build

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

# The storage and platform packages are workspace packages, not on the npm registry:
# pack them into the staging area and install them from those tarballs.
mkdir -p "$STAGING_DIR/packages"
(cd "$ROOT_DIR" && npm pack --silent \
  --workspace @agentforeach/storage \
  --workspace @agentforeach/storage-cosmos \
  --workspace @agentforeach/storage-postgres \
  --workspace @agentforeach/platform \
  --workspace @agentforeach/platform-azure \
  --workspace @agentforeach/platform-cloudflare \
  --pack-destination "$STAGING_DIR/packages" >/dev/null)

# Copy the real package.json deps into the staging package.json, pointing the
# workspace packages at their tarballs.
node -e "
  const fs = require('fs');
  const gw = require('$GATEWAY_DIR/package.json');
  const pkg = require('./package.json');
  const tarballs = fs.readdirSync('packages');
  pkg.dependencies = { ...gw.dependencies };
  for (const name of Object.keys(pkg.dependencies)) {
    if (!name.startsWith('@agentforeach/')) continue;
    const file = tarballs.find((t) => t === name.slice(1).replace('/', '-') + '-' + pkg.dependencies[name] + '.tgz');
    if (!file) throw new Error('no packed tarball for ' + name);
    pkg.dependencies[name] = 'file:packages/' + file;
  }
  fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2));
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

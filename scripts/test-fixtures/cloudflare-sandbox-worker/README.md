# Cloudflare sandbox test Worker

The real Cloudflare sandbox backend in a Worker, for the live conformance run (`scripts/test-sandbox-conformance-live.mjs cloudflare-containers`). It runs any command it is sent, so keep its token secret and delete it when done.

**Cost:** Workers Paid plan, Containers billing for one `standard-2` instance while the suite runs (a few minutes), and registry storage for the image (about 500 MB compressed) and the suite's snapshots until you delete them.

```sh
npm run build --workspace @agentforeach/gateway
cd scripts/test-fixtures/cloudflare-sandbox-worker
npx wrangler deploy                      # builds and pushes the sandbox image (Docker needed)
openssl rand -hex 32 | tee .token | npx wrangler secret put API_TOKEN
# optional, to exercise snapshot deletion too:
#   npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
#   npx wrangler secret put CLOUDFLARE_IMAGES_API_TOKEN
cd ../../..
CF_SANDBOX_TEST_URL=https://afe-sandbox-conformance.<subdomain>.workers.dev \
CF_SANDBOX_TEST_TOKEN=$(cat scripts/test-fixtures/cloudflare-sandbox-worker/.token) \
  node scripts/test-sandbox-conformance-live.mjs cloudflare-containers
```

The first start of a new image can take about 30 s, and starts right after a push sometimes fail once (Cloudflare Containers is in beta); run the suite again if the first check times out.

**Delete everything afterwards:**

```sh
cd scripts/test-fixtures/cloudflare-sandbox-worker
npx wrangler delete
npx wrangler containers list             # delete the application if it is still listed
npx wrangler containers images list      # then each afe-sandbox-conformance tag, snapshots included:
npx wrangler containers images delete afe-sandbox-conformance:<tag>
rm .token
```

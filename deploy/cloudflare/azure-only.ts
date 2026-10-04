/**
 * Stands in for an Azure-only module in the Worker bundle.
 *
 * The gateway reaches Azure-only code (Cosmos, Blob Storage, Web PubSub,
 * Entra ID tokens, MCP's stdio transport) only through `await import()`,
 * on the paths a deployment's configuration selects; the ACA sandbox
 * clients are built only when an ACA provider is chosen, and building one
 * here throws, which turns the sandbox tools off. wrangler.jsonc aliases
 * each such module here, so the Azure SDKs are never bundled into the
 * Worker, and a configuration that selects one anyway fails with a clear
 * error instead of a missing module. scripts/check-bundle.mjs checks that
 * every lazy import into Azure-only code has such an alias, and that nothing
 * reaches one without it.
 */

function unavailable(name: string): never {
  throw new Error(
    `${name} is Azure-only and isn't available on Cloudflare Workers. ` +
      "Choose a provider this platform supports (database: postgres; objects: s3 on R2; realtime: the Cloudflare provider).",
  );
}

const stub: Record<string, unknown> = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === "then" || typeof property === "symbol") return undefined; // so `await import()` resolves
      return new Proxy(function () {}, {
        apply: () => unavailable(String(property)),
        construct: () => unavailable(String(property)),
        get: () => unavailable(String(property)),
      });
    },
  },
);

export default stub;
export const CosmosStorage = stub.CosmosStorage;
export const AzureBlobObjectStore = stub.AzureBlobObjectStore;
export const WebPubSubRealtime = stub.WebPubSubRealtime;
export const webPubSubRelay = stub.webPubSubRelay;
export const webPubSubHost = stub.webPubSubHost;
export const createAzureTokenCredential = stub.createAzureTokenCredential;
export const createDefaultTokenProvider = stub.createDefaultTokenProvider;
export const AcaSandboxesClient = stub.AcaSandboxesClient;
export const DynamicSessionsClient = stub.DynamicSessionsClient;
export const StdioClientTransport = stub.StdioClientTransport;

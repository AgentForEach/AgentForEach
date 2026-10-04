/**
 * AgentForEach Azure pack — Entra ID tokens
 *
 * Tokens for Azure data planes: the sandboxes (ACA Sandboxes and Dynamic
 * Sessions, audience `https://dynamicsessions.io`) and Cosmos DB.
 *
 * Sources, in order:
 *   1. AZURE_SANDBOX_TOKEN env var (tests / CI override)
 *   2. App Service managed identity (IDENTITY_ENDPOINT + IDENTITY_HEADER),
 *      which Azure Functions sets whenever a managed identity is attached.
 *      Plain fetch, so production needs no @azure/identity dependency.
 *   3. `az account get-access-token` (local dev after `az login`)
 *
 * Service-principal or workload-identity auth (DefaultAzureCredential) is not
 * supported; set AZURE_SANDBOX_TOKEN from your own token source if needed.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SANDBOX_TOKEN_RESOURCE = "https://dynamicsessions.io";

/** Refresh this long before the token expires. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface TokenProvider {
  getToken(): Promise<string>;
}

type CachedToken = { token: string; expiresAtMs: number };

async function fetchManagedIdentityToken(
  resource: string,
  endpoint: string,
  identityHeader: string,
  clientId = process.env.AZURE_CLIENT_ID,
): Promise<CachedToken> {
  const url = new URL(endpoint);
  url.searchParams.set("resource", resource);
  url.searchParams.set("api-version", "2019-08-01");
  if (clientId) url.searchParams.set("client_id", clientId);

  const resp = await fetch(url, {
    headers: { "X-IDENTITY-HEADER": identityHeader },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    throw new Error(`Managed identity token request failed: ${resp.status}`);
  }
  const body = (await resp.json()) as { access_token: string; expires_on: string | number };
  return {
    token: body.access_token,
    expiresAtMs: Number(body.expires_on) * 1000,
  };
}

async function fetchAzCliToken(resource: string): Promise<CachedToken> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "az",
      ["account", "get-access-token", "--resource", resource, "-o", "json"],
      { timeout: 20_000 },
    ));
  } catch (err) {
    throw new Error(
      "No Azure credentials: attach a managed identity to the Function App " +
        "(IDENTITY_ENDPOINT/IDENTITY_HEADER), or run `az login` for local dev. " +
        `(${(err as Error).message})`,
    );
  }
  const body = JSON.parse(stdout) as { accessToken: string; expires_on?: number; expiresOn?: string };
  const expiresAtMs = body.expires_on
    ? body.expires_on * 1000
    : Date.parse(body.expiresOn ?? "") || Date.now() + 10 * 60 * 1000;
  return { token: body.accessToken, expiresAtMs };
}

export function createDefaultTokenProvider(
  resource: string = SANDBOX_TOKEN_RESOURCE,
): TokenProvider {
  let cached: CachedToken | null = null;
  let inflight: Promise<CachedToken> | null = null;

  return {
    async getToken(): Promise<string> {
      const envToken = process.env.AZURE_SANDBOX_TOKEN;
      if (envToken) return envToken;

      if (cached && cached.expiresAtMs - EXPIRY_MARGIN_MS > Date.now()) {
        return cached.token;
      }

      const { IDENTITY_ENDPOINT, IDENTITY_HEADER } = process.env;
      inflight ??= (
        IDENTITY_ENDPOINT && IDENTITY_HEADER
          ? fetchManagedIdentityToken(resource, IDENTITY_ENDPOINT, IDENTITY_HEADER)
          : fetchAzCliToken(resource)
      ).finally(() => {
        inflight = null;
      });

      cached = await inflight;
      return cached.token;
    },
  };
}

/**
 * An Azure SDK TokenCredential (`getToken` → `{ token, expiresOnTimestamp }`)
 * from the same sources, minus the sandbox env override: the managed
 * identity in Azure, `az login` locally. `clientId` picks a user-assigned
 * identity; omitted, AZURE_CLIENT_ID if set, else the system-assigned one.
 */
export function createAzureTokenCredential(resource: string, clientId?: string) {
  let cached: CachedToken | null = null;
  let inflight: Promise<CachedToken> | null = null;
  return {
    async getToken(): Promise<{ token: string; expiresOnTimestamp: number }> {
      if (!cached || cached.expiresAtMs - EXPIRY_MARGIN_MS <= Date.now()) {
        const { IDENTITY_ENDPOINT, IDENTITY_HEADER } = process.env;
        inflight ??= (
          IDENTITY_ENDPOINT && IDENTITY_HEADER
            ? fetchManagedIdentityToken(resource, IDENTITY_ENDPOINT, IDENTITY_HEADER, clientId)
            : fetchAzCliToken(resource)
        ).finally(() => {
          inflight = null;
        });
        cached = await inflight;
      }
      return { token: cached.token, expiresOnTimestamp: cached.expiresAtMs };
    },
  };
}

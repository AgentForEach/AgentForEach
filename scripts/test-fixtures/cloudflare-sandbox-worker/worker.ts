/**
 * A test Worker for the live sandbox conformance run
 * (scripts/test-sandbox-conformance-live.mjs cloudflare-containers): the real
 * ContainerSandbox, SandboxEgress and CloudflareContainersSandbox, with each
 * backend method callable over POST /rpc behind a bearer token. Not for
 * production: it runs any command it is sent.
 */

import { CloudflareContainersSandbox } from "../../../packages/platform-cloudflare/src/index.ts";
import { ContainerSandbox, SandboxEgress } from "../../../packages/platform-cloudflare/src/sandbox/objects.ts";

export { ContainerSandbox, SandboxEgress };

type Env = {
  SANDBOX: DurableObjectNamespace<ContainerSandbox>;
  /** Callers send it as `Authorization: Bearer <API_TOKEN>`. */
  API_TOKEN: string;
  /** Optional: with both, snapshots are deleted from the registry as in production. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_IMAGES_API_TOKEN?: string;
};

const METHODS = new Set(["exec", "fileWrite", "fileRead", "fileList", "fileReadBinary", "setEnv", "setEgressCredentials", "deleteUserSandboxes"]);

function backend(env: Env): CloudflareContainersSandbox {
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_IMAGES_API_TOKEN: apiToken } = env;
  return new CloudflareContainersSandbox(env.SANDBOX, {
    // Deny by default, nothing listed: the suite's egress check needs its echo host closed.
    networkAccess: "disabled",
    egressAllowHosts: [],
    snapshotDeletion: accountId && apiToken ? { accountId, apiToken } : undefined,
  });
}

/** Constant-time comparison of the bearer token. */
function authorized(request: Request, token: string): boolean {
  const given = new TextEncoder().encode(request.headers.get("authorization") ?? "");
  const wanted = new TextEncoder().encode(`Bearer ${token}`);
  if (!token || given.byteLength !== wanted.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, wanted);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env.API_TOKEN)) return new Response("unauthorized", { status: 401 });
    const url = new URL(request.url);
    if (url.pathname !== "/rpc" || request.method !== "POST") return new Response("not found", { status: 404 });
    const { method, args } = (await request.json()) as { method: string; args: unknown[] };
    const sandboxes = backend(env);
    try {
      let result: unknown;
      if (method === "capabilities") result = sandboxes.capabilities;
      else if (method === "suspend") result = await env.SANDBOX.getByName(`sbx:${String(args[0])}`).suspend();
      else if (METHODS.has(method)) {
        const call = (sandboxes as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
        result = await call.apply(sandboxes, args);
      } else return Response.json({ ok: false, error: `unknown method ${method}`, name: "Error" });
      return Response.json({ ok: true, result });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err), name: err instanceof Error ? err.name : "Error" });
    }
  },
};

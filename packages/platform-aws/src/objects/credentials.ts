/**
 * AgentForEach Platform AWS — S3 access for the shared `s3` provider
 *
 * The object store on AWS is the platform's own `s3` provider
 * (`@agentforeach/platform`, SigV4 over `fetch`); this pack adds only what
 * it can't have without an SDK: the host's credentials. `awsCredentials()`
 * reads them from the SDK's Node credential chain (environment, SSO, web
 * identity, shared files, ECS and EC2 metadata) and keeps them until shortly
 * before they expire. Each set carries its `expiration`, so the provider
 * signs links to end before the credentials do.
 *
 * `awsS3Defaults()` is what the Lambda entry installs into the gateway
 * (`installS3Defaults`), so `OBJECT_STORE_PROVIDER=s3` (set by the
 * deployment) needs no keys, no endpoint and no region there.
 */

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { AwsCredentials } from "@agentforeach/platform";

/** Anything that returns AWS credentials, such as an SDK credential provider. */
export type AwsCredentialSource = () => Promise<AwsCredentials>;

export type AwsCredentialsOptions = {
  /** Where credentials come from. Default: the SDK's Node credential chain. */
  source?: AwsCredentialSource;
  /** Fetch new credentials this long before the current ones expire. Default 5 minutes. */
  refreshBeforeMs?: number;
  now?: () => number;
};

/**
 * Credentials for the `s3` provider, cached until `refreshBeforeMs` before
 * their `expiration` (for ever when they have none, as static keys don't).
 * Concurrent calls share one fetch. If a refresh fails while the cached
 * credentials still work, those are returned.
 */
export function awsCredentials(options: AwsCredentialsOptions = {}): AwsCredentialSource {
  const source = options.source ?? defaultProvider();
  const refreshBeforeMs = options.refreshBeforeMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  let cached: AwsCredentials | undefined;
  let pending: Promise<AwsCredentials> | undefined;

  const fresh = (credentials: AwsCredentials) => !credentials.expiration || credentials.expiration.getTime() - now() > refreshBeforeMs;
  const usable = (credentials: AwsCredentials) => !credentials.expiration || credentials.expiration.getTime() > now();

  return async () => {
    if (cached && fresh(cached)) return cached;
    pending ??= source()
      .then((c) => {
        cached = {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
          ...(c.expiration ? { expiration: c.expiration } : {}),
        };
        return cached;
      })
      .catch((err: unknown) => {
        if (cached && usable(cached)) return cached;
        throw err;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

/** The host's S3 access, in the shape the gateway's `installS3Defaults` takes. */
export type AwsS3Defaults = {
  credentials: AwsCredentialSource;
  endpoint?: string;
  region?: string;
  addressing: "virtual";
  deleteVersions: boolean;
  maxSignedUrlSeconds: number;
};

/**
 * S3 in the host's region, with its credentials: the regional endpoint,
 * virtual-hosted addressing (what AWS recommends; bucket names must not
 * contain dots), and erasure that deletes every version, in case the
 * buckets are versioned. Download links last at most `maxSignedUrlSeconds`
 * (default an hour): Lambda's role credentials carry no expiration, so
 * without a cap a link could die before the expiry the user is told. The
 * endpoint is left out when no region is known, and OBJECT_STORE_S3_*
 * settings override any of it. The provider itself is chosen by
 * OBJECT_STORE_PROVIDER=s3, never by these defaults.
 */
export function awsS3Defaults(options: AwsCredentialsOptions & { region?: string; maxSignedUrlSeconds?: number } = {}): AwsS3Defaults {
  const region = options.region ?? (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined);
  return {
    credentials: awsCredentials(options),
    ...(region ? { endpoint: `https://s3.${region}.amazonaws.com`, region } : {}),
    addressing: "virtual",
    deleteVersions: true,
    maxSignedUrlSeconds: options.maxSignedUrlSeconds ?? 3600,
  };
}

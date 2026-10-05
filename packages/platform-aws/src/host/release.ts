/**
 * The release bootstrap: what a Lambda function loads before the gateway
 * starts.
 *
 * Each function's environment names one release manifest in S3
 * (AGENTFOREACH_RELEASE_BUCKET, AGENTFOREACH_RELEASE_KEY), written by the deploy for
 * that release and function. It holds:
 * - `config`: the gateway's agentforeach.json, installed as the config (a
 *   Lambda package carries no config file of its own);
 * - `environment`: plain settings, set in process.env;
 * - `secrets`: Secrets Manager references (an ARN, and optionally a key in
 *   the secret's JSON), whose values are set in process.env.
 *
 * Everything is read before anything is set, so a secret that can't be read
 * leaves the environment as it was and the next invocation tries again: the
 * gateway never starts half-configured. A manifest can't set the function's
 * own AWS, Lambda or Node settings, nor the variables that locate the
 * manifest. Loading happens once per process; concurrent callers share it.
 */

import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";

export interface SecretRef {
  /** The secret's ARN. */
  arn: string;
  /** For a JSON secret, the key whose (string) value to use. Default: the whole secret string. */
  jsonKey?: string;
}

export interface ReleaseManifest {
  version: 1;
  environment: Record<string, string>;
  secrets: Record<string, SecretRef>;
  config: Record<string, unknown>;
}

/** The variables that locate a function's manifest. */
export const RELEASE_BUCKET_VAR = "AGENTFOREACH_RELEASE_BUCKET";
export const RELEASE_KEY_VAR = "AGENTFOREACH_RELEASE_KEY";

/**
 * Names a manifest may not set: the function's credentials, region and
 * runtime (AWS_*, LAMBDA_*, _HANDLER, _X_AMZN_*), Node's options, a config
 * file path, and the manifest's own location. AWS_SANDBOX_* are the
 * sandbox's settings, not the runtime's, so they are allowed.
 */
const RESERVED = /^(AWS_(?!SANDBOX_)|LAMBDA_|NODE_|_HANDLER$|_X_AMZN_|CONFIG_FILE_JSON$|AGENTFOREACH_RELEASE_(BUCKET|KEY)$)/;
const SECRET_ARN = /^arn:[^:]+:secretsmanager:[^:]+:\d{12}:secret:.+/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const AWS_TIMEOUT_MS = 15_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The manifest, checked; throws on anything unexpected. */
export function validateReleaseManifest(value: unknown): ReleaseManifest {
  const doc = value as Partial<ReleaseManifest> | undefined;
  if (!isRecord(doc) || doc.version !== 1 || !isRecord(doc.config)) throw new Error("Invalid release manifest");
  for (const field of ["environment", "secrets"] as const) {
    const values = doc[field];
    if (!isRecord(values)) throw new Error(`Invalid release manifest: "${field}" must be an object`);
    for (const [name, v] of Object.entries(values)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || RESERVED.test(name)) throw new Error(`The release manifest may not set ${name}`);
      if (field === "environment" && typeof v !== "string") throw new Error(`Invalid release manifest: ${name} must be a string`);
      if (field === "secrets" && !(isRecord(v) && typeof v.arn === "string" && SECRET_ARN.test(v.arn))) {
        throw new Error(`Invalid release manifest: ${name} must reference a Secrets Manager ARN`);
      }
    }
  }
  if (Object.keys(doc.secrets!).some((name) => name in doc.environment!)) {
    throw new Error("Invalid release manifest: a name is both a setting and a secret");
  }
  return doc as ReleaseManifest;
}

export interface ReleaseLoaderDeps {
  /** The manifest's text. */
  readManifest(bucket: string, key: string): Promise<string>;
  /** A secret's value. */
  readSecret(ref: SecretRef): Promise<string>;
  /** Install the gateway's config (`installConfig` from gateway/utils/config.ts). */
  installConfig(config: Record<string, unknown>): void;
  /** Default: process.env. */
  env?: Record<string, string | undefined>;
}

/** Load the release once: returns the loader every handler awaits before it starts. */
export function createReleaseLoader(deps: ReleaseLoaderDeps): () => Promise<void> {
  const env = deps.env ?? process.env;
  let loading: Promise<void> | undefined;
  const load = async () => {
    const bucket = env[RELEASE_BUCKET_VAR];
    const key = env[RELEASE_KEY_VAR];
    if (!bucket || !key) throw new Error(`${RELEASE_BUCKET_VAR} and ${RELEASE_KEY_VAR} must name the release manifest`);
    const manifest = validateReleaseManifest(JSON.parse(await deps.readManifest(bucket, key)));
    // Read everything first: a failure here must leave the environment untouched.
    const secrets = await Promise.all(
      Object.entries(manifest.secrets).map(async ([name, ref]) => [name, await deps.readSecret(ref)] as const),
    );
    for (const [name, value] of secrets) {
      if (typeof value !== "string" || value.length === 0) throw new Error(`The secret for ${name} is empty`);
    }
    for (const [name, value] of [...Object.entries(manifest.environment), ...secrets]) env[name] = value;
    deps.installConfig(manifest.config);
  };
  return () =>
    (loading ??= load().catch((err) => {
      loading = undefined;
      throw err;
    }));
}

async function readBody(body: GetObjectCommandOutput["Body"]): Promise<string> {
  if (!body) throw new Error("The release manifest is empty");
  const stream = body as AsyncIterable<Uint8Array> & { destroy?: () => void };
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_MANIFEST_BYTES) throw new Error("The release manifest is over 1 MiB");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    stream.destroy?.();
  }
}

/** The release loader on AWS: the manifest from S3, secrets from Secrets Manager, with the function's own credentials. */
export function awsReleaseLoader(options: Pick<ReleaseLoaderDeps, "installConfig" | "env">): () => Promise<void> {
  type S3 = typeof import("@aws-sdk/client-s3");
  type SecretsManager = typeof import("@aws-sdk/client-secrets-manager");
  let s3: { sdk: S3; client: InstanceType<S3["S3Client"]> } | undefined;
  let secrets: { sdk: SecretsManager; client: InstanceType<SecretsManager["SecretsManagerClient"]> } | undefined;
  return createReleaseLoader({
    ...options,
    async readManifest(bucket, key) {
      if (!s3) {
        const sdk = await import("@aws-sdk/client-s3");
        s3 = { sdk, client: new sdk.S3Client({ maxAttempts: 3 }) };
      }
      const { Body } = await s3.client.send(new s3.sdk.GetObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(AWS_TIMEOUT_MS),
      });
      return readBody(Body);
    },
    async readSecret(ref) {
      if (!secrets) {
        const sdk = await import("@aws-sdk/client-secrets-manager");
        secrets = { sdk, client: new sdk.SecretsManagerClient({ maxAttempts: 3 }) };
      }
      const { SecretString } = await secrets.client.send(new secrets.sdk.GetSecretValueCommand({ SecretId: ref.arn }), {
        abortSignal: AbortSignal.timeout(AWS_TIMEOUT_MS),
      });
      if (SecretString === undefined) throw new Error("Only string secrets can be loaded");
      if (!ref.jsonKey) return SecretString;
      const value = (JSON.parse(SecretString) as Record<string, unknown>)[ref.jsonKey];
      if (typeof value !== "string") throw new Error(`The secret has no string "${ref.jsonKey}"`);
      return value;
    },
  });
}

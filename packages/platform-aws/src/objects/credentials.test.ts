import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { S3ObjectStore, type AwsCredentials } from "@agentforeach/platform";
import { awsCredentials, awsS3Defaults } from "./credentials.js";

/** A source that hands out numbered credentials, each expiring `ttlMs` after it was fetched. */
function countingSource(clock: { now: number }, ttlMs?: number) {
  let calls = 0;
  const source = async (): Promise<AwsCredentials> => {
    calls++;
    return {
      accessKeyId: `ASIA${calls}`,
      secretAccessKey: "s",
      sessionToken: `t${calls}`,
      ...(ttlMs !== undefined ? { expiration: new Date(clock.now + ttlMs) } : {}),
    };
  };
  return { source, calls: () => calls };
}

describe("AWS credentials for the s3 provider", () => {
  it("caches credentials until five minutes before they expire", async () => {
    const clock = { now: Date.parse("2026-10-05T00:00:00Z") };
    const { source, calls } = countingSource(clock, 60 * 60_000);
    const credentials = awsCredentials({ source, now: () => clock.now });
    const first = await credentials();
    assert.equal(first.expiration?.toISOString(), "2026-10-05T01:00:00.000Z");
    clock.now += 54 * 60_000;
    assert.equal(await credentials(), first, "still more than five minutes left");
    clock.now += 2 * 60_000;
    const second = await credentials();
    assert.equal(second.accessKeyId, "ASIA2");
    assert.equal(calls(), 2);
  });

  it("shares one fetch between concurrent callers", async () => {
    const clock = { now: 0 };
    const { source, calls } = countingSource(clock, 60 * 60_000);
    const credentials = awsCredentials({ source, now: () => clock.now });
    const all = await Promise.all([credentials(), credentials(), credentials()]);
    assert.equal(calls(), 1);
    assert.ok(all.every((c) => c === all[0]));
  });

  it("keeps static keys for good", async () => {
    const clock = { now: 0 };
    const { source, calls } = countingSource(clock);
    const credentials = awsCredentials({ source, now: () => clock.now });
    await credentials();
    clock.now += 365 * 86_400_000;
    await credentials();
    assert.equal(calls(), 1);
  });

  it("falls back to the cached credentials while they work if a refresh fails", async () => {
    const clock = { now: 0 };
    let fail = false;
    const source = async (): Promise<AwsCredentials> => {
      if (fail) throw new Error("metadata service unreachable");
      return { accessKeyId: "a", secretAccessKey: "s", expiration: new Date(clock.now + 10 * 60_000) };
    };
    const credentials = awsCredentials({ source, now: () => clock.now });
    const cached = await credentials();
    fail = true;
    clock.now += 6 * 60_000; // inside the refresh window, not yet expired
    assert.equal(await credentials(), cached);
    clock.now += 5 * 60_000; // expired
    await assert.rejects(credentials(), /metadata service unreachable/);
  });

  it("reads the SDK's Node chain by default, starting with the environment", async () => {
    const saved = { ...process.env };
    try {
      process.env.AWS_ACCESS_KEY_ID = "AKIDENV";
      process.env.AWS_SECRET_ACCESS_KEY = "secret";
      process.env.AWS_SESSION_TOKEN = "token";
      process.env.AWS_CREDENTIAL_EXPIRATION = "2099-01-01T00:00:00Z";
      const credentials = await awsCredentials()();
      assert.equal(credentials.accessKeyId, "AKIDENV");
      assert.equal(credentials.sessionToken, "token");
      assert.equal(credentials.expiration?.toISOString(), "2099-01-01T00:00:00.000Z");
    } finally {
      process.env = saved;
    }
  });

  it("points the s3 provider at the host's region", () => {
    const defaults = awsS3Defaults({ region: "eu-central-1", source: async () => ({ accessKeyId: "a", secretAccessKey: "s" }) });
    assert.equal(defaults.endpoint, "https://s3.eu-central-1.amazonaws.com");
    assert.deepEqual([defaults.region, defaults.addressing, defaults.deleteVersions, defaults.maxSignedUrlSeconds], ["eu-central-1", "virtual", true, 3600]);
    assert.equal(awsS3Defaults({ region: "eu-central-1", maxSignedUrlSeconds: 900 }).maxSignedUrlSeconds, 900);
    const saved = { AWS_REGION: process.env.AWS_REGION, AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION };
    try {
      delete process.env.AWS_REGION;
      delete process.env.AWS_DEFAULT_REGION;
      assert.equal(awsS3Defaults().endpoint, undefined, "no region, no endpoint: the gateway then asks for one");
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });

  it("gives the s3 provider credentials whose expiration cuts links short", async () => {
    const expiration = new Date(Date.now() + 20 * 60_000);
    const credentials = awsCredentials({ source: async () => ({ accessKeyId: "ASIA", secretAccessKey: "s", sessionToken: "t", expiration }) });
    const store = new S3ObjectStore({ endpoint: "https://s3.us-east-1.amazonaws.com", bucket: "exports", addressing: "virtual", credentials });
    const { expiresAt } = await store.signedUrlWithExpiry("u/f.txt", { expiresAt: new Date(Date.now() + 86_400_000) });
    assert.ok(expiresAt.getTime() <= expiration.getTime() - 60_000 && expiresAt.getTime() > expiration.getTime() - 62_000);
  });
});

/**
 * Workspace checkpoints in S3, for the aws-agentcore backend's s3-checkpoint
 * mode: one object per workspace, `workspaces/v1/<key>.json`, holding the
 * bounded archive of its /mnt/data (base64) and the generation it belongs to.
 * Only the gateway reaches the bucket; the sandbox gets no credentials.
 *
 * Every write is conditional, so a writer that lost its lease can't save
 * over a newer one:
 *
 *   - fence: before an operation, rewrite the object (IfMatch its ETag, or
 *     IfNoneMatch "*" when absent), so an older operation's commit, which
 *     carries the old ETag, fails;
 *   - commit: the new archive, IfMatch the fenced ETag;
 *   - erase: overwrite with a deletion marker for the erased generation
 *     (conditionally, so it never overwrites a newer generation's
 *     checkpoint). A writer of that generation then finds the marker and
 *     stops; the next generation finds it and starts empty. A checkpoint
 *     of an older generation is never restored.
 *
 * Erasure overwrites, it never deletes, so the bucket must never have had
 * versioning (enabled or suspended): an older version would keep the
 * erased files. It is checked once per process. The gateway needs only
 * s3:GetBucketVersioning, s3:GetObject and s3:PutObject on the bucket.
 *
 * Ported from the AWS reference (aws-workspace-checkpoints.ts), with the
 * generation in each object.
 */

import { randomUUID } from "node:crypto";
import { GetBucketVersioningCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

export type S3Sender = Pick<S3Client, "send">;

/** A workspace's saved archive (null: none yet), and the ETag of the object as this operation left it. */
export type Checkpoint = { archive: string | null; etag: string };

/** A writer of an erased generation, or one whose checkpoint was replaced: it must stop. */
export class CheckpointFencedError extends Error {
  constructor(reason: "erased" | "stale") {
    super(
      reason === "erased"
        ? "This sandbox was erased; nothing was saved"
        : "A newer operation took this sandbox over; nothing was saved",
    );
    this.name = "CheckpointFencedError";
  }
}

type Stored = { version: 1; generation: number; fence: string; archive?: string | null; deleted?: true };

const TIMEOUT_MS = 60_000;

export class S3WorkspaceCheckpoints {
  private versioningChecked?: Promise<void>;

  /**
   * @param maxArchiveChars the largest archive (base64) a checkpoint may hold
   * @param expectedBucketOwner the account that must own the bucket (ExpectedBucketOwner on every call)
   */
  constructor(
    private readonly bucket: string,
    private readonly client: S3Sender,
    private readonly maxArchiveChars: number,
    private readonly expectedBucketOwner?: string,
  ) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
      throw new Error(`Invalid workspace bucket name: ${bucket}`);
    }
  }

  private objectKey(key: string): string {
    if (!/^afe-[a-f0-9]{64}-[a-f0-9]{24}$/.test(key)) throw new Error("Invalid workspace key");
    return `workspaces/v1/${key}.json`;
  }

  private checkVersioning(): Promise<void> {
    this.versioningChecked ??= (async () => {
      const result = await this.client.send(
        new GetBucketVersioningCommand({ Bucket: this.bucket, ExpectedBucketOwner: this.expectedBucketOwner }),
        { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (result.Status) {
        throw new Error(
          `The workspace bucket ${this.bucket} has versioning ${result.Status}: it must never have had versioning, ` +
            "since erasure overwrites checkpoints and an older version would keep the erased files",
        );
      }
    })();
    // A failed check (a network error) is tried again next time.
    this.versioningChecked.catch(() => (this.versioningChecked = undefined));
    return this.versioningChecked;
  }

  /** Write the object: IfMatch `etag`, or only if absent when `etag` is null. Returns the new ETag. */
  private async put(key: string, body: Stored, etag: string | null): Promise<string> {
    await this.checkVersioning();
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        ExpectedBucketOwner: this.expectedBucketOwner,
        Key: this.objectKey(key),
        Body: JSON.stringify(body),
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
        ...(etag === null ? { IfNoneMatch: "*" } : { IfMatch: etag }),
      }),
      { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!result.ETag) throw new Error("S3 returned no ETag for a workspace checkpoint");
    return result.ETag;
  }

  /** The object and its ETag. (Absent objects are found with a conditional create, not a read: without s3:ListBucket a missing key reads as 403.) */
  private async get(key: string): Promise<{ body: Stored; etag: string }> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, ExpectedBucketOwner: this.expectedBucketOwner, Key: this.objectKey(key) }),
      { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!result.Body || !result.ETag) throw new Error("S3 returned an incomplete workspace checkpoint");
    const stream = result.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > this.maxArchiveChars + 4096) throw new Error("The stored workspace checkpoint is larger than the limit");
        chunks.push(chunk);
      }
    } finally {
      stream.destroy?.();
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Stored;
    if (
      body?.version !== 1 ||
      !Number.isInteger(body.generation) ||
      (body.archive != null && (typeof body.archive !== "string" || body.archive.length > this.maxArchiveChars))
    ) {
      throw new Error("The stored workspace checkpoint is invalid");
    }
    return { body, etag: result.ETag };
  }

  /**
   * Fence the checkpoint for an operation of `generation` holding lease
   * `token`, and return what to restore. Throws CheckpointFencedError when
   * the workspace was erased in this generation, or a newer one wrote it.
   */
  async fence(key: string, token: string, generation: number): Promise<Checkpoint> {
    const marker: Stored = { version: 1, generation, fence: token, archive: null };
    try {
      return { archive: null, etag: await this.put(key, marker, null) };
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
    }
    const { body, etag } = await this.get(key);
    if (body.generation > generation) throw new CheckpointFencedError("stale");
    if (body.deleted && body.generation === generation) throw new CheckpointFencedError("erased");
    // An older generation's files were erased (or are being): never restored.
    const archive = body.generation === generation && !body.deleted ? (body.archive ?? null) : null;
    return { archive, etag: await this.put(key, { ...marker, archive }, etag) };
  }

  /** Save `archive` over the fenced checkpoint; fails if anything wrote it since. */
  async commit(key: string, fenced: Checkpoint, archive: string, token: string, generation: number): Promise<void> {
    if (archive.length > this.maxArchiveChars) throw new Error("The workspace archive is larger than the limit");
    await this.put(key, { version: 1, generation, fence: `${token}:${randomUUID()}`, archive }, fenced.etag);
  }

  /**
   * Overwrite the checkpoint of `generation` (or older) with a deletion
   * marker. A newer generation's checkpoint is left alone: the erased files
   * are already gone from it.
   */
  async erase(key: string, generation: number): Promise<void> {
    const marker: Stored = { version: 1, generation, fence: randomUUID(), deleted: true };
    for (let attempt = 0; ; attempt++) {
      try {
        await this.put(key, marker, null);
        return;
      } catch (err) {
        if (!isPreconditionFailed(err)) throw err;
      }
      const { body, etag } = await this.get(key);
      if (body.generation > generation || (body.deleted && body.generation === generation)) return;
      try {
        await this.put(key, marker, etag);
        return;
      } catch (err) {
        // Written meanwhile (a fence or commit): look again.
        if (attempt >= 5 || !isPreconditionFailed(err)) throw err;
      }
    }
  }
}

/** A conditional write lost: 412, or 409 when S3 saw a concurrent conditional write to the key. */
function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "PreconditionFailed" ||
    e?.name === "ConditionalRequestConflict" ||
    e?.$metadata?.httpStatusCode === 412 ||
    e?.$metadata?.httpStatusCode === 409
  );
}

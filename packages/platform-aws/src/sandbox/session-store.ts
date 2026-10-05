/**
 * Which AgentCore runtime sessions an owner has started (aws-sandbox-sessions),
 * recorded before each session's first call, so a gateway that crashed or
 * cold-started can still stop them all on account erasure.
 */

import { createHash } from "node:crypto";
import type { Collection, Doc, StorageAdapter } from "@agentforeach/storage";
import { AWS_SANDBOX_SESSIONS } from "../collections.js";

/** The owner of a sandbox: a hash of the user id, so no AWS name or record holds the id itself. */
export function ownerHash(userId: string): string {
  return createHash("sha256").update(userId).digest("hex");
}

/** A runtime session an owner started. */
export type SessionRecord = {
  owner: string;
  runtimeArn: string;
  /** The runtime endpoint the session ran on (absent: DEFAULT). */
  qualifier?: string;
  /** The AgentCore runtimeSessionId. */
  sessionId: string;
};

export type AwsSandboxSession = Doc & SessionRecord;

export class AwsSessionStore {
  private collection?: Promise<Collection<AwsSandboxSession>>;
  /** Sessions this process has recorded: one write per session, not per call. */
  private readonly recorded = new Set<string>();

  constructor(private readonly storage: StorageAdapter) {}

  private records(): Promise<Collection<AwsSandboxSession>> {
    this.collection ??= (async () => {
      await this.storage.initialize();
      return this.storage.collection<AwsSandboxSession>(AWS_SANDBOX_SESSIONS);
    })();
    return this.collection;
  }

  /** Record a session before it is first called (idempotent). */
  async track(session: SessionRecord): Promise<void> {
    const id = createHash("sha256")
      .update(JSON.stringify([session.runtimeArn, session.qualifier ?? "DEFAULT", session.sessionId]))
      .digest("hex");
    if (this.recorded.has(id)) return;
    const { qualifier, ...rest } = session;
    await (await this.records()).upsert({ ...rest, ...(qualifier ? { qualifier } : {}), id });
    this.recorded.add(id);
  }

  list(owner: string): Promise<AwsSandboxSession[]> {
    return this.records().then((c) => c.find({ partitionKey: owner }));
  }

  async remove(session: AwsSandboxSession): Promise<void> {
    this.recorded.delete(session.id);
    await (await this.records()).delete(session.id, session.owner);
  }
}

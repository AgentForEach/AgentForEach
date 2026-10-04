/**
 * AgentForEach Platform — One-time connection tickets
 *
 * Providers that run their own sockets carry the access token in the
 * WebSocket URL (browsers can't set headers on a WebSocket), and a URL can
 * end up in request logs. So each URL is a ticket: its token's `jti` is
 * redeemed by the object that holds the connection, and a URL that has been
 * used can't be used again (docs/Realtime-Protocol.md, "Tokens on
 * self-hosted providers").
 *
 *   - A client URL connects once. Clients negotiate a new one to reconnect.
 *   - A relay URL has at most one connection at a time, and may connect again
 *     only within `resumeMs` after its connection closed, so the browser's
 *     live view survives a page reload but a URL lifted from a log afterwards
 *     is useless.
 *
 * Redemptions are serialised here, so two connects with one ticket can't
 * both succeed, whatever the storage.
 */

/** The parts of Durable Object storage the ledger uses. */
export interface TicketStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

type TicketRecord = { exp: number; closedAt?: number };

const PREFIX = "ticket:";

/** How long after its connection closes a relay URL may connect again. */
export const RELAY_RESUME_MS = 30_000;

export class TicketLedger {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: TicketStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Redeems ticket `id` (valid until `expMs`) for a new connection. False when
   * it was used already: it has a connection open now (`isOpen`), or its
   * connection closed more than `resumeMs` ago, or `resumeMs` is 0.
   */
  redeem(id: string, expMs: number, resumeMs: number, isOpen: (id: string) => boolean): Promise<boolean> {
    return this.serial(async () => {
      await this.sweep();
      const key = PREFIX + id;
      const record = await this.storage.get<TicketRecord>(key);
      if (record) {
        if (isOpen(id)) return false;
        if (record.closedAt === undefined || resumeMs <= 0 || this.now() - record.closedAt > resumeMs) return false;
      }
      await this.storage.put<TicketRecord>(key, { exp: expMs });
      return true;
    });
  }

  /** The connection that redeemed ticket `id` has closed. */
  closed(id: string): Promise<void> {
    return this.serial(async () => {
      const key = PREFIX + id;
      const record = await this.storage.get<TicketRecord>(key);
      if (record) await this.storage.put<TicketRecord>(key, { ...record, closedAt: this.now() });
    });
  }

  /** Forget tickets past their expiry (their tokens are refused anyway). */
  private async sweep(): Promise<void> {
    const now = this.now();
    for (const [key, record] of await this.storage.list<TicketRecord>({ prefix: PREFIX })) {
      if (record.exp <= now) await this.storage.delete(key);
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** A Map as ticket storage (the in-memory provider, tests). */
export function memoryTicketStorage(map = new Map<string, unknown>()): TicketStorage {
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key, value) => void map.set(key, value),
    delete: async (key) => map.delete(key),
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map([...map].filter(([k]) => k.startsWith(prefix)) as Array<[string, T]>),
  };
}

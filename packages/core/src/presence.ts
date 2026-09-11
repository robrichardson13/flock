export const PRESENCE_TTL_MS = 45_000;

export interface PresenceReport {
  client: string;
  actor: string;
  boardId: string | null;
  looking: boolean;
}

interface PresenceEntry {
  actor: string;
  boardId: string | null;
  expiresAt: number;
}

/**
 * In-memory "who is looking at what board" tracker, keyed by client id (one
 * per page load). No clock reads: `now` is always passed in by the caller.
 */
export class Presence {
  #ttlMs: number;
  #byClient = new Map<string, PresenceEntry>();

  constructor(opts?: { ttlMs?: number }) {
    this.#ttlMs = opts?.ttlMs ?? PRESENCE_TTL_MS;
  }

  report(r: PresenceReport, now: number): void {
    this.#prune(now);
    if (!r.looking) {
      this.#byClient.delete(r.client);
      return;
    }
    this.#byClient.set(r.client, {
      actor: r.actor,
      boardId: r.boardId,
      expiresAt: now + this.#ttlMs,
    });
  }

  isLooking(actor: string, boardId: string, now: number): boolean {
    this.#prune(now);
    for (const entry of this.#byClient.values()) {
      if (entry.actor === actor && entry.boardId === boardId && entry.expiresAt > now) {
        return true;
      }
    }
    return false;
  }

  /** Live entries after pruning. For tests. */
  size(now: number): number {
    this.#prune(now);
    return this.#byClient.size;
  }

  #prune(now: number): void {
    for (const [client, entry] of this.#byClient) {
      if (entry.expiresAt <= now) {
        this.#byClient.delete(client);
      }
    }
  }
}

export const PRESENCE_TTL_MS = 45_000;

/** A focused, visible window with no input in the last three minutes is not "looking" (ADR 0021). */
export const IDLE_MS = 180_000;

export interface LookingInputs {
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
  /** `document.hasFocus()`. Ignored on a foreground-only device. */
  focused: boolean;
  /** When the client last saw real user input. */
  lastInputAt: number;
  now: number;
  /**
   * The device shows exactly one app at a time and has no per-window focus: a phone or tablet.
   * There, `visible` already means "this is the foreground app in front of the user's face".
   */
  foregroundOnly: boolean;
}

/**
 * Is this client looking at its board right now? Pure, and the only definition of "looking" —
 * the web wiring supplies the inputs, the server never recomputes it.
 *
 * Desktop keeps ADR 0021's rule: visible **and** focused **and** touched inside `IDLE_MS`, because
 * a board merely visible on a second monitor beside a focused terminal is "might glance", and a
 * board left open while its owner walks away should not suppress anything.
 *
 * A foreground-only device has neither failure mode, and had two of its own (ADR 0021 amendment):
 * `document.hasFocus()` is unreliable in an iOS standalone web app, where there is no second window
 * to lose focus to, and reading a channel for three minutes without tapping is the ordinary way a
 * phone is used, not absence. There, visible is the whole rule; the OS screen-lock is the idle
 * timer, and `PRESENCE_TTL_MS` bounds any stale "looking" at 45s once the beat stops.
 */
export function clientIsLooking(inputs: LookingInputs): boolean {
  if (!inputs.visible) return false;
  if (inputs.foregroundOnly) return true;
  return inputs.focused && inputs.now - inputs.lastInputAt < IDLE_MS;
}

/**
 * What the client says about itself alongside `looking`. Diagnostic only — nothing here changes
 * a suppression decision; it exists so a log line can say *why* a client decided what it decided,
 * and so a stale bundle on a phone is visible rather than inferred (card 54).
 */
export interface PresenceClientInfo {
  /** The build the page JS came from. `unknown` when the bundle predates this field. */
  build?: string;
  /** How the page is displayed: an installed home-screen app, or a browser tab. */
  mode?: "standalone" | "browser";
  /** The `clientIsLooking` inputs, as the client saw them. */
  visible?: boolean;
  focused?: boolean;
  lastInputAgeMs?: number;
  foregroundOnly?: boolean;
  /** `navigator.userAgent`, as the request carried it. Bounded by the caller. */
  userAgent?: string;
  /**
   * The notification-dismissal read-out (card 70): what the page's last foreground sweep did.
   * Diagnostic only — presence never reads any of it, and a client that sends none of it behaves
   * exactly as before. See `packages/web/src/dismissLog.ts` for what each field means.
   */
  sweepAgeMs?: number;
  sweepReason?: string;
  sweepCount?: number;
  swState?: string;
  notifsSeen?: number;
  notifsClosed?: number;
  workerAck?: string;
  workerSeen?: number;
  workerClosed?: number;
  activateSeen?: number;
  activateClosed?: number;
  dismissErr?: string;
}

export interface PresenceReport {
  client: string;
  actor: string;
  boardId: string | null;
  looking: boolean;
  info?: PresenceClientInfo;
}

interface PresenceEntry {
  actor: string;
  boardId: string | null;
  reportedAt: number;
  expiresAt: number;
  info?: PresenceClientInfo;
}

/** One live client in a presence dump. */
export interface PresenceSnapshotEntry {
  client: string;
  actor: string;
  boardId: string | null;
  reportedAt: number;
  expiresAt: number;
  /** How long ago this client last reported, in ms. */
  ageMs: number;
  info?: PresenceClientInfo;
}

/** Why a suppression decision went the way it did, for the push log. */
export interface LookingDetail {
  looking: boolean;
  /** Age of the freshest matching report, or null when there is none. */
  ageMs: number | null;
  /** How many live clients match. */
  clients: number;
  /** Which rule matched: the client is on this board, or it is on Home (§D8 amendment). */
  via: "board" | "home" | null;
}

/**
 * A presence entry whose scope is `null` is on **Home** — the boards list, where the bell lives —
 * and counts as looking at every board (card 54). See `isLooking`.
 *
 * A client that named a board slug the server could not resolve must NOT land here: it is a stale
 * tab pointed at a deleted board, not someone watching the app. The server gives those a scope of
 * `unresolvedScope(slug)`, which can never equal a board id and so matches nothing.
 */
export function unresolvedScope(slug: string): string {
  return `unresolved:${slug.slice(0, 64)}`;
}

/**
 * Hard cap on tracked clients. Presence is best-effort and every entry expires on its own, but a
 * map fed by an unauthenticated route gets a bound anyway: past the cap the entry closest to
 * expiry is evicted to make room.
 */
export const MAX_PRESENCE_CLIENTS = 500;

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
    if (!this.#byClient.has(r.client)) this.#evictIfFull();
    this.#byClient.set(r.client, {
      actor: r.actor,
      boardId: r.boardId,
      reportedAt: now,
      expiresAt: now + this.#ttlMs,
      info: r.info,
    });
  }

  /**
   * Is this actor looking at this board right now?
   *
   * A client scoped to the board is the obvious yes. A client on **Home** (`boardId: null`) is
   * also a yes, for every board (card 54, amending ADR 0021's §D8 keying). The reason is what a
   * buzz is *for*: it says "come and look". Someone on Home is already in the app, watching the
   * board list light up and the bell count climb; buzzing their phone while they hold it and read
   * that list is the complaint this rule exists to prevent. It matters far more on iOS than it
   * reads on paper — a home-screen app launches at `start_url: "/"`, which *is* Home, so the
   * status quo pushed a foregrounded phone through the whole first stretch of every session.
   *
   * Urgent notifications (asks, awaiting-human) never reach this function; they bypass presence
   * entirely and still arrive. Nothing here silences the things you are meant to be told about.
   */
  isLooking(actor: string, boardId: string, now: number): boolean {
    return this.lookingDetail(actor, boardId, now).looking;
  }

  /**
   * Why `isLooking` answered the way it did: the freshest matching report's age and how many live
   * clients match. Diagnostic; `isLooking` is the decision.
   */
  lookingDetail(actor: string, boardId: string | null, now: number): LookingDetail {
    this.#prune(now);
    let clients = 0;
    let freshest: number | null = null;
    let via: "board" | "home" | null = null;
    for (const entry of this.#byClient.values()) {
      if (entry.actor !== actor) continue;
      // `null` is Home and matches every board; anything else must match exactly, so a client
      // on another board — or on an unresolved scope — suppresses nothing here.
      const matched: "board" | "home" | null = entry.boardId === boardId ? "board" : entry.boardId === null ? "home" : null;
      if (matched === null) continue;
      clients++;
      // A board match is the stronger reason; report it even if a Home client is fresher.
      if (via === null || matched === "board") via = matched;
      if (freshest === null || entry.reportedAt > freshest) freshest = entry.reportedAt;
    }
    return { looking: clients > 0, ageMs: freshest === null ? null : now - freshest, clients, via };
  }

  /** Every live client, freshest first. For the loopback presence dump. */
  snapshot(now: number): PresenceSnapshotEntry[] {
    this.#prune(now);
    const out: PresenceSnapshotEntry[] = [];
    for (const [client, entry] of this.#byClient) {
      out.push({
        client,
        actor: entry.actor,
        boardId: entry.boardId,
        reportedAt: entry.reportedAt,
        expiresAt: entry.expiresAt,
        ageMs: now - entry.reportedAt,
        info: entry.info,
      });
    }
    out.sort((a, b) => b.reportedAt - a.reportedAt);
    return out;
  }

  /** Live entries after pruning. For tests. */
  size(now: number): number {
    this.#prune(now);
    return this.#byClient.size;
  }

  /** Drop the entry closest to expiry once the cap is reached, so the map can never grow without
   *  bound between prunes. */
  #evictIfFull(): void {
    if (this.#byClient.size < MAX_PRESENCE_CLIENTS) return;
    let oldest: string | null = null;
    let oldestAt = Infinity;
    for (const [client, entry] of this.#byClient) {
      if (entry.expiresAt < oldestAt) {
        oldestAt = entry.expiresAt;
        oldest = client;
      }
    }
    if (oldest !== null) this.#byClient.delete(oldest);
  }

  #prune(now: number): void {
    for (const [client, entry] of this.#byClient) {
      if (entry.expiresAt <= now) {
        this.#byClient.delete(client);
      }
    }
  }
}

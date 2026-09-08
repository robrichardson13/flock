/**
 * Identity of the people on a board: what an avatar says without a lookup.
 *
 * Names are the only stable handle an actor has — no ids, no profile — so both the
 * initials and the colour are derived from the name and nothing else. The same agent
 * therefore looks the same on every board, in every session, with no state to keep.
 */

/** One or two letters, from word boundaries where the name has them, else the name's start. */
export function initialsOf(name: string): string {
  const words = name.replace(/[^a-z0-9]+/gi, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    const w = words[0];
    // A single word gives its first two letters, so "scout" and "scroll" stay apart.
    return (w[0] + (w[1] ?? "")).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** FNV-1a: small, stable across runs, and well spread for short strings. */
export function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Identity colour is drawn from the theme, not from a colour wheel.
 *
 * The old scheme hashed a name onto one of 48 free HSL chips. It was good engineering and
 * bad art direction (audit C5/C6): the loudest colour on the phone was unowned, it walked
 * straight through the status hues, and a green agent sat beside a green "done".
 *
 * What replaces it encodes something instead. The actor's *kind* picks the family — agents
 * take the theme's five cool tints, people its five warm ones — so cool means machine and
 * warm means person before a single initial is read, and the name only chooses which of the
 * five. Ten chips, all checked at 4.5:1 behind white initials and all held clear of the
 * status hues (see the direction page, card #2 section 01).
 *
 * The values live in CSS as `--id-agent-1..5` / `--id-human-1..5`, and this returns the
 * var() reference rather than a colour — so a tint is retuned in the stylesheet and every
 * avatar on screen follows, with no React involved at all.
 */
export const ID_TINTS_PER_FAMILY = 5;

/** Which of the five tints in the family, 1-based, so it reads like the CSS var it names. */
export function avatarTintIndex(name: string): number {
  // The high bits of an FNV-1a hash are the well-mixed ones; its low four are not, and
  // taking the index straight off them clusters names of a similar shape onto one chip.
  return ((hashName(name) >>> 16) % ID_TINTS_PER_FAMILY) + 1;
}

/**
 * The fill for `name`'s avatar: a reference to the theme's own token, so it is
 * deterministic per name and follows the stylesheet rather than duplicating it.
 */
export function avatarColor(name: string, kind: "agent" | "human" = "agent"): string {
  return `var(--id-${kind === "human" ? "human" : "agent"}-${avatarTintIndex(name)})`;
}

/** "3m", "2h", "4d" — the age of a timestamp in one or two characters. */
export function shortAge(iso: string, from = Date.now()): string {
  const ms = Math.max(0, from - new Date(iso).getTime());
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** How recently an actor must have written to count as here right now. */
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export const isActive = (iso: string, from = Date.now()) => from - new Date(iso).getTime() < ACTIVE_WINDOW_MS;

/**
 * Working vs idle, for the presence dot and the roster's "N idle" row: an actor is working
 * iff they hold a card that is `doing` right now. This is the one determination for both —
 * a dot must never disagree with the roster it sits beside.
 */
export function isWorking(name: string, cards: { assignee: string | null; status: string }[]): boolean {
  return cards.some((c) => c.assignee === name && c.status === "doing");
}

/** How recently an actor must have written to still be worth a grey dot rather than none. */
export const SEEN_WINDOW_MS = 60 * 60 * 1000;

export type Presence = "working" | "idle";

/**
 * The dot beside an avatar, in one place, so the header stack, the phone's team sheet and
 * the desktop roster can never disagree about who is here.
 *
 * Three states, not two. **Working** (green) holds a `doing` card right now. **Idle** (grey)
 * holds nothing but has written inside the last hour — here, between things. **Nothing at
 * all** is an actor the board only remembers: their name is history, and a dot would claim
 * a presence they do not have. The hour is deliberately wider than `ACTIVE_WINDOW_MS`, which
 * answers a different question — that one is "typing right now", and orders the stack.
 */
export function presenceOf(
  m: { name: string; lastSeen: string },
  cards: { assignee: string | null; status: string }[],
  from = Date.now(),
): Presence | undefined {
  if (isWorking(m.name, cards)) return "working";
  return from - new Date(m.lastSeen).getTime() < SEEN_WINDOW_MS ? "idle" : undefined;
}

/**
 * The actor view's three groups, in the order it shows them. Statuses map rather than being
 * listed: `awaiting-human` is a card still in the actor's hands (it is waiting on a person,
 * not finished), `wontfix` is finished, and `todo` is everything else they have touched.
 */
export type ActorCardGroup = "doing" | "done" | "other";

export function actorCardGroup(status: string): ActorCardGroup {
  if (status === "doing" || status === "awaiting-human") return "doing";
  if (status === "done" || status === "wontfix") return "done";
  return "other";
}

export function groupActorCards<T extends { status: string }>(cards: readonly T[]): Record<ActorCardGroup, T[]> {
  const groups: Record<ActorCardGroup, T[]> = { doing: [], done: [], other: [] };
  for (const c of cards) groups[actorCardGroup(c.status)].push(c);
  return groups;
}

/**
 * The roles carried by *every* card in a list, which is therefore no reason for any one of
 * them to be there (#31). conductor created all 26 cards on this board, so 26 rows read
 * "created" and the caption distinguished nothing — F1, the repeated sentence, in the last
 * place it survived. A builder's "claimed · resolved" sits on some of their cards and not
 * others, so it stays.
 *
 * A single card is exempt: there is nothing for it to be shared *with*, and "created" on the
 * one card an actor has touched is the whole answer to why they are on this board.
 */
export function sharedRoles(cards: readonly { roles: readonly string[] }[]): Set<string> {
  if (cards.length < 2) return new Set();
  const shared = new Set(cards[0].roles);
  for (const c of cards.slice(1)) {
    for (const r of shared) if (!c.roles.includes(r)) shared.delete(r);
    if (shared.size === 0) break;
  }
  return shared;
}

/**
 * What a row owes the reader beyond the card itself: why this card is in this actor's list.
 * "holding" is dropped — the assignee avatar on the row already says it, and a caption
 * repeating the row is noise — and so is anything in `drop`, which the actor view fills from
 * `sharedRoles`.
 */
export function rolesCaption(roles: readonly string[], drop: ReadonlySet<string> = new Set()): string {
  return roles.filter((r) => r !== "holding" && !drop.has(r)).join(" · ");
}

/* ---------- the roster (#31) ---------- */

/**
 * The three groups the roster shows, in the order it shows them: who is on something, who is
 * stuck on a person, and everyone else the board remembers. Same rule as the presence dot —
 * `isWorking` is holding a `doing` card — with `awaiting-human` split out, because a card
 * parked on a human is not the same news as one being worked.
 */
export type RosterGroupKey = "working" | "waiting" | "idle";

export const ROSTER_GROUPS: { key: RosterGroupKey; label: string }[] = [
  { key: "working", label: "Working" },
  { key: "waiting", label: "Waiting on you" },
  { key: "idle", label: "Idle" },
];

type HeldCard = { num: number; title: string; assignee: string | null; status: string };

/**
 * The card this actor is on, if any: a `doing` claim first, then an `awaiting-human` one.
 * Nothing in flock limits an actor to one claim, so this is "the one worth naming in a
 * one-line caption", not "the only one" — the actor view lists them all.
 */
export function heldCard<T extends HeldCard>(name: string, cards: readonly T[]): T | undefined {
  return cards.find((c) => c.assignee === name && c.status === "doing")
    ?? cards.find((c) => c.assignee === name && c.status === "awaiting-human");
}

export function rosterGroupOf(name: string, cards: readonly HeldCard[]): RosterGroupKey {
  const held = heldCard(name, cards);
  if (!held) return "idle";
  return held.status === "doing" ? "working" : "waiting";
}

export function groupRoster<M extends { name: string }>(
  team: readonly M[],
  cards: readonly HeldCard[],
): Record<RosterGroupKey, M[]> {
  const groups: Record<RosterGroupKey, M[]> = { working: [], waiting: [], idle: [] };
  for (const m of team) groups[rosterGroupOf(m.name, cards)].push(m);
  return groups;
}

/**
 * The one caption line under a roster row's name, in the same two ranks as a Home row and a
 * kanban tile (#15, #12): what they are on if they are on something, and otherwise what they
 * ran and how long ago they last wrote.
 *
 * What is *not* here: the actor's kind ("agent"/"human"), which the avatar's own shape says
 * before a word is read, and the write count, which is operator detail of the kind #12 took
 * off the tile. Those two ran verbatim down all 29 rows of the old list.
 */
export function rosterCaption(
  m: { name: string; kind: string; lastSeen: string; model?: string },
  cards: readonly HeldCard[],
  age: (iso: string) => string = shortAge,
): string {
  const held = heldCard(m.name, cards);
  if (held) return `#${held.num} ${held.title}`;
  const what = m.model ?? m.kind;
  const when = age(m.lastSeen);
  return when === "now" ? what : `${what} · ${when}`;
}

/**
 * The board's own count, in the roster's head: how many of the names below are on something
 * and how many are not. Zeroes are left out rather than written — "0 working" is a fact the
 * absent Working group already states.
 */
export function rosterCounts(groups: Record<RosterGroupKey, { name: string }[]>): string {
  return ROSTER_GROUPS.map(({ key, label }) => (groups[key].length === 0 ? null : `${groups[key].length} ${label.toLowerCase()}`))
    .filter(Boolean)
    .join(" · ");
}

/** The actor view's route: `#/b/<slug>/a/<name>` (#49). Names can hold spaces, so encode. */
export function actorHref(boardRef: string, name: string): string {
  return `#/b/${encodeURIComponent(boardRef)}/a/${encodeURIComponent(name)}`;
}

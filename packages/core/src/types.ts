export type ActorKind = "human" | "agent";

/** Runtime an agent ran under: harness (e.g. claude-code@2.1.261), model name, and effort level. */
export interface Runtime {
  harness?: string;
  model?: string;
  effort?: string;
}

export interface Actor extends Runtime {
  name: string;
  kind: ActorKind;
}

export type CardStatus = "todo" | "doing" | "awaiting-human" | "done" | "wontfix";
export const CARD_STATUSES: CardStatus[] = ["todo", "doing", "awaiting-human", "done", "wontfix"];
export const CLOSED_STATUSES: CardStatus[] = ["done", "wontfix"];

export interface Board {
  id: string;
  slug: string;
  title: string;
  /** Freeform markdown: destination / goal, notes, fog of war, out of scope. */
  body: string;
  /** Absolute directory this board is scoped to (a repo or worktree), or null for a free-floating board. */
  project: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export type BoardState = "awaiting" | "working" | "idle" | "complete" | "archived";

/** A card in `doing`, as the boards index shows it: enough to say what is being worked and by whom. */
export interface DoingCard {
  num: number;
  title: string;
  assignee: string | null;
}

/** A board plus what the index needs to rank and describe it. Superset of Board. */
export interface BoardSummary extends Board {
  state: BoardState;
  /** Same shape as snapshot().counts. */
  counts: Record<CardStatus, number>;
  /** todo + doing + awaiting-human. */
  open: number;
  /** Every card on the board, wontfix included. */
  total: number;
  /** Most recent event on the board, or null for a board with none. */
  lastEvent: Event | null;
  /** lastEvent.createdAt, else updatedAt. The sort key within a state. */
  lastActivityAt: string;
  /** boardActors() capped to the 5 most recent writers. Liveness is the client's call. */
  team: TeamMember[];
  /** Cards in `doing`, most recently updated first, capped at 3. Empty when nothing is being worked. */
  doing: DoingCard[];
}

export interface Card {
  id: string;
  boardId: string;
  /** Per-board sequential number, the human-facing id (#12). */
  num: number;
  title: string;
  body: string;
  status: CardStatus;
  assignee: string | null;
  labels: string[];
  /** Set while status is awaiting-human. */
  question: string | null;
  questionBy: string | null;
  /**
   * The comment num of the pending question — the `question`-kind comment `askHuman` posted
   * alongside it — so a UI can react to it (and thereby answer it, card 76) without a separate
   * fetch of the card's full comment thread. Null whenever `question` is null.
   */
  questionCommentNum: number | null;
  /** Reactions already on the pending question comment, same shape and ordering as a comment's. Empty when `question` is null. */
  questionReactions: Reaction[];
  position: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Card nums that must close before this can start. */
  blockedBy: number[];
  /** Derived: true when any blocker is still open. */
  blocked: boolean;
  /** When a human parked this card, ISO. Null when it is not on hold. */
  heldAt: string | null;
  /** Who parked it. Null when it is not on hold. */
  heldBy: string | null;
  /** Why, free text. Null when there is no hold, or a hold with no reason given. */
  holdReason: string | null;
  /** Derived: `heldAt !== null`. No agent may claim a held card. */
  held: boolean;
}

/** Someone who has written on a board: the team strip's unit. */
export interface TeamMember extends Runtime {
  name: string;
  kind: ActorKind;
  /** Most recent event this actor wrote on this board. */
  lastSeen: string;
  /** How many events this actor has written on this board. */
  events: number;
}

/**
 * What an actor did to a card. `holding` is the card's own assignee field; the rest are
 * read off the event log, so they are history and never expire.
 */
export type ActorCardRole = "holding" | "claimed" | "created" | "commented" | "resolved";

export const ACTOR_CARD_ROLES: ActorCardRole[] = ["holding", "claimed", "created", "commented", "resolved"];

/** A card an actor touched, as the actor view lists it: the card itself plus why it is listed. */
export interface ActorCard extends Card {
  /** In ACTOR_CARD_ROLES order, so a row's roles read the same way every time. */
  roles: ActorCardRole[];
  /** When this actor last wrote on this card; the card's own updatedAt for a card they only hold. */
  lastTouchedAt: string;
}

/** One actor as one board knows them: who they are, what ran, and every card they touched. */
export interface ActorProfile extends Runtime {
  name: string;
  kind: ActorKind;
  /** Their most recent event on this board, or null for someone who only holds a card. */
  lastSeen: string | null;
  /** How many events they have written on this board. */
  events: number;
  /** Most recently touched first. */
  cards: ActorCard[];
}

export type CommentKind = "comment" | "question" | "answer" | "resolution";

export interface Comment {
  id: string;
  cardId: string;
  /** Per-card sequential number; with `cardNum` it spells the ref `4.2`. See ADR 0019. */
  num: number;
  /** The number of the card this comment is on — the first half of its ref. */
  cardNum: number;
  author: string;
  authorKind: ActorKind;
  kind: CommentKind;
  body: string;
  createdAt: string;
  /** Images posted with the comment, in order. Metadata only, never bytes. */
  attachments: Attachment[];
  /** Most-used emoji first, ties broken by first use. Empty when nobody has reacted. */
  reactions: Reaction[];
}

/** Metadata only — never the image bytes. */
export interface Attachment {
  id: string;
  boardId: string;
  /** An attachment hangs off exactly one of these, or neither while it is still unbound. */
  messageId: string | null;
  commentId: string | null;
  author: string;
  authorKind: ActorKind;
  mime: string;
  name: string | null;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

/**
 * One emoji on one message or comment, already aggregated for display: the web renders a row of these
 * without further grouping. `actors` is every actor who used this emoji, oldest reaction first;
 * a client decides "did I react" by looking for its own name in it.
 */
export interface Reaction {
  emoji: string;
  /** Always `actors.length`; carried explicitly so a renderer never has to count. */
  count: number;
  actors: string[];
}

export interface Message {
  id: string;
  boardId: string;
  /** Per-board sequential number, the human-facing id (`m7`). See ADR 0018. */
  num: number;
  author: string;
  authorKind: ActorKind;
  body: string;
  createdAt: string;
  attachments: Attachment[];
  /** Most-used emoji first, ties broken by first use. Empty when nobody has reacted. */
  reactions: Reaction[];
}

/** What `react`/`unreact` return: the message as it now stands, plus whether anything changed. */
export interface ReactionResult {
  message: Message;
  /** False when the reaction was already there (react) or already absent (unreact); no event was emitted. */
  changed: boolean;
}

/** What `reactToComment`/`unreactFromComment` return; the comment twin of `ReactionResult`. */
export interface CommentReactionResult {
  comment: Comment;
  /** False when the reaction was already there (react) or already absent (unreact); no event was emitted. */
  changed: boolean;
  /**
   * Set when this reaction was a human reacting to the card's still-pending question: the
   * reaction doubled as the answer (the emoji itself), and this is the card after that
   * transition. `unreactFromComment` never sets this — unreacting never un-answers.
   */
  answeredCard?: Card;
}

export interface Decision {
  id: string;
  boardId: string;
  /** Per-board sequential number, the human-facing id (`d7`). */
  num: number;
  cardNum: number | null;
  gist: string;
  author: string;
  createdAt: string;
  /** When this decision was archived, ISO. Null while it is standing. */
  archivedAt: string | null;
  /** Who archived it. Null while it is standing. */
  archivedBy: string | null;
  /** Why, free text. Null while standing, or an archive with no reason given. */
  archiveReason: string | null;
  /** The `num` of the decision that replaced this one, when archived via `--supersedes`. */
  supersededBy: number | null;
}

/** Which decisions an archive/restore call applies to. Explicit `nums`, or a filter — never both meaningfully combined. */
export interface DecisionSelector {
  nums?: number[];
  card?: number;
  author?: string;
  /** `created_at < before`. Accepts `YYYY-MM-DD` or a full ISO timestamp. */
  before?: string;
}

export type EventType =
  | "board.created"
  | "board.updated"
  | "card.created"
  | "card.updated"
  | "card.claimed"
  | "card.released"
  | "card.moved"
  | "card.closed"
  | "card.blocked"
  | "card.unblocked"
  | "card.held"
  | "card.unheld"
  | "card.asked"
  | "card.answered"
  | "comment.posted"
  | "message.posted"
  | "message.reacted"
  | "message.unreacted"
  | "comment.reacted"
  | "comment.unreacted"
  | "decision.recorded"
  | "decision.archived"
  | "decision.restored";

export interface Event extends Runtime {
  seq: number;
  boardId: string;
  actor: string;
  actorKind: ActorKind;
  type: EventType;
  cardNum: number | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export class FlockError extends Error {
  constructor(
    message: string,
    public code: "not_found" | "conflict" | "invalid" = "invalid",
    public status: number = code === "not_found" ? 404 : code === "conflict" ? 409 : 400,
  ) {
    super(message);
    this.name = "FlockError";
  }
}

import type { ActorCard, ActorCardRole, ActorProfile, Attachment, Board, BoardState, BoardSummary, Card, CardStatus, Comment, Decision, DoingCard, Event, Message, TeamMember } from "@flock/core/types";

export type { ActorCard, ActorCardRole, ActorProfile, Attachment, Board, BoardState, BoardSummary, Card, CardStatus, Comment, Decision, DoingCard, Event, Message, TeamMember };

/** Mirrors `@flock/core`'s hook field schema (not re-exported by that package's browser-safe
 * `./types` entry point, so declared locally rather than pulling in `@flock/core`'s bun:sqlite-laden
 * main index). */
export type HookFieldType = "text" | "textarea" | "select" | "checkbox";
export interface HookFieldOption {
  value: string;
  label: string;
}
export interface HookField {
  name: string;
  label: string;
  type: HookFieldType;
  required?: boolean;
  placeholder?: string;
  default?: string | boolean;
  options?: HookFieldOption[];
}
export interface HookDescribeResponse {
  enabled: boolean;
  title?: string;
  submit?: string;
  fields?: HookField[];
  warning?: string;
}

export interface Snapshot {
  board: Board;
  cards: Card[];
  /** Standing decisions only — archived ones are fetched separately, see `api.decisions`. */
  decisions: Decision[];
  /** How many decisions are archived, for the disclosure that reveals them. */
  archivedDecisionCount: number;
  messages: Message[];
  lastSeq: number;
  /** Everyone who has written on this board, newest write first. */
  team: TeamMember[];
  counts: Record<CardStatus, number>;
  frontier: number[];
  /** Cards a human has parked, excluded from `frontier`. */
  held: number[];
}

export type NeedsHuman = Card & { boardSlug: string; boardTitle: string };

/** The actors roll-up: latest-seen name/kind, with runtime cached from that actor's last write. */
export interface ActorInfo {
  name: string;
  kind: string;
  lastSeen: string;
  harness?: string;
  model?: string;
  effort?: string;
}

const ACTOR_KEY = "flock.actor";

export function getActorName(): string {
  try {
    return localStorage.getItem(ACTOR_KEY) ?? "";
  } catch {
    return "";
  }
}
export function setActorName(name: string) {
  try {
    localStorage.setItem(ACTOR_KEY, name);
  } catch {}
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public stderr?: string) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-flock-actor-kind": "human", ...extraHeaders };
  const name = getActorName();
  if (name) headers["x-flock-actor"] = name;
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    let msg = res.statusText;
    let code: string | undefined;
    let stderr: string | undefined;
    try {
      const j = await res.json();
      msg = j.error ?? msg;
      code = j.code;
      stderr = j.stderr;
    } catch {}
    throw new ApiError(msg, res.status, code, stderr);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A raw-body sibling of `req()`: the JSON helper can't send bytes. Used only for attachment upload. */
async function reqRaw<T>(path: string, blob: Blob, opts: { mime: string; width?: number; height?: number; name?: string } = { mime: blob.type }): Promise<T> {
  const headers: Record<string, string> = { "content-type": opts.mime || "application/octet-stream", "x-flock-actor-kind": "human" };
  const name = getActorName();
  if (name) headers["x-flock-actor"] = name;
  if (opts.width) headers["x-flock-width"] = String(Math.round(opts.width));
  if (opts.height) headers["x-flock-height"] = String(Math.round(opts.height));
  if (opts.name) headers["x-flock-filename"] = encodeURIComponent(opts.name);
  const res = await fetch(`/api${path}`, { method: "POST", headers, body: blob });
  if (!res.ok) {
    let msg = res.statusText;
    let code: string | undefined;
    try {
      const j = await res.json();
      msg = j.error ?? msg;
      code = j.code;
    } catch {}
    throw new ApiError(msg, res.status, code);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => req<{ actor: { name: string; kind: string }; dbPath: string }>("GET", "/me"),
  needsMe: () => req<NeedsHuman[]>("GET", "/needs-me"),
  actors: () => req<ActorInfo[]>("GET", "/actors"),
  boards: () => req<BoardSummary[]>("GET", "/boards"),
  createBoard: (input: { title: string; body?: string; project?: string }) => req<Board>("POST", "/boards", input),
  hookDescribe: () => req<HookDescribeResponse>("GET", "/hooks/board-create"),
  createBoardWithHook: (input: { title: string; inputs: Record<string, string | boolean> }) =>
    req<Board>("POST", "/boards/hook", input, { "x-flock-hook": "1" }),
  updateBoard: (b: string, patch: Partial<Pick<Board, "title" | "body" | "status">>) => req<Board>("PATCH", `/boards/${b}`, patch),
  deleteBoard: (b: string) => req<void>("DELETE", `/boards/${b}`),
  snapshot: (b: string) => req<Snapshot>("GET", `/boards/${b}`),
  /** One actor as this board knows them, plus every card they touched here. */
  actorProfile: (b: string, name: string) => req<ActorProfile>("GET", `/boards/${b}/actors/${encodeURIComponent(name)}`),
  card: (b: string, n: number) => req<{ card: Card; comments: Comment[]; blocks: number[] }>("GET", `/boards/${b}/cards/${n}`),
  createCard: (b: string, input: { title: string; body?: string; labels?: string[]; blockedBy?: number[] }) => req<Card>("POST", `/boards/${b}/cards`, input),
  updateCard: (b: string, n: number, patch: { title?: string; body?: string; addLabels?: string[]; removeLabels?: string[] }) => req<Card>("PATCH", `/boards/${b}/cards/${n}`, patch),
  claim: (b: string, n: number, force = false) => req<Card>("POST", `/boards/${b}/cards/${n}/claim`, { force }),
  release: (b: string, n: number) => req<Card>("POST", `/boards/${b}/cards/${n}/release`),
  hold: (b: string, n: number, reason?: string) => req<Card>("POST", `/boards/${b}/cards/${n}/hold`, { reason }),
  unhold: (b: string, n: number) => req<Card>("POST", `/boards/${b}/cards/${n}/unhold`),
  toggleTask: (b: string, n: number, index: number, checked: boolean) =>
    req<Card>("POST", `/boards/${b}/cards/${n}/toggle-task`, { index, checked }),
  move: (b: string, n: number, status: CardStatus, reason?: string, attachments?: string[]) =>
    req<Card>("POST", `/boards/${b}/cards/${n}/move`, { status, reason, attachments }),
  close: (b: string, n: number, resolution?: string, status: "done" | "wontfix" = "done") => req<Card>("POST", `/boards/${b}/cards/${n}/close`, { resolution, status }),
  ask: (b: string, n: number, question: string) => req<Card>("POST", `/boards/${b}/cards/${n}/ask`, { question }),
  answer: (b: string, n: number, answer: string) => req<Card>("POST", `/boards/${b}/cards/${n}/answer`, { answer }),
  comment: (b: string, n: number, body: string, attachments?: string[]) =>
    req<Comment>("POST", `/boards/${b}/cards/${n}/comments`, { body, attachments }),
  block: (b: string, n: number, by: number) => req<Card>("POST", `/boards/${b}/cards/${n}/blockers`, { by }),
  unblock: (b: string, n: number, by: number) => req<Card>("DELETE", `/boards/${b}/cards/${n}/blockers/${by}`),
  say: (b: string, body: string, attachments?: string[]) => req<Message>("POST", `/boards/${b}/messages`, { body, attachments }),
  uploadAttachment: (b: string, blob: Blob, opts: { width?: number; height?: number; name?: string; mime?: string } = {}) =>
    reqRaw<Attachment>(`/boards/${b}/attachments`, blob, { mime: opts.mime ?? blob.type, width: opts.width, height: opts.height, name: opts.name }),
  decide: (b: string, gist: string, card?: number | null, supersedes?: number) =>
    req<Decision>("POST", `/boards/${b}/decisions`, { gist, card, supersedes }),
  decisions: (b: string, q?: { archived?: "1" | "all" }) =>
    req<Decision[]>("GET", `/boards/${b}/decisions${q?.archived ? `?archived=${q.archived}` : ""}`),
  archiveDecisions: (b: string, sel: { nums?: number[]; card?: number; author?: string; before?: string }, reason?: string) =>
    req<{ archived: Decision[] }>("POST", `/boards/${b}/decisions/archive`, { ...sel, reason }),
  restoreDecisions: (b: string, sel: { nums?: number[]; card?: number; author?: string; before?: string }) =>
    req<{ restored: Decision[] }>("POST", `/boards/${b}/decisions/restore`, sel),
  events: (b: string, since = 0) => req<Event[]>("GET", `/boards/${b}/events?since=${since}`),
  eventsTail: (b: string, limit = 50) => req<Event[]>("GET", `/boards/${b}/events?tail=1&limit=${limit}`),
  allEvents: (since = 0) => req<Event[]>("GET", `/events?since=${since}`),
};

export function attachmentUrl(board: string, id: string): string {
  return `/api/boards/${board}/attachments/${id}`;
}

/** SSE paths. `useLiveStream` in live.ts owns the connection, resume and reconnect. */
export const streamPath = {
  board: (boardId: string) => `/api/boards/${boardId}/stream`,
  all: () => `/api/stream`,
};

/**
 * Spawned agents and the extra directories a board is scoped to (ADR 0029 §1, §4). The store
 * only: launching a session is the CLI's job, and core never touches a process or a path.
 */
import type { Database } from "bun:sqlite";
import type { Agent, AgentStatus } from "./types.ts";

type AgentRow = {
  board_id: string; name: string; card_num: number | null; harness: string; model: string | null; effort: string | null;
  session_key: string | null; open_url: string | null; cwd: string; pid: number | null; launcher: string; status: string;
  inbox_seq: number; created_at: string; updated_at: string;
};

export type NewAgent = Pick<Agent, "name" | "cardNum" | "harness" | "model" | "effort" | "sessionKey" | "openUrl" | "cwd" | "pid" | "launcher">;

export type AgentPatch = Partial<Pick<Agent, "sessionKey" | "openUrl" | "pid" | "status">>;

function rowToAgent(r: AgentRow): Agent {
  return {
    boardId: r.board_id,
    name: r.name,
    cardNum: r.card_num,
    harness: r.harness,
    model: r.model,
    effort: r.effort,
    sessionKey: r.session_key,
    openUrl: r.open_url,
    cwd: r.cwd,
    pid: r.pid,
    launcher: r.launcher,
    status: r.status as AgentStatus,
    inboxSeq: r.inbox_seq,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Record a spawned agent. Spawning a name again on the same board replaces its row — a fresh
 * session for the same worker — but keeps its inbox cursor, so what it has not read stays unread.
 */
export function upsertAgent(db: Database, boardId: string, input: NewAgent, at: string): Agent {
  db.query(
    `INSERT INTO agents(board_id, name, card_num, harness, model, effort, session_key, open_url, cwd, pid, launcher, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
     ON CONFLICT(board_id, name) DO UPDATE SET
       card_num = excluded.card_num, harness = excluded.harness, model = excluded.model, effort = excluded.effort,
       session_key = excluded.session_key, open_url = excluded.open_url, cwd = excluded.cwd, pid = excluded.pid,
       launcher = excluded.launcher, status = 'running', updated_at = excluded.updated_at`,
  ).run(boardId, input.name, input.cardNum, input.harness, input.model, input.effort, input.sessionKey, input.openUrl, input.cwd, input.pid, input.launcher, at, at);
  return agentRow(db, boardId, input.name)!;
}

export function agentRow(db: Database, boardId: string, name: string): Agent | null {
  const r = db.query("SELECT * FROM agents WHERE board_id = ? AND name = ?").get(boardId, name) as AgentRow | null;
  return r ? rowToAgent(r) : null;
}

export function agentRows(db: Database, boardId: string): Agent[] {
  const rows = db.query("SELECT * FROM agents WHERE board_id = ? ORDER BY created_at").all(boardId) as AgentRow[];
  return rows.map(rowToAgent);
}

export function patchAgent(db: Database, boardId: string, name: string, patch: AgentPatch, at: string) {
  const current = agentRow(db, boardId, name);
  if (!current) return null;
  const next = { ...current, ...patch };
  db.query("UPDATE agents SET session_key = ?, open_url = ?, pid = ?, status = ?, updated_at = ? WHERE board_id = ? AND name = ?")
    .run(next.sessionKey, next.openUrl, next.pid, next.status, at, boardId, name);
  return agentRow(db, boardId, name);
}

/** Advance an agent's read cursor; never backwards. */
export function markInboxRead(db: Database, boardId: string, name: string, seq: number) {
  db.query("UPDATE agents SET inbox_seq = MAX(inbox_seq, ?) WHERE board_id = ? AND name = ?").run(seq, boardId, name);
}

/** Scope `dir` to a board on behalf of a card; closing that card unlinks it. */
export function linkDir(db: Database, boardId: string, dir: string, cardNum: number | null, at: string) {
  db.query("INSERT INTO board_dirs(dir, board_id, card_num, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(dir) DO UPDATE SET board_id = excluded.board_id, card_num = excluded.card_num")
    .run(dir, boardId, cardNum, at);
}

export function unlinkCardDirs(db: Database, boardId: string, cardNum: number) {
  db.query("DELETE FROM board_dirs WHERE board_id = ? AND card_num = ?").run(boardId, cardNum);
}

/** Every linked directory, as `[dir, boardId]` pairs. */
export function linkedDirs(db: Database): { dir: string; boardId: string }[] {
  return db.query("SELECT dir, board_id AS boardId FROM board_dirs").all() as { dir: string; boardId: string }[];
}

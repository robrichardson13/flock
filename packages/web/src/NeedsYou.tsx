import { useState, type CSSProperties } from "react";
import { api, getActorName, type Card } from "./api.ts";
import { agoText } from "./App.tsx";
import { enterClass } from "./live.ts";
import { MessageBody } from "./markdown.tsx";
import { hasReaction, MessageReactions, ReactionSheet, useDoubleTapReact, type ThreadEntry } from "./thread.tsx";

/** The pending question, reshaped as a `ThreadEntry` so it can go through the same
 *  `useDoubleTapReact`/`ReactionSheet`/`MessageReactions` machinery every other reactable row
 *  uses (card 76). Only `num` and `reactions` are ever read back out of it; the rest exists to
 *  satisfy the shared shape. */
export interface QuestionEntry extends ThreadEntry {
  num: number;
  reactions: Card["questionReactions"];
}

export function questionEntry(card: Card): QuestionEntry | null {
  if (!card.questionCommentNum) return null;
  return {
    id: `${card.id}-question`,
    author: card.questionBy ?? "",
    authorKind: "agent",
    createdAt: card.updatedAt,
    body: card.question ?? "",
    num: card.questionCommentNum,
    reactions: card.questionReactions,
  };
}

/** One question waiting on the human, with its answer box. Used on Home (cross-board) and inside a board.
 *  Double-tapping anywhere on the panel opens the same reaction sheet a comment gets; reacting
 *  here — a human is the only actor who ever drives this UI — answers the question with the
 *  emoji itself (core's `reactToComment`), the same way typing an answer and hitting Answer
 *  does. A tap on the input or the Answer button is never mistaken for the gesture. */
export function NeedsYou({ boardId, card, boardTitle, boardSlug, onDone, isNew, moved, tint, style }: { boardId: string; card: Card; boardTitle?: string; boardSlug?: string; onDone?: () => void; isNew?: boolean; moved?: boolean; tint?: boolean; style?: CSSProperties }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<QuestionEntry | null>(null);
  const me = getActorName();
  const submit = async () => {
    if (!answer.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.answer(boardId, card.num, answer.trim());
      setAnswer("");
      onDone?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggleReaction = async (entry: QuestionEntry, emoji: string, mine: boolean) => {
    try {
      if (mine) await api.unreactFromComment(boardId, card.num, entry.num, emoji);
      else await api.reactToComment(boardId, card.num, entry.num, emoji);
      onDone?.();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const tapHandlers = useDoubleTapReact<QuestionEntry>((entry) => {
    setPicked(entry);
    return true;
  });
  const q = questionEntry(card);
  const href = boardSlug ? `#/b/${boardSlug}/c/${card.num}` : undefined;
  return (
    <div className={`needs-item${enterClass(!!isNew)}${moved ? " moved" : ""}${tint ? " replay-tint" : ""}`} style={style} data-anchor data-flip={card.id} {...(q ? tapHandlers(q) : {})}>
      <a className="needs-meta" href={href}>
        {boardTitle && <span className="needs-board">{boardTitle}</span>}
        <span className="card-num">#{card.num}</span>
        <span className="ellipsis grow">{card.title}</span>
      </a>
      <div className="needs-q">{card.question && <MessageBody text={card.question} />}</div>
      <div className="needs-by muted small">{card.questionBy} asked {agoText(card.updatedAt)}</div>
      {q && <MessageReactions reactions={q.reactions} viewer={me} onToggle={(emoji, mine) => toggleReaction(q, emoji, mine)} />}
      <form
        className="row gap"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input className="input grow" placeholder="Your answer" value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={busy} enterKeyHint="send" />
        <button type="submit" className="btn btn-primary" disabled={busy || !answer.trim()}>Answer</button>
      </form>
      {err && <div className="inline-error">{err}</div>}
      <ReactionSheet
        entry={picked}
        onClose={() => setPicked(null)}
        isMine={(entry, emoji) => hasReaction(entry.reactions, me, emoji)}
        onPick={(entry, emoji, mine) => toggleReaction(entry, emoji, mine)}
      />
    </div>
  );
}

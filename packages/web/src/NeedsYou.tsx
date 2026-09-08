import { useState, type CSSProperties } from "react";
import { api, type Card } from "./api.ts";
import { agoText } from "./App.tsx";
import { enterClass } from "./live.ts";
import { MessageBody } from "./markdown.tsx";

/** One question waiting on the human, with its answer box. Used on Home (cross-board) and inside a board. */
export function NeedsYou({ boardId, card, boardTitle, boardSlug, onDone, isNew, moved, tint, style }: { boardId: string; card: Card; boardTitle?: string; boardSlug?: string; onDone?: () => void; isNew?: boolean; moved?: boolean; tint?: boolean; style?: CSSProperties }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
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
  const href = boardSlug ? `#/b/${boardSlug}/c/${card.num}` : undefined;
  return (
    <div className={`needs-item${enterClass(!!isNew)}${moved ? " moved" : ""}${tint ? " replay-tint" : ""}`} style={style} data-anchor data-flip={card.id}>
      <a className="needs-meta" href={href}>
        {boardTitle && <span className="needs-board">{boardTitle}</span>}
        <span className="card-num">#{card.num}</span>
        <span className="ellipsis grow">{card.title}</span>
      </a>
      <div className="needs-q">{card.question && <MessageBody text={card.question} />}</div>
      <div className="needs-by muted small">{card.questionBy} asked {agoText(card.updatedAt)}</div>
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
    </div>
  );
}

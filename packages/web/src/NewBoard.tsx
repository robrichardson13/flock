import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.ts";
import { Sheet } from "./ui.tsx";
import { autoFocusField } from "./focus.ts";

const PROJECT_HINT = "Boards for a project directory come from `flock init` in that directory.";

/** The "+" dialog: a title and an optional project directory. `POST /api/boards`. */
export function NewBoard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Fresh state on every open.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setProject("");
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // #13: `preventScroll`, or WebKit scrolls to reveal the field it has just been handed
    // and takes the whole fixed shell with it.
    const id = setTimeout(() => autoFocusField(titleRef.current), 50);
    return () => clearTimeout(id);
  }, [open]);

  const valid = !submitting && title.trim().length > 0;

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const board = await api.createBoard({ title: title.trim(), project: project.trim() || undefined });
      window.location.hash = `#/b/${board.slug}`;
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="New board" hideClose>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={titleRef}
          className="input input-lg"
          placeholder="Board title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <input
          className="input"
          placeholder="Project directory (optional, absolute path)"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        />
        <div className="muted small">{PROJECT_HINT}</div>

        {error && <div className="inline-error">{error}</div>}

        <div className="row gap end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!valid}>{submitting ? "Creating…" : "Create board"}</button>
        </div>
      </form>
    </Sheet>
  );
}

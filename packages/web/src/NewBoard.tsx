import { useEffect, useRef, useState } from "react";
import { api, ApiError, type HookDescribeResponse, type HookField } from "./api.ts";
import { Sheet } from "./ui.tsx";
import { autoFocusField } from "./focus.ts";

const PROJECT_HINT = "Boards for a project directory come from `flock init` in that directory.";

type Values = Record<string, string | boolean>;

/**
 * The value a field starts on. A `select` needs care: React drives it by value, so a value that is
 * not one of its options leaves the control showing nothing while `required` keeps Create disabled
 * — and a required select renders no blank option for the human to pick their way out of. So a
 * required select whose `default` is missing (or is not one of its options) starts on the first
 * option, which is what a plain HTML form would have shown anyway.
 */
export function defaultFor(f: HookField): string | boolean {
  if (f.type === "checkbox") return typeof f.default === "boolean" ? f.default : false;
  const preferred = typeof f.default === "string" ? f.default : "";
  if (f.type !== "select") return preferred;
  const options = f.options ?? [];
  if (options.some((o) => o.value === preferred)) return preferred;
  return f.required ? (options[0]?.value ?? "") : "";
}

export function defaultsFor(fields: HookField[]): Values {
  const v: Values = {};
  for (const f of fields) v[f.name] = defaultFor(f);
  return v;
}

/** True once every required, non-checkbox field the hook declared has a non-blank value. */
export function requiredFieldsMet(fields: HookField[], values: Values): boolean {
  return fields.every((f) => !f.required || f.type === "checkbox" || String(values[f.name] ?? "").trim().length > 0);
}

/**
 * The "+" dialog: fetches `GET /api/hooks/board-create` on open and renders either the
 * hook's declared fields (`POST /api/boards/hook`) or a plain title + optional project
 * directory (`POST /api/boards`). See ADR 0008 and card #4 design §6.
 */
export function NewBoard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [describe, setDescribe] = useState<HookDescribeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [values, setValues] = useState<Values>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stderr, setStderr] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // What the last fetch answered, so a revalidation does not blank the sheet it is in.
  const describeRef = useRef<HookDescribeResponse | null>(null);
  describeRef.current = describe;

  // Fresh state on every open; an in-flight fetch from a since-closed dialog is dropped.
  //
  // #15: the hook description is fetched on *mount*, not on open, and a re-open revalidates
  // without throwing the last answer away. A sheet is bottom-anchored, so anything that
  // changes its content height after it is up moves its top edge: with the fetch starting at
  // open, the sheet came up 199px tall around the "checking…" line and grew to 579px a frame
  // or two later — its top jumping from 685 to 288 at 390x844. Fetching at mount means the
  // fields are known long before the "+" is tapped and the sheet's first painted height is
  // its final one. `loading` is now only true while there is nothing to show at all.
  useEffect(() => {
    setTitle("");
    setProject("");
    setValues({});
    setError(null);
    setStderr(null);
    // Closing does not need a fetch; the mount already did one and re-opening revalidates.
    if (!open && describeRef.current) return;
    if (!describeRef.current) setLoading(true);
    let cancelled = false;
    api
      .hookDescribe()
      .then((d) => {
        if (cancelled) return;
        setDescribe(d);
        setValues(defaultsFor(d.fields ?? []));
      })
      .catch(() => {
        if (cancelled) return;
        setDescribe({ enabled: false, warning: "Could not check for a board-creation hook." });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || loading) return;
    // #13: `preventScroll`, or WebKit scrolls to reveal the field it has just been handed
    // and takes the whole fixed shell with it. #15: on the phone it does not focus at all —
    // the keyboard would not come, and the dead focus cost a sheet jump and a lost
    // interception. See `autoFocusField` in focus.ts.
    const id = setTimeout(() => autoFocusField(titleRef.current), 50);
    return () => clearTimeout(id);
  }, [open, loading]);

  const fields = describe?.fields ?? [];
  const valid = !submitting && !loading && title.trim().length > 0 && (!describe?.enabled || requiredFieldsMet(fields, values));

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    setStderr(null);
    try {
      const board = describe?.enabled
        ? await api.createBoardWithHook({ title: title.trim(), inputs: values })
        : await api.createBoard({ title: title.trim(), project: project.trim() || undefined });
      window.location.hash = `#/b/${board.slug}`;
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setStderr(e.stderr ?? null);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  // The trigger button says "New board" (`AppTopBar`'s onNewBoard item); the sheet title and the
  // submit button keep that same noun rather than a hook's own wording ("New workspace" / "Create
  // workspace") — one flow, one noun, wherever it appears. A hook's `title`/`submit` still reach
  // `flock hook describe` on the CLI; only the web dialog fixes them to the trigger's noun.
  const dialogTitle = "New board";
  const submitLabel = submitting ? "Creating…" : "Create board";

  return (
    <Sheet open={open} onClose={onClose} title={dialogTitle} hideClose>
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

        {loading && <div className="muted small">Checking for a board-creation hook…</div>}

        {!loading && describe?.enabled && fields.map((f) => (
          <HookFieldInput
            key={f.name}
            field={f}
            value={values[f.name]}
            onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))}
          />
        ))}

        {!loading && describe && !describe.enabled && (
          <div className="hook-field">
            <input
              className="input"
              placeholder="Project directory (optional, absolute path)"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            />
            <div className="muted small">{PROJECT_HINT}</div>
          </div>
        )}

        {!loading && describe?.warning && <div className="muted small">{describe.warning}</div>}

        {error && (
          <div className="inline-error">
            {error}
            {stderr && <pre className="hook-stderr"><code>{stderr}</code></pre>}
          </div>
        )}

        <div className="row gap end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!valid}>{submitLabel}</button>
        </div>
      </form>
    </Sheet>
  );
}

/**
 * One form grammar with New card: a placeholder carries the field's name, never a label sitting
 * above the control (#27, critique finding F10). A `select` has no `placeholder` attribute of its
 * own, so an optional field's blank entry is labelled with the field's name instead of rendering
 * empty, and the control dims to `.input`'s placeholder colour while that blank entry is selected —
 * the same "unfilled" look a text input's placeholder gives for free.
 */
function HookFieldInput({ field, value, onChange }: { field: HookField; value: string | boolean | undefined; onChange: (v: string | boolean) => void }) {
  const id = `hf-${field.name}`;
  const placeholder = field.placeholder || field.label;

  if (field.type === "checkbox") {
    return (
      <label className="row gap" htmlFor={id}>
        <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span>{field.label}</span>
      </label>
    );
  }

  if (field.type === "select") {
    const options = field.options ?? [];
    const blank = (value as string) === "";
    // A hook is free to declare its own blank entry (the nib example's Group field ships
    // {value: "", label: "(none)"}); add the synthetic placeholder only when it didn't, so an
    // optional select never shows two "no value" rows.
    const hasOwnBlank = options.some((o) => o.value === "");
    return (
      <span className="select-wrap">
        <select
          id={id}
          className={`select${blank ? " select-placeholder" : ""}`}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {!field.required && !hasOwnBlank && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.value === "" ? o.label || placeholder : o.label}</option>
          ))}
        </select>
      </span>
    );
  }

  if (field.type === "textarea") {
    return (
      <textarea id={id} className="textarea" rows={3} placeholder={placeholder} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
    );
  }

  return (
    <input id={id} className="input" placeholder={placeholder} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
  );
}

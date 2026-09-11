import type { ReactNode } from "react";
import type { PushState } from "./push.ts";
import { Icons, Sheet } from "./ui.tsx";

type PushKind = PushState["kind"];

/** One entry in a `.push-note` callout: the neutral/warn/attention body, its optional numbered
 *  steps (`needs-install` only) and its optional trailing hint line (`blocked` only). */
interface PushNote {
  text?: string;
  steps?: string[];
  hint?: string;
}

interface Treatment {
  /** `Icons.bell` or `Icons.bellOff`, per §2's table. */
  icon: (s?: number) => ReactNode;
  /** The Home row's meta line and, doubled, the panel's row-summary reading. */
  meta: string;
  /** Whether `.push-dot--{kind}` has anything to paint (`on`/`blocked`/`needs-install`). */
  dot: boolean;
  /** Present for every kind but `on`/`off`: the panel's explanatory callout. */
  note?: PushNote;
}

/**
 * The §2 treatment table, once, as data — so `PushRow` and `PushPanel` read the same icon,
 * colour class, copy and callout for a given `PushState["kind"]` and cannot drift apart.
 */
export const TREATMENT: Record<PushKind, Treatment> = {
  on: {
    icon: Icons.bell,
    meta: "On for this device",
    dot: true,
  },
  off: {
    icon: Icons.bell,
    meta: "Off — turn on to get pinged when a card needs you",
    dot: false,
  },
  blocked: {
    icon: Icons.bellOff,
    meta: "Blocked in your browser settings",
    dot: true,
    note: {
      text: "Notifications are blocked for this site. flock can't ask again.",
      hint: "Safari: Settings → Notifications → flock. Chrome: the icon at the left of the address bar.",
    },
  },
  "needs-install": {
    icon: Icons.bell,
    meta: "Add flock to your Home Screen first",
    dot: true,
    note: {
      steps: [
        "Tap the Share button in Safari.",
        "Choose “Add to Home Screen”.",
        "Open flock from your Home Screen, then turn notifications on there.",
      ],
    },
  },
  "server-off": {
    icon: Icons.bellOff,
    meta: "Not set up on this server",
    dot: false,
    note: {
      text: "This flock server has no notification key, so it can't send anything yet.",
      hint: "Set FLOCK_VAPID_PUBLIC_KEY and FLOCK_VAPID_PRIVATE_KEY, or give the server a writable ~/.flock.",
    },
  },
  insecure: {
    icon: Icons.bellOff,
    meta: "Needs a secure connection",
    dot: false,
    note: { text: "Notifications need HTTPS. Open flock over https://, or on localhost." },
  },
  unsupported: {
    icon: Icons.bellOff,
    meta: "Not supported in this browser",
    dot: false,
    note: { text: "This browser doesn't support notifications. Chrome, Edge, Firefox and Safari 16.4+ do." },
  },
};

/**
 * The Home row: one tap opens the panel. In `off` the trailing button enables directly, without
 * a round trip through the panel — the row's own gesture is a valid place to fire
 * `Notification.requestPermission()` from.
 */
export function PushRow({ state, busy, error, onEnable, onOpen }: {
  state: PushState;
  busy: boolean;
  error: string | null;
  onEnable: () => void;
  onOpen: () => void;
}) {
  const t = TREATMENT[state.kind];
  return (
    <section className="section">
      <div className="section-head"><h2>Notifications</h2></div>
      <div className="list">
        <button className="list-row push-row" onClick={onOpen}>
          <span className={`push-icon push-icon--${state.kind}`}>{t.icon(20)}</span>
          <div className="list-main">
            <div className="list-title">Notifications</div>
            {error
              ? <div className="inline-error">{error}</div>
              : <div className="push-meta">{t.meta}</div>}
          </div>
          {state.kind === "off"
            ? (
              <button
                className="btn btn-primary push-row-btn"
                disabled={busy}
                aria-busy={busy}
                onClick={(e) => { e.stopPropagation(); onEnable(); }}
              >
                {busy ? "Turning on…" : "Turn on notifications"}
              </button>
            )
            : (
              <>
                <span className={`push-dot push-dot--${state.kind}`} />
                <span className="chev">{Icons.chevron(18)}</span>
              </>
            )}
        </button>
      </div>
    </section>
  );
}

/**
 * The panel: a `Sheet` (bottom sheet on the phone, centred dialog on desktop) opened from either
 * the row or the identity menu. Test-send and the device list are card D's; this card's `on`
 * state shows only the lead line and the `Turn off` button, per the row/panel split in §5.
 */
export function PushPanel({ open, onClose, state, busy, error, onEnable, onDisable }: {
  open: boolean;
  onClose: () => void;
  state: PushState;
  busy: boolean;
  error: string | null;
  onEnable: () => void;
  onDisable: () => void;
}) {
  const t = TREATMENT[state.kind];
  const note = t.note;
  return (
    <Sheet open={open} onClose={onClose} title="Notifications" className="push-sheet" hideClose>
      <div className="push-panel">
        <p className="push-lead muted">Get a notification when someone posts in a channel, or when a card needs you.</p>

        {note && (
          <div className={`push-note push-note--${state.kind}`}>
            <span className="push-note-icon">{Icons.bellOff(18)}</span>
            <div>
              {note.text && <p>{note.text}</p>}
              {note.steps && <ol className="push-steps">{note.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
              {note.hint && <p className="push-hint">{note.hint}</p>}
            </div>
          </div>
        )}

        {(state.kind === "on" || state.kind === "off") && (
          <div className="push-actions">
            <button
              className={`btn ${state.kind === "on" ? "" : "btn-primary"} btn-block`}
              disabled={busy}
              aria-busy={busy}
              onClick={state.kind === "on" ? onDisable : onEnable}
            >
              {busy
                ? (state.kind === "on" ? "Turning off…" : "Turning on…")
                : (state.kind === "on" ? "Turn off" : "Turn on notifications")}
            </button>
            {error && <div className="inline-error">{error}</div>}
          </div>
        )}

        {/* Test send and the device list are card D's; `on` renders nothing further here. */}
      </div>
      <button className="btn btn-block btn-ghost sheet-cancel" onClick={onClose}>Done</button>
    </Sheet>
  );
}

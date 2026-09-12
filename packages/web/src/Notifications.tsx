import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type NotifySettings, type NotifySettingsFields, type PushSubscriptionSummary } from "./api.ts";
import { agoText } from "./App.tsx";
import { deviceLabel } from "./devices.ts";
import { currentSubscription, type PushState } from "./push.ts";
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

/** ADR 0024's "What buzzes" section: one row per toggle, ordered urgent-to-chatty. */
interface ToggleRow {
  key: keyof NotifySettingsFields;
  title: string;
  body: string;
}

const TOGGLE_ROWS: readonly ToggleRow[] = [
  { key: "needsMe", title: "Needs me", body: "A card is waiting on your answer." },
  { key: "review", title: "Review requested", body: "A PR is up, or screenshots are ready to look at." },
  { key: "info", title: "Everything else", body: "Every channel message and card update." },
  { key: "settled", title: "Quiet check-in", body: "One ping when a board goes quiet." },
];

/** The quiet-check-in threshold options offered in the sheet. */
export const THRESHOLD_OPTIONS_MS: readonly number[] = [15, 30, 60, 120, 240].map((m) => m * 60_000);

/** "15m" under an hour, "2h" at or above one — used for both the fixed options and a stored
 *  value that does not match any of them (the server default is 20 minutes). */
export function formatThreshold(ms: number): string {
  return ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`;
}

/** The select's options: the fixed list, plus the current value slotted in if it is not
 *  already one of them, so the control always has a matching option instead of silently
 *  rounding away from what is actually stored. */
function thresholdOptions(currentMs: number): number[] {
  if (THRESHOLD_OPTIONS_MS.includes(currentMs)) return [...THRESHOLD_OPTIONS_MS];
  return [...THRESHOLD_OPTIONS_MS, currentMs].sort((a, b) => a - b);
}

/** A plain on/off control with no dependency beyond the tokens `.push-panel` already uses. */
function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

/**
 * ADR 0024: the four independent toggles plus the quiet-check-in threshold, fetched and saved
 * against either the actor's global row (`board` omitted, opened from Home) or one board's
 * override (opened from a board's menu). Save-on-toggle, optimistic with a revert on failure —
 * nothing here swallows an error; a failed PUT rolls the switch back and shows `.inline-error`.
 */
export function NotifyPrefs({ open, board, onGlobalChange }: {
  open: boolean;
  /** Omitted/undefined: editing the actor's global row. Present: this board's override. */
  board?: { slug: string; title: string } | null;
  /** Told the resolved *global* settings after every load/save that touched the global row —
   *  App.tsx uses this to keep the bell honest without fetching settings itself. */
  onGlobalChange?: (resolved: NotifySettings) => void;
}) {
  const boardSlug = board?.slug;
  const [resolved, setResolved] = useState<NotifySettings | null>(null);
  const [raw, setRaw] = useState<NotifySettingsFields | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(() => {
    api.notifySettings(boardSlug)
      .then((r) => {
        setResolved(r.resolved);
        setRaw(r.raw);
        setLoadError(null);
        if (!boardSlug) onGlobalChange?.(r.resolved);
      })
      .catch((e) => setLoadError((e as Error).message));
    // onGlobalChange is expected stable (a useCallback in App.tsx); including it would refetch
    // on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardSlug]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const patch = useCallback((fields: Partial<NotifySettingsFields>) => {
    const prevResolved = resolved;
    const prevRaw = raw;
    setSaveError(null);
    setResolved((r) => (r ? { ...r, ...(fields as Partial<NotifySettings>) } : r));
    setRaw((r) => ({ needsMe: null, review: null, info: null, settled: null, settledAfterMs: null, ...r, ...fields }));
    return api.putNotifySettings(fields, boardSlug)
      .then((res) => {
        setResolved(res.resolved);
        setRaw(res.raw);
        if (!boardSlug) onGlobalChange?.(res.resolved);
      })
      .catch((e) => {
        setResolved(prevResolved);
        setRaw(prevRaw);
        setSaveError((e as Error).message);
        throw e;
      });
  }, [resolved, raw, boardSlug, onGlobalChange]);

  const onToggle = (key: ToggleRow["key"], next: boolean) => { patch({ [key]: next }).catch(() => {}); };
  const onThreshold = (ms: number) => { patch({ settledAfterMs: ms }).catch(() => {}); };
  const hasOverride = !!board && !!raw && Object.values(raw).some((v) => v !== null);
  const onReset = () => {
    setResetting(true);
    patch({ needsMe: null, review: null, info: null, settled: null, settledAfterMs: null })
      .catch(() => {})
      .finally(() => setResetting(false));
  };

  if (!resolved && !loadError) return null;

  return (
    <section className="section notify-prefs">
      <div className="section-head">
        <h2>What buzzes</h2>
        {board && (
          <button type="button" className="linkish small notify-reset" disabled={!hasOverride || resetting} onClick={onReset}>
            Same as all boards
          </button>
        )}
      </div>
      {board && <p className="muted small notify-board-name">For {board.title}</p>}
      {loadError && <div className="inline-error">Couldn't load notification settings: {loadError}</div>}
      {resolved && (
        <div className="notify-toggle-list">
          {TOGGLE_ROWS.map((row) => {
            const inherited = board ? raw?.[row.key] == null : false;
            const checked = resolved[row.key] as boolean;
            return (
              <div key={row.key} className={`notify-toggle-row${inherited ? " inherited" : ""}`}>
                <div className="notify-toggle-main">
                  <div className="notify-toggle-title">{row.title}</div>
                  <div className="notify-toggle-body muted">{row.body}</div>
                  {row.key === "settled" && checked && (
                    <select
                      className="notify-threshold"
                      aria-label="Check in after"
                      value={resolved.settledAfterMs}
                      onChange={(e) => onThreshold(Number(e.target.value))}
                    >
                      {thresholdOptions(resolved.settledAfterMs).map((ms) => (
                        <option key={ms} value={ms}>{formatThreshold(ms)}</option>
                      ))}
                    </select>
                  )}
                </div>
                <Switch checked={checked} onChange={(next) => onToggle(row.key, next)} label={row.title} />
              </div>
            );
          })}
        </div>
      )}
      {saveError && <div className="inline-error">{saveError}</div>}
    </section>
  );
}

/**
 * The panel: a `Sheet` (bottom sheet on the phone, centred dialog on desktop) opened from either
 * the row or the identity menu. `on` additionally owns the test-send button and the device list
 * (§5) — both fetched here, not threaded down from `App.tsx`, since they are this panel's own
 * business and nothing else on the page needs them.
 */
export function PushPanel({ open, onClose, state, busy, error, onEnable, onDisable, board, onGlobalNotifyChange }: {
  open: boolean;
  onClose: () => void;
  state: PushState;
  busy: boolean;
  error: string | null;
  onEnable: () => void;
  onDisable: () => void;
  /** ADR 0024: opened from a board rather than Home, so "What buzzes" edits that board's
   *  override instead of the actor's global row. */
  board?: { slug: string; title: string } | null;
  onGlobalNotifyChange?: (resolved: NotifySettings) => void;
}) {
  const t = TREATMENT[state.kind];
  const note = t.note;

  // Devices: fetched whenever the panel is open and the state is `on` (covers first open and a
  // fresh enable), and re-fetched explicitly after a successful remove. A failed fetch renders
  // nothing (§5: "one device is the normal case", not an error box) rather than a silent stale
  // list — the next open/enable/remove tries again.
  const [devices, setDevices] = useState<PushSubscriptionSummary[]>([]);
  const [mine, setMine] = useState<string | null>(null);
  const loadDevices = useCallback(() => {
    Promise.all([api.pushSubscriptions(), currentSubscription()])
      .then(([subs, sub]) => {
        setDevices(subs);
        setMine(sub?.endpoint ?? null);
      })
      .catch(() => {
        setDevices([]);
        setMine(null);
      });
  }, []);
  useEffect(() => {
    if (open && state.kind === "on") loadDevices();
  }, [open, state.kind, loadDevices]);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removingEndpoint, setRemovingEndpoint] = useState<string | null>(null);

  // Test result/error and any remove error are this open of the panel's business only.
  useEffect(() => {
    if (!open) {
      setTestResult(null);
      setTestError(null);
      setRemoveError(null);
    }
  }, [open]);

  const onTest = useCallback(() => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    api.pushTest()
      .then(({ sent }) => {
        setTestResult(sent === 0 ? "No devices to send to." : sent === 1 ? "Sent to 1 device." : `Sent to ${sent} devices.`);
      })
      .catch((e) => setTestError((e as Error).message))
      .finally(() => setTesting(false));
  }, []);

  const onRemove = useCallback((endpoint: string) => {
    setRemovingEndpoint(endpoint);
    setRemoveError(null);
    api.pushUnsubscribe(endpoint)
      .then(loadDevices)
      .catch((e) => setRemoveError((e as Error).message))
      .finally(() => setRemovingEndpoint(null));
  }, [loadDevices]);

  // This device first (§5), identified by matching the live browser subscription's endpoint.
  const sorted = mine ? [...devices].sort((a, b) => (a.endpoint === mine ? -1 : b.endpoint === mine ? 1 : 0)) : devices;

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

        {state.kind === "on" && (
          <>
            {/* ADR 0024: settings for notifications you are not receiving is a puzzle, not a
                feature, so this only ever shows once push is actually on. */}
            <NotifyPrefs open={open} board={board} onGlobalChange={onGlobalNotifyChange} />

            <div className="push-test">
              <button className="btn btn-block" disabled={testing} aria-busy={testing} onClick={onTest}>
                {testing ? "Sending…" : "Send a test notification"}
              </button>
              {testResult && <p className="push-hint">{testResult}</p>}
              {testError && <div className="inline-error">{testError}</div>}
            </div>

            {devices.length > 0 && (
              <section className="section push-devices">
                <div className="section-head"><h2>Devices</h2><span className="section-count">{devices.length}</span></div>
                <div className="list">
                  {sorted.map((d) => {
                    const isMine = d.endpoint === mine;
                    const label = deviceLabel(d.userAgent);
                    return (
                      <div key={d.id} className="list-row push-device" title={d.userAgent ?? undefined}>
                        <div className="list-main">
                          <div className="list-title">{label}</div>
                          <div className="push-meta">
                            {isMine ? "This device" : d.lastUsedAt ? `Last used ${agoText(d.lastUsedAt)}` : "Never used"}
                          </div>
                        </div>
                        {!isMine && (
                          <button
                            className="icon-btn push-device-remove"
                            aria-label={`Remove ${label}`}
                            disabled={removingEndpoint === d.endpoint}
                            onClick={() => onRemove(d.endpoint)}
                          >
                            {Icons.trash(16)}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {removeError && <div className="inline-error">{removeError}</div>}
              </section>
            )}
          </>
        )}
      </div>
      <button className="btn btn-block btn-ghost sheet-cancel" onClick={onClose}>Done</button>
    </Sheet>
  );
}

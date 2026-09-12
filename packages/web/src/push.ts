import { api } from "./api.ts";
import { ACK_TIMEOUT_MS, dismissRecorder, formatSwState, type SweepReason } from "./dismissLog.ts";
import { notificationsToClose } from "./notifGroups.ts";

/** Everything the decision depends on, read off the environment by the caller. */
export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isSecureContext: boolean;
  /** navigator.standalone === true, or display-mode: standalone matches. */
  isStandalone: boolean;
  isIOS: boolean;
  permission: NotificationPermission | "unavailable";
  /** This device has a subscription registered with the server. */
  subscribed: boolean;
}

export type PushState =
  | { kind: "on" }
  | { kind: "off" } // supported, permission "default" or granted-but-unsubscribed
  | { kind: "blocked" } // permission "denied"
  | { kind: "needs-install" } // iOS, not standalone
  | { kind: "insecure" } // not a secure context
  | { kind: "unsupported" }
  | { kind: "server-off" }; // the browser can, the server has no VAPID key

/**
 * Pure. Precedence, highest first: insecure -> needs-install -> unsupported -> blocked ->
 * on/off. `isSecureContext` is checked before everything, because nothing else can fix it. The
 * install check comes before the capability check: in a plain iOS Safari tab `PushManager` and
 * `Notification` are both undefined, and the naive read of that is "unsupported" when the true
 * answer is "add it to your Home Screen and it will work".
 */
export function pushState(env: PushEnv): PushState {
  if (!env.isSecureContext) return { kind: "insecure" };
  if (env.isIOS && !env.isStandalone) return { kind: "needs-install" };
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return { kind: "unsupported" };
  if (env.permission === "denied") return { kind: "blocked" };
  if (env.permission === "granted" && env.subscribed) return { kind: "on" };
  return { kind: "off" };
}

/**
 * Layers the server's own availability over the browser's state. Pure. `server-off` is not a
 * fact about the browser, so `pushState(env)` itself never produces it — this is a separate
 * step the caller applies afterward. Precedence: everything but `off` outranks it (a device
 * already `on` stays on; the key only matters for *new* subscriptions), and a key that has not
 * resolved yet (`key === null`) is assumed to work rather than guessed at.
 */
export function withServerKey(state: PushState, key: { enabled: boolean; publicKey?: string } | null): PushState {
  if (state.kind !== "off") return state;
  if (key === null) return state;
  return key.enabled && key.publicKey ? state : { kind: "server-off" };
}

/**
 * `navigator.platform` is dead on iPadOS (it reports "MacIntel"), so an iPad is told apart from
 * a real Mac by touch support instead.
 */
export function isIOSDevice(nav: Pick<Navigator, "userAgent" | "maxTouchPoints"> = navigator): boolean {
  return nav.maxTouchPoints > 1 && /Mac|iP(hone|ad|od)/.test(nav.userAgent);
}

/** Reads the real browser. `subscribed` is the caller's job — see `currentSubscription`. */
export function readPushEnv(subscribed: boolean): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  const hasNotification = typeof Notification !== "undefined";
  return {
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: typeof PushManager !== "undefined",
    hasNotification,
    isSecureContext: window.isSecureContext,
    isStandalone: nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches,
    isIOS: isIOSDevice(),
    permission: hasNotification ? Notification.permission : "unavailable",
    subscribed,
  };
}

/** This device's live browser subscription, if any. Never touches the server. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/**
 * VAPID public keys arrive base64url-encoded (RFC 8292); `PushManager.subscribe` wants the raw
 * bytes as a `Uint8Array`. Five lines, pure, unit-tested against the 87-char key format.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type PushKey = { enabled: boolean; publicKey?: string; reason?: string };

let keyPromise: Promise<PushKey> | null = null;
let keyValue: PushKey | null = null;

/**
 * Fire-and-remember fetch of the server's VAPID key, so a click handler never has to await a
 * network call before it can decide whether to prompt. Safe to call repeatedly — later calls
 * reuse the in-flight or resolved promise — and re-fetches only after a failure, never after a
 * plain `{ enabled: false }` answer (that is a real, cacheable answer, not an error).
 */
export function primePushKey(): Promise<PushKey> {
  if (!keyPromise) {
    keyPromise = api.pushKey()
      .then((k) => (keyValue = k))
      .catch((e) => {
        keyPromise = null;
        throw e;
      });
  }
  return keyPromise;
}

/** Synchronous read of the last resolved key. Null means `primePushKey` hasn't resolved yet. */
export function pushKeyNow(): PushKey | null {
  return keyValue;
}

/**
 * Must be called from a user gesture: every step up to and including
 * `Notification.requestPermission()` runs with nothing slow awaited first, so iOS still
 * recognizes the call as part of the gesture that triggered it. Registering the worker first is
 * fine (Apple's own guidance); a network fetch first is not, so the key is the caller's job
 * (`primePushKey`/`pushKeyNow`) and arrives here already in hand.
 */
export async function enablePush(publicKey: string): Promise<PushState> {
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { kind: "blocked" };
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.pushSubscribe({ endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent });
  return { kind: "on" };
}

/** Hard ceiling on one sweep. A tray that somehow holds more than this is a bug elsewhere; it
 *  must never turn a foregrounding into an unbounded loop. */
export const CLOSE_LIMIT = 100;

/** How long to wait on `navigator.serviceWorker.ready` before giving up on it. `ready` never
 *  rejects and never resolves when no worker was ever registered, so it needs its own bound. */
const READY_TIMEOUT_MS = 3_000;

/**
 * The registration whose worker is *active*, which is the one that owns the shown notifications.
 * `navigator.serviceWorker.ready` is the correct source (PR 48 used `getRegistration`, which can
 * hand back a registration whose new worker is still installing on the first load after a
 * sw.js update), but it is unbounded, so it races a timeout and falls back to `getRegistration`.
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  const sw = navigator.serviceWorker;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), READY_TIMEOUT_MS));
  const ready = await Promise.race([sw.ready.catch(() => null), timeout]);
  if (ready) return ready;
  return (await sw.getRegistration("/")) ?? null;
}

/**
 * Closes this device's own visible push notifications for `boardSlug` — every one of them when
 * `boardSlug` is null — bounded to `limit`. Never throws: every failure is logged with context
 * and treated as "closed nothing", and it is a no-op wherever notifications or service workers
 * aren't supported (`server-off`, `unsupported`, `insecure`, a page that never registered a
 * worker).
 *
 * An *empty* result is logged too, deliberately. On WebKit this is the case that silently ate
 * the whole feature in PR 48: the page asking a registration for its notifications can come back
 * with nothing even while the worker itself can see them, and a bare `return 0` left no trace of
 * that at all. `askWorkerToCloseAll` is the answer to it; this log is how anyone knows it fired.
 */
export async function closeBoardNotifications(boardSlug: string | null, limit = CLOSE_LIMIT): Promise<number> {
  return (await sweepFromPage(boardSlug, limit)).closed;
}

/** What one page-side sweep saw and closed. `seen` is `-1` when the page could not even ask. */
export interface PageSweepResult {
  seen: number;
  closed: number;
}

/** `closeBoardNotifications` with the count the page *saw* kept, which is the number that tells a
 *  WebKit enumeration failure apart from an already-empty tray. */
async function sweepFromPage(boardSlug: string | null, limit: number): Promise<PageSweepResult> {
  if (!("serviceWorker" in navigator) || typeof Notification === "undefined") return { seen: -1, closed: 0 };
  try {
    const reg = await activeRegistration();
    if (!reg) return { seen: -1, closed: 0 };
    const open = await reg.getNotifications();
    if (open.length === 0) {
      console.info("[push] page-side getNotifications() saw none open (expected on WebKit; the worker sweeps too)");
      return { seen: 0, closed: 0 };
    }
    const closeTags = new Set(notificationsToClose(open.map((n) => n.tag), boardSlug, limit));
    let closed = 0;
    for (const n of open) {
      if (closed >= limit) break;
      if (!closeTags.has(n.tag)) continue;
      n.close();
      closed++;
    }
    return { seen: open.length, closed };
  } catch (err) {
    console.warn(`[push] closeBoardNotifications(${boardSlug ?? "-"}) failed`, err);
    dismissRecorder.error(err);
    return { seen: -1, closed: 0 };
  }
}

/** A one-line summary of which worker is in charge, for the presence beat. Never throws. */
export async function readSwState(): Promise<string> {
  if (!("serviceWorker" in navigator)) return "unsupported";
  try {
    const reg = await activeRegistration();
    if (!reg) return formatSwState(null);
    return formatSwState({
      scriptURL: reg.active?.scriptURL ?? null,
      state: reg.active?.state ?? null,
      hasController: !!navigator.serviceWorker.controller,
      hasWaiting: !!reg.waiting,
    });
  } catch (err) {
    dismissRecorder.error(err);
    return "error";
  }
}

/** The message the page sends the worker to have it sweep its own notifications. The worker
 *  answers to this string in `packages/web/public/sw.js`; keep the two spellings in step. */
export const CLOSE_ALL_MESSAGE = "flock:close-all";

/**
 * Asks the active service worker to close every notification it has shown, from inside the
 * worker. This is the route that actually works on iOS: a worker enumerating its own
 * notifications is reliable (PR 48's tap-to-clear-siblings proves it — same call, worker
 * context), while the page asking the registration for the same list is not.
 *
 * Fire-and-forget by design — there is no reply channel and nothing to await — and it never
 * throws.
 */
export async function askWorkerToCloseAll(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) {
    dismissRecorder.ack("unsupported");
    return false;
  }
  try {
    const reg = await activeRegistration();
    const worker = reg?.active ?? navigator.serviceWorker.controller ?? null;
    if (!worker) {
      dismissRecorder.ack("no-worker");
      return false;
    }
    const port = openAckPort();
    dismissRecorder.ack("pending");
    worker.postMessage({ type: CLOSE_ALL_MESSAGE, limit: CLOSE_LIMIT }, port ? [port] : []);
    return true;
  } catch (err) {
    console.warn("[push] askWorkerToCloseAll failed", err);
    dismissRecorder.error(err);
    dismissRecorder.ack("no-worker");
    return false;
  }
}

/**
 * A one-shot reply channel for `flock:close-all`, handed to the worker so its answer lands in
 * `dismissRecorder` and rides out on the next presence beat. Nothing awaits it: the sweep is
 * fire-and-forget, and an answer that arrives 200ms later is still on the same beat. Bounded by
 * `ACK_TIMEOUT_MS`, after which the ack is recorded as a timeout and the port is dropped.
 *
 * Returns null where `MessageChannel` does not exist, in which case the worker gets no port and
 * the ack stays `pending` — which is itself the reading "we could not ask".
 */
function openAckPort(): MessagePort | null {
  if (typeof MessageChannel === "undefined") return null;
  const { port1, port2 } = new MessageChannel();
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    try { port1.close(); } catch { /* already closed; nothing to do */ }
  };
  const timer = setTimeout(() => {
    if (settled) return;
    dismissRecorder.ack("timeout");
    done();
  }, ACK_TIMEOUT_MS);
  port1.onmessage = (ev: MessageEvent) => {
    const d = (ev.data ?? {}) as { seen?: number; closed?: number; err?: string | null; activateSeen?: number; activateClosed?: number };
    dismissRecorder.ack("yes", {
      seen: d.seen,
      closed: d.closed,
      activateSeen: d.activateSeen,
      activateClosed: d.activateClosed,
    });
    if (d.err) dismissRecorder.error(`worker: ${d.err}`);
    clearTimeout(timer);
    done();
  };
  port1.start?.();
  return port2;
}

/**
 * The whole foreground sweep, belt and braces: ask the worker to clear its own notifications
 * *and* try from the page. Both are bounded, neither throws, and running both is deliberate —
 * either one alone has a browser where it comes back empty. Unfiltered by board: this app is one
 * origin, the person is now looking at it, and everything in the tray is stale.
 */
export async function dismissAllNotifications(reason: SweepReason = "mount"): Promise<void> {
  dismissRecorder.begin(reason);
  const [, page, sw] = await Promise.all([
    askWorkerToCloseAll(),
    sweepFromPage(null, CLOSE_LIMIT),
    readSwState(),
  ]);
  dismissRecorder.pageResult(page.seen, page.closed);
  dismissRecorder.swState(sw);
}

/**
 * Unsubscribes locally and tells the server, in that order, ignoring a failure of either so the
 * toggle never gets stuck on.
 */
export async function disablePush(): Promise<PushState> {
  try {
    const sub = await currentSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      try {
        await sub.unsubscribe();
      } catch {
        // Ignored: the toggle must not get stuck on because the browser side failed.
      }
      try {
        await api.pushUnsubscribe(endpoint);
      } catch {
        // Ignored: same reasoning, for the server side.
      }
    }
  } catch {
    // getSubscription() itself failed; nothing to unsubscribe.
  }
  return { kind: "off" };
}

import { api } from "./api.ts";

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
  | { kind: "unsupported" };

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

/**
 * Must be called from a user gesture: every step up to and including
 * `Notification.requestPermission()` runs with nothing slow awaited first, so iOS still
 * recognizes the call as part of the gesture that triggered it. Registering the worker first is
 * fine (Apple's own guidance); a network fetch first is not, which is why `GET /api/push/key`
 * comes after the prompt, not before it.
 */
export async function enablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { kind: "blocked" };
  const { publicKey } = await api.pushKey();
  if (!publicKey) return { kind: "unsupported" };
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.pushSubscribe({ endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent });
  return { kind: "on" };
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

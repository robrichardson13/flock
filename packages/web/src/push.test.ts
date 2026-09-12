import { describe, expect, it } from "bun:test";
import { dismissRecorder } from "./dismissLog.ts";
import { askWorkerToCloseAll, closeBoardNotifications, CLOSE_ALL_MESSAGE, dismissAllNotifications, pushState, urlBase64ToUint8Array, withServerKey, type PushEnv, type PushState } from "./push.ts";

const base = (): PushEnv => ({
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  isSecureContext: true,
  isStandalone: false,
  isIOS: false,
  permission: "default",
  subscribed: false,
});

describe("pushState", () => {
  it("is insecure over an insecure context, no matter what else is true", () => {
    expect(pushState({ ...base(), isSecureContext: false }).kind).toBe("insecure");
    expect(pushState({ ...base(), isSecureContext: false, isIOS: true }).kind).toBe("insecure");
    expect(pushState({ ...base(), isSecureContext: false, hasPushManager: false }).kind).toBe("insecure");
  });

  it("is needs-install on iOS outside standalone, even though capabilities read as absent", () => {
    // The plain iOS Safari tab case: serviceWorker exists, PushManager and Notification do not.
    const env: PushEnv = { ...base(), isIOS: true, isStandalone: false, hasPushManager: false, hasNotification: false };
    expect(pushState(env).kind).toBe("needs-install");
  });

  it("is off (not needs-install) on iOS once standalone", () => {
    expect(pushState({ ...base(), isIOS: true, isStandalone: true }).kind).toBe("off");
  });

  it("is unsupported when a capability is missing off iOS", () => {
    expect(pushState({ ...base(), hasServiceWorker: false }).kind).toBe("unsupported");
    expect(pushState({ ...base(), hasPushManager: false }).kind).toBe("unsupported");
    expect(pushState({ ...base(), hasNotification: false }).kind).toBe("unsupported");
  });

  it("is blocked when permission is denied", () => {
    expect(pushState({ ...base(), permission: "denied" }).kind).toBe("blocked");
  });

  it("is on only when granted and subscribed", () => {
    expect(pushState({ ...base(), permission: "granted", subscribed: true }).kind).toBe("on");
    expect(pushState({ ...base(), permission: "granted", subscribed: false }).kind).toBe("off");
  });

  it("is off by default (permission not yet requested)", () => {
    expect(pushState(base()).kind).toBe("off");
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes a known vector", () => {
    // "fx" -> base64 "Znj4" ... use a simple ASCII round trip instead: "hello" base64url is "aGVsbG8".
    const out = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(out)).toEqual([104, 101, 108, 108, 111]); // "hello"
  });

  it("round-trips a realistic 87-char VAPID public key without throwing and yields 65 bytes", () => {
    // An uncompressed P-256 point is 65 bytes (0x04 prefix + 32 + 32), base64url-encoded to 87
    // chars with no padding — the exact shape generateVAPIDKeys() returns.
    const raw = new Uint8Array(65);
    raw[0] = 4;
    for (let i = 1; i < 65; i++) raw[i] = i % 256;
    let bin = "";
    for (const b of raw) bin += String.fromCharCode(b);
    const key = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(key.length).toBe(87);
    const decoded = urlBase64ToUint8Array(key);
    expect(decoded.length).toBe(65);
    expect(Array.from(decoded)).toEqual(Array.from(raw));
  });

  it("handles every padding remainder", () => {
    expect(Array.from(urlBase64ToUint8Array("YQ"))).toEqual([97]); // "a", padding %4 == 2
    expect(Array.from(urlBase64ToUint8Array("YWI"))).toEqual([97, 98]); // "ab", padding %4 == 3
    expect(Array.from(urlBase64ToUint8Array("YWJj"))).toEqual([97, 98, 99]); // "abc", no padding needed
  });
});

describe("withServerKey", () => {
  const kinds: PushState["kind"][] = ["on", "off", "blocked", "needs-install", "insecure", "unsupported", "server-off"];
  const enabledKey = { enabled: true, publicKey: "abc" };
  const disabledKey = { enabled: false };
  const noKeyKey = { enabled: true }; // enabled but no publicKey set

  it("leaves on/blocked/needs-install/insecure/unsupported/server-off untouched regardless of the key", () => {
    for (const kind of kinds) {
      if (kind === "off") continue;
      const state = { kind } as PushState;
      expect(withServerKey(state, null)).toEqual(state);
      expect(withServerKey(state, enabledKey)).toEqual(state);
      expect(withServerKey(state, disabledKey)).toEqual(state);
    }
  });

  it("assumes off will work when the key has not resolved yet", () => {
    expect(withServerKey({ kind: "off" }, null)).toEqual({ kind: "off" });
  });

  it("stays off when the server has a usable key", () => {
    expect(withServerKey({ kind: "off" }, enabledKey)).toEqual({ kind: "off" });
  });

  it("becomes server-off when the server key is disabled or missing", () => {
    expect(withServerKey({ kind: "off" }, disabledKey)).toEqual({ kind: "server-off" });
    expect(withServerKey({ kind: "off" }, noKeyKey)).toEqual({ kind: "server-off" });
  });

  it("never turns on into server-off: a subscribed device stays on even if the key later goes away", () => {
    expect(withServerKey({ kind: "on" }, disabledKey)).toEqual({ kind: "on" });
  });
});

type FakeNotification = { tag: string; close: () => void };
type FakeWorker = { postMessage: (m: unknown, transfer?: unknown) => void; scriptURL?: string; state?: string };
type FakeRegistration = { getNotifications: () => Promise<FakeNotification[]>; active?: FakeWorker | null; waiting?: unknown };

/** A minimal fake of what the close/sweep helpers touch: `navigator.serviceWorker` (`ready`,
 *  `getRegistration`, `controller`), `Notification` (only checked for existence) and a
 *  registration's `getNotifications()`/`active`. Swapped in for the duration of one test and
 *  always restored, even on failure. `ready` rejects when there is no registration so the
 *  fallback path is taken immediately rather than waiting out the real timeout. */
function withFakeNotificationEnv<T>(
  opts: { registration: FakeRegistration | null; controller?: FakeWorker | null },
  fn: () => Promise<T>,
): Promise<T> {
  const savedNav = (globalThis as { navigator?: unknown }).navigator;
  const savedNotification = (globalThis as { Notification?: unknown }).Notification;
  (globalThis as { navigator?: unknown }).navigator = {
    serviceWorker: {
      ready: opts.registration ? Promise.resolve(opts.registration) : Promise.reject(new Error("no worker")),
      getRegistration: async () => opts.registration,
      controller: opts.controller ?? null,
    },
  };
  (globalThis as { Notification?: unknown }).Notification = class {};
  return fn().finally(() => {
    (globalThis as { navigator?: unknown }).navigator = savedNav;
    (globalThis as { Notification?: unknown }).Notification = savedNotification;
  });
}

describe("closeBoardNotifications", () => {
  it("closes only the tapped board's notifications, bounded, and reports the count", async () => {
    const closed: string[] = [];
    const open = [
      { tag: "#/b/flock/channel", close: () => closed.push("#/b/flock/channel") },
      { tag: "#/b/flock/c/1", close: () => closed.push("#/b/flock/c/1") },
      { tag: "#/b/other/channel", close: () => closed.push("#/b/other/channel") },
    ];
    const n = await withFakeNotificationEnv({ registration: { getNotifications: async () => open } }, () =>
      closeBoardNotifications("flock", 50),
    );
    expect(n).toBe(2);
    expect(closed.sort()).toEqual(["#/b/flock/c/1", "#/b/flock/channel"]);
  });

  it("closes nothing and returns 0 when there is no registration", async () => {
    const n = await withFakeNotificationEnv({ registration: null }, () => closeBoardNotifications("flock", 50));
    expect(n).toBe(0);
  });

  it("closes nothing and returns 0 when serviceWorker/Notification are unsupported", async () => {
    const savedNav = (globalThis as { navigator?: unknown }).navigator;
    (globalThis as { navigator?: unknown }).navigator = {};
    try {
      expect(await closeBoardNotifications("flock", 50)).toBe(0);
    } finally {
      (globalThis as { navigator?: unknown }).navigator = savedNav;
    }
  });

  it("never throws when getNotifications rejects", async () => {
    const n = await withFakeNotificationEnv(
      { registration: { getNotifications: async () => { throw new Error("boom"); } } },
      () => closeBoardNotifications("flock", 50),
    );
    expect(n).toBe(0);
  });
});

describe("closeBoardNotifications, unfiltered", () => {
  it("closes every board's notifications when the slug is null", async () => {
    const closed: string[] = [];
    const open = [
      { tag: "#/b/flock/channel", close: () => closed.push("a") },
      { tag: "#/b/other/c/9", close: () => closed.push("b") },
    ];
    const n = await withFakeNotificationEnv({ registration: { getNotifications: async () => open } }, () =>
      closeBoardNotifications(null),
    );
    expect(n).toBe(2);
    expect(closed).toEqual(["a", "b"]);
  });

  it("never closes more than the limit, however many are open", async () => {
    let closed = 0;
    const open = Array.from({ length: 250 }, (_, i) => ({ tag: `#/b/flock/c/${i}`, close: () => closed++ }));
    const n = await withFakeNotificationEnv({ registration: { getNotifications: async () => open } }, () =>
      closeBoardNotifications(null),
    );
    expect(n).toBe(100);
    expect(closed).toBe(100);
  });
});

describe("askWorkerToCloseAll", () => {
  it("posts the close-all message to the active worker", async () => {
    const posted: unknown[] = [];
    const reg: FakeRegistration = { getNotifications: async () => [], active: { postMessage: (m) => posted.push(m) } };
    const ok = await withFakeNotificationEnv({ registration: reg }, () => askWorkerToCloseAll());
    expect(ok).toBe(true);
    expect(posted).toEqual([{ type: CLOSE_ALL_MESSAGE, limit: 100 }]);
  });

  it("falls back to the controller when the registration has no active worker", async () => {
    const posted: unknown[] = [];
    const reg: FakeRegistration = { getNotifications: async () => [], active: null };
    const ok = await withFakeNotificationEnv(
      { registration: reg, controller: { postMessage: (m) => posted.push(m) } },
      () => askWorkerToCloseAll(),
    );
    expect(ok).toBe(true);
    expect(posted).toHaveLength(1);
  });

  it("returns false rather than throwing when there is no worker at all", async () => {
    expect(await withFakeNotificationEnv({ registration: null }, () => askWorkerToCloseAll())).toBe(false);
  });
});

describe("dismissAllNotifications", () => {
  it("runs both routes: the worker message and the page-side close", async () => {
    const posted: unknown[] = [];
    const closed: string[] = [];
    const reg: FakeRegistration = {
      getNotifications: async () => [{ tag: "#/b/flock/channel", close: () => closed.push("x") }],
      active: { postMessage: (m) => posted.push(m) },
    };
    await withFakeNotificationEnv({ registration: reg }, () => dismissAllNotifications());
    expect(posted).toHaveLength(1);
    expect(closed).toEqual(["x"]);
  });

  it("resolves without throwing when both routes fail", async () => {
    const reg: FakeRegistration = { getNotifications: async () => { throw new Error("boom"); }, active: null };
    await withFakeNotificationEnv({ registration: reg }, () => dismissAllNotifications());
  });
});

describe("the sweep records what it saw (card 70)", () => {
  it("fills the read-out with the page's counts and the worker state", async () => {
    const reg: FakeRegistration = {
      getNotifications: async () => [{ tag: "#/b/flock/channel", close: () => {} }],
      active: { postMessage: () => {}, scriptURL: "https://x.test/sw.js", state: "activated" },
      waiting: null,
    };
    await withFakeNotificationEnv({ registration: reg, controller: { postMessage: () => {} } }, () =>
      dismissAllNotifications("pageshow"),
    );
    const r = dismissRecorder.read();
    expect(r.sweepReason).toBe("pageshow");
    expect(r.sweepCount).toBeGreaterThan(0);
    expect(r.notifsSeen).toBe(1);
    expect(r.notifsClosed).toBe(1);
    expect(r.swState).toBe("sw.js@activated,ctl1,wait0");
    // The message went out; the fake worker never answers, so the ack is still outstanding.
    expect(r.workerAck).toBe("pending");
  });

  it("records no-worker rather than a silent nothing when there is no worker to ask", async () => {
    await withFakeNotificationEnv({ registration: null }, () => dismissAllNotifications("mount"));
    const r = dismissRecorder.read();
    expect(r.workerAck).toBe("no-worker");
    expect(r.notifsSeen).toBe(-1);
    expect(r.swState).toBe("none");
  });

  it("takes the worker's own counts off the reply port", async () => {
    let delivered: { data: unknown; ports: readonly MessagePort[] } | null = null;
    const reg: FakeRegistration = {
      getNotifications: async () => [],
      active: {
        postMessage: (m: unknown, transfer?: unknown) => {
          delivered = { data: m, ports: (transfer as MessagePort[]) ?? [] };
        },
      },
    };
    await withFakeNotificationEnv({ registration: reg }, () => dismissAllNotifications("visible"));
    // Answer the way sw.js does.
    const port = delivered!.ports[0]!;
    port.postMessage({ type: "flock:close-all:done", seen: 2, closed: 2, activateSeen: 1, activateClosed: 0 });
    await new Promise((r) => setTimeout(r, 10));
    const r = dismissRecorder.read();
    expect(r.workerAck).toBe("yes");
    expect(r.workerSeen).toBe(2);
    expect(r.workerClosed).toBe(2);
    expect(r.activateSeen).toBe(1);
    expect(r.activateClosed).toBe(0);
    // The page saw nothing while the worker saw two: exactly the WebKit split this exists to show.
    expect(r.notifsSeen).toBe(0);
  });
});

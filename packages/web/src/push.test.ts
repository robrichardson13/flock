import { describe, expect, it } from "bun:test";
import { pushState, urlBase64ToUint8Array, withServerKey, type PushEnv, type PushState } from "./push.ts";

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

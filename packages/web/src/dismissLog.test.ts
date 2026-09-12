import { describe, expect, it } from "bun:test";
import { createDismissRecorder, describeError, dismissBeatFields, emptyReport, formatSwState, MAX_ERR_CHARS, MAX_SW_STATE_CHARS } from "./dismissLog.ts";

describe("formatSwState", () => {
  it("names the script, its state, and who controls the page", () => {
    expect(formatSwState({ scriptURL: "https://x.test/sw.js", state: "activated", hasController: true, hasWaiting: false }))
      .toBe("sw.js@activated,ctl1,wait0");
  });

  it("says none when there is no registration at all", () => {
    expect(formatSwState(null)).toBe("none");
  });

  it("flags a waiting worker, which is the 'notification belongs to the old registration' case", () => {
    expect(formatSwState({ scriptURL: "/sw.js", state: "activating", hasController: false, hasWaiting: true }))
      .toBe("sw.js@activating,ctl0,wait1");
  });

  it("never exceeds the state clamp, whatever the script URL", () => {
    const s = formatSwState({ scriptURL: `/${"a".repeat(300)}.js`, state: "activated", hasController: true, hasWaiting: false });
    expect(s.length).toBeLessThanOrEqual(MAX_SW_STATE_CHARS);
  });
});

describe("describeError", () => {
  it("keeps the name and message, clamped", () => {
    expect(describeError(new TypeError("boom"))).toBe("TypeError: boom");
    expect(describeError(new Error("x".repeat(500))).length).toBe(MAX_ERR_CHARS);
  });

  it("stringifies a non-Error rather than throwing", () => {
    expect(describeError("nope")).toBe("nope");
  });
});

describe("createDismissRecorder", () => {
  const at = (t: number) => () => t;

  it("reports nothing before the first sweep", () => {
    const r = createDismissRecorder(at(1000));
    expect(r.read()).toEqual(emptyReport());
    expect(dismissBeatFields(r.read())).toEqual({});
  });

  it("counts sweeps and ages the last one", () => {
    let now = 1000;
    const r = createDismissRecorder(() => now);
    r.begin("mount");
    now = 3500;
    expect(r.read().sweepAgeMs).toBe(2500);
    expect(r.read().sweepCount).toBe(1);
    r.begin("pageshow");
    expect(r.read().sweepCount).toBe(2);
    expect(r.read().sweepReason).toBe("pageshow");
    expect(r.read().sweepAgeMs).toBe(0);
  });

  it("carries the page and worker counts separately, which is the whole diagnosis", () => {
    const r = createDismissRecorder(at(0));
    r.begin("visible");
    r.pageResult(0, 0);
    r.ack("yes", { seen: 3, closed: 3, activateSeen: 1, activateClosed: 1 });
    const read = r.read();
    expect(read.notifsSeen).toBe(0);
    expect(read.workerSeen).toBe(3);
    expect(read.workerClosed).toBe(3);
    expect(read.activateSeen).toBe(1);
  });

  it("does not let a late timeout overwrite an ack that already arrived", () => {
    const r = createDismissRecorder(at(0));
    r.begin("focus");
    r.ack("pending");
    r.ack("yes", { seen: 1, closed: 1 });
    r.ack("timeout");
    expect(r.read().workerAck).toBe("yes");
  });

  it("does not let a pending overwrite a real answer", () => {
    const r = createDismissRecorder(at(0));
    r.begin("focus");
    r.ack("no-worker");
    r.ack("pending");
    expect(r.read().workerAck).toBe("no-worker");
  });

  it("clears the previous sweep's numbers when a new one starts", () => {
    const r = createDismissRecorder(at(0));
    r.begin("mount");
    r.pageResult(4, 4);
    r.ack("yes", { seen: 4, closed: 4 });
    r.error(new Error("old"));
    r.begin("pageshow");
    const read = r.read();
    expect(read.notifsSeen).toBeNull();
    expect(read.workerAck).toBeNull();
    expect(read.err).toBeNull();
  });

  it("clamps a nonsense count rather than putting it on the wire", () => {
    const r = createDismissRecorder(at(0));
    r.begin("mount");
    r.pageResult(1e9, Number.NaN);
    expect(r.read().notifsSeen).toBe(9_999);
    expect(r.read().notifsClosed).toBeNull();
  });
});

describe("dismissBeatFields", () => {
  it("drops every null, so an untouched page adds nothing to the beat", () => {
    expect(dismissBeatFields(emptyReport())).toEqual({});
  });

  it("carries a zero count, which is a real reading and not a missing one", () => {
    const r = createDismissRecorder(() => 0);
    r.begin("mount");
    r.pageResult(0, 0);
    r.swState("sw.js@activated,ctl1,wait0");
    expect(dismissBeatFields(r.read())).toEqual({
      sweepAgeMs: 0,
      sweepReason: "mount",
      sweepCount: 1,
      swState: "sw.js@activated,ctl1,wait0",
      notifsSeen: 0,
      notifsClosed: 0,
    });
  });
});

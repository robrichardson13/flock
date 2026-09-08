import { afterEach, describe, expect, it } from "bun:test";

/**
 * A localStorage stand-in with the bits this module actually uses, including the
 * enumeration a sweep needs. `throws` reproduces the browsers where the accessor itself
 * raises (private mode, a blocked origin) and `quota` the store that accepts reads but
 * refuses writes once it is full — the two cases every guard here exists for.
 */
function fakeStorage({ throws = false, quota = false } = {}) {
  const map = new Map<string, string>();
  return {
    map,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => {
      if (throws) throw new Error("blocked");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throws || quota) throw new Error("quota exceeded");
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
  };
}

/** The sweep runs once per module instance, so each case gets a fresh import. */
async function load(storage: unknown) {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return await import(`./snapshot.ts?${Math.random()}`) as typeof import("./snapshot.ts");
}

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
});

describe("snapshot store", () => {
  it("round-trips a payload under a versioned key", async () => {
    const s = fakeStorage();
    const { readSnapshot, writeSnapshot, snapKey } = await load(s);
    writeSnapshot(snapKey.home, { boards: [{ id: "a" }] });
    expect(readSnapshot<{ boards: { id: string }[] }>(snapKey.home)?.boards[0].id).toBe("a");
    expect([...s.map.keys()]).toEqual(["flock.snap.1.home"]);
  });

  it("keys a board and a card by route", async () => {
    const { snapKey } = await load(fakeStorage());
    expect(snapKey.board("better-ux")).toBe("board:better-ux");
    expect(snapKey.card("better-ux", 43)).toBe("card:better-ux:43");
  });

  it("returns null for a missing entry and for corrupt JSON", async () => {
    const s = fakeStorage();
    const { readSnapshot } = await load(s);
    expect(readSnapshot("home")).toBeNull();
    s.map.set("flock.snap.1.home", "{not json");
    expect(readSnapshot("home")).toBeNull();
  });

  it("survives a store that throws on every access", async () => {
    const { readSnapshot, writeSnapshot } = await load(fakeStorage({ throws: true }));
    expect(readSnapshot("home")).toBeNull();
    expect(() => writeSnapshot("home", { a: 1 })).not.toThrow();
  });

  it("survives no storage at all", async () => {
    const { readSnapshot, writeSnapshot } = await load(undefined);
    expect(readSnapshot("home")).toBeNull();
    expect(() => writeSnapshot("home", { a: 1 })).not.toThrow();
  });

  it("drops a payload past the size cap, and the stale entry with it", async () => {
    const s = fakeStorage();
    const { readSnapshot, writeSnapshot } = await load(s);
    writeSnapshot("home", { small: true });
    writeSnapshot("home", { big: "x".repeat(600_000) });
    expect(readSnapshot("home")).toBeNull();
  });

  it("does not throw when the store is out of room", async () => {
    const { writeSnapshot, readSnapshot } = await load(fakeStorage({ quota: true }));
    expect(() => writeSnapshot("home", { a: 1 })).not.toThrow();
    expect(readSnapshot("home")).toBeNull();
  });

  it("sweeps entries written by an older version", async () => {
    const s = fakeStorage();
    s.map.set("flock.snap.0.home", "{}");
    s.map.set("flock.lab", "{}");
    const { writeSnapshot } = await load(s);
    writeSnapshot("home", { a: 1 });
    expect([...s.map.keys()].sort()).toEqual(["flock.lab", "flock.snap.1.home"]);
  });

  it("forgets one route's frame", async () => {
    const s = fakeStorage();
    const { writeSnapshot, clearSnapshot, readSnapshot } = await load(s);
    writeSnapshot("board:gone", { a: 1 });
    writeSnapshot("home", { b: 2 });
    clearSnapshot("board:gone");
    expect(readSnapshot("board:gone")).toBeNull();
    expect(readSnapshot("home")).not.toBeNull();
  });

  it("clears every cached frame", async () => {
    const s = fakeStorage();
    const { writeSnapshot, clearSnapshots, readSnapshot } = await load(s);
    writeSnapshot("home", { a: 1 });
    writeSnapshot("board:x", { b: 2 });
    clearSnapshots();
    expect(readSnapshot("home")).toBeNull();
    expect(readSnapshot("board:x")).toBeNull();
  });
});

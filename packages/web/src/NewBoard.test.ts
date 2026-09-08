import { describe, expect, it } from "bun:test";
import { defaultFor, defaultsFor, requiredFieldsMet } from "./NewBoard.tsx";
import type { HookField } from "./api.ts";

const select = (extra: Partial<HookField> = {}): HookField => ({
  name: "repo",
  label: "Repository",
  type: "select",
  options: [{ value: "flock", label: "flock" }, { value: "other", label: "other" }],
  ...extra,
});

describe("defaultFor", () => {
  it("starts a required select on its first option when the hook gave no usable default", () => {
    // Otherwise the control shows the first option while the form's value is "", so the required
    // check never passes and Create can never be pressed.
    expect(defaultFor(select({ required: true }))).toBe("flock");
    expect(defaultFor(select({ required: true, default: "gone" }))).toBe("flock");
  });

  it("honors a default that is one of the options", () => {
    expect(defaultFor(select({ required: true, default: "other" }))).toBe("other");
    expect(defaultFor(select({ default: "other" }))).toBe("other");
  });

  it("leaves an optional select blank so its blank entry stays reachable", () => {
    expect(defaultFor(select())).toBe("");
    expect(defaultFor(select({ default: "gone" }))).toBe("");
  });

  it("leaves a required select with no options blank rather than inventing one", () => {
    expect(defaultFor(select({ required: true, options: [] }))).toBe("");
  });

  it("gives a checkbox a boolean and every other field its string default", () => {
    expect(defaultFor({ name: "seed", label: "Seed", type: "checkbox" })).toBe(false);
    expect(defaultFor({ name: "seed", label: "Seed", type: "checkbox", default: true })).toBe(true);
    expect(defaultFor({ name: "b", label: "Branch", type: "text" })).toBe("");
    expect(defaultFor({ name: "b", label: "Branch", type: "text", default: "main" })).toBe("main");
  });
});

describe("requiredFieldsMet", () => {
  it("passes once the defaults of a required select are in place", () => {
    const fields = [select({ required: true }), { name: "branch", label: "Branch", type: "text", required: true } as HookField];
    const values = defaultsFor(fields);
    expect(requiredFieldsMet(fields, values)).toBe(false);
    expect(requiredFieldsMet(fields, { ...values, branch: "login-flow" })).toBe(true);
  });

  it("ignores whitespace and does not gate on checkboxes", () => {
    const fields: HookField[] = [
      { name: "branch", label: "Branch", type: "text", required: true },
      { name: "seed", label: "Seed", type: "checkbox", required: true },
    ];
    expect(requiredFieldsMet(fields, { branch: "  ", seed: false })).toBe(false);
    expect(requiredFieldsMet(fields, { branch: "x", seed: false })).toBe(true);
  });
});

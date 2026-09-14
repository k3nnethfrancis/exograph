import { describe, expect, it } from "vitest";

import { invocationActivityLabel, isInvocationActivityKind } from "../invocation-activity";

describe("invocation activity", () => {
  it("reduces a path to one bounded basename", () => {
    expect(invocationActivityLabel("/Users/person/private/wiki/projects/exograph/tasks.md")).toBe("tasks.md");
    expect(invocationActivityLabel("C:\\Users\\person\\wiki\\notes.md")).toBe("notes.md");
    expect(invocationActivityLabel(`/notes/${"a".repeat(100)}.md`, 20)).toBe(`${"a".repeat(16)}….md`);
  });

  it("strips terminal controls and rejects empty labels", () => {
    expect(invocationActivityLabel("\u001b[31m/notes/task.md\u001b[0m\n")).toBe("task.md");
    expect(invocationActivityLabel("\u0000\n\t")).toBeNull();
    expect(invocationActivityLabel({ path: "/notes/task.md" })).toBeNull();
  });

  it("accepts only the intentionally small activity vocabulary", () => {
    expect(isInvocationActivityKind("reading")).toBe(true);
    expect(isInvocationActivityKind("done")).toBe(true);
    expect(isInvocationActivityKind("stopped")).toBe(true);
    expect(isInvocationActivityKind("failed")).toBe(true);
    expect(isInvocationActivityKind("finishing")).toBe(false);
    expect(isInvocationActivityKind("thinking")).toBe(false);
    expect(isInvocationActivityKind("reasoning")).toBe(false);
  });
});

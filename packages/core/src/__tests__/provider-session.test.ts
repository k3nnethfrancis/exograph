import { describe, expect, it } from "vitest";

import { commandForClaudeResume, commandForCodexResume } from "../provider-session";

describe("provider session handoff", () => {
  it("turns a headless Claude command into an interactive resume command", () => {
    expect(commandForClaudeResume(
      { command: "claude -p --output-format stream-json --permission-mode acceptEdits" },
      "11111111-1111-4111-8111-111111111111",
    )).toBe("claude --permission-mode acceptEdits --resume '11111111-1111-4111-8111-111111111111'");
  });

  it("turns a headless Codex command into an interactive resume command", () => {
    expect(commandForCodexResume(
      { command: "codex exec --json --sandbox workspace-write -" },
      "22222222-2222-4222-8222-222222222222",
    )).toBe("codex resume '22222222-2222-4222-8222-222222222222'");
  });
});

import { describe, expect, it } from "vitest";

import { isNewTerminalShortcut, shellPanelShortcut } from "./useAppKeybindings";
import { resolvedWorkspaceShortcutBindings, shortcutBindingIssue, shortcutBindingsHaveConflict } from "../shellHelpModel";

describe("app keybindings", () => {
  it("maps familiar primary and secondary sidebar shortcuts without accepting noisy variants", () => {
    expect(shellPanelShortcut({ code: "KeyB", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false })).toBe("explorer");
    expect(shellPanelShortcut({ code: "KeyB", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, repeat: false })).toBe("explorer");
    expect(shellPanelShortcut({ code: "KeyB", metaKey: true, ctrlKey: false, shiftKey: false, altKey: true, repeat: false })).toBe("utility");
    expect(shellPanelShortcut({ code: "KeyB", metaKey: false, ctrlKey: true, shiftKey: false, altKey: true, repeat: false })).toBe("utility");
    expect(shellPanelShortcut({ code: "KeyB", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, repeat: false })).toBeNull();
    expect(shellPanelShortcut({ code: "KeyB", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: true })).toBeNull();
    expect(shellPanelShortcut({ code: "KeyN", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false })).toBeNull();
  });

  it("recognizes Mod+T as the new terminal shortcut", () => {
    expect(isNewTerminalShortcut({ key: "t", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false })).toBe(true);
    expect(isNewTerminalShortcut({ key: "T", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, repeat: false })).toBe(true);
  });

  it("ignores modified or repeated Mod+T events", () => {
    expect(isNewTerminalShortcut({ key: "t", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, repeat: false })).toBe(false);
    expect(isNewTerminalShortcut({ key: "t", metaKey: true, ctrlKey: false, shiftKey: false, altKey: true, repeat: false })).toBe(false);
    expect(isNewTerminalShortcut({ key: "t", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: true })).toBe(false);
    expect(isNewTerminalShortcut({ key: "n", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false })).toBe(false);
  });

  it("resolves per-workspace overrides and rejects duplicate global bindings", () => {
    const bindings = resolvedWorkspaceShortcutBindings({ "new-note": { code: "KeyK" } });
    expect(bindings["new-note"]).toEqual({ code: "KeyK" });
    expect(bindings["daily-note"]).toEqual({ code: "KeyN", shift: true });
    expect(shortcutBindingsHaveConflict({ explorer: { code: "KeyK" }, terminal: { code: "KeyK" } })).toBe(true);
    expect(shortcutBindingsHaveConflict({ explorer: { code: "KeyK" }, terminal: { code: "KeyT" } })).toBe(false);
  });
});


it("keeps native and Invoke combinations out of the configurable global bindings", () => {
  for (const binding of [{ code: "KeyC" }, { code: "KeyQ", alt: true }, { code: "Enter" }, { code: "KeyZ", shift: true }, { code: "KeyG" }, { code: "KeyG", shift: true }, { code: "KeyG", alt: true }, { code: "KeyD" }, { code: "KeyK", shift: true }]) {
    expect(shortcutBindingIssue("explorer", binding, {})).toContain("Reserved");
  }
  expect(shortcutBindingIssue("explorer", { code: "KeyB" }, {})).toBeNull();
  expect(shortcutBindingIssue("save", { code: "KeyS" }, {})).toBeNull();
  expect(shortcutBindingIssue("explorer", { code: "KeyE", alt: true }, {})).toBeNull();
});

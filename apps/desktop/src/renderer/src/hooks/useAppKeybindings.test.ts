import { describe, expect, it } from "vitest";

import { shellPanelShortcut } from "./useAppKeybindings";
import { codeMirrorShortcutKey, resolvedWorkspaceShortcutBindings, shortcutBindingIssue, shortcutBindingsHaveConflict, shortcutMatches } from "../shellHelpModel";

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

  it("matches the resolved terminal binding through the live shortcut contract", () => {
    const terminal = resolvedWorkspaceShortcutBindings({}).terminal;
    expect(shortcutMatches({ code: "KeyT", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false }, terminal)).toBe(true);
    expect(shortcutMatches({ code: "KeyT", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, repeat: false }, terminal)).toBe(true);
  });

  it("rejects modified, repeated, or wrong terminal events through the live shortcut contract", () => {
    const terminal = resolvedWorkspaceShortcutBindings({}).terminal;
    for (const event of [
      { code: "KeyT", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, repeat: false },
      { code: "KeyT", metaKey: true, ctrlKey: false, shiftKey: false, altKey: true, repeat: false },
      { code: "KeyT", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: true },
      { code: "KeyN", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false },
    ]) {
      expect(shortcutMatches(event, terminal)).toBe(false);
    }
  });

  it("resolves per-workspace overrides and rejects duplicate global bindings", () => {
    const bindings = resolvedWorkspaceShortcutBindings({ "new-note": { code: "KeyK" } });
    expect(bindings["new-note"]).toEqual({ code: "KeyK" });
    expect(bindings["daily-note"]).toEqual({ code: "KeyN", shift: true });
    expect(shortcutBindingsHaveConflict({ explorer: { code: "KeyK" }, terminal: { code: "KeyK" } })).toBe(true);
    expect(shortcutBindingsHaveConflict({ explorer: { code: "KeyK" }, terminal: { code: "KeyT" } })).toBe(false);
  });

  it("converts the canonical Save binding to the editor keymap shape", () => {
    expect(codeMirrorShortcutKey({ code: "KeyK", alt: true, shift: true })).toBe("Mod-Alt-Shift-k");
    expect(codeMirrorShortcutKey({ code: "Enter" })).toBe("Mod-Enter");
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

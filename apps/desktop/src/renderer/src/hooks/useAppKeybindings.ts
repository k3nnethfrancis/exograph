import { useEffect } from "react";
import type { WorkspaceShortcutBindings } from "@exograph/core";

import { editorOwnsShortcut, resolvedWorkspaceShortcutBindings, shortcutMatches } from "../shellHelpModel";

interface UseAppKeybindingsOptions {
  activeDocumentPath: string | null;
  settingsOpen?: boolean;
  shortcutBindings?: WorkspaceShortcutBindings;
  saveDocument: (filePath: string) => Promise<void>;
  createUntitledNote: () => Promise<void>;
  openOrCreateDailyNote: () => Promise<void>;
  createShellTerminal: () => Promise<void>;
  toggleExplorerPanel: () => void;
  toggleUtilityPanel: () => void;
  updateAppZoom: (direction: -1 | 0 | 1) => void;
}

export function useAppKeybindings(options: UseAppKeybindingsOptions) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // The modal owns keyboard interaction, including its shortcut recorder.
      if (options.settingsOpen) return;
      const bindings = resolvedWorkspaceShortcutBindings(options.shortcutBindings);
      const panelShortcut = shellPanelShortcut(event, options.shortcutBindings);
      if (panelShortcut) {
        // Preserve Markdown's Mod+B and editor bindings from older settings,
        // while allowing validated custom panel shortcuts inside the editor.
        if (isCodeMirrorEvent(event) && editorOwnsShortcut(bindings[panelShortcut])) return;
        event.preventDefault();
        event.stopPropagation();
        if (panelShortcut === "explorer") {
          options.toggleExplorerPanel();
        } else {
          options.toggleUtilityPanel();
        }
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && isZoomKey(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        options.updateAppZoom(zoomDirection(event.key));
        return;
      }
      if (shortcutMatches(event, bindings.save) && options.activeDocumentPath) {
        // Let the editor keymap flush an active inline-agent composer into the
        // document model before saving. The window-level capture handler would
        // otherwise persist only the mention and drop the draft text.
        if (event.composedPath().some((entry) => entry instanceof Element && entry.closest(".cm-editor"))) {
          return;
        }
        event.preventDefault();
        void options.saveDocument(options.activeDocumentPath).catch(() => { /* The document owner displays save failures and conflicts. */ });
        return;
      }
      if (shortcutMatches(event, bindings["new-note"])) {
        event.preventDefault();
        void options.createUntitledNote();
        return;
      }
      if (shortcutMatches(event, bindings["daily-note"])) {
        event.preventDefault();
        void options.openOrCreateDailyNote();
        return;
      }
      if (shortcutMatches(event, bindings.terminal)) {
        event.preventDefault();
        void options.createShellTerminal();
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [
    options.activeDocumentPath,
    options.settingsOpen,
    options.shortcutBindings,
    options.saveDocument,
    options.createUntitledNote,
    options.openOrCreateDailyNote,
    options.createShellTerminal,
    options.toggleExplorerPanel,
    options.toggleUtilityPanel,
    options.updateAppZoom,
  ]);
}

function isCodeMirrorEvent(event: KeyboardEvent): boolean {
  return event.composedPath().some((entry) => entry instanceof Element && entry.closest(".cm-editor"));
}

type ShortcutEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat">;
type ShellPanelShortcutEvent = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat">;
export type ShellPanelShortcut = "explorer" | "utility";

export function shellPanelShortcut(event: ShellPanelShortcutEvent, bindings?: WorkspaceShortcutBindings): ShellPanelShortcut | null {
  const resolved = resolvedWorkspaceShortcutBindings(bindings);
  if (shortcutMatches(event, resolved.explorer)) return "explorer";
  if (shortcutMatches(event, resolved.utility)) return "utility";
  return null;
}

export function isNewTerminalShortcut(event: ShortcutEvent, bindings?: WorkspaceShortcutBindings): boolean {
  return shortcutMatches({ ...event, code: event.key.length === 1 ? `Key${event.key.toUpperCase()}` : event.key }, resolvedWorkspaceShortcutBindings(bindings).terminal);
}

function isZoomKey(key: string): boolean {
  return key === "+" || key === "=" || key === "-" || key === "_" || key === "0";
}

function zoomDirection(key: string): -1 | 0 | 1 {
  if (key === "-" || key === "_") {
    return -1;
  }
  if (key === "0") {
    return 0;
  }
  return 1;
}

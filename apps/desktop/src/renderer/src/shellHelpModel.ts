import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import type { WorkspaceShortcutBinding, WorkspaceShortcutBindings, WorkspaceShortcutId } from "@exograph/core";

export interface AppKeybindingHelp {
  id: WorkspaceShortcutId | "invoke" | "zoom";
  label: string;
  mac: string;
  other: string;
}

export const APP_KEYBINDINGS: readonly AppKeybindingHelp[] = [
  { id: "explorer", label: "Explorer", mac: "⌘ B", other: "Ctrl B" },
  { id: "utility", label: "Utility", mac: "⌘ ⌥ B", other: "Ctrl Alt B" },
  { id: "new-note", label: "New note", mac: "⌘ N", other: "Ctrl N" },
  { id: "daily-note", label: "Daily note", mac: "⌘ ⇧ N", other: "Ctrl Shift N" },
  { id: "terminal", label: "New terminal", mac: "⌘ T", other: "Ctrl T" },
  { id: "save", label: "Save", mac: "⌘ S", other: "Ctrl S" },
  { id: "invoke", label: "Invoke", mac: "⌘ ↵", other: "Ctrl Enter" },
  { id: "zoom", label: "App zoom", mac: "⌘ + / − / 0", other: "Ctrl + / − / 0" },
] as const;

export const DEFAULT_WORKSPACE_SHORTCUT_BINDINGS: Record<WorkspaceShortcutId, WorkspaceShortcutBinding> = {
  explorer: { code: "KeyB" },
  utility: { code: "KeyB", alt: true },
  "new-note": { code: "KeyN" },
  "daily-note": { code: "KeyN", shift: true },
  terminal: { code: "KeyT" },
  save: { code: "KeyS" },
};

export function resolvedWorkspaceShortcutBindings(overrides: WorkspaceShortcutBindings | undefined): Record<WorkspaceShortcutId, WorkspaceShortcutBinding> {
  return {
    explorer: { ...DEFAULT_WORKSPACE_SHORTCUT_BINDINGS.explorer, ...overrides?.explorer },
    utility: { ...DEFAULT_WORKSPACE_SHORTCUT_BINDINGS.utility, ...overrides?.utility },
    "new-note": { ...DEFAULT_WORKSPACE_SHORTCUT_BINDINGS["new-note"], ...overrides?.["new-note"] },
    "daily-note": { ...DEFAULT_WORKSPACE_SHORTCUT_BINDINGS["daily-note"], ...overrides?.["daily-note"] },
    terminal: { ...DEFAULT_WORKSPACE_SHORTCUT_BINDINGS.terminal, ...overrides?.terminal },
    save: { ...DEFAULT_WORKSPACE_SHORTCUT_BINDINGS.save, ...overrides?.save },
  };
}

export function shortcutLabel(binding: WorkspaceShortcutBinding, isMac = isMacPlatform()): string {
  const modifier = isMac ? "⌘" : "Ctrl";
  const alt = binding.alt ? (isMac ? "⌥" : "Alt ") : "";
  const shift = binding.shift ? (isMac ? "⇧" : "Shift ") : "";
  const key = binding.code === "Enter" ? (isMac ? "↵" : "Enter") : binding.code.replace("Key", "");
  return isMac ? [modifier, alt, shift, key].filter(Boolean).join(" ") : `${modifier} ${alt}${shift}${key}`.replace(/\s+/g, " ");
}

export function workspaceHelpKeybindings(overrides: WorkspaceShortcutBindings | undefined, isMac = isMacPlatform()): AppKeybindingHelp[] {
  const bindings = resolvedWorkspaceShortcutBindings(overrides);
  return APP_KEYBINDINGS.map((entry) => {
    if (!(entry.id in bindings)) return entry;
    const label = shortcutLabel(bindings[entry.id as WorkspaceShortcutId], isMac);
    return { ...entry, mac: isMac ? label : entry.mac, other: isMac ? entry.other : label };
  });
}

export function shortcutMatches(event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat">, binding: WorkspaceShortcutBinding): boolean {
  const mod = event.metaKey || event.ctrlKey;
  return mod && !event.repeat && event.code === binding.code && Boolean(event.shiftKey) === Boolean(binding.shift) && Boolean(event.altKey) === Boolean(binding.alt);
}

export function shortcutBindingFromEvent(event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): WorkspaceShortcutBinding | null {
  if (!(event.metaKey || event.ctrlKey) || !/^(?:Key[A-Z]|Enter)$/.test(event.code)) return null;
  return { code: event.code, shift: event.shiftKey, alt: event.altKey };
}

export function shortcutBindingsHaveConflict(bindings: WorkspaceShortcutBindings | undefined): boolean {
  const values = Object.values(resolvedWorkspaceShortcutBindings(bindings));
  return new Set(values.map((binding) => `${binding.code}:${Boolean(binding.shift)}:${Boolean(binding.alt)}`)).size !== values.length;
}

export function isMacPlatform(platform = globalThis.navigator?.platform ?? ""): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}


/** Reject collisions and bindings owned by native editing or system commands. */
export function shortcutBindingIssue(id: WorkspaceShortcutId, binding: WorkspaceShortcutBinding, overrides: WorkspaceShortcutBindings | undefined): string | null {
  const resolved = resolvedWorkspaceShortcutBindings(overrides);
  const collision = APP_KEYBINDINGS.find(entry => entry.id !== id && entry.id in resolved
    && binding.code === resolved[entry.id as WorkspaceShortcutId].code
    && Boolean(binding.alt) === Boolean(resolved[entry.id as WorkspaceShortcutId].alt)
    && Boolean(binding.shift) === Boolean(resolved[entry.id as WorkspaceShortcutId].shift));
  if (collision) return `Already used by ${collision.label}. Choose another shortcut.`;
  if (binding.code === "Enter") return "Reserved for Invoke. Choose another shortcut.";
  if (["KeyQ", "KeyW", "KeyH", "KeyM"].includes(binding.code)) return "Reserved for a system command. Choose another shortcut.";
  const native = !binding.alt && !binding.shift && ["KeyC", "KeyV", "KeyX", "KeyO", "KeyP", "KeyR", "KeyL"].includes(binding.code);
  const sharedEditorDefault = !binding.alt && !binding.shift && ((binding.code === "KeyB" && id === "explorer") || (binding.code === "KeyS" && id === "save"));
  if (native || (!sharedEditorDefault && editorOwnsShortcut(binding))) return "Reserved for a system or editor command. Choose another shortcut.";
  return null;
}


/** These are the keymaps enabled by NoteEditor's basicSetup. Include both
 * platform spellings because workspace primary-modifier bindings are portable. */
export function editorOwnsShortcut(binding: WorkspaceShortcutBinding): boolean {
  if (!binding.alt && !binding.shift && ["KeyB", "KeyS", "KeyC", "KeyV", "KeyX"].includes(binding.code)) return true;
  return [...defaultKeymap, ...historyKeymap, ...searchKeymap].some(command =>
    [command.key, command.mac, command.win, command.linux].some(key => {
      if (!key) return false;
      const parts = key.split("-");
      const letter = parts.at(-1);
      if (!parts.some(part => part === "Mod" || part === "Cmd") || !letter || !/^[a-z]$/i.test(letter)) return false;
      const shift = parts.includes("Shift");
      return binding.code === `Key${letter.toUpperCase()}` && Boolean(binding.alt) === parts.includes("Alt")
        && (Boolean(binding.shift) === shift || (!shift && Boolean(command.shift) && Boolean(binding.shift)));
    }),
  );
}

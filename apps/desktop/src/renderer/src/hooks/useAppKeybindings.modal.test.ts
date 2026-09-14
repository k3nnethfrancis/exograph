import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useAppKeybindings } from "./useAppKeybindings";
let renderer: ReactTestRenderer | undefined;
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.unstubAllGlobals(); });
it("yields capture keys to Settings without firing background actions or preventing native input", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let listener: (event: KeyboardEvent) => void;
  vi.stubGlobal("window", { addEventListener: (_: string, callback: typeof listener) => { listener = callback; }, removeEventListener() {} });
  const actions = { saveDocument: vi.fn(async () => {}), createUntitledNote: vi.fn(async () => {}), openOrCreateDailyNote: vi.fn(async () => {}), createShellTerminal: vi.fn(async () => {}), toggleExplorerPanel: vi.fn(), toggleUtilityPanel: vi.fn(), updateAppZoom: vi.fn() };
  function Harness({ settingsOpen }: { settingsOpen: boolean }) { useAppKeybindings({ activeDocumentPath: "/note.md", settingsOpen, ...actions }); return null; }
  await act(async () => { renderer = create(createElement(Harness, { settingsOpen: true })); });
  const event = (code: string, key: string) => ({ key, code, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, composedPath: () => [], preventDefault: vi.fn(), stopPropagation: vi.fn() });
  for (const [code, key] of [["KeyB", "b"], ["KeyN", "n"], ["KeyT", "t"], ["KeyS", "s"], ["Equal", "="], ["KeyC", "c"]]) {
    const input = event(code, key);
    listener!(input as unknown as KeyboardEvent);
    expect(input.preventDefault).not.toHaveBeenCalled();
  }
  for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  await act(async () => renderer!.update(createElement(Harness, { settingsOpen: false })));
  listener!(event("KeyB", "b") as unknown as KeyboardEvent);
  expect(actions.toggleExplorerPanel).toHaveBeenCalledOnce();
});

it("runs custom panel shortcuts in the editor while leaving native Mod+B to Markdown", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  class EditorElement { closest(selector: string) { return selector === ".cm-editor" ? this : null; } }
  vi.stubGlobal("Element", EditorElement);
  let listener: (event: KeyboardEvent) => void;
  vi.stubGlobal("window", { addEventListener: (_: string, callback: typeof listener) => { listener = callback; }, removeEventListener() {} });
  const toggleExplorerPanel = vi.fn();
  const toggleUtilityPanel = vi.fn();
  function Harness({ custom, legacy = false }: { custom: boolean; legacy?: boolean }) {
    useAppKeybindings({ activeDocumentPath: "/note.md", shortcutBindings: legacy ? { explorer: { code: "KeyG" } } : custom ? { explorer: { code: "KeyE", alt: true } } : {},
      saveDocument: vi.fn(async () => {}), createUntitledNote: vi.fn(async () => {}), openOrCreateDailyNote: vi.fn(async () => {}), createShellTerminal: vi.fn(async () => {}), toggleExplorerPanel, toggleUtilityPanel, updateAppZoom: vi.fn() });
    return null;
  }
  await act(async () => { renderer = create(createElement(Harness, { custom: true })); });
  const event = (code: string, altKey: boolean) => ({ key: code.slice(-1).toLowerCase(), code, metaKey: true, ctrlKey: false, shiftKey: false, altKey, repeat: false, composedPath: () => [new EditorElement()], preventDefault: vi.fn(), stopPropagation: vi.fn() });
  listener!(event("KeyE", true) as unknown as KeyboardEvent);
  expect(toggleExplorerPanel).toHaveBeenCalledOnce();
  listener!(event("KeyB", true) as unknown as KeyboardEvent);
  expect(toggleUtilityPanel).toHaveBeenCalledOnce();
  await act(async () => renderer!.update(createElement(Harness, { custom: false })));
  const bold = event("KeyB", false);
  listener!(bold as unknown as KeyboardEvent);
  expect(toggleExplorerPanel).toHaveBeenCalledOnce();
  expect(bold.preventDefault).not.toHaveBeenCalled();
  await act(async () => renderer!.update(createElement(Harness, { custom: false, legacy: true })));
  const findNext = event("KeyG", false);
  listener!(findNext as unknown as KeyboardEvent);
  expect(toggleExplorerPanel).toHaveBeenCalledOnce();
  expect(findNext.preventDefault).not.toHaveBeenCalled();
});

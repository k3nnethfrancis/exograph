import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShortcutsSection } from "./ShortcutsSection";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.unstubAllGlobals(); });
async function mount() {
  const onChange = vi.fn();
  await act(async () => { renderer = create(createElement(ShortcutsSection, { bindings: {}, onChange })); });
  return { onChange, button: () => renderer!.root.findByProps({ "data-testid": "workspace-settings-shortcut-explorer" }), status: () => renderer!.root.findByProps({ role: "status" }).children.join("") };
}
function key(code: string, extra = {}) {
  return { key: code.replace("Key", "").toLowerCase(), code, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
}
describe("shortcut capture", () => {
  it("requires activation, visibly captures, then reports and stages a normalized binding", async () => {
    const fixture = await mount();
    expect(fixture.button().children.join("")).not.toContain("Change shortcut");
    expect(fixture.button().props["aria-label"]).toBe("Change Explorer shortcut");
    await act(async () => fixture.button().props.onKeyDown(key("KeyE", { altKey: true })));
    expect(fixture.onChange).not.toHaveBeenCalled();
    await act(async () => fixture.button().props.onClick());
    expect(fixture.button().children).toEqual(["Press a shortcut…"]);
    expect(fixture.status()).toContain("Escape cancels");
    await act(async () => fixture.button().props.onKeyDown(key("KeyE", { altKey: true })));
    expect(fixture.onChange).toHaveBeenCalledWith({ explorer: { code: "KeyE", shift: false, alt: true } });
    expect(fixture.button().props["aria-pressed"]).toBe(false);
    expect(fixture.status()).toContain("Explorer shortcut changed");
  });
  it("names collisions and rejects native commands without modifying settings", async () => {
    const fixture = await mount();
    await act(async () => fixture.button().props.onClick());
    await act(async () => fixture.button().props.onKeyDown(key("KeyN")));
    expect(fixture.status()).toContain("Already used by New note");
    expect(fixture.button().props["aria-pressed"]).toBe(true);
    await act(async () => fixture.button().props.onKeyDown(key("KeyC")));
    expect(fixture.status()).toContain("Reserved");
    expect(fixture.onChange).not.toHaveBeenCalled();
    const escape = key("Escape", { key: "Escape", metaKey: false });
    await act(async () => fixture.button().props.onKeyDown(escape));
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(fixture.button().props["aria-pressed"]).toBe(false);
    expect(fixture.status()).toContain("canceled");
  });
  it("lets Tab move focus and cancels on blur; Reset all restores defaults", async () => {
    const fixture = await mount();
    await act(async () => fixture.button().props.onClick());
    const tab = key("Tab", { key: "Tab", metaKey: false });
    await act(async () => fixture.button().props.onKeyDown(tab));
    expect(tab.preventDefault).not.toHaveBeenCalled();
    await act(async () => fixture.button().props.onBlur());
    expect(fixture.onChange).not.toHaveBeenCalled();
    const reset = renderer!.root.findAllByType("button").find(button => button.children.join("") === "Reset all")!;
    await act(async () => reset.props.onClick());
    expect(fixture.onChange).toHaveBeenCalledWith({});
  });
});

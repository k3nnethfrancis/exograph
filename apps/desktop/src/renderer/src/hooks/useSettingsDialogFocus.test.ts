import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useSettingsDialogFocus } from "./useSettingsDialogFocus";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.unstubAllGlobals(); });

async function fixture() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let active: ElementStub;
  let dialog: ElementStub;
  class ElementStub {
    isConnected = true;
    tabIndex = 0;
    disabled = false;
    visible = true;
    controls: ElementStub[] = [];
    focus() { active = this; }
    closest(selector: string) { return selector === '[role="dialog"]' ? dialog : null; }
    contains(element: ElementStub) { return this.controls.includes(element); }
    matches() { return this.disabled; }
    getClientRects() { return this.visible ? [{}] : []; }
    querySelectorAll() { return this.controls; }
  }
  vi.stubGlobal("HTMLElement", ElementStub);
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  dialog = new ElementStub();
  const opener = new ElementStub();
  const fallback = new ElementStub();
  const close = new ElementStub();
  const last = new ElementStub();
  const hidden = new ElementStub(); hidden.visible = false;
  const disabled = new ElementStub(); disabled.disabled = true;
  dialog.controls = [close, last, hidden, disabled];
  active = opener;
  vi.stubGlobal("document", { get activeElement() { return active; }, body: {}, querySelector: () => fallback });
  const onClose = vi.fn();
  function Harness() {
    const focus = useSettingsDialogFocus(onClose);
    return createElement("div", { ref: focus.dialogRef, onKeyDown: focus.onKeyDown }, createElement("button", { ref: focus.closeRef }));
  }
  await act(async () => { renderer = create(createElement(Harness), { createNodeMock: element => element.type === "div" ? dialog : close }); });
  const press = (key: string, overrides = {}) => {
    const event = { key, target: active, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides };
    renderer!.root.findByType("div").props.onKeyDown(event);
    return event;
  };
  return { opener, fallback, close, last, dialog, onClose, press, active: () => active };
}

it("focuses Close, wraps both boundaries, and skips disabled or hidden controls", async () => {
  const f = await fixture();
  expect(f.active()).toBe(f.close);
  f.press("Tab", { shiftKey: true });
  expect(f.active()).toBe(f.last);
  f.press("Tab");
  expect(f.active()).toBe(f.close);
  expect(f.press("Tab").preventDefault).not.toHaveBeenCalled();
});

it("respects child-consumed Escape and portal targets; routes ordinary Escape through safe close", async () => {
  const f = await fixture();
  f.press("Escape", { defaultPrevented: true });
  f.press("Escape", { target: f.fallback });
  expect(f.onClose).not.toHaveBeenCalled();
  f.last.focus();
  f.press("Escape");
  expect(f.onClose).toHaveBeenCalledOnce();
  // A rejected close leaves the mounted dialog and its focus untouched.
  expect(f.active()).toBe(f.last);
});

it("restores the connected opener only on unmount", async () => {
  const f = await fixture();
  await act(async () => renderer!.unmount()); renderer = undefined;
  expect(f.active()).toBe(f.opener);
});

it("returns to the persistent menu toggle if the original menu item unmounted", async () => {
  const f = await fixture();
  f.opener.isConnected = false;
  await act(async () => renderer!.unmount()); renderer = undefined;
  expect(f.active()).toBe(f.fallback);
});

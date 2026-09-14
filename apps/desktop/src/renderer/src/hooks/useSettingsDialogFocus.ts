import { useLayoutEffect, useRef, type KeyboardEvent } from "react";

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';

/** Keyboard containment belongs to this dialog, not the whole document: child
 * controls can consume Escape, and portal dialogs retain their own focus. */
export function useSettingsDialogFocus(onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      const fallback = document.querySelector<HTMLElement>('[data-testid="workspace-menu-toggle"]');
      const destination = opener?.isConnected ? opener : fallback;
      destination?.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const dialog = dialogRef.current;
    if (!dialog || event.defaultPrevented || !(event.target instanceof HTMLElement)
      || !dialog.contains(event.target) || event.target.closest('[role="dialog"]') !== dialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
    const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter(control => control.tabIndex >= 0 && !control.matches(":disabled") && !control.closest("[inert]")
        && control.getClientRects().length > 0 && getComputedStyle(control).visibility !== "hidden")
      .sort((left, right) => (left.tabIndex || Infinity) - (right.tabIndex || Infinity));
    const current = controls.indexOf(document.activeElement as HTMLElement);
    const wrap = controls.length === 0 || current < 0 || (event.shiftKey ? current === 0 : current === controls.length - 1);
    if (!wrap) return;
    event.preventDefault();
    (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    if (!controls.length) dialog.focus();
  }
  return { dialogRef, closeRef, onKeyDown };
}

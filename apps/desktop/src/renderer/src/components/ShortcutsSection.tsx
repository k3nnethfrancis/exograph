import { useId, useState } from "react";
import type { WorkspaceShortcutBindings, WorkspaceShortcutId } from "@exograph/core";
import { APP_KEYBINDINGS, resolvedWorkspaceShortcutBindings, shortcutBindingFromEvent, shortcutBindingIssue, shortcutLabel } from "../shellHelpModel";

interface ShortcutsSectionProps {
  bindings?: WorkspaceShortcutBindings;
  onChange: (bindings: WorkspaceShortcutBindings) => void;
}

export function ShortcutsSection({ bindings, onChange }: ShortcutsSectionProps) {
  const [capturing, setCapturing] = useState<WorkspaceShortcutId | null>(null);
  const [message, setMessage] = useState("");
  const statusId = useId();
  const resolved = resolvedWorkspaceShortcutBindings(bindings);
  const rows = APP_KEYBINDINGS.filter(entry => entry.id in resolved);
  const cancel = () => {
    setCapturing(null);
    setMessage("Shortcut change canceled.");
  };
  return (
    <section className="dialog-field dialog-field--section" data-testid="workspace-settings-shortcuts">
      <div className="dialog-field__header">
        <span className="dialog-field__label">Global shortcuts</span>
        <button className="toolbar-button" onClick={() => { setCapturing(null); setMessage("Default shortcuts restored."); onChange({}); }} type="button">Reset all</button>
      </div>
      <div className="onboarding-section__hint">Select a shortcut to change it. Escape cancels.</div>
      {rows.map(({ id: rowId, label }) => {
        const id = rowId as WorkspaceShortcutId;
        const active = capturing === id;
        return (
          <div className="settings-control-row" key={id}>
            <span className="dialog-field__label">{label}</span>
            <button
              aria-label={`Change ${label} shortcut`}
              aria-describedby={statusId}
              aria-pressed={active}
              className="toolbar-button settings-shortcut-value"
              data-testid={`workspace-settings-shortcut-${id}`}
              onClick={() => { setCapturing(id); setMessage(`Press a shortcut for ${label}. Escape cancels.`); }}
              onBlur={() => { if (active) cancel(); }}
              onKeyDown={(event) => {
                if (!active || event.repeat) return;
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); return; }
                if (event.key === "Tab") return;
                if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return;
                const binding = event.metaKey && event.ctrlKey ? null : shortcutBindingFromEvent(event);
                event.preventDefault();
                event.stopPropagation();
                if (!binding) { setMessage("Use Command or Control plus a letter, optionally with Shift or Alt. Escape cancels."); return; }
                const issue = shortcutBindingIssue(id, binding, bindings);
                if (issue) { setMessage(issue); return; }
                onChange({ ...bindings, [id]: binding });
                setCapturing(null);
                setMessage(`${label} shortcut changed to ${shortcutLabel(binding)}.`);
              }}
              type="button"
            >{active ? "Press a shortcut…" : shortcutLabel(resolved[id])}</button>
          </div>
        );
      })}
      <div id={statusId} role="status" aria-live="polite" className="dialog-card__status">{message}</div>
    </section>
  );
}

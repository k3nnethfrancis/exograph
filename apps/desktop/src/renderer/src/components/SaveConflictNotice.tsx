import { useState } from "react";

export function SaveConflictNotice({ kind, pending, onSaveCopy, onDiscard }: {
  kind: "changed" | "missing";
  pending: boolean;
  onSaveCopy?: () => void;
  onDiscard?: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  return <div className="save-conflict-notice" role="alert" data-testid="save-conflict-notice">
    <span>{kind === "missing" ? "This file was removed." : "This file changed outside Exograph."} Your local edits are kept here. Autosave is paused.</span>
    <div className="dialog-card__actions">
      <button className="toolbar-button" disabled={pending} onClick={onSaveCopy} type="button">Save a copy…</button>
      <button className="toolbar-button" disabled={pending} onClick={() => {
        setError(null);
        void onDiscard?.().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      }} type="button">{kind === "missing" ? "Discard local edits and close" : "Discard local edits and reload"}</button>
    </div>
    {error ? <span>{error}</span> : null}
  </div>;
}

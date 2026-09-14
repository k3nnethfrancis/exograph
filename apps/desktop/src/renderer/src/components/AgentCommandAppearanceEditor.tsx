import { useEffect, useRef, useState } from "react";
import { type AgentCommandAppearance } from "@exograph/core/agent-command-configuration";
import { AgentCommandIcon } from "./AgentCommandIcon";
import { importAgentCommandIcon } from "./agentCommandIconUpload";

export function AgentCommandAppearanceEditor({ appearance, label, handle, onChange, onPendingChange }: {
  appearance?: AgentCommandAppearance;
  label: string;
  handle: string;
  onChange: (appearance: AgentCommandAppearance | undefined) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const uploadVersion = useRef(0);
  const latest = useRef({ appearance, onChange });
  latest.current = { appearance, onChange };
  useEffect(() => () => { uploadVersion.current += 1; }, []);
  const update = (patch: Partial<AgentCommandAppearance>) => {
    const next = { ...latest.current.appearance, ...patch };
    latest.current.onChange(next.color || next.iconDataUrl ? {
      ...(next.color ? { color: next.color } : {}),
      ...(next.iconDataUrl ? { iconDataUrl: next.iconDataUrl } : {}),
    } : undefined);
  };
  return <div className="agent-command-appearance">
    <AgentCommandIcon command={{ handle, appearance }} size={24} />
    <label className="agent-command-appearance__color">Color
      <input aria-label={`${label} color`} type="color" value={appearance?.color ?? "#808080"} onChange={(event) => update({ color: event.target.value })} />
    </label>
    {appearance?.color ? <button className="toolbar-button" type="button" onClick={() => update({ color: undefined })}>Reset color</button> : null}
    <label className="toolbar-button agent-command-appearance__upload">
      {loading ? "Loading icon…" : "Upload icon"}
      <input aria-label={`${label} icon`} type="file" accept="image/png,image/jpeg" disabled={loading} onChange={async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        const version = ++uploadVersion.current;
        setError(undefined);
        setLoading(true);
        onPendingChange?.(true);
        try {
          const iconDataUrl = await importAgentCommandIcon(file);
          if (version === uploadVersion.current) update({ iconDataUrl });
        } catch (reason) {
          if (version === uploadVersion.current) setError(reason instanceof Error ? reason.message : "This image could not be opened.");
        } finally {
          if (version === uploadVersion.current) { setLoading(false); onPendingChange?.(false); }
        }
      }} />
    </label>
    {appearance?.iconDataUrl ? <button className="toolbar-button" type="button" onClick={() => { uploadVersion.current += 1; setLoading(false); onPendingChange?.(false); setError(undefined); update({ iconDataUrl: undefined }); }}>Remove icon</button> : null}
    {error ? <span className="dialog-field__error" role="alert">{error}</span> : null}
  </div>;
}

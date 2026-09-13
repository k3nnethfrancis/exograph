import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { publicationScope, type PublicationAction, type PublishingStatus } from "../../../shared/api";
import type { WorkspaceSettingsDialogState } from "../workspaceSettingsDialogTypes";

export function PublishingSection({ settings, setSettings }: {
  settings: WorkspaceSettingsDialogState;
  setSettings: Dispatch<SetStateAction<WorkspaceSettingsDialogState | null>>;
}) {
  const [status, setStatus] = useState<PublishingStatus>({ phase: "idle", diagnostics: [] });
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const identity = JSON.stringify([settings.workspaceRoot, settings.noteRoots, settings.publishing]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let eventSeen = false;
    const off = window.exograph.publishing.onStatus((next) => { eventSeen = true; setStatus(next); });
    void window.exograph.publishing.getStatus().then((next) => {
      if (mounted.current && !eventSeen) setStatus(next);
    }).catch((cause) => { if (mounted.current) setError(String(cause)); });
    return () => { mounted.current = false; off(); };
  }, []);
  const config = settings.publishing ?? { publicationDirectory: "", engineDirectory: "", siteUrl: "" };
  const busy = starting || status.phase === "exporting" || status.phase === "building";
  const saved = settings.saveStatus === "saved" && settings.applyStatus !== "applying";
  const update = (key: keyof typeof config, value: string) => {
    setError(null);
    setSettings((current) => current ? { ...current, publishing: { ...config, [key]: value }, saveStatus: "idle", errorMessage: null } : current);
  };
  const run = async (action: PublicationAction) => {
    const requestIdentity = identity;
    setStarting(true);
    setError(null);
    try {
      const next = await window.exograph.publishing.build({ action, scope: publicationScope(settings) });
      if (mounted.current && requestIdentity === identityRef.current) setStatus(next);
    } catch (cause) { if (mounted.current && requestIdentity === identityRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setStarting(false); }
  };
  const choose = async (key: "publicationDirectory" | "engineDirectory") => {
    const requestIdentity = identity;
    try {
      const paths = await window.exograph.workspace.selectFolder({ title: key === "publicationDirectory" ? "Choose publication folder" : "Choose Quartz project" });
      if (paths[0] && mounted.current && requestIdentity === identityRef.current) update(key, paths[0]);
    } catch (cause) { if (mounted.current) setError(String(cause)); }
  };
  const action = (operation: () => Promise<unknown>) => {
    void operation().catch((cause) => { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); });
  };
  return <section className="dialog-form" data-testid="workspace-settings-publishing">
    <label className="dialog-field">
      <span className="dialog-field__label">Publication folder</span>
      <div className="settings-control-row">
        <input className="dialog-card__input" data-testid="publishing-folder" value={config.publicationDirectory} onChange={(event) => update("publicationDirectory", event.target.value)} />
        <button className="toolbar-button" type="button" onClick={() => void choose("publicationDirectory")}>Select</button>
      </div>
      <small>Choose a folder inside this workspace’s Note Root. Local links to notes outside it are removed from the website.</small>
    </label>
    <label className="dialog-field">
      <span className="dialog-field__label">Quartz project</span>
      <div className="settings-control-row">
        <input className="dialog-card__input" data-testid="publishing-engine" value={config.engineDirectory} onChange={(event) => update("engineDirectory", event.target.value)} />
        <button className="toolbar-button" type="button" onClick={() => void choose("engineDirectory")}>Select</button>
      </div>
      <small>The site’s design and build tools. Keep this project outside your notes folders.</small>
    </label>
    <label className="dialog-field">
      <span className="dialog-field__label">Site URL</span>
      <input className="dialog-card__input" data-testid="publishing-site-url" placeholder="https://example.com" type="url" value={config.siteUrl} onChange={(event) => update("siteUrl", event.target.value)} />
    </label>
    <div className="dialog-card__actions">
      <button className="toolbar-button" data-testid="publishing-preview" disabled={busy || !saved} type="button" onClick={() => void run("preview")}>Build preview</button>
      <button className="toolbar-button" data-testid="publishing-prepare" disabled={busy || !saved} type="button" onClick={() => void run("prepare")}>Prepare publish</button>
      {busy || status.previewUrl ? <button className="toolbar-button" type="button" onClick={() => action(() => window.exograph.publishing.stop())}>{busy ? "Cancel build" : "Stop preview"}</button> : null}
    </div>
    <p className="dialog-card__hint">Prepare publish creates a site artifact for review. Deployment is a separate step.</p>
    <div role="status" aria-live="polite" data-testid="publishing-status">
      {status.phase === "exporting" ? "Preparing notes…" : status.phase === "building" ? "Building site…" : null}
      {status.phase === "ready" ? <>
        <p>{status.action === "prepare" ? "Site prepared. It has not been deployed." : "Preview ready."}</p>
        {status.previewUrl ? <button className="toolbar-button" type="button" data-testid="publishing-open-preview" onClick={() => action(() => window.exograph.shell.openExternal(status.previewUrl!))}>Open preview</button> : null}
        <button className="toolbar-button" type="button" onClick={() => action(() => window.exograph.publishing.revealOutput())}>Show site files</button>
      </> : null}
    </div>
    {error || status.error ? <p role="alert" className="dialog-card__status--error">{error ?? status.error}</p> : null}
    {status.diagnostics.length ? <details><summary>{status.diagnostics.length} publication notice{status.diagnostics.length === 1 ? "" : "s"}</summary>
      <ul>{status.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic.path}: {diagnostic.message}</li>)}</ul>
    </details> : null}
  </section>;
}

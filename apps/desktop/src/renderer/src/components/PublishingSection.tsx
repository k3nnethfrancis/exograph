import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { PublishingSetup } from "./PublishingSetup";
import { publicationScope, type PublicationAction, type PublishingStatus } from "../../../shared/api";
import type { WorkspaceSettingsDialogState } from "../workspaceSettingsDialogTypes";

export function PublishingSection({ settings, setSettings }: {
  settings: WorkspaceSettingsDialogState;
  setSettings: Dispatch<SetStateAction<WorkspaceSettingsDialogState | null>>;
}) {
  const [status, setStatus] = useState<PublishingStatus>({ phase: "idle", diagnostics: [] });
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [hasSavedDesign, setHasSavedDesign] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [managed, setManaged] = useState(false);
  const [setupNotice, setSetupNotice] = useState<string | null>(null);
  useEffect(() => {
    if (settings.saveStatus !== "saved" || settings.applyStatus === "applying") return;
    let current = true;
    void window.exograph.publishing.getSetupStatus().then(result => { if (current) { setManaged(result.managed); setHasSavedDesign(Boolean(result.hasSavedDesign)); } }).catch(() => {});
    return () => { current = false; };
  }, [settings.publishing?.engineDirectory, settings.saveStatus, settings.applyStatus]);
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
  const deploymentUrl = status.deployment?.status === "deployed" ? status.deployment.deploymentUrl : undefined;
  const busy = starting || status.phase === "exporting" || status.phase === "building" || status.phase === "deploying";
  const saved = settings.saveStatus === "saved" && settings.applyStatus !== "applying";
  const update = (key: keyof typeof config, value: string) => {
    setError(null);
    setSettings((current) => current ? { ...current, publishing: { ...config, [key]: value }, saveStatus: "idle", errorMessage: null } : current);
  };
  const run = async (action: PublicationAction, design?: "vanilla") => {
    const requestIdentity = identity;
    setStarting(true);
    setError(null);
    try {
      const next = await window.exograph.publishing.build({ action, ...(design ? { design } : {}), scope: publicationScope(settings) });
      if (mounted.current && requestIdentity === identityRef.current) setStatus(next);
    } catch (cause) { if (mounted.current && requestIdentity === identityRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setStarting(false); }
  };
  const changeDesign = async (action: "restore" | "undo") => {
    const requestIdentity = identity;
    setStarting(true); setError(null); setConfirmRestore(false);
    try {
      const next = await window.exograph.publishing.changeDesign({ scope: publicationScope(settings), action });
      if (mounted.current && requestIdentity === identityRef.current) {
        setStatus(next);
        if (next.phase !== "error") setHasSavedDesign(action === "restore");
        if (next.phase !== "error") setSetupNotice(action === "restore" ? "Vanilla restored. Your previous customization is saved. Preview and publish when ready." : "Your saved customization is restored. Preview and publish when ready.");
      }
    } catch (cause) { if (mounted.current && requestIdentity === identityRef.current) setError(String(cause)); }
    finally { if (mounted.current) setStarting(false); }
  };
  const publish = async () => {
    if (!status.preparedId || status.action !== "prepare" || status.phase !== "ready" || busy || !saved || status.deployment?.status === "deployed") return;
    const requestIdentity = identity;
    setStarting(true);
    setError(null);
    try {
      const next = await window.exograph.publishing.publish({ scope: publicationScope(settings), preparedId: status.preparedId });
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
  if (setupOpen) return <PublishingSetup key={identity} scope={publicationScope(settings)} onClose={() => setSetupOpen(false)} onConfigured={publishing => {
    if (identityRef.current !== identity) return;
    setSettings(current => current ? { ...current, publishing, saveStatus: "idle", errorMessage: null } : current);
    setManaged(true); setSetupOpen(false);
    setSetupNotice("Website connected. Prepare and publish when you’re ready to update the live site.");
  }} />;
  return <section className="dialog-form" data-testid="workspace-settings-publishing">
    {!config.engineDirectory ? <><p>Turn a folder of notes into a website. Exo manages the site code and publishes through GitHub Pages.</p><button className="toolbar-button" data-testid="publishing-start-setup" type="button" disabled={!saved} onClick={() => setSetupOpen(true)}>Set up website</button></> : <>
    {setupNotice ? <p role="status">{setupNotice}</p> : null}
    <div className="dialog-card"><strong>{config.destinationRepository || "Your website"}</strong><p>{config.siteUrl}</p><small>Content: {config.publicationDirectory}</small>
      <div className="dialog-card__actions">{managed ? <button className="toolbar-button" type="button" disabled={busy || !saved} onClick={() => action(() => window.exograph.publishing.revealTheme())}>Customize appearance</button> : null}
      <button className="toolbar-button" data-testid="publishing-start-setup" type="button" disabled={busy || !saved} onClick={() => setSetupOpen(true)}>{managed ? "Website setup" : "Use managed publishing"}</button></div>
    </div>
    {managed ? <details><summary>Design and recovery</summary>
      <p>Customize the Quartz code for this site. Restoring vanilla keeps your notes, address, and publishing setup. It uses the original Quartz version.</p>
      <div className="dialog-card__actions">
        <button className="toolbar-button" disabled={busy || !saved} onClick={() => void run("preview", "vanilla")}>Preview vanilla</button>
        <button className="toolbar-button" disabled={busy || !saved} onClick={() => setConfirmRestore(true)}>Restore vanilla</button>
        <button className="toolbar-button" disabled={busy || !saved || !hasSavedDesign} onClick={() => void changeDesign("undo")}>Undo restore</button>
      </div>
      {confirmRestore ? <div role="group" aria-label="Restore vanilla design"><p>Your current customization will be saved before vanilla replaces it. Your live site changes only when you publish.</p><button className="toolbar-button" disabled={busy || !saved} onClick={() => void changeDesign("restore")}>Save customization and restore</button><button className="toolbar-button" onClick={() => setConfirmRestore(false)}>Cancel</button></div> : null}
    </details> : null}
    <details><summary>Publishing configuration</summary><div className="dialog-form">
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
      <small>An installed Quartz 5 project with your theme and configuration. Keep it outside your notes folders.</small>
    </label>
    <label className="dialog-field">
      <span className="dialog-field__label">Site URL</span>
      <input className="dialog-card__input" data-testid="publishing-site-url" placeholder="https://example.com" type="url" value={config.siteUrl} onChange={(event) => update("siteUrl", event.target.value)} />
    </label>
    <label className="dialog-field">
      <span className="dialog-field__label">Destination repository</span>
      <input className="dialog-card__input" data-testid="publishing-repository" placeholder="owner/repository" value={config.destinationRepository ?? ""} onChange={(event) => update("destinationRepository", event.target.value)} />
      <small>The GitHub repository for your website. Publishing uses its reviewed GitHub Pages workflow and publication branch.</small>
    </label>
    </div></details>
    <div className="dialog-card__actions">
      <button className="toolbar-button" data-testid={status.previewUrl ? "publishing-open-preview" : "publishing-preview"} disabled={busy || !saved} type="button" onClick={() => status.previewUrl ? action(() => window.exograph.shell.openExternal(status.previewUrl!)) : void run("preview")}>View local site</button>
      <button className="toolbar-button" data-testid="publishing-prepare" disabled={busy || !saved} type="button" onClick={() => void run("prepare")}>Prepare publish</button>
      <button className="toolbar-button" data-testid="publishing-publish" disabled={busy || !saved || status.phase !== "ready" || status.action !== "prepare" || !status.preparedId || status.deployment?.status === "deployed"} type="button" onClick={() => void publish()}>Publish website</button>
      {busy || status.previewUrl ? <button className="toolbar-button" type="button" onClick={() => action(() => window.exograph.publishing.stop())}>{status.phase === "deploying" ? "Stop waiting" : busy ? "Cancel build" : "Stop preview"}</button> : null}
    </div>
    <p className="dialog-card__hint">Prepare publish saves theme edits and a content snapshot for review. Publish website sends that snapshot to GitHub Pages. Your notes are unchanged.</p>
    <div role="status" aria-live="polite" data-testid="publishing-status">
      {status.phase === "exporting" ? "Preparing notes…" : status.phase === "building" ? "Building site…" : null}
      {status.phase === "deploying" ? "Publishing site… Stopping the local wait does not cancel a dispatched remote workflow; check its status before publishing again." : null}
      {status.phase === "ready" ? <>
        <p>{status.deployment?.status === "deployed" ? "Site published." : status.action === "prepare" ? "Site prepared. It has not been deployed." : status.design === "vanilla" ? "Vanilla preview ready. Your active design is unchanged." : "Preview ready."}</p>
        <button className="toolbar-button" type="button" onClick={() => action(() => window.exograph.publishing.revealOutput())}>Show site files</button>
      </> : null}
    </div>
    {status.deployment?.status === "setup-required" ? <p role="alert">Publishing setup required: {status.deployment.message}</p> : null}
    {deploymentUrl ? <button className="toolbar-button" data-testid="publishing-open-site" type="button" onClick={() => action(() => window.exograph.shell.openExternal(deploymentUrl))}>Open published site</button> : null}
    {error || status.error ? <p role="alert" className="dialog-card__status--error">{error ?? status.error}</p> : null}
    {status.diagnostics.length ? <details><summary>{status.diagnostics.length} publication notice{status.diagnostics.length === 1 ? "" : "s"}</summary>
      <ul>{status.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic.path}: {diagnostic.message}</li>)}</ul>
    </details> : null}
    </>}
  </section>;
}

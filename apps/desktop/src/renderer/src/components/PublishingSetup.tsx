import { useEffect, useRef, useState } from "react";
import type { PublishingAuthStatus, PublishingScope } from "../../../shared/api";

export function PublishingSetup({ scope, onConfigured, onClose }: {
  scope: PublishingScope;
  onConfigured: (config: NonNullable<PublishingScope["publishing"]>) => void;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState(scope.publishing?.publicationDirectory ?? "");
  const [repository, setRepository] = useState(scope.publishing?.destinationRepository ?? "");
  const [createRepository, setCreateRepository] = useState(!scope.publishing?.destinationRepository);
  const [siteUrl, setSiteUrl] = useState(scope.publishing?.siteUrl ?? "");
  const [theme, setTheme] = useState(scope.publishing?.engineDirectory ?? "");
  const [importTheme, setImportTheme] = useState(Boolean(scope.publishing?.engineDirectory));
  const [auth, setAuth] = useState<PublishingAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void window.exograph.publishing.getSetupStatus().then(next => { if (mounted.current) setAuth(next); }).catch(e => { if (mounted.current) setError(String(e)); });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!auth?.pending) return;
    const timer = window.setInterval(() => {
      void window.exograph.publishing.getSetupStatus().then(next => { if (mounted.current) setAuth(next); }).catch(e => { if (mounted.current) setError(String(e)); });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [auth?.pending]);
  const choose = async (target: "folder" | "theme") => {
    try {
      const paths = await window.exograph.workspace.selectFolder({ title: target === "folder" ? "Choose website content" : "Choose existing Quartz theme" });
      if (paths[0] && mounted.current) (target === "folder" ? setFolder : setTheme)(paths[0]);
    } catch (cause) { setError(String(cause)); }
  };
  const connect = async () => {
    setError(null);
    try { setAuth(await window.exograph.publishing.startAuth()); }
    catch (cause) { setError(String(cause)); }
  };
  const setup = async () => {
    setBusy(true); setError(null);
    try {
      const result = await window.exograph.publishing.setup({ scope, publicationDirectory: folder, repository, createRepository, visibility: "public", ...(siteUrl.trim() ? { siteUrl: siteUrl.trim() } : {}), ...(importTheme ? { themeDirectory: theme } : {}) });
      if (!mounted.current) return;
      if (result.status !== "ready") { setError(result.message ?? "Setup could not finish."); return; }
      onConfigured({ publicationDirectory: folder, engineDirectory: result.engineDirectory, siteUrl: result.siteUrl, destinationRepository: result.repository });
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <section className="dialog-form" data-testid="publishing-setup">
    <p>Choose your notes. Exo sets up a website repository with its own Quartz theme and GitHub Pages publishing.</p>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "1rem" }}>
      <label className="dialog-field"><span className="dialog-field__label">Website content</span>
        <div className="settings-control-row"><input className="dialog-card__input" data-testid="publishing-setup-folder" value={folder} onChange={e => setFolder(e.target.value)} placeholder="Choose a folder in your notes" /><button className="toolbar-button" type="button" onClick={() => void choose("folder")}>Choose folder</button></div>
        <small>Notes stay here. Drafts and private links are excluded from the published copy.</small>
      </label>
      <div className="dialog-field"><span className="dialog-field__label">GitHub</span>
        {auth?.authenticated ? <span>Connected{auth.login ? ` as ${auth.login}` : ""}</span> : <button className="toolbar-button" type="button" disabled={auth?.pending} onClick={() => void connect()}>Connect GitHub</button>}
        {auth?.deviceCode ? <p>Enter <strong>{auth.deviceCode}</strong> on GitHub to connect.</p> : null}
        {auth?.verificationUrl ? <button className="toolbar-button" type="button" onClick={() => void window.exograph.shell.openExternal(auth.verificationUrl!).catch(e => setError(String(e)))}>Open GitHub sign-in</button> : null}
        {!auth?.authenticated && auth?.message ? <small>{auth.message}</small> : null}
      </div>
      <label className="dialog-field"><span className="dialog-field__label">Website repository</span>
        <select className="dialog-card__input" value={createRepository ? "create" : "existing"} onChange={e => setCreateRepository(e.target.value === "create")} aria-label="Repository setup"><option value="create">Create a new repository</option><option value="existing">Use an existing repository</option></select>
        <input className="dialog-card__input" data-testid="publishing-setup-repository" value={repository} onChange={e => setRepository(e.target.value)} placeholder={auth?.login ? `${auth.login}/my-website` : "owner/my-website"} />
        <small>{createRepository ? "The new repository will be public and contain only your site code and exported content." : "Exo will import your theme and replace the old publishing automation, keeping its configuration for recovery. Repository history is preserved. Your current website stays live until you publish."}</small>
      </label>
      <label className="dialog-field"><span className="dialog-field__label">Theme</span>
        <select className="dialog-card__input" value={importTheme ? "import" : "vanilla"} onChange={e => setImportTheme(e.target.value === "import")} aria-label="Website theme"><option value="vanilla">Quartz default</option><option value="import">Import my existing Quartz theme</option></select>
      </label>
      {importTheme ? <label className="dialog-field"><span className="dialog-field__label">Existing Quartz project</span><div className="settings-control-row"><input className="dialog-card__input" data-testid="publishing-setup-theme" value={theme} onChange={e => setTheme(e.target.value)} /><button className="toolbar-button" type="button" onClick={() => void choose("theme")}>Choose theme</button></div><small>Exo copies your committed theme into the website repository.</small></label> : null}
      <label className="dialog-field"><span className="dialog-field__label">Site address (optional)</span><input className="dialog-card__input" value={siteUrl} onChange={e => setSiteUrl(e.target.value)} placeholder="Use the GitHub Pages address" /><small>Keep your current address when migrating an existing site. A new custom domain also needs DNS configuration.</small></label>
    </fieldset>
    {error ? <p role="alert" className="dialog-card__status--error">{error}</p> : null}
    {busy ? <p role="status">Setting up your website and installing Quartz… This can take a few minutes.</p> : null}
    <div className="dialog-card__actions"><button className="toolbar-button" data-testid="publishing-setup-submit" type="button" disabled={busy || !auth?.authenticated || !folder.trim() || !repository.trim() || (importTheme && !theme.trim())} onClick={() => void setup()}>{busy ? "Setting up…" : "Set up website"}</button><button className="toolbar-button" type="button" onClick={() => { if (busy || auth?.pending) void window.exograph.publishing.cancelSetup().catch(e => setError(String(e))); else onClose(); }}>{busy || auth?.pending ? "Cancel setup" : "Back"}</button></div>
  </section>;
}

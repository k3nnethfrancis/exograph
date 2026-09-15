import { useEffect, useRef, useState } from "react";
import type { PublishingAuthStatus, PublishingScope } from "../../../shared/api";

export function PublishingSetup({ scope, onConfigured, onClose }: {
  scope: PublishingScope;
  onConfigured: (config: NonNullable<PublishingScope["publishing"]>) => void;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState(scope.publishing?.publicationDirectory ?? "");
  const [account, setAccount] = useState(scope.publishing?.destinationRepository?.split("/")[0] ?? "");
  const [repositoryName, setRepositoryName] = useState(scope.publishing?.destinationRepository?.split("/")[1] ?? "");
  const [createRepository, setCreateRepository] = useState(!scope.publishing?.destinationRepository);
  const [siteUrl, setSiteUrl] = useState(scope.publishing?.siteUrl ?? "");
  const [theme, setTheme] = useState(scope.publishing?.engineDirectory ?? "");
  const [importTheme, setImportTheme] = useState(Boolean(scope.publishing?.engineDirectory));
  const [auth, setAuth] = useState<PublishingAuthStatus | null>(null);
  const selectedAccount = account || auth?.login || "";
  const repository = `${selectedAccount}/${repositoryName.trim()}`;
  const accounts = auth?.accounts ?? (auth?.login ? [{ login: auth.login, kind: "user", canCreate: true }] : []);
  const validName = /^[A-Za-z0-9_.-]+$/.test(repositoryName.trim()) && ![".", ".."].includes(repositoryName.trim());
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
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
      const paths = await window.exograph.workspace.selectFolder({ title: target === "folder" ? "Choose website content" : "Choose existing Quartz site", defaultPath: (target === "folder" ? folder : theme) || undefined });
      if (paths[0] && mounted.current) (target === "folder" ? setFolder : setTheme)(paths[0]);
    } catch (cause) { setError(String(cause)); }
  };
  const connect = async () => {
    setConnecting(true); setError(null);
    try { setAuth(await window.exograph.publishing.startAuth()); }
    catch (cause) { setError(String(cause)); }
    finally { setConnecting(false); }
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
    <p>Choose the notes you want to publish. Exo sets up the website on GitHub Pages.</p>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "1rem" }}>
      <label className="dialog-field"><span className="dialog-field__label">Website content</span>
        <div className="settings-control-row"><input className="dialog-card__input" data-testid="publishing-setup-folder" value={folder} onChange={e => setFolder(e.target.value)} placeholder="Choose a folder in your notes" /><button className="toolbar-button" type="button" onClick={() => void choose("folder")}>Choose folder</button></div>
        <small>Notes stay here. Only publishable notes are exported; links to private notes become plain text.</small>
      </label>
      <div className="dialog-field"><span className="dialog-field__label">GitHub</span>
        {auth?.authenticated ? <span>Connected{auth.login ? ` as ${auth.login}` : ""}</span> : <button className="toolbar-button" type="button" disabled={connecting || auth?.pending} onClick={() => void connect()}>{connecting ? "Connecting…" : "Connect GitHub"}</button>}
        {auth?.deviceCode ? <p>Enter <strong>{auth.deviceCode}</strong> on GitHub to connect.</p> : null}
        {auth?.verificationUrl ? <button className="toolbar-button" type="button" onClick={() => void window.exograph.shell.openExternal(auth.verificationUrl!).catch(e => setError(String(e)))}>Open GitHub sign-in</button> : null}
        {!auth?.authenticated && auth?.message ? <small>{auth.message}</small> : null}
      </div>
      <div className="dialog-field"><span className="dialog-field__label">Website repository</span>
        <select className="dialog-card__input" value={createRepository ? "create" : "existing"} onChange={e => setCreateRepository(e.target.value === "create")} aria-label="Repository setup"><option value="create">Create a new repository</option><option value="existing">Use an existing repository</option></select>
        {auth?.authenticated ? <>
          {accounts.length > 1 || selectedAccount !== auth.login ? <><label htmlFor="publishing-account">Account</label>
          <select id="publishing-account" className="dialog-card__input" aria-label="GitHub account" value={selectedAccount} onChange={e => setAccount(e.target.value)}>
            {!accounts.some(item => item.login === selectedAccount) && selectedAccount ? <option value={selectedAccount}>{selectedAccount}</option> : null}
            {accounts.map(item => <option key={item.login} value={item.login} disabled={createRepository && !item.canCreate}>{item.login}{item.kind === "organization" ? " (organization)" : ""}</option>)}
          </select></> : <small>GitHub account: {selectedAccount}</small>}
          {auth.accountsMessage ? <><small role="status">{auth.accountsMessage}</small><button className="toolbar-button" type="button" onClick={() => void connect()}>Refresh accounts</button></> : null}
        </> : null}
        <label htmlFor="publishing-repository-name">Repository name</label>
        <input className="dialog-card__input" id="publishing-repository-name" aria-label="Repository name" data-testid="publishing-setup-repository" value={repositoryName} onChange={e => setRepositoryName(e.target.value)} placeholder="my-garden" />
        {repositoryName.trim() && !validName ? <small role="alert">Use letters, numbers, dots, underscores, or hyphens for the repository name.</small> : null}
        <small>{createRepository ? "Setup uploads your site code and exported notes to a public repository. Publish makes the website live." : "Exo will import your theme and replace the old publishing automation, keeping its configuration for recovery. Repository history is preserved. Your current website stays live until you publish."}</small>
      </div>
      <label className="settings-control-row"><input type="checkbox" checked={importTheme} onChange={e => setImportTheme(e.target.checked)} />Import an existing Quartz site</label>
      {!importTheme ? <small>Your site starts with vanilla Quartz. Customize its appearance after setup.</small> : null}
      {importTheme ? <label className="dialog-field"><span className="dialog-field__label">Existing Quartz site</span><div className="settings-control-row"><input className="dialog-card__input" data-testid="publishing-setup-theme" value={theme} onChange={e => setTheme(e.target.value)} /><button className="toolbar-button" type="button" onClick={() => void choose("theme")}>Choose site</button></div><small>Exo copies your committed theme into the website repository.</small></label> : null}
      <label className="dialog-field"><span className="dialog-field__label">Site address (optional)</span><input className="dialog-card__input" value={siteUrl} onChange={e => setSiteUrl(e.target.value)} placeholder="Use the GitHub Pages address" /><small>Keep your current address when migrating an existing site. A new custom domain also needs DNS configuration.</small></label>
    </fieldset>
    {error ? <p role="alert" className="dialog-card__status--error">{error}</p> : null}
    {busy ? <p role="status">Setting up your website and installing Quartz… This can take a few minutes.</p> : null}
    <div className="dialog-card__actions"><button className="toolbar-button" data-testid="publishing-setup-submit" type="button" disabled={busy || !auth?.authenticated || !folder.trim() || (!selectedAccount || !validName || (createRepository && accounts.find(item => item.login === selectedAccount)?.canCreate === false)) || (importTheme && !theme.trim())} onClick={() => void setup()}>{busy ? "Setting up…" : "Set up website"}</button><button className="toolbar-button" type="button" onClick={() => { if (busy || auth?.pending) void window.exograph.publishing.cancelSetup().catch(e => setError(String(e))); else onClose(); }}>{busy || auth?.pending ? "Cancel setup" : "Back"}</button></div>
  </section>;
}

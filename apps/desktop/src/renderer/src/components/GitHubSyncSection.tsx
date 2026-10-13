import "./githubSync.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitHubSyncConfig, GitHubSyncConnectionResult, GitHubSyncRepositoryInfo, GitHubSyncSetup, GitHubSyncSetupProgress, GitHubSyncStatus } from "../../../shared/api";
import { GitHubConnection } from "./GitHubConnection";
import { GitHubDownload, GitHubRepositoryPicker } from "./GitHubRepositoryPicker";

const activePhases = new Set<GitHubSyncStatus["phase"]>(["checking", "saving", "fetching", "merging", "pushing"]);
const sameConfig = (a: GitHubSyncConfig, b: GitHubSyncConfig) => a.enabled === b.enabled && a.remote === b.remote && a.branch === b.branch && a.remoteBranch === b.remoteBranch && a.cadence === b.cadence;
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const localTime = (value: string) => new Date(value).toLocaleString();

export function GitHubSyncSection({ disabled = false, onDownloaded }: { disabled?: boolean; onDownloaded?: (directory: string) => void | Promise<void> }) {
  const [status, setStatus] = useState<GitHubSyncStatus | null>(null);
  const [draft, setDraft] = useState<GitHubSyncConfig | null>(null);
  const [setup, setSetup] = useState<GitHubSyncSetup>();
  const [name, setName] = useState("");
  const [cadence, setCadence] = useState<GitHubSyncConfig["cadence"]>("hourly");
  const [mode, setMode] = useState<"home" | "create" | "existing" | "download">("home");
  const [selected, setSelected] = useState<GitHubSyncRepositoryInfo>();
  const [review, setReview] = useState<GitHubSyncConnectionResult>();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [setupProgress, setSetupProgress] = useState<GitHubSyncSetupProgress>();
  const [cancelling, setCancelling] = useState(false);
  const [reload, setReload] = useState(0);
  const [authenticated, setAuthenticated] = useState(false);
  const connected = useCallback(() => setAuthenticated(true), []);
  const alive = useRef(false);
  const root = useRef<string | null>(null);
  const operation = useRef(false);

  useEffect(() => {
    alive.current = true;
    let current = true;
    let event: GitHubSyncStatus | null = null;
    const api = window.exograph.githubSync;
    if (!api) { setError("GitHub sync is unavailable. Restart Exograph after installing the current build."); return () => { alive.current = false; }; }
    const offSetup = api.onSetupProgress(next => { if (current) setSetupProgress(next); });
    const off = api.onStatus(next => {
      event = next;
      if (current && root.current === next.root) setStatus(next);
    });
    void api.getStatus().then(next => {
      if (!current) return;
      const latest = event && event.root === next.root ? event : next;
      root.current = latest.root; setStatus(latest); setDraft(latest.config); setError(null);
    }).catch(cause => { if (current) setError(errorMessage(cause)); });
    return () => { current = false; alive.current = false; off(); offSetup(); };
  }, [reload]);

  useEffect(() => {
    if (!authenticated) return;
    let current = true;
    void window.exograph.githubSync.inspectSetup().then(next => {
      if (!current || (root.current && root.current !== next.root)) return;
      setSetup(next); setName(next.suggestedName);
    }).catch(cause => { if (current) setError(errorMessage(cause)); });
    return () => { current = false; };
  }, [authenticated, reload]);

  const run = async (kind: string, action: () => Promise<GitHubSyncStatus | GitHubSyncConnectionResult>) => {
    if (!status || disabled || operation.current || activePhases.has(status.phase)) return;
    const capturedRoot = status.root;
    operation.current = true; setPending(kind); setError(null); setSetupProgress(undefined);
    try {
      const result = await action();
      if (!alive.current || root.current !== capturedRoot) return;
      if ("kind" in result && result.kind === "review-required") { setReview(result); setSelected(result.repository); setMode("existing"); return; }
      const next = "kind" in result ? result.status : result;
      if (next?.root === capturedRoot) { setStatus(next); setDraft(next.config); setMode("home"); setReview(undefined); }
    } catch (cause) { if (alive.current && root.current === capturedRoot) setError(errorMessage(cause)); }
    finally { operation.current = false; if (alive.current) setPending(null); }
  };
  const configure = (config: GitHubSyncConfig) => void run("save", () => window.exograph.githubSync.configure({ root: status!.root, config }));
  const cancel = async () => {
    if (!status || cancelling) return;
    const capturedRoot = status.root;
    setCancelling(true); setError(null);
    try {
      const next = await window.exograph.githubSync.cancel();
      if (alive.current && root.current === capturedRoot && next.root === capturedRoot) setStatus(next);
    } catch (cause) { if (alive.current && root.current === capturedRoot) setError(errorMessage(cause)); }
    finally { if (alive.current) setCancelling(false); }
  };
  const busy = Boolean(pending || (status && activePhases.has(status.phase)));
  const dirty = Boolean(status && draft && !sameConfig(status.config, draft));
  const validName = /^[A-Za-z0-9_.-]+$/.test(name.trim()) && ![".", ".."].includes(name.trim());
  const destination = status?.repository;
  const preferred = setup?.candidates.find(candidate => candidate.preferred) ?? (setup?.candidates.length === 1 ? setup.candidates[0] : undefined);
  const chooseExisting = (repository: GitHubSyncRepositoryInfo) => { setSelected(repository); setReview(undefined); };
  const enable = (repository: GitHubSyncRepositoryInfo, remote?: string) => void run("connect", () => window.exograph.githubSync.connectExisting({ root: status!.root, repository: repository.nameWithOwner, cadence, ...(remote ? { remote } : {}) }));

  return <section className="github-sync-section" data-testid="workspace-settings-github-sync">
    {disabled ? <p role="status">Apply your workspace changes before configuring sync.</p> : null}
    {mode === "download" && onDownloaded ? <GitHubDownload onDownloaded={onDownloaded} onClose={() => setMode("home")} /> : <>
      {status && draft ? <>
        {destination && mode === "home" ? <>
          <div className="github-sync-summary"><div className="github-sync-repository"><button className="github-sync-link" type="button" onClick={() => void window.exograph.shell.openExternal(`https://github.com/${destination}`).catch(cause => setError(errorMessage(cause)))}>{destination} ↗</button><small>Private</small></div>
            <small>{status.lastSuccess ? `Last synced ${localTime(status.lastSuccess)}` : "Not yet synced"}</small>
          </div>
          <div className="github-sync-actions">
            <button className="toolbar-button toolbar-button--primary" data-testid="github-sync-now" type="button" disabled={disabled || busy || dirty || !status.config.enabled} onClick={() => void run("sync", () => window.exograph.githubSync.syncNow({ root: status.root }))}>{busy ? "Syncing…" : "Sync now"}</button>
            <label className="github-sync-schedule">Automatically<Schedule value={status.config.cadence} disabled={disabled || busy} onChange={value => configure({ ...status.config, cadence: value })} /></label>
            <button className="toolbar-button" data-testid="github-sync-pause" type="button" disabled={disabled || busy} onClick={() => configure({ ...status.config, enabled: !status.config.enabled })}>{status.config.enabled ? "Pause sync" : "Resume sync"}</button>
          </div>
          <small>Sync runs while this workspace is open. Missed runs resume when Exograph opens or wakes.</small>
          <GitHubConnection onConnected={connected} />
          <details data-testid="github-sync-details"><summary>Git details</summary>
            <div className="github-sync-fields">
              <label className="dialog-field"><span className="dialog-field__label">Git remote</span><input className="dialog-card__input" data-testid="github-sync-remote" disabled={disabled || busy} value={draft.remote} onChange={event => setDraft({ ...draft, remote: event.target.value })} spellCheck={false} /></label>
              <label className="dialog-field"><span className="dialog-field__label">Branch</span><input className="dialog-card__input" data-testid="github-sync-branch" disabled={disabled || busy} value={draft.branch} onChange={event => setDraft({ ...draft, branch: event.target.value })} spellCheck={false} /></label>
            </div>
            <small>{status.root}</small>{status.config.remoteBranch ? <small>Remote branch: {status.config.remoteBranch}</small> : null}
            {status.lastSyncedCommit ? <small>Saved revision: <code>{status.lastSyncedCommit.slice(0, 8)}</code></small> : null}
            {status.nextRun ? <small>Next sync: {localTime(status.nextRun)}</small> : null}
            <button className="toolbar-button" data-testid="github-sync-save" type="button" disabled={disabled || busy || !dirty || !draft.remote.trim() || !draft.branch.trim()} onClick={() => configure(draft)}>Save Git details</button>
          </details>
        </> : <>
          {mode === "existing" && !selected ? null : <GitHubConnection onConnected={connected} />}
          {authenticated && setup ? <>
            {mode === "home" ? <>
              {preferred ? <div className="github-sync-summary"><strong>{preferred.repository.nameWithOwner} · {preferred.repository.isPrivate ? "Private" : "Public"}</strong><small>This notes folder is already connected.</small>
                <Schedule value={cadence} disabled={disabled || busy} onChange={setCadence} />
                <button className="toolbar-button toolbar-button--primary" data-testid="github-sync-enable" type="button" disabled={disabled || busy || !preferred.repository.isPrivate || !preferred.repository.writable} onClick={() => enable(preferred.repository, preferred.remote)}>Enable sync</button>
                {!preferred.repository.isPrivate ? <p>Notes sync requires a private repository.</p> : !preferred.repository.writable ? <p>You need write access to enable sync.</p> : null}
              </div> : setup.candidates.length > 1 ? <div className="github-repository-list"><p>Choose the repository for these notes.</p>{setup.candidates.map(candidate => <button className="github-repository-option" key={candidate.remote} type="button" disabled={disabled || busy || !candidate.repository.isPrivate || !candidate.repository.writable} onClick={() => enable(candidate.repository, candidate.remote)}><strong>{candidate.repository.nameWithOwner}</strong><small>{candidate.branch}</small></button>)}</div> : <p>Keep your notes on GitHub and continue on another computer.</p>}
              {setup.local.problem ? <p role="status">{setup.local.problem}</p> : null}
              <div className="github-sync-actions"><button className="toolbar-button" data-testid="github-sync-create" type="button" disabled={disabled || busy} onClick={() => setMode("create")}>Create private repository</button><button className="toolbar-button" data-testid="github-sync-existing" type="button" disabled={disabled || busy} onClick={() => setMode("existing")}>Use existing repository</button></div>
            </> : mode === "create" ? <>
              <label className="dialog-field"><span className="dialog-field__label">Repository name</span><input className="dialog-card__input" data-testid="github-sync-name" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
              <strong>{setup.account?.login}/{name.trim()} · Private</strong>
              <small>Includes notes, attachments, and editorial annotations. Credentials, caches, and local app state stay on this computer.</small>
              <Schedule value={cadence} disabled={busy} onChange={setCadence} />
              <button className="toolbar-button toolbar-button--primary" data-testid="github-sync-create-submit" type="button" disabled={disabled || busy || !validName || !setup.account} onClick={() => void run("create", () => window.exograph.githubSync.createAndSync({ root: status.root, owner: setup.account!.login, name: name.trim(), cadence }))}>{busy ? "Setting up…" : "Create and sync"}</button>
            </> : mode === "existing" ? <>
              {!selected ? <GitHubRepositoryPicker disabled={disabled || busy} onSelect={chooseExisting} /> : <>
                <strong>{selected.nameWithOwner} · Private</strong>
                {review ? <div role="status" data-testid="github-sync-combination-review"><p>{review.message}</p><p>Your local notes and this repository are kept separate.</p>{onDownloaded ? <button className="toolbar-button" type="button" onClick={() => setMode("download")}>Download as another workspace</button> : null}</div> : <><Schedule value={cadence} disabled={disabled || busy} onChange={setCadence} /><button className="toolbar-button toolbar-button--primary" data-testid="github-sync-connect-submit" type="button" disabled={disabled || busy} onClick={() => enable(selected)}>Connect and sync</button></>}
                <button className="toolbar-button" type="button" disabled={busy} onClick={() => { setSelected(undefined); setReview(undefined); }}>Choose another repository</button>
              </>}
            </> : null}
            {mode !== "home" ? <button className="toolbar-button" type="button" disabled={busy} onClick={() => { setMode("home"); setReview(undefined); }}>Back</button> : null}
          </> : authenticated ? <p role="status">Checking this notes folder…</p> : null}
        </>}
        {["checking", "fetching", "pushing"].includes(status.phase) ? <button className="toolbar-button" data-testid="github-sync-cancel" type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "Stopping…" : "Stop sync"}</button> : null}
        {pending && setupProgress ? <p role="status">{setupProgress.message}</p> : null}
        <div role="status" aria-live="polite" data-testid="github-sync-status"><p role={status.phase === "error" ? "alert" : undefined}>{status.message || (status.config.enabled ? "Ready to sync." : destination ? "Sync paused." : "")}</p></div>
        {status.conflicts?.length ? <div role="alert"><p>Resolve these files before syncing again. Your changes are preserved.</p><ul>{status.conflicts.map(file => <li key={file}>{file}</li>)}</ul></div> : null}
        {status.excluded.length ? <details><summary>Files kept on this computer ({status.excluded.length})</summary><ul>{status.excluded.map(file => <li key={file}>{file}</li>)}</ul></details> : null}
      </> : !error ? <p role="status">Loading sync settings…</p> : null}
    </>}
    {error ? <div role="alert"><p className="dialog-card__status--error">{error}</p><button className="toolbar-button" onClick={() => setReload(value => value + 1)}>Retry</button></div> : null}
  </section>;
}

function Schedule({ value, disabled, onChange }: { value: GitHubSyncConfig["cadence"]; disabled?: boolean; onChange: (value: GitHubSyncConfig["cadence"]) => void }) {
  return <select className="dialog-card__input" aria-label="Sync schedule" data-testid="github-sync-cadence" value={value} disabled={disabled} onChange={event => onChange(event.target.value as GitHubSyncConfig["cadence"])}><option value="manual">Manual</option><option value="hourly">Hourly</option><option value="daily">Daily</option></select>;
}

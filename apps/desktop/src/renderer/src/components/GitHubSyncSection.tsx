import "./githubSync.css";
import { useEffect, useRef, useState } from "react";
import type { GitHubSyncConfig, GitHubSyncStatus, PublishingAuthStatus } from "../../../shared/api";

const activePhases = new Set<GitHubSyncStatus["phase"]>(["checking", "saving", "fetching", "merging", "pushing"]);
const sameConfig = (a: GitHubSyncConfig, b: GitHubSyncConfig) => a.enabled === b.enabled && a.remote === b.remote && a.branch === b.branch && a.cadence === b.cadence;
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const localTime = (value: string) => new Date(value).toLocaleString();

/** Configuration is deliberately saved through sync's own validated boundary. */
export function GitHubSyncSection({ disabled = false }: { disabled?: boolean }) {
  const [status, setStatus] = useState<GitHubSyncStatus | null>(null);
  const [draft, setDraft] = useState<GitHubSyncConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "sync" | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reload, setReload] = useState(0);
  const [auth, setAuth] = useState<PublishingAuthStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const alive = useRef(false);
  const root = useRef<string | null>(null);
  const operation = useRef(false);

  useEffect(() => {
    alive.current = true;
    let current = true;
    let event: GitHubSyncStatus | null = null;
    const api = window.exograph.githubSync;
    if (!api) { setError("GitHub sync is unavailable. Restart Exograph after installing the current build."); return () => { alive.current = false; }; }
    const off = api.onStatus(next => {
      event = next;
      if (current && root.current === next.root) setStatus(next);
    });
    void api.getStatus().then(next => {
      if (!current) return;
      const latest = event && event.root === next.root ? event : next;
      root.current = latest.root; setStatus(latest); setDraft(latest.config); setError(null);
    }).catch(cause => { if (current) setError(errorMessage(cause)); });
    void window.exograph.publishing.getSetupStatus().then(next => { if (current) setAuth(next); }).catch(() => {});
    return () => { current = false; alive.current = false; off(); };
  }, [reload]);

  useEffect(() => {
    if (!auth?.pending) return;
    let current = true;
    const timer = window.setInterval(() => {
      void window.exograph.publishing.getSetupStatus().then(next => { if (current) setAuth(next); }).catch(cause => { if (current) setError(errorMessage(cause)); });
    }, 2000);
    return () => { current = false; window.clearInterval(timer); };
  }, [auth?.pending]);

  const run = async (kind: "save" | "sync") => {
    if (!status || !draft || disabled || operation.current || activePhases.has(status.phase)) return;
    const capturedRoot = status.root;
    operation.current = true; setPending(kind); setError(null);
    try {
      const next = kind === "save"
        ? await window.exograph.githubSync.configure({ root: capturedRoot, config: { ...draft } })
        : await window.exograph.githubSync.syncNow({ root: capturedRoot });
      if (!alive.current || root.current !== capturedRoot || next.root !== capturedRoot) return;
      setStatus(next);
      if (kind === "save") setDraft(next.config);
    } catch (cause) { if (alive.current && root.current === capturedRoot) setError(errorMessage(cause)); }
    finally { operation.current = false; if (alive.current) setPending(null); }
  };
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
  const connect = async () => {
    if (connecting || auth?.pending) return;
    setConnecting(true); setError(null);
    try { const next = await window.exograph.publishing.startAuth(); if (alive.current) setAuth(next); }
    catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally { if (alive.current) setConnecting(false); }
  };
  const dirty = Boolean(status && draft && !sameConfig(status.config, draft));
  const busy = Boolean(pending || (status && activePhases.has(status.phase)));
  const update = (patch: Partial<GitHubSyncConfig>) => { setDraft(current => current ? { ...current, ...patch } : current); setError(null); };

  return <section className="github-sync-section" data-testid="workspace-settings-github-sync">
    {disabled ? <p role="status">Apply your workspace changes before configuring sync.</p> : null}
    {status && draft ? <>
      <div className="github-sync-summary"><strong>{status.repository ? `${status.repository} · Private` : "Private repository"}</strong><p>{status.root}</p>
        <small>Uses this notes folder’s Git repository. Clone or connect its Git remote before enabling sync.</small>
      </div>
      <fieldset disabled={disabled || busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "1rem" }}>
        <label className="github-sync-toggle"><input data-testid="github-sync-enabled" type="checkbox" checked={draft.enabled} onChange={event => update({ enabled: event.target.checked })} />Enable GitHub sync</label>
        <label className="dialog-field"><span className="dialog-field__label">Sync schedule</span>
          <select className="dialog-card__input" data-testid="github-sync-cadence" value={draft.cadence} onChange={event => update({ cadence: event.target.value as GitHubSyncConfig["cadence"] })}>
            <option value="manual">Only when I press Sync now</option><option value="hourly">Hourly</option><option value="daily">Daily</option>
          </select>
          <small>Scheduled sync runs for the active workspace while Exograph is open. Missed runs resume when the app opens or wakes. Sync does not publish your website.</small>
        </label>
        <div className="github-sync-fields">
          <label className="dialog-field"><span className="dialog-field__label">Git remote</span><input className="dialog-card__input" data-testid="github-sync-remote" value={draft.remote} onChange={event => update({ remote: event.target.value })} spellCheck={false} /></label>
          <label className="dialog-field"><span className="dialog-field__label">Branch</span><input className="dialog-card__input" data-testid="github-sync-branch" value={draft.branch} onChange={event => update({ branch: event.target.value })} spellCheck={false} /></label>
        </div>
      </fieldset>
      <div className="github-sync-actions">
        <button className="toolbar-button" data-testid="github-sync-save" type="button" disabled={disabled || busy || !dirty || !draft.remote.trim() || !draft.branch.trim()} onClick={() => void run("save")}>{pending === "save" ? "Saving…" : "Save configuration"}</button>
        <button className="toolbar-button" data-testid="github-sync-now" type="button" disabled={disabled || busy || dirty || !status.config.enabled} onClick={() => void run("sync")}>{pending === "sync" || activePhases.has(status.phase) ? "Syncing…" : "Sync now"}</button>
        {["checking", "fetching", "pushing"].includes(status.phase) ? <button className="toolbar-button" data-testid="github-sync-cancel" type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "Stopping…" : "Stop sync"}</button> : null}
      </div>
      {dirty ? <small>Save configuration to use these settings.</small> : null}
      <div role="status" aria-live="polite" data-testid="github-sync-status">
        <p role={status.phase === "error" ? "alert" : undefined}>{status.message || (status.config.enabled ? "Ready to sync." : "Sync is off.")}</p>
        {activePhases.has(status.phase) ? <p>{({ checking: "Checking repository…", saving: "Saving local changes…", fetching: "Checking GitHub…", merging: "Combining changes…", pushing: "Sending changes to GitHub…" } as Partial<Record<GitHubSyncStatus["phase"], string>>)[status.phase]}</p> : null}
        <p>Last successful sync: {status.lastSuccess ? localTime(status.lastSuccess) : "Not yet synced"}</p>
        {status.lastSyncedCommit ? <small>Saved revision: <code>{status.lastSyncedCommit.slice(0, 8)}</code></small> : null}
        {status.nextRun ? <small>Next scheduled sync: {localTime(status.nextRun)}</small> : null}
      </div>
      {status.conflicts?.length ? <div role="alert"><p>Resolve these files before syncing again. Your changes are preserved.</p><ul>{status.conflicts.map(file => <li key={file}>{file}</li>)}</ul></div> : null}
      {status.excluded.length ? <details><summary>Files kept on this computer ({status.excluded.length})</summary><ul>{status.excluded.map(file => <li key={file}>{file}</li>)}</ul></details> : null}
    </> : !error ? <p role="status">Loading sync settings…</p> : null}
    <div className="dialog-field"><span className="dialog-field__label">GitHub account</span>
      {auth?.authenticated ? <small>Connected{auth.login ? ` as ${auth.login}` : ""}</small> : <button className="toolbar-button" type="button" disabled={connecting || auth?.pending} onClick={() => void connect()}>{connecting || auth?.pending ? "Connecting…" : "Connect GitHub"}</button>}
      {auth?.deviceCode ? <p>Enter <strong>{auth.deviceCode}</strong> on GitHub.</p> : null}
      {auth?.verificationUrl ? <button className="toolbar-button" type="button" onClick={() => void window.exograph.shell.openExternal(auth.verificationUrl!).catch(cause => setError(errorMessage(cause)))}>Open GitHub sign-in</button> : null}
      {!auth?.authenticated && auth?.message ? <small>{auth.message}</small> : null}
    </div>
    {error ? <div role="alert"><p className="dialog-card__status--error">{error}</p>{!status ? <button className="toolbar-button" onClick={() => setReload(value => value + 1)}>Retry</button> : null}</div> : null}
  </section>;
}

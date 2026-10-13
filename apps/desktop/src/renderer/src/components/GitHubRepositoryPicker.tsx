import { useCallback, useEffect, useRef, useState } from "react";
import type { GitHubSyncRepositoryInfo } from "../../../shared/api";
import { GitHubConnection } from "./GitHubConnection";
import "./githubSync.css";

export function GitHubRepositoryPicker({ onSelect, disabled = false }: {
  onSelect: (repository: GitHubSyncRepositoryInfo) => void;
  disabled?: boolean;
}) {
  const [authenticated, setAuthenticated] = useState(false);
  const connected = useCallback(() => setAuthenticated(true), []);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [repositories, setRepositories] = useState<GitHubSyncRepositoryInfo[]>([]);
  const [nextPage, setNextPage] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    if (!authenticated) return;
    const request = ++generation.current;
    setBusy(true); setError(undefined);
    const timer = window.setTimeout(() => {
      void window.exograph.githubSync.listRepositories({ query }).then(result => {
        if (request !== generation.current) return;
        setRepositories(result.repositories); setNextPage(result.nextPage);
      }).catch(cause => { if (request === generation.current) setError(String(cause)); })
        .finally(() => { if (request === generation.current) setBusy(false); });
    }, query ? 250 : 0);
    return () => { window.clearTimeout(timer); generation.current++; };
  }, [authenticated, query, reload]);
  const loadMore = async () => {
    if (!nextPage || busy) return;
    const request = generation.current;
    setBusy(true);
    try {
      const result = await window.exograph.githubSync.listRepositories({ query, page: nextPage });
      if (request !== generation.current) return;
      setRepositories(current => [...current, ...result.repositories]); setNextPage(result.nextPage);
    } catch (cause) { if (request === generation.current) setError(String(cause)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const lookup = async () => {
    setBusy(true); setError(undefined);
    try {
      const repo = await window.exograph.githubSync.inspectRepository({ repository: url.trim() });
      if (!repo.isPrivate || !repo.writable) { setError(!repo.isPrivate ? "Choose a private repository." : "You need write access to sync this repository."); return; }
      onSelect(repo);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="github-sync-section" data-testid="github-repository-picker">
    <GitHubConnection onConnected={connected} />
    {authenticated ? <>
      <label className="dialog-field"><span className="dialog-field__label">Your repositories</span><input className="dialog-card__input" data-testid="github-repository-search" placeholder="Search repositories" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="github-repository-list" aria-label="GitHub repositories">
        {repositories.map(repo => <button key={repo.nameWithOwner} className="github-repository-option" type="button" disabled={disabled || busy || !repo.isPrivate || !repo.writable} onClick={() => onSelect(repo)}>
          <strong>{repo.nameWithOwner}</strong><small>{!repo.isPrivate ? "Public · unavailable for notes sync" : !repo.writable ? "Read only" : "Private"}</small>
        </button>)}
        {!busy && !repositories.length ? <small>No matching repositories. You can enter a repository URL below.</small> : null}
      </div>
      {busy ? <small role="status">Loading repositories…</small> : null}
      {nextPage ? <button className="toolbar-button" type="button" disabled={disabled || busy} onClick={() => void loadMore()}>Load more</button> : null}
      <details><summary>Use a repository URL</summary><div className="github-sync-actions"><input className="dialog-card__input" aria-label="Repository URL" placeholder="https://github.com/account/notes" value={url} onChange={event => setUrl(event.target.value)} /><button className="toolbar-button" type="button" disabled={disabled || busy || !url.trim()} onClick={() => void lookup()}>Find repository</button></div></details>
    </> : null}
    {error ? <div role="alert"><p>{error}</p><button className="toolbar-button" type="button" onClick={() => setReload(value => value + 1)}>Retry</button></div> : null}
  </section>;
}

export function GitHubDownload({ onDownloaded, onClose }: { onDownloaded: (directory: string) => void | Promise<void>; onClose: () => void }) {
  const [selected, setSelected] = useState<GitHubSyncRepositoryInfo>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [canCancel, setCanCancel] = useState(false);
  const [downloaded, setDownloaded] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => window.exograph.githubSync.onSetupProgress(progress => { setMessage(progress.message); setCanCancel(progress.canCancel); }), []);
  const download = async () => {
    if (!selected || busy) return;
    setBusy(true); setError(undefined);
    try {
      if (downloaded) { await onDownloaded(downloaded); return; }
      const result = await window.exograph.githubSync.downloadRepository({ repository: selected.nameWithOwner });
      if (result) { setDownloaded(result.directory); await onDownloaded(result.directory); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="github-sync-section" data-testid="github-download">
    <h2>Open from GitHub</h2>
    {!selected ? <GitHubRepositoryPicker onSelect={setSelected} /> : <>
      <strong>{selected.nameWithOwner} · Private</strong>
      <p>Choose where to download your notes, then finish setting up this workspace.</p>
      <button className="toolbar-button toolbar-button--primary" data-testid="github-download-submit" type="button" disabled={busy} onClick={() => void download()}>{busy ? (downloaded ? "Opening…" : "Downloading…") : downloaded ? "Open downloaded notes" : "Download notes"}</button>
      {busy ? <p role="status">{message || "Downloading your notes…"}</p> : null}
      {busy ? <button className="toolbar-button" type="button" disabled={!canCancel} onClick={() => void window.exograph.githubSync.cancelSetup().catch(cause => setError(String(cause)))}>Stop download</button> : <button className="toolbar-button" type="button" onClick={() => { setSelected(undefined); setDownloaded(undefined); }}>Choose another repository</button>}
    </>}
    {error ? <p role="alert">{error}</p> : null}
    <button className="toolbar-button" type="button" disabled={busy} onClick={onClose}>Back</button>
  </section>;
}

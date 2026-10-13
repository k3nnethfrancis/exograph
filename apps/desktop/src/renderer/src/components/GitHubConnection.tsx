import { useEffect, useState } from "react";
import type { PublishingAuthStatus } from "../../../shared/api";

export function GitHubConnection({ onConnected }: { onConnected?: (auth: PublishingAuthStatus) => void }) {
  const [auth, setAuth] = useState<PublishingAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const refresh = () => void window.exograph.githubSync.getAccountStatus().then(next => {
      if (!alive) return;
      setAuth(next);
      if (next.authenticated) onConnected?.(next);
    }).catch(cause => { if (alive) setError(String(cause)); });
    refresh();
    const timer = auth?.pending ? window.setInterval(refresh, 2000) : undefined;
    return () => { alive = false; if (timer) window.clearInterval(timer); };
  }, [onConnected, auth?.pending]);
  const connect = async () => {
    setBusy(true); setError(undefined);
    try { const next = await window.exograph.githubSync.startAccountAuth(); setAuth(next); if (next.authenticated) onConnected?.(next); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="github-connection">
    {auth?.authenticated ? <small>Connected as {auth.login}</small> : <button className="toolbar-button toolbar-button--primary" type="button" disabled={busy || auth?.pending} onClick={() => void connect()}>{busy || auth?.pending ? "Connecting…" : "Connect GitHub"}</button>}
    {auth?.deviceCode ? <p>Enter <strong>{auth.deviceCode}</strong> on GitHub.</p> : null}
    {auth?.verificationUrl ? <button className="toolbar-button" type="button" onClick={() => void window.exograph.shell.openExternal(auth.verificationUrl!).catch(cause => setError(String(cause)))}>Open GitHub sign-in</button> : null}
    {!auth?.authenticated && auth?.message ? <small>{auth.message}</small> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}

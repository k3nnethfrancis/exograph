import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, FileText, Globe2, Plus, RotateCw, X } from "lucide-react";

import { ChromeTab } from "./Chrome";
import type { DragManager } from "../hooks/useDragManager";
import type { PreviewTarget } from "../../../shared/api/workspace-filesystem";
import { PdfDocumentView } from "./PdfDocumentView";

interface BrowserPaneProps {
  paneId: string;
  target: PreviewTarget;
  compact: boolean;
  onFocus: () => void;
  onNavigate: (target: string) => Promise<PreviewTarget>;
  onOpenExternal: (target: string) => Promise<void>;
  onClosePane: (() => void) | null;
  tabs?: Array<{ id: string; target: PreviewTarget }>;
  activeTabId?: string | null;
  onSelectTab?: (id: string) => void;
  onCreateTab?: () => void;
  onCloseTab?: (id: string) => void;
  dragManager?: DragManager;
}

export function BrowserPane(props: BrowserPaneProps) {
  const { paneId, target, compact, onFocus, onNavigate, onClosePane } = props;
  const tabs = props.tabs?.length ? props.tabs : [{ id: paneId, target }];
  const [draftUrl, setDraftUrl] = useState(target.url);
  const [error, setError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [reloadRevision, setReloadRevision] = useState(0);
  const safeUrl = useMemo(() => trustedPreviewFrameUrl(target.url), [target.url]);
  const canOpenExternal = isTrustedLocalhostUrl(safeUrl);
  const loadKey = `${safeUrl}:${reloadRevision}`;
  const activeLoadKey = useRef(loadKey);

  useEffect(() => {
    setDraftUrl(target.url);
  }, [target.url]);

  useEffect(() => {
    activeLoadKey.current = loadKey;
    if (safeUrl === "about:blank") {
      setLoadState("idle");
      return;
    }
    setLoadState("loading");
  }, [loadKey, safeUrl]);

  async function confirmPreviewLoaded(expectedLoadKey: string) {
    if (!isTrustedLocalhostUrl(safeUrl)) {
      if (activeLoadKey.current === expectedLoadKey) setLoadState("loaded");
      return;
    }
    try {
      await fetch(safeUrl, { cache: "no-store", mode: "no-cors" });
      if (activeLoadKey.current === expectedLoadKey) setLoadState("loaded");
    } catch {
      if (activeLoadKey.current === expectedLoadKey) setLoadState("failed");
    }
  }

  function focusPreviewPane() {
    onFocus();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onNavigate(draftUrl)
      .then((nextTarget) => {
        setError(null);
        setDraftUrl(nextTarget.url);
        setReloadRevision((current) => current + 1);
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Unable to load preview target.");
      });
  }

  return (
    <section className={`browser-pane ${compact ? "browser-pane--compact" : ""}`} data-testid="browser-pane" onMouseDown={focusPreviewPane}>
      <div className="browser-pane__header">
        <div className="browser-pane__tabs">
          {tabs.map((tab, index) => (
            <ChromeTab
              active={(props.activeTabId ?? paneId) === tab.id}
              className="browser-tab"
              key={tab.id}
              testId="browser-tab-preview"
              dropPaneId={props.paneId}
              dropKind="browser"
              onClick={() => { props.onSelectTab?.(tab.id); focusPreviewPane(); }}
              onMouseDown={(event) => props.dragManager?.startDrag(event, { kind: "preview", previewId: tab.id, sourcePaneId: props.paneId })}
              leading={tab.target.kind === "pdf" ? <FileText size={13} /> : <Globe2 size={13} />}
              closeLabel="Close preview pane"
              closeIcon={<X size={12} />}
              onClose={props.onCloseTab || onClosePane ? (event) => {
                event.stopPropagation();
                if (props.onCloseTab) props.onCloseTab(tab.id);
                else onClosePane?.();
              } : undefined}
            >
              {index === 0 ? "Preview" : `Preview ${index + 1}`}
            </ChromeTab>
          ))}
          {props.onCreateTab ? (
            <button aria-label="New preview" className="browser-pane__new" onClick={props.onCreateTab} title="New preview" type="button"><Plus size={14} aria-hidden="true" /></button>
          ) : null}
        </div>
        <form className="browser-pane__address" onSubmit={submit}>
          <input
            aria-label="Preview URL"
            data-testid="browser-url-input"
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            spellCheck={false}
          />
          <span
            aria-label={`Preview ${loadState}`}
            className="browser-pane__status"
            data-state={loadState}
            role="status"
            title={`Preview ${loadState}`}
          />
          {canOpenExternal ? (
            <button
              aria-label="Open preview in default browser"
              className="browser-pane__button"
              onClick={() => void props.onOpenExternal(safeUrl)}
              title="Open in browser"
              type="button"
            >
              <ExternalLink size={13} />
            </button>
          ) : null}
          <button aria-label="Reload preview" className="browser-pane__button" data-testid="browser-load-url" title="Reload preview" type="submit">
            <RotateCw size={13} />
          </button>
        </form>
      </div>
      {target.kind === "pdf" ? (
        <PdfDocumentView filePath={target.filePath} key={paneId} />
      ) : safeUrl === "about:blank" ? (
        <div className="browser-pane__empty">{error ?? "Enter a local or localhost URL to preview."}</div>
      ) : (
        <iframe
          key={loadKey}
          className="browser-pane__frame"
          data-testid="browser-preview-frame"
          onError={() => setLoadState("failed")}
          onLoad={() => void confirmPreviewLoaded(loadKey)}
          referrerPolicy="no-referrer"
          sandbox={previewSandbox(safeUrl)}
          src={safeUrl}
          title="Preview"
        />
      )}
      {loadState === "failed" ? (
        <div className="browser-pane__failure" role="alert">Preview unavailable. Reload or open it in your browser.</div>
      ) : null}
    </section>
  );
}

function trustedPreviewFrameUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "about:blank";
  }
  if (trimmed === "about:blank") {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:") {
      return parsed.toString();
    }
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && isLocalhost(parsed.hostname)) {
      return parsed.toString();
    }
  } catch {
    return "about:blank";
  }
  return "about:blank";
}

function isLocalhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isTrustedLocalhostUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLocalhost(parsed.hostname);
  } catch {
    return false;
  }
}

function previewSandbox(value: string): string {
  return isTrustedLocalhostUrl(value)
    ? "allow-forms allow-same-origin allow-scripts"
    : "allow-forms allow-scripts";
}

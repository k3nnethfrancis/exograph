import { ArrowUpRight, ExternalLink, X } from "lucide-react";
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import type { NoteDocument, SearchResult, WorkspaceGraphContext } from "@exograph/core";
import type { InvocationHistoryItem } from "../../../shared/api";

import { buildNoteGraphContext } from "../graphAffordances";
import { AgentCommandIcon } from "./AgentCommandIcon";

type ConnectionTab = "outline" | "links" | "history";
const CONNECTION_TABS: readonly { id: Exclude<ConnectionTab, "history">; label: string }[] = [
  { id: "outline", label: "Outline" },
  { id: "links", label: "Links" },
];

interface InspectorDockProps {
  document: NoteDocument | null;
  graphContext: WorkspaceGraphContext | null;
  open: boolean;
  activeTag: string | null;
  tagResults: SearchResult[];
  onToggle: () => void;
  onOpenTarget: (target: string) => void;
  onOpenExternal: (target: string) => void;
  onOpenTag: (tag: string) => void;
  onOpenHeading: (filePath: string, line: number) => void;
  invocationHistory: InvocationHistoryItem[];
  invocationHistoryError?: string | null;
  requestedTab?: { tab: "history"; nonce: number } | null;
  onOpenInvocationHistory: (item: InvocationHistoryItem) => void;
  onResumeInvocation: (invocationId: string) => void;
  onRetryInvocationHistory?: () => void;
}

export function InspectorDock(props: InspectorDockProps) {
  const {
    document,
    graphContext: loadedGraphContext,
    open,
    activeTag,
    tagResults,
    onToggle,
    onOpenTarget,
    onOpenExternal,
    onOpenTag,
    onOpenHeading,
    invocationHistory,
    invocationHistoryError = null,
    requestedTab,
    onOpenInvocationHistory,
    onResumeInvocation,
    onRetryInvocationHistory,
  } = props;
  const [activeTab, setActiveTab] = useState<ConnectionTab>("outline");
  const tabListId = useId();
  const graphContext = buildNoteGraphContext(loadedGraphContext);
  const isMarkdown = document?.kind === "markdown";
  const backlinks = isMarkdown ? graphContext?.backlinks ?? [] : [];
  const referenceLinks = isMarkdown ? graphContext?.outgoingLinks.filter((item) => item.resolution !== "external" && item.resolution !== "artifact") ?? [] : [];
  const externalLinks = isMarkdown ? graphContext?.externalLinks ?? [] : [];
  const artifactLinks = isMarkdown ? graphContext?.artifactLinks ?? [] : [];
  const tags = isMarkdown ? graphContext?.tags ?? [] : [];
  const outline = isMarkdown ? extractOutline(document?.body ?? "") : [];
  const tabs = useMemo<readonly { id: ConnectionTab; label: string }[]>(
    () => invocationHistory.length > 0 || invocationHistoryError
      ? [...CONNECTION_TABS, { id: "history", label: "History" }]
      : CONNECTION_TABS,
    [invocationHistory.length, invocationHistoryError],
  );

  useEffect(() => {
    if (requestedTab?.tab === "history" && (invocationHistory.length > 0 || invocationHistoryError)) setActiveTab("history");
  }, [invocationHistory.length, invocationHistoryError, requestedTab?.nonce, requestedTab?.tab]);

  useEffect(() => {
    if (activeTab === "history" && invocationHistory.length === 0 && !invocationHistoryError) setActiveTab("outline");
  }, [activeTab, invocationHistory.length, invocationHistoryError]);

  if (!open) {
    return null;
  }

  return (
    <section className="connections-rail" data-testid="inspector-panel">
      <header className="connections-rail__header">
        <div>
          <div className="connections-rail__title">Note context</div>
          <div className="connections-rail__summary">{backlinks.length} back · {referenceLinks.length + externalLinks.length + artifactLinks.length} links</div>
        </div>
        <button aria-label="Close note context" className="connections-rail__close" onClick={onToggle} title="Close note context" type="button"><X size={15} /></button>
      </header>
      <div className="connections-rail__content">
      <div className="connections-panel">
        <div className="connections-tabs" role="tablist" aria-label="Note connections" id={tabListId}>
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              id={`${tabListId}-${tab.id}`}
              aria-controls={`${tabListId}-panel`}
              aria-selected={activeTab === tab.id}
              className="connections-tabs__tab"
              data-testid={`connections-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => moveConnectionTab(event, index, tabs, setActiveTab)}
              role="tab"
              tabIndex={activeTab === tab.id ? 0 : -1}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div
          id={`${tabListId}-panel`}
          aria-labelledby={`${tabListId}-${activeTab}`}
          className="connections-panel__body"
          data-testid={`connections-panel-${activeTab}`}
          role="tabpanel"
          tabIndex={0}
        >
          {activeTab === "outline" ? (
            <OutlineTab filePath={document?.filePath ?? null} isMarkdown={isMarkdown} headings={outline} onOpenHeading={onOpenHeading} />
          ) : activeTab === "links" ? (
            <LinksTab isMarkdown={isMarkdown} backlinks={backlinks} references={referenceLinks} externalLinks={externalLinks} artifactLinks={artifactLinks} tags={tags} activeTag={activeTag} tagResults={tagResults} onOpenTarget={onOpenTarget} onOpenExternal={onOpenExternal} onOpenTag={onOpenTag} />
          ) : activeTab === "history" ? (
            <InvocationHistoryTab
              error={invocationHistoryError}
              items={invocationHistory}
              onOpen={onOpenInvocationHistory}
              onResume={onResumeInvocation}
              onRetry={onRetryInvocationHistory}
            />
          ) : null}
        </div>
      </div>
      </div>
    </section>
  );
}

function OutlineTab(props: {
  filePath: string | null;
  isMarkdown: boolean;
  headings: OutlineHeading[];
  onOpenHeading: (filePath: string, line: number) => void;
}) {
  if (!props.isMarkdown) return <div className="footer-empty">No note selected</div>;
  return (
    <section className="connections-panel__section" data-testid="outline-panel">
      <div className="connections-panel__section-title">Headings</div>
      {props.headings.length ? <ol className="connections-outline">{props.headings.map((heading) => (
        <li className="connections-outline__item" key={`${heading.line}:${heading.level}`} style={{ paddingInlineStart: `${Math.max(0, heading.level - 1) * 12}px` }}>
          <button className="connections-outline__link" disabled={!props.filePath} onClick={() => props.filePath && props.onOpenHeading(props.filePath, heading.line)} type="button">{heading.text}</button>
        </li>
      ))}</ol> : <div className="footer-empty">No headings</div>}
    </section>
  );
}

function LinksTab(props: {
  isMarkdown: boolean;
  backlinks: Array<{ label: string; target: string }>;
  references: Array<{ label: string; target: string }>;
  externalLinks: Array<{ label: string; target: string }>;
  artifactLinks: Array<{ label: string; target: string }>;
  tags: string[];
  activeTag: string | null;
  tagResults: SearchResult[];
  onOpenTarget: (target: string) => void;
  onOpenExternal: (target: string) => void;
  onOpenTag: (tag: string) => void;
}) {
  if (!props.isMarkdown) return <div className="footer-empty">No note selected</div>;
  return <>
    <ConnectionList title="Linked from" items={props.backlinks} onOpen={props.onOpenTarget} empty="No backlinks" />
    <ConnectionList title="Links to" items={props.references} onOpen={props.onOpenTarget} empty="No note links" />
    <ConnectionList title="External" items={props.externalLinks} onOpen={props.onOpenExternal} empty="No external links" external />
    <ArtifactList items={props.artifactLinks} />
    <section className="connections-panel__section" data-testid="tags-panel">
      <div className="connections-panel__section-title">Tags</div>
      {props.tags.length ? <div className="tag-list">{props.tags.map((tag) => <button key={tag} className="tag-pill" onClick={() => props.onOpenTag(tag)} type="button">#{tag}</button>)}</div> : <div className="footer-empty">No tags</div>}
      {props.activeTag ? <div className="tag-results"><div className="footer-panel__subtitle">Results for #{props.activeTag}</div>{props.tagResults.map((result) => <button key={result.filePath} className="footer-item" onClick={() => props.onOpenTarget(result.filePath)} type="button">{result.title}</button>)}</div> : null}
    </section>
  </>;
}

function ConnectionList(props: { title: string; items: Array<{ label: string; target: string }>; onOpen: (target: string) => void; empty: string; external?: boolean }) {
  return <section className="connections-panel__section"><div className="connections-panel__section-title">{props.title}</div>{props.items.length ? props.items.map((item) => <button key={`${item.label}-${item.target}`} className="footer-item" onClick={() => props.onOpen(item.target)} type="button">{item.label}{props.external ? <ExternalLink size={12} /> : null}</button>) : <div className="footer-empty">{props.empty}</div>}</section>;
}

function ArtifactList({ items }: { items: Array<{ label: string; target: string }> }) {
  return <section className="connections-panel__section"><div className="connections-panel__section-title">Artifacts</div>{items.length ? items.map((item) => <div className="footer-item footer-item--static" key={`${item.label}-${item.target}`} title={item.target}>{item.label}</div>) : <div className="footer-empty">No code or attachments</div>}</section>;
}

function moveConnectionTab(event: KeyboardEvent<HTMLButtonElement>, index: number, tabs: readonly { id: ConnectionTab }[], setTab: (tab: ConnectionTab) => void) {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  setTab(tabs[next].id);
  requestAnimationFrame(() => document.getElementById(`${(event.currentTarget.parentElement as HTMLElement).id}-${tabs[next].id}`)?.focus());
}

export function InvocationHistoryTab({ error, items, onOpen, onResume, onRetry }: {
  error?: string | null;
  items: InvocationHistoryItem[];
  onOpen: (item: InvocationHistoryItem) => void;
  onResume: (invocationId: string) => void;
  onRetry?: () => void;
}) {
  return (
    <section className="invocation-history" data-testid="invocation-history-panel">
      {error ? (
        <div className="invocation-history__error" role="status">
          <span>{error}</span>
          {onRetry ? <button className="toolbar-button" onClick={onRetry} type="button">Retry</button> : null}
        </div>
      ) : null}
      {items.map((item) => (
        <div className="invocation-history__row" key={item.invocationId}>
          {item.changeIds.length > 0 ? <button className="invocation-history__open" onClick={() => onOpen(item)} type="button">
            <span className={`invocation-history__status invocation-history__status--${item.outcome}`} aria-hidden="true" />
            <span className="invocation-history__agent" aria-hidden="true">
              <AgentCommandIcon command={item.command} size={14} />
            </span>
            <span>
              <strong>@{item.command.handle}</strong>
              <small>{relativeInvocationTime(item.endedAt ?? item.createdAt)} · {item.outcome}{item.changedFileCount > 1 ? ` · ${item.changedFileCount} files` : ""}</small>
            </span>
          </button> : <div className="invocation-history__open invocation-history__open--status">
            <span className={`invocation-history__status invocation-history__status--${item.outcome}`} aria-hidden="true" />
            <span className="invocation-history__agent" aria-hidden="true">
              <AgentCommandIcon command={item.command} size={14} />
            </span>
            <span>
              <strong>@{item.command.handle}</strong>
              <small>{relativeInvocationTime(item.endedAt ?? item.createdAt)} · {item.outcome}</small>
            </span>
          </div>}
          {item.providerSessionId ? (
            <button aria-label={`Resume ${item.command.label} in Terminal`} className="invocation-history__resume" onClick={() => onResume(item.invocationId)} title="Resume in Terminal" type="button"><ArrowUpRight size={14} /></button>
          ) : null}
        </div>
      ))}
    </section>
  );
}

export function relativeInvocationTime(iso: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - new Date(iso).getTime());
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

interface OutlineHeading {
  level: number;
  text: string;
  line: number;
}

export function extractOutline(body: string): OutlineHeading[] {
  return body.split(/\r?\n/u).flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    return match ? [{ level: match[1].length, text: match[2].trim(), line: index + 1 }] : [];
  });
}

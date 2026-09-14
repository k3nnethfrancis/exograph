import { useCallback, useRef, useState, type ReactNode } from "react";

import type { AgentCommand, InvocationSkillContext, NoteDocument, WorkspaceGraphContext } from "@exograph/core";
import type { InvocationFileReviewPayload } from "../../../shared/api";
import type { InvocationReviewPosition, InvocationReviewQueueProjection } from "./invocation";
import type { DragManager } from "../hooks/useDragManager";
import type { ExographThemeVariant } from "../theme/types";

import { ChromeTab } from "./Chrome";
import { getDocumentDisplayTitle } from "./documentDisplay";
import { EditorFaultBoundary } from "./EditorFaultBoundary";
import type { EditorFaultContext } from "./editorFaultDiagnostics";
import { NoteEditor, type EditorInitialSelectionRequest } from "./NoteEditor";
import { FolderOverviewPane } from "./FolderOverviewPane";
import type { InlineAgentDraft } from "./inlineAgentComposer";

interface EditorDocument extends NoteDocument {
  dirty: boolean;
  saveConflict?: "changed" | "missing";
  resolvingConflict?: boolean;
  filesystemState?: "deleted";
}

export interface EditorPaneState {
  id: string;
  openPaths: string[];
  activePath: string | null;
  openFolderPaths?: string[];
  activeFolderPath?: string | null;
}

export interface AgentComposeRequest {
  filePath: string;
  nonce: number;
  handle: string;
  message: string;
  skill?: InvocationSkillContext;
}

interface EditorPaneProps {
  pane: EditorPaneState;
  documents: Record<string, EditorDocument>;
  graphContextByPath: Record<string, WorkspaceGraphContext>;
  saveStatuses: Record<string, "idle" | "saving" | "saved" | "error" | "conflict">;
  isFocused: boolean;
  onFocusPane: () => void;
  onActivateTab: (filePath: string) => void;
  onCloseTab: (filePath: string) => void;
  onActivateFolder: (directoryPath: string) => void;
  onCloseFolder: (directoryPath: string) => void;
  onOpenFolder: (directoryPath: string) => void;
  onOpenFile: (filePath: string) => void;
  /** Close this entire pane (merge back into parent split). Null when this is the only pane. */
  onClosePane: (() => void) | null;
  dragManager: DragManager;
  onOpenGraph: () => void;
  onUpdateFrontmatter: (key: string, value: unknown) => void;
  onBodyChange: (body: string) => void;
  onSave: () => void;
  onSaveConflictCopy?: () => void;
  onDiscardSaveConflict?: () => Promise<void>;
  onRecoverDeleted: () => void;
  onSaveDeletedAs: () => void;
  onShowInExplorer: (filePath: string) => void;
  onOpenTag: (tag: string) => void;
  onOpenTarget: (target: string) => void;
  onSuggestTargets: (query: string) => Promise<Array<{ label: string; target: string; detail?: string }>>;
  onPreviewTarget: (target: string) => Promise<{ title: string; excerpt: string } | null>;
  agentCommands: AgentCommand[];
  onInvokeAgent: (draft: InlineAgentDraft) => void;
  invocationReview: EditorInvocationReview | null;
  editingFrozen: boolean;
  historyAvailable: boolean;
  onOpenHistory: () => void;
  theme: ExographThemeVariant;
  fontSize: number;
  onAppZoom: (direction: -1 | 0 | 1) => void;
  compact: boolean;
  revealLineRequest?: { filePath: string; line: number; nonce: number } | null;
  scrollRestoreRequest?: { filePath: string; scrollTop: number; nonce: number } | null;
  initialSelectionRequest?: EditorInitialSelectionRequest | null;
  onInitialSelectionRequestHandled?: (nonce: number) => void;
  agentComposeRequest?: AgentComposeRequest | null;
  onAgentComposeRequestHandled?: (nonce: number) => void;
  isNoteDocument: (filePath: string) => boolean;
  invocationActivity?: {
    protocolInvocationId?: string;
    render: (position?: InvocationReviewPosition) => ReactNode;
  };
  onResumeProtocolInvocation?: (protocolInvocationId: string) => void;
}

export function EditorPane(props: EditorPaneProps) {
  const {
    pane,
    documents,
    graphContextByPath,
    saveStatuses,
    isFocused,
    onFocusPane,
    onActivateTab,
    onCloseTab,
    onActivateFolder,
    onCloseFolder,
    onOpenFolder,
    onOpenFile,
    onClosePane,
    dragManager,
    onOpenGraph,
    onUpdateFrontmatter,
    onBodyChange,
    onSave,
    onSaveConflictCopy,
    onDiscardSaveConflict,
    onRecoverDeleted,
    onSaveDeletedAs,
    onShowInExplorer,
    onOpenTag,
    onOpenTarget,
    onSuggestTargets,
    onPreviewTarget,
    agentCommands,
    onInvokeAgent,
    invocationReview,
    editingFrozen,
    historyAvailable,
    onOpenHistory,
    theme,
    fontSize,
    onAppZoom,
    compact,
    revealLineRequest,
    scrollRestoreRequest,
    initialSelectionRequest,
    onInitialSelectionRequestHandled,
    agentComposeRequest,
    onAgentComposeRequestHandled,
    isNoteDocument,
    invocationActivity,
    onResumeProtocolInvocation,
  } = props;

  const activeDocument = pane.activePath ? documents[pane.activePath] ?? null : null;
  const activeGraphContext = pane.activePath ? graphContextByPath[pane.activePath] ?? null : null;
  const [propertiesCollapsed, setPropertiesCollapsed] = useState(true);
  const [tabContextMenu, setTabContextMenu] = useState<{ filePath: string; x: number; y: number } | null>(null);
  const faultContextRef = useRef<EditorFaultContext>({
    notePath: activeDocument?.filePath ?? null,
    mode: activeDocument?.kind === "markdown" ? "markdown-live" : activeDocument ? "code" : "empty",
    selection: null,
    agentHandle: null,
  });
  const updateFaultContext = useCallback((context: EditorFaultContext) => {
    faultContextRef.current = context;
  }, []);
  faultContextRef.current = {
    ...faultContextRef.current,
    notePath: activeDocument?.filePath ?? null,
    mode: activeDocument?.kind === "markdown" ? "markdown-live" : activeDocument ? "code" : "empty",
  };

  return (
    <div
      className={`editor-pane ${isFocused ? "editor-pane--focused" : ""} ${compact ? "editor-pane--compact" : ""}`}
      data-testid={`editor-pane-${pane.id}`}
      onMouseDown={onFocusPane}
    >
      <div className="tab-strip" data-testid={`editor-tabs-${pane.id}`}>
        {(pane.openFolderPaths ?? []).map((directoryPath) => {
          const title = directoryPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "Folder";
          return <ChromeTab key={`folder:${directoryPath}`} active={directoryPath === pane.activeFolderPath} className="tab-strip__tab" dropPaneId={pane.id} dropKind="editor" onClick={() => onActivateFolder(directoryPath)} leading={<span className="status-dot" />} closeLabel={`Close ${title}`} onClose={(event) => { event.stopPropagation(); onCloseFolder(directoryPath); }} closeIcon="×">{title}</ChromeTab>;
        })}
        {pane.openPaths.map((filePath) => {
          const document = documents[filePath];
          if (!document) {
            return null;
          }
          const displayTitle = getDocumentDisplayTitle(document.filePath, document.kind);

          return (
            <ChromeTab
              key={document.filePath}
              active={document.filePath === pane.activePath}
              className={`tab-strip__tab${document.filesystemState === "deleted" ? " tab-strip__tab--deleted" : ""}`}
              dropPaneId={pane.id}
              dropKind="editor"
              onClick={() => onActivateTab(document.filePath)}
              onMouseDown={(event) => {
                dragManager.startDrag(event, {
                  kind: "document",
                  filePath: document.filePath,
                  sourcePaneId: pane.id,
                });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setTabContextMenu({ filePath: document.filePath, x: event.clientX, y: event.clientY });
              }}
              leading={<span className={document.filesystemState === "deleted" ? "status-dot status-dot--deleted" : document.dirty ? "status-dot status-dot--dirty" : "status-dot"} />}
              closeLabel={`Close ${displayTitle}`}
              onClose={(event) => {
                event.stopPropagation();
                onCloseTab(document.filePath);
              }}
              closeIcon="×"
            >
              {document.filesystemState === "deleted" ? `${displayTitle} · deleted` : displayTitle}
            </ChromeTab>
          );
        })}
        {onClosePane ? (
          <button
            className="tab-strip__close-pane"
            onClick={onClosePane}
            title="Close pane"
            aria-label="Close pane"
            type="button"
          >
            ×
          </button>
        ) : null}
      </div>

      {tabContextMenu ? (
        <>
          <button aria-label="Dismiss tab menu" className="tree-context-menu__backdrop" onClick={() => setTabContextMenu(null)} type="button" />
          <div className="tree-context-menu" style={{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }}>
            <button className="tree-context-menu__item" onClick={() => { onShowInExplorer(tabContextMenu.filePath); setTabContextMenu(null); }} type="button">
              Show in Explorer
            </button>
          </div>
        </>
      ) : null}

      {pane.activeFolderPath ? <FolderOverviewPane directoryPath={pane.activeFolderPath} onOpenFolder={onOpenFolder} onOpenFile={onOpenFile} onClose={() => onCloseFolder(pane.activeFolderPath!)} /> : <EditorFaultBoundary key={pane.activePath ?? "empty"} getContext={() => faultContextRef.current}><NoteEditor
        document={activeDocument}
        graphContext={activeGraphContext}
        saveStatus={pane.activePath ? saveStatuses[pane.activePath] ?? "idle" : "idle"}
        propertiesCollapsed={propertiesCollapsed}
        onToggleProperties={() => setPropertiesCollapsed((current) => !current)}
        onOpenGraph={onOpenGraph}
        onUpdateFrontmatter={onUpdateFrontmatter}
        onBodyChange={onBodyChange}
        onSave={onSave}
        onSaveConflictCopy={onSaveConflictCopy}
        onDiscardSaveConflict={onDiscardSaveConflict}
        onRecoverDeleted={onRecoverDeleted}
        onSaveDeletedAs={onSaveDeletedAs}
        onOpenTag={onOpenTag}
        onOpenTarget={onOpenTarget}
        onSuggestTargets={onSuggestTargets}
        onPreviewTarget={onPreviewTarget}
        agentCommands={agentCommands}
        onInvokeAgent={onInvokeAgent}
        invocationReview={invocationReview}
        editingFrozen={editingFrozen}
        historyAvailable={historyAvailable}
        onOpenHistory={onOpenHistory}
        onFocus={onFocusPane}
        theme={theme}
        fontSize={fontSize}
        onAppZoom={onAppZoom}
        compact={compact}
        isNoteDocument={activeDocument ? isNoteDocument(activeDocument.filePath) : false}
        revealLineRequest={revealLineRequest}
        scrollRestoreRequest={scrollRestoreRequest}
        initialSelectionRequest={initialSelectionRequest}
        onInitialSelectionRequestHandled={onInitialSelectionRequestHandled}
        agentComposeRequest={agentComposeRequest?.filePath === activeDocument?.filePath ? agentComposeRequest : null}
        onAgentComposeRequestHandled={onAgentComposeRequestHandled}
        onDiagnosticContext={updateFaultContext}
        invocationActivity={invocationActivity}
        onResumeProtocolInvocation={onResumeProtocolInvocation}
      /></EditorFaultBoundary>}
    </div>
  );
}

export interface EditorInvocationReview {
  payload: InvocationFileReviewPayload;
  queue: InvocationReviewQueueProjection;
  readOnly: boolean;
  decisionPending: boolean;
  onNavigate: (index: number) => void;
  onKeepCurrent: () => void;
  onRejectCurrent: () => void;
  onKeepAll?: () => void;
  onRejectAll?: () => void;
  onRefreshConflict: () => void;
  onOpenConflict: () => void;
  onDismiss?: () => void;
  onResume?: () => void;
}

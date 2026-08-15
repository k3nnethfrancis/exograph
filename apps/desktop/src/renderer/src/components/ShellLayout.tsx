import type { CSSProperties, ReactNode } from "react";
import type { WorkspaceSearchResults } from "@exograph/core";
import type { WorkspaceShortcutBindings } from "@exograph/core";
import { ChevronRight, FileText, Folder, Globe2, ListTree, PanelLeft, PanelRight, SquareTerminal } from "lucide-react";

import type { AppearanceMode, ResolvedAppearance } from "../appearance";
import type { DragManager } from "../hooks/useDragManager";
import type { PaneNode, PaneNodeId, PaneTreeActions } from "../hooks/usePaneTree";
import type { WorkspaceSearchResultMode } from "../hooks/useWorkspaceSearch";
import type { UtilityDestination } from "../utilitySurfaceModel";
import { FileTree, SidebarSearchPane } from "./FileTree";
import type { RootSection } from "./ExplorerSections";
import { PaneTree } from "./PaneTree";
import { WorkspaceMenu } from "./WorkspaceMenu";
import type { WorkspaceBreadcrumbSegment } from "../workspaceBreadcrumb";
import { WorkspaceSearchField } from "./WorkspaceSearchField";
import { ExographMark } from "./ExographMark";

interface ShellLayoutProps {
  titleSegments: WorkspaceBreadcrumbSegment[];
  workspaceLabel: string;
  shortcutBindings?: WorkspaceShortcutBindings;
  noteSections: RootSection[];
  appearanceMode: AppearanceMode;
  resolvedAppearance: ResolvedAppearance;
  searchQuery: string;
  searchResults: WorkspaceSearchResults;
  searchResultMode: WorkspaceSearchResultMode;
  searchResultQuery: string;
  searchMessage: string | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  utilityWidth: number;
  onToggleSidebar: () => void;
  onResizeSidebar: (event: React.MouseEvent) => void;
  onResizeUtility: (event: React.MouseEvent) => void;
  canvas: PaneNode;
  focusedPaneId: PaneNodeId;
  canvasActions: PaneTreeActions;
  onFocusCanvasPane: (leafId: PaneNodeId) => void;
  renderLeaf: (leaf: import("../hooks/usePaneTree").PaneLeaf, focused: boolean) => ReactNode;
  dragManager: DragManager;
  utilityContent: ReactNode;
  utilitySurface: UtilityDestination;
  utilityOpen: boolean;
  onToggleUtility: () => void;
  onOpenUtilityBrowser: () => void;
  onOpenUtilityTerminal: () => void;
  onOpenUtilityGraph: () => void;
  onOpenNoteContext: () => void;
  revealExplorerPathRequest?: { path: string; nonce: number; kind?: "file" | "directory" } | null;
  onAppearanceModeChange: (mode: AppearanceMode) => void;
  onOpenWorkspaceSettings: () => void;
  onSearchQueryChange: (value: string) => void;
  onSearchSubmit: () => void;
  onSearchClear: () => void;
  onOpenFile: (filePath: string, line?: number | null) => void;
  onOpenFolder: (directoryPath: string) => void;
  onOpenTerminalSession: (sessionId: string) => void;
  onOpenTag: (tag: string) => void;
  onExpandDirectory: (directoryPath: string, rootKind: "notes") => void;
  explorerScale: number;
  onCreateFile: (directoryPath: string) => void;
  onCreateDirectory: (directoryPath: string) => void;
  onCreateTerminalInDirectory: (directoryPath: string) => void;
  onRenamePath: (targetPath: string) => void;
  onDeletePath: (targetPath: string) => void;
  onOpenTitleSegment: (segment: WorkspaceBreadcrumbSegment) => void;
}

export function ShellLayout(props: ShellLayoutProps) {
  const visibleTitleSegments = compactBreadcrumbSegments(props.titleSegments);
  return (
    <div className="workspace-frame">
      <header className="workspace-titlebar" data-testid="workspace-titlebar">
        <div className="workspace-titlebar__identity">
          <button
            aria-label={props.sidebarCollapsed ? "Show explorer" : "Hide explorer"}
            aria-pressed={!props.sidebarCollapsed}
            className="workspace-titlebar__button"
            data-testid="workspace-titlebar-sidebar"
            onClick={props.onToggleSidebar}
            title={props.sidebarCollapsed ? "Show explorer" : "Hide explorer"}
            type="button"
          >
            <PanelLeft size={16} aria-hidden="true" />
          </button>
          <span className="workspace-titlebar__divider" aria-hidden="true" />
          <div className="workspace-titlebar__title" data-testid="workspace-title" title={props.titleSegments.map((segment) => segment.label).join(" / ")}>
            {visibleTitleSegments.map((segment, index) => (
              <span className="workspace-titlebar__crumb" key={segment.path ?? "ellipsis"}>
                {index > 0 ? <ChevronRight className="workspace-titlebar__chevron" size={12} strokeWidth={1.75} aria-hidden="true" /> : null}
                {segment.kind === "ellipsis" ? <span className="workspace-titlebar__ellipsis" title="Middle folders hidden">…</span> : (
                  <button className={`workspace-titlebar__segment workspace-titlebar__segment--${segment.kind}`} onClick={() => props.onOpenTitleSegment(segment)} type="button">
                    {segment.kind === "folder" ? <Folder size={13} aria-hidden="true" /> : <FileText size={12} aria-hidden="true" />}
                    <span>{segment.label}</span>
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
        <div className="workspace-search-anchor">
          <WorkspaceSearchField query={props.searchQuery} onChange={props.onSearchQueryChange} onClear={props.onSearchClear} onSubmit={props.onSearchSubmit} />
          {props.searchQuery.trim() ? (
            <div className="workspace-search-popover" data-testid="workspace-search-popover">
              <SidebarSearchPane query={props.searchQuery} results={props.searchResults} resultMode={props.searchResultMode} resultQuery={props.searchResultQuery} message={props.searchMessage} onOpenFile={(path) => { props.onSearchClear(); props.onOpenFile(path); }} />
            </div>
          ) : null}
        </div>
        <div className="workspace-titlebar__actions">
          <button aria-label={props.utilityOpen ? "Hide utility pane" : "Show utility pane"} aria-pressed={props.utilityOpen} className="workspace-titlebar__button" data-testid="utility-pane-toggle" onClick={props.onToggleUtility} title={props.utilityOpen ? "Hide utility pane" : "Show utility pane"} type="button">
            <PanelRight size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div
        className={`workspace-shell${props.sidebarCollapsed ? " workspace-shell--sidebar-collapsed" : ""}${props.utilityOpen ? " workspace-shell--utility-open" : ""}`}
        style={{ "--workspace-utility-width": `${props.utilityWidth}px` } as CSSProperties}
      >
      <aside className="workspace-shell__explorer" style={{ width: props.sidebarCollapsed ? 0 : props.sidebarWidth }}>
        <FileTree
          appearanceMode={props.appearanceMode}
          collapsed={props.sidebarCollapsed}
          dragManager={props.dragManager}
          explorerScale={props.explorerScale}
          noteRoots={props.noteSections}
          onAppearanceModeChange={props.onAppearanceModeChange}
          onCreateDirectory={props.onCreateDirectory}
          onCreateFile={props.onCreateFile}
          onCreateTerminal={props.onCreateTerminalInDirectory}
          onDeletePath={props.onDeletePath}
          onExpandDirectory={props.onExpandDirectory}
          onOpenFile={props.onOpenFile}
          onOpenFolder={props.onOpenFolder}
          onOpenTag={props.onOpenTag}
          onOpenTerminalSession={props.onOpenTerminalSession}
          onRenamePath={props.onRenamePath}
          onToggleCollapsed={props.onToggleSidebar}
          resolvedAppearance={props.resolvedAppearance}
          revealPathRequest={props.revealExplorerPathRequest}
        />
      </aside>
      {!props.sidebarCollapsed ? <div className="pane-split-resizer pane-split-resizer--vertical" onMouseDown={props.onResizeSidebar} /> : null}
      <main className="workspace-shell__canvas">
        <PaneTree node={props.canvas} actions={props.canvasActions} focusedLeafId={props.focusedPaneId} onFocusLeaf={props.onFocusCanvasPane} renderLeaf={props.renderLeaf} hoverEdge={props.dragManager.hoverEdge} />
      </main>
      {props.utilityOpen ? (
        <div
          aria-label="Resize utility pane"
          className="pane-split-resizer pane-split-resizer--vertical workspace-shell__utility-resizer"
          data-testid="utility-pane-resizer"
          onMouseDown={props.onResizeUtility}
          role="separator"
        />
      ) : null}
      <aside aria-hidden={!props.utilityOpen} className="workspace-shell__utility" data-testid="utility-pane">
        <nav className="workspace-utility-rail" aria-label="Utility pane">
          <button aria-label="Open terminal" aria-pressed={props.utilityOpen && props.utilitySurface === "terminal"} className="workspace-utility-rail__button" data-testid="utility-pane-terminal" data-utility-drop-kind="terminal" onClick={props.onOpenUtilityTerminal} title="Terminal" type="button"><SquareTerminal size={16} aria-hidden="true" /></button>
          <button aria-label="Open preview" aria-pressed={props.utilityOpen && props.utilitySurface === "preview"} className="workspace-utility-rail__button" data-testid="utility-pane-preview" data-utility-drop-kind="preview" onClick={props.onOpenUtilityBrowser} title="Preview" type="button"><Globe2 size={16} aria-hidden="true" /></button>
          <button aria-label="Open note context" aria-pressed={props.utilityOpen && props.utilitySurface === "context"} className="workspace-utility-rail__button" data-testid="utility-pane-context" onClick={props.onOpenNoteContext} title="Note context" type="button"><ListTree size={16} aria-hidden="true" /></button>
          <button aria-label="Open graph" aria-pressed={props.utilityOpen && props.utilitySurface === "graph"} className="workspace-utility-rail__button" data-testid="utility-pane-graph" onClick={props.onOpenUtilityGraph} title="Graph" type="button"><ExographMark size={16} /></button>
        </nav>
        <div className="workspace-utility-surface" data-utility-drop-kind={props.utilitySurface === "terminal" || props.utilitySurface === "preview" ? props.utilitySurface : undefined}>
          {props.utilityContent}
        </div>
      </aside>
      </div>
      <WorkspaceMenu collapsed={props.sidebarCollapsed} label={props.workspaceLabel} shortcutBindings={props.shortcutBindings} onOpenSettings={props.onOpenWorkspaceSettings} />
    </div>
  );
}

type CompactBreadcrumbSegment = WorkspaceBreadcrumbSegment | { kind: "ellipsis"; label: "…"; path: null };

export function compactBreadcrumbSegments(segments: WorkspaceBreadcrumbSegment[], maxLabelCharacters = 32): CompactBreadcrumbSegment[] {
  const labelCharacters = segments.reduce((total, segment) => total + segment.label.length, 0);
  if (segments.length <= 2 || (segments.length <= 3 && labelCharacters <= maxLabelCharacters)) return segments;
  return [segments[0], { kind: "ellipsis", label: "…", path: null }, segments.at(-1)!];
}

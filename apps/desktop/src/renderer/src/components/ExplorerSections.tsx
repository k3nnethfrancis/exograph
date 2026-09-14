import { ChevronDown, ChevronLeft, ChevronRight, FileText, Folder, FolderOpen, FolderTree, Hash } from "lucide-react";
import type { SearchResult, TreeNode } from "@exograph/core";
import type { CSSProperties } from "react";
import type { DragManager } from "../hooks/useDragManager";
import type { ExplorerRootKind } from "./FileTree";

const MAX_LABEL_CHARS = 25;

function truncateLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

export interface RootSection {
  label: string;
  path: string;
  nodes: TreeNode[];
}

export interface ContextTarget {
  path: string;
  kind: "file" | "directory";
}

interface SearchSectionProps {
  label: string;
  results: SearchResult[];
  onOpenFile: (filePath: string, line?: number | null) => void;
  onOpenFolder?: (directoryPath: string) => void;
  dragManager: DragManager;
}

interface TagSearchSectionProps {
  results: SearchResult[];
  onOpenFile: (filePath: string, line?: number | null) => void;
  onOpenTag: (tag: string) => void;
  dragManager: DragManager;
}

interface SectionProps {
  label: string;
  sections: RootSection[];
  rootKind: ExplorerRootKind;
  expandedPaths: Set<string>;
  onTogglePath: (path: string, rootKind?: ExplorerRootKind) => void;
  onOpenFile: (filePath: string, line?: number | null) => void;
  onOpenFolder?: (directoryPath: string) => void;
  dragManager: DragManager;
  onContextMenu?: (event: React.MouseEvent, target: ContextTarget) => void;
  showHeader?: boolean;
  alwaysShowRoots?: boolean;
  mirrored?: boolean;
  revealedPath?: string | null;
  onTreeInteraction?: () => void;
}

export const ROOT_GROUP_PREFIX = "__root__:";

export function SearchSection(props: SearchSectionProps) {
  const { label, results, onOpenFile, dragManager } = props;
  if (results.length === 0) {
    return null;
  }

  return (
    <div className="search-section">
      <div className="search-section__title">{label}</div>
      {results.map((result) => (
        <button
          key={result.filePath}
          className="search-result"
          onClick={() => onOpenFile(result.filePath)}
          onMouseDown={(event) =>
            dragManager.startDrag(event, { kind: "document", filePath: result.filePath })
          }
          type="button"
        >
          <strong>{result.title}</strong>
          <span>{result.snippet}</span>
        </button>
      ))}
    </div>
  );
}

export function TagSearchSection(props: TagSearchSectionProps) {
  const { results, onOpenFile, onOpenTag, dragManager } = props;
  if (results.length === 0) {
    return null;
  }

  return (
    <div className="search-section">
      <div className="search-section__title">Tags</div>
      {results.map((result) => (
        <div key={`${result.filePath}-${result.snippet}`} className="search-result search-result--split">
          <button className="search-result__tag" onClick={() => onOpenTag(result.snippet)} type="button">
            <Hash size={12} />
            {result.snippet}
          </button>
          <button
            className="search-result__file"
            onClick={() => onOpenFile(result.filePath)}
            onMouseDown={(event) =>
              dragManager.startDrag(event, { kind: "document", filePath: result.filePath })
            }
            type="button"
          >
            <strong>{result.title}</strong>
            <span>{result.filePath}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

export function Section(props: SectionProps) {
  const {
    label,
    sections,
    rootKind,
    expandedPaths,
    onTogglePath,
    onOpenFile,
    onOpenFolder,
    dragManager,
    onContextMenu,
    showHeader = true,
    alwaysShowRoots = false,
    mirrored = false,
    revealedPath = null,
    onTreeInteraction,
  } = props;
  const CollapsedChevron = mirrored ? ChevronLeft : ChevronRight;

  if (sections.length === 1 && !alwaysShowRoots) {
    return (
      <div className="tree-section">
        {showHeader ? (
          <div className="tree-section__title">
            <FolderTree size={14} />
            {label}
          </div>
        ) : null}
        <TreeNodes
          nodes={sections[0].nodes}
          depth={0}
          rootKind={rootKind}
          expandedPaths={expandedPaths}
          onTogglePath={onTogglePath}
          onOpenFile={onOpenFile}
          onOpenFolder={onOpenFolder}
          dragManager={dragManager}
          onContextMenu={onContextMenu}
          mirrored={mirrored}
          revealedPath={revealedPath}
          onTreeInteraction={onTreeInteraction}
        />
      </div>
    );
  }

  return (
    <div className="tree-section">
      {showHeader ? (
        <div className="tree-section__title">
          <FolderTree size={14} />
          {label}
        </div>
      ) : null}
      {sections.map((section) => {
        const rootKey = `${ROOT_GROUP_PREFIX}${section.path}`;
        const expanded = expandedPaths.has(rootKey);
        return (
          <div key={section.path} className="root-group">
            <button
              className="root-group__toggle"
              data-explorer-drop-path={rootKind === "notes" ? section.path : undefined}
              onClick={() => onTogglePath(rootKey)}
              type="button"
            >
              {expanded ? <ChevronDown size={12} /> : <CollapsedChevron size={12} />}
              <span className="root-group__title">{section.label}</span>
            </button>
            {expanded ? (
              <TreeNodes
                nodes={section.nodes}
                depth={0}
                rootKind={rootKind}
                expandedPaths={expandedPaths}
                onTogglePath={onTogglePath}
                onOpenFile={onOpenFile}
                onOpenFolder={onOpenFolder}
                dragManager={dragManager}
                onContextMenu={onContextMenu}
                mirrored={mirrored}
                revealedPath={revealedPath}
                onTreeInteraction={onTreeInteraction}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TreeNodes({
  nodes,
  depth,
  rootKind,
  expandedPaths,
  onTogglePath,
  onOpenFile,
  onOpenFolder,
  dragManager,
  onContextMenu,
  mirrored,
  revealedPath,
  onTreeInteraction,
}: {
  nodes: TreeNode[];
  depth: number;
  rootKind: ExplorerRootKind;
  expandedPaths: Set<string>;
  onTogglePath: (path: string, rootKind?: ExplorerRootKind) => void;
  onOpenFile: (filePath: string, line?: number | null) => void;
  onOpenFolder?: (directoryPath: string) => void;
  dragManager: DragManager;
  onContextMenu?: (event: React.MouseEvent, target: ContextTarget) => void;
  mirrored: boolean;
  revealedPath: string | null;
  onTreeInteraction?: () => void;
}) {
  const visibleNodes = nodes.filter((node) => node.kind === "directory" || node.name !== "index.md");
  return (
    <div className="tree-nodes">
      {visibleNodes.map((node) => {
        const depthStyle = { "--tree-depth": depth } as CSSProperties;
        if (node.kind === "directory") {
          const expanded = expandedPaths.has(node.path);
          const FolderIcon = expanded ? FolderOpen : Folder;
          return (
            <div key={node.path}>
              <button
                className={`tree-node tree-node--directory${node.path === revealedPath ? " tree-node--revealed" : ""}`}
                data-explorer-path={node.path}
                data-explorer-drop-path={rootKind === "notes" ? node.path : undefined}
                data-explorer-root-kind={rootKind}
                style={depthStyle}
                aria-expanded={expanded}
                aria-label={`${node.name}, ${expanded ? "expanded" : "collapsed"} folder`}
                onClick={() => { onTreeInteraction?.(); onTogglePath(node.path, rootKind); }}
                onDoubleClick={() => onOpenFolder?.(node.path)}
                onMouseDown={rootKind === "notes" ? (event) =>
                  dragManager.startDrag(event, { kind: "workspace-path", path: node.path, nodeKind: "directory" })
                : undefined}
                onContextMenu={onContextMenu ? (event) => onContextMenu(event, { path: node.path, kind: "directory" }) : undefined}
                type="button"
              >
                <FolderIcon className="tree-node__kind-icon" size={13} aria-hidden="true" />
                <span className="tree-node__label" title={node.name}>{truncateLabel(node.name)}</span>
              </button>
              {expanded && node.children?.length ? (
                <TreeNodes
                  nodes={node.children}
                  depth={depth + 1}
                  rootKind={rootKind}
                  expandedPaths={expandedPaths}
                  onTogglePath={onTogglePath}
                  onOpenFile={onOpenFile}
                  onOpenFolder={onOpenFolder}
                  dragManager={dragManager}
                  onContextMenu={onContextMenu}
                  mirrored={mirrored}
                  revealedPath={revealedPath}
                  onTreeInteraction={onTreeInteraction}
                />
              ) : null}
            </div>
          );
        }

        const fileLabel = truncateLabel(node.name.endsWith(".md") ? node.name.slice(0, -3) : node.name);
        return (
          <button
            key={node.path}
            className={`tree-node tree-node--file${node.path === revealedPath ? " tree-node--revealed" : ""}`}
            data-explorer-path={node.path}
            data-explorer-drop-path={rootKind === "notes" ? node.path : undefined}
            data-explorer-drop-kind={rootKind === "notes" ? "file" : undefined}
            data-explorer-root-kind={rootKind}
            style={depthStyle}
            aria-label={`${fileLabel}, file`}
            onClick={() => { onTreeInteraction?.(); onOpenFile(node.path); }}
            onMouseDown={rootKind === "notes" ? (event) =>
              dragManager.startDrag(event, { kind: "workspace-path", path: node.path, nodeKind: "file" })
            : undefined}
            onContextMenu={onContextMenu ? (event) => onContextMenu(event, { path: node.path, kind: "file" }) : undefined}
            type="button"
          >
            <FileText className="tree-node__kind-icon" size={13} aria-hidden="true" />
            <span className="tree-node__label" title={node.name}>{fileLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

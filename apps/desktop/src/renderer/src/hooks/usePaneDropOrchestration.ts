import {
  findNode,
  mapLeaves,
  paneId,
  pruneEmptyLeaves,
  removeNode,
  updateNode,
  type EditorPaneContent,
  type PaneContent,
  type PaneLeaf,
  type PaneNode,
  type PaneNodeId,
  type PaneTreeActions,
} from "./usePaneTree";
import { useDragManager, type DragManager, type DropEdge } from "./useDragManager";
import { directoryOf } from "../workspaceTree";

interface UsePaneDropOrchestrationOptions {
  canvasTree: PaneNode;
  canvasActions: PaneTreeActions;
  focusPane: (leafId: PaneNodeId) => void;
  ensureDocumentLoaded: (filePath: string) => Promise<void>;
  moveWorkspacePathIntoDirectory: (sourcePath: string, targetDirectoryPath: string) => Promise<void>;
  returnSurfaceToUtility: (surface: "terminal" | "preview", id: string, sourcePaneId?: string) => void;
}

export function usePaneDropOrchestration(options: UsePaneDropOrchestrationOptions): DragManager {
  return useDragManager((target, payload) => {
    if (target.kind === "explorer") {
      if (payload.kind === "workspace-path") {
        const targetDirectoryPath = target.targetKind === "file" ? directoryOf(target.targetPath) : target.targetPath;
        void (async () => {
          for (const sourcePath of payload.paths ?? [payload.path]) {
            await options.moveWorkspacePathIntoDirectory(sourcePath, targetDirectoryPath);
          }
        })().catch((error) => {
          console.error("[workspace] move failed", error);
        });
      }
      return;
    }

    if (target.kind === "utility") {
      if (payload.kind === "terminal") {
        options.returnSurfaceToUtility("terminal", payload.terminalId, payload.sourcePaneId);
      } else if (payload.kind === "preview") {
        options.returnSurfaceToUtility("preview", payload.previewId, payload.sourcePaneId);
      }
      return;
    }

    if (payload.kind === "document") {
      handleDocumentDrop(options, target.leafId, target.edge, payload.filePath, payload.sourcePaneId);
    } else if (payload.kind === "terminal") {
      handleSurfaceDrop(options, target.leafId, target.edge, { kind: "terminal", terminalId: payload.terminalId }, payload.sourcePaneId);
    } else if (payload.kind === "preview") {
      handleSurfaceDrop(options, target.leafId, target.edge, { kind: "browser", previewId: payload.previewId }, payload.sourcePaneId);
    } else if (payload.kind === "workspace-path" && payload.nodeKind === "file") {
      handleDocumentDrop(options, target.leafId, target.edge, payload.path);
    }
  });
}

function handleSurfaceDrop(
  options: UsePaneDropOrchestrationOptions,
  leafId: PaneNodeId,
  edge: DropEdge,
  content: PaneContent,
  sourceLeafId?: PaneNodeId,
) {
  const targetLeaf = findNode(options.canvasTree, (node) => node.id === leafId && node.kind === "leaf") as PaneLeaf | undefined;
  if (!targetLeaf) return;
  if (sourceLeafId === leafId) return;
  const dropEdge = edge === "center" ? "right" : edge;
  const direction: "horizontal" | "vertical" = dropEdge === "left" || dropEdge === "right" ? "horizontal" : "vertical";
  const position: "before" | "after" = dropEdge === "left" || dropEdge === "top" ? "before" : "after";
  const newLeafId = paneId();
  options.canvasActions.setTree((previous) => {
    let tree = updateNode(previous, leafId, (node) => {
    const newLeaf: PaneLeaf = { kind: "leaf", id: newLeafId, content };
    return {
      kind: "split",
      id: paneId(),
      direction,
      ratio: 0.5,
      children: position === "before" ? [newLeaf, node as PaneLeaf] : [node as PaneLeaf, newLeaf],
    };
    });
    if (sourceLeafId && sourceLeafId !== leafId) tree = removeNode(tree, sourceLeafId) ?? tree;
    return tree;
  });
  options.focusPane(newLeafId);
}

function handleDocumentDrop(
  options: UsePaneDropOrchestrationOptions,
  leafId: PaneNodeId,
  edge: DropEdge,
  filePath: string,
  sourceLeafId?: string,
) {
  void options.ensureDocumentLoaded(filePath);
  const targetLeaf = findNode(options.canvasTree, (node) => node.id === leafId && node.kind === "leaf") as PaneLeaf | undefined;
  if (!targetLeaf) {
    return;
  }
  const dropEdge = targetLeaf.content.kind !== "editor" && edge === "center" ? "right" : edge;
  const isEmptyEditor = (leaf: PaneLeaf) => leaf.content.kind === "editor" && leaf.content.openPaths.length === 0;

  if (dropEdge === "center") {
    options.canvasActions.setTree((previous) => {
      let tree = mapLeaves(previous, (leaf) => {
        if (leaf.content.kind !== "editor") return leaf;
        if (sourceLeafId && leaf.id === sourceLeafId && leaf.id !== leafId) {
          const remaining = leaf.content.openPaths.filter((path) => path !== filePath);
          return { ...leaf, content: { ...leaf.content, openPaths: remaining, activePath: leaf.content.activePath === filePath ? (remaining.at(-1) ?? null) : leaf.content.activePath } };
        }
        if (leaf.id === leafId) {
          return { ...leaf, content: { ...leaf.content, activePath: filePath, openPaths: leaf.content.openPaths.includes(filePath) ? leaf.content.openPaths : [...leaf.content.openPaths, filePath] } };
        }
        return leaf;
      });
      return pruneEmptyLeaves(tree, isEmptyEditor);
    });
    options.focusPane(leafId);
    return;
  }

  if (sourceLeafId === leafId && targetLeaf.content.kind === "editor" && targetLeaf.content.openPaths.length <= 1) {
    return;
  }

  const direction: "horizontal" | "vertical" = dropEdge === "left" || dropEdge === "right" ? "horizontal" : "vertical";
  const position: "before" | "after" = dropEdge === "left" || dropEdge === "top" ? "before" : "after";
  const newLeafId = paneId();
  const newContent: EditorPaneContent = { kind: "editor", openPaths: [filePath], activePath: filePath };

  options.canvasActions.setTree((previous) => {
    const newLeaf: PaneLeaf = { kind: "leaf", id: newLeafId, content: newContent };
    let tree = updateNode(previous, leafId, (node) => ({
      kind: "split" as const,
      id: paneId(),
      direction,
      ratio: 0.5,
      children: (position === "before" ? [newLeaf, node as PaneLeaf] : [node as PaneLeaf, newLeaf]) as [PaneNode, PaneNode],
    }));
    if (sourceLeafId) {
      tree = mapLeaves(tree, (leaf) => {
        if (leaf.id !== sourceLeafId || leaf.content.kind !== "editor") return leaf;
        const remaining = leaf.content.openPaths.filter((path) => path !== filePath);
        return { ...leaf, content: { ...leaf.content, openPaths: remaining, activePath: leaf.content.activePath === filePath ? (remaining.at(-1) ?? null) : leaf.content.activePath } };
      });
    }
    return pruneEmptyLeaves(tree, isEmptyEditor);
  });
  options.focusPane(newLeafId);
}

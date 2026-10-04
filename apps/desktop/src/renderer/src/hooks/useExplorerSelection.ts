import { useState, type MouseEvent } from "react";
import type { TreeNode } from "@exograph/core";
import type { DragManager } from "./useDragManager";

/** Range selection follows visible file order, never hidden descendants. */
export function visibleExplorerFiles(nodes: TreeNode[], expanded: ReadonlySet<string>): string[] {
  return nodes.flatMap((node) => node.kind === "directory"
    ? expanded.has(node.path) ? visibleExplorerFiles(node.children ?? [], expanded) : []
    : node.name === "index.md" ? [] : [node.path]);
}

export function useExplorerSelection(visible: string[], dragManager: DragManager, openFile: (path: string) => void) {
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const paths = selected.filter((path) => visible.includes(path));

  function mouseDown(event: MouseEvent, path: string) {
    if (event.button !== 0) return;
    event.preventDefault();
    let next = paths;
    if (event.shiftKey) {
      const from = anchor ? visible.indexOf(anchor) : -1;
      const to = visible.indexOf(path);
      next = from < 0 ? [path] : visible.slice(Math.min(from, to), Math.max(from, to) + 1);
      if (event.metaKey || event.ctrlKey) next = [...new Set([...paths, ...next])];
    } else if (event.metaKey || event.ctrlKey) {
      next = paths.includes(path) ? paths.filter((item) => item !== path) : [...paths, path];
      setAnchor(path);
    } else if (!paths.includes(path)) {
      next = [path];
      setAnchor(path);
    }
    setSelected(next);
    if (!event.shiftKey && !event.metaKey && !event.ctrlKey) {
      dragManager.startDrag(event, { kind: "workspace-path", path, nodeKind: "file", paths: next });
    }
  }

  function click(event: MouseEvent, path: string) {
    if (event.shiftKey || event.metaKey || event.ctrlKey) return;
    setSelected([path]);
    setAnchor(path);
    openFile(path);
  }

  return { paths, mouseDown, click };
}

export type ExplorerSelection = ReturnType<typeof useExplorerSelection>;

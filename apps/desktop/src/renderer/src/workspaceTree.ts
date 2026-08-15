import type { TreeNode } from "@exograph/core";

export function treeLoadKey(rootKind: "notes", directoryPath: string): string {
  return `${rootKind}:${directoryPath}`;
}

export function replaceTreeChildrenInRoots(
  roots: Record<string, TreeNode[]>,
  directoryPath: string,
  children: TreeNode[],
): Record<string, TreeNode[]> {
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(roots).map(([rootPath, nodes]) => {
      const nextNodes = replaceTreeChildren(nodes, directoryPath, children);
      if (nextNodes !== nodes) {
        changed = true;
      }
      return [rootPath, nextNodes];
    }),
  );
  return changed ? next : roots;
}

/**
 * A root refresh is intentionally shallow. Preserve descendants that the user
 * already expanded beyond that boundary, while taking the fresh root shape as
 * authoritative so deleted or renamed paths disappear.
 */
export function mergeTreeRootsWithMaterializedBranches(
  current: Record<string, TreeNode[]>,
  refreshed: Record<string, TreeNode[]>,
): Record<string, TreeNode[]> {
  return Object.fromEntries(
    Object.entries(refreshed).map(([rootPath, nodes]) => [
      rootPath,
      mergeTreeChildren(current[rootPath] ?? [], nodes),
    ]),
  );
}

export function replaceTreeChildren(nodes: TreeNode[], directoryPath: string, children: TreeNode[]): TreeNode[] {
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.kind !== "directory") {
      return node;
    }
    if (node.path === directoryPath) {
      changed = true;
      return { ...node, children: mergeTreeChildren(node.children ?? [], children) };
    }
    const nextChildren = node.children ? replaceTreeChildren(node.children, directoryPath, children) : node.children;
    if (nextChildren !== node.children) {
      changed = true;
      return { ...node, children: nextChildren };
    }
    return node;
  });
  return changed ? nextNodes : nodes;
}

export function mergeTreeChildren(existing: TreeNode[], incoming: TreeNode[]): TreeNode[] {
  if (existing.length === 0) {
    return incoming;
  }
  const existingByPath = new Map(existing.map((node) => [node.path, node]));
  return incoming.map((node) => {
    const previous = existingByPath.get(node.path);
    if (!previous || previous.kind !== "directory" || node.kind !== "directory") {
      return node;
    }
    if ((previous.children?.length ?? 0) > 0 && (node.children?.length ?? 0) === 0) {
      return previous;
    }
    return {
      ...node,
      children: mergeTreeChildren(previous.children ?? [], node.children ?? []),
    };
  });
}

export function treeDirectoryHasChildrenInRoots(roots: Record<string, TreeNode[]>, directoryPath: string): boolean {
  return Object.values(roots).some((nodes) => treeDirectoryHasChildren(nodes, directoryPath));
}

export function treeDirectoryHasChildren(nodes: TreeNode[], directoryPath: string): boolean {
  for (const node of nodes) {
    if (node.kind !== "directory") {
      continue;
    }
    if (node.path === directoryPath) {
      return (node.children?.length ?? 0) > 0;
    }
    if (node.children && treeDirectoryHasChildren(node.children, directoryPath)) {
      return true;
    }
  }
  return false;
}

export function directoryOf(filePath: string): string {
  return filePath.split("/").slice(0, -1).join("/") || "/";
}

export function pathLabel(filePath: string): string {
  return filePath.split("/").filter(Boolean).at(-1) ?? filePath;
}

export function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

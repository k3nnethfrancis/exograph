import { useRef, useState } from "react";
import type { TreeNode, WorkspaceModel } from "@exograph/core";

import {
  replaceTreeChildrenInRoots,
  mergeTreeRootsWithMaterializedBranches,
  treeDirectoryHasChildrenInRoots,
  treeLoadKey,
} from "../workspaceTree";

export interface UseWorkspaceTreesOptions {
  noteTreeMaxDepth: number;
}

export function useWorkspaceTrees(options: UseWorkspaceTreesOptions) {
  const [noteTrees, setNoteTrees] = useState<Record<string, TreeNode[]>>({});
  const loadedTreeDirectoriesRef = useRef<Set<string>>(new Set());
  const excludedPathsRef = useRef<string[]>([]);

  function replaceTreesForModel(
    model: WorkspaceModel,
    nextNoteTrees: Record<string, TreeNode[]>,
  ): void {
    excludedPathsRef.current = model.contentPolicy?.excludedPaths ?? [];
    setNoteTrees((current) => mergeTreeRootsWithMaterializedBranches(current, nextNoteTrees));
    loadedTreeDirectoriesRef.current = loadedRootKeys(model);
  }

  async function reloadTreesForModel(model: WorkspaceModel): Promise<void> {
    const nextNoteTrees = await loadInitialTrees(model, options);
    replaceTreesForModel(model, nextNoteTrees);
  }

  async function expandTreeDirectory(directoryPath: string): Promise<void> {
    const loadKey = treeLoadKey("notes", directoryPath);
    if (loadedTreeDirectoriesRef.current.has(loadKey)) {
      return;
    }
    if (treeDirectoryHasChildrenInRoots(noteTrees, directoryPath)) {
      loadedTreeDirectoriesRef.current.add(loadKey);
      return;
    }
    loadedTreeDirectoriesRef.current.add(loadKey);

    const children = await window.exograph.workspace.listTree(directoryPath, {
      allowedFileExtensions: [".md", ".pdf"],
      maxDepth: 1,
      excludedPaths: excludedPathsRef.current,
    });
    setNoteTrees((current) => replaceTreeChildrenInRoots(current, directoryPath, children));
  }

  async function refreshTreeDirectory(directoryPath: string): Promise<void> {
    const children = await window.exograph.workspace.listTree(directoryPath, {
      allowedFileExtensions: [".md", ".pdf"],
      maxDepth: 1,
      excludedPaths: excludedPathsRef.current,
    });
    loadedTreeDirectoriesRef.current.add(treeLoadKey("notes", directoryPath));
    setNoteTrees((current) => replaceTreeChildrenInRoots(current, directoryPath, children));
  }

  return {
    noteTrees,
    replaceTreesForModel,
    reloadTreesForModel,
    expandTreeDirectory,
    refreshTreeDirectory,
  };
}

export async function loadInitialTrees(
  model: WorkspaceModel,
  options: UseWorkspaceTreesOptions,
): Promise<Record<string, TreeNode[]>> {
  const nextNoteTrees = await Promise.all(
    model.noteRoots.map(
      async (root) =>
        [root.path, await window.exograph.workspace.listTree(root.path, {
          allowedFileExtensions: [".md", ".pdf"],
          maxDepth: options.noteTreeMaxDepth,
          excludedPaths: model.contentPolicy?.excludedPaths ?? [],
        })] as const,
    ),
  );

  return Object.fromEntries(nextNoteTrees);
}

function loadedRootKeys(model: WorkspaceModel): Set<string> {
  return new Set([
    ...model.noteRoots.map((root) => treeLoadKey("notes", root.path)),
  ]);
}

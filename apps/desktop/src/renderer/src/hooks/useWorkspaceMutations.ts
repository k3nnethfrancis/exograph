import { useState } from "react";
import type { WorkspaceModel } from "@exograph/core";

import type { PaneNodeId } from "./usePaneTree";
import { directoryOf, pathLabel } from "../workspaceTree";

export type WorkspaceDialogState =
  | { kind: "save-copy"; sourcePath: string; targetPath: string; value: string; title: string; confirmLabel: string }
  | {
      kind: "create-file";
      targetPath: string;
      value: string;
      title: string;
      confirmLabel: string;
    }
  | {
      kind: "create-directory";
      targetPath: string;
      value: string;
      title: string;
      confirmLabel: string;
    }
  | {
      kind: "rename";
      preserveMarkdown: boolean;
      targetPath: string;
      value: string;
      title: string;
      confirmLabel: string;
    }
  | {
      kind: "delete";
      targetPath: string;
      title: string;
      message: string;
      confirmLabel: string;
    }
  | {
      kind: "move-conflict";
      title: string;
      message: string;
      confirmLabel: string;
    }
  | {
      kind: "recover-as";
      sourcePath: string;
      targetPath: string;
      value: string;
      title: string;
      confirmLabel: string;
    };

interface UseWorkspaceMutationsOptions {
  workspaceModel: WorkspaceModel | null;
  activeDocumentPath: string | null;
  editorFocusedLeafId: PaneNodeId;
  reloadTrees: () => Promise<void>;
  saveConflictCopy: (filePath: string, destination: string) => Promise<void>;
  openFile: (filePath: string, leafId?: PaneNodeId) => Promise<void>;
  remapOpenPaths: (sourcePath: string, nextPath: string) => void;
  removeDeletedPaths: (targetPath: string) => void;
  revealExplorerPath: (path: string) => void;
  requestGeneratedTitleSelection: (filePath: string) => void;
  recoverDeletedDocument: (sourcePath: string, destinationPath: string) => Promise<void>;
}

export function useWorkspaceMutations(options: UseWorkspaceMutationsOptions) {
  const [dialog, setDialog] = useState<WorkspaceDialogState | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogPending, setDialogPending] = useState(false);

  function saveConflictCopy(filePath: string) {
    setDialogError(null);
    setDialog({ kind: "save-copy", sourcePath: filePath, targetPath: directoryOf(filePath), value: pathLabel(filePath).replace(/(\.[^.]+)?$/, "-local-copy$1"), title: "Save local edits as a copy", confirmLabel: "Save copy" });
  }

  function createFileInDirectory(directoryPath: string) {
    if (!options.workspaceModel) {
      return;
    }

    const noteRootPaths = options.workspaceModel.noteRoots.map((root) => root.path);
    const suggested = isInsideNoteRoot(directoryPath, noteRootPaths) ? "untitled.md" : "new-file.txt";
    setDialog({
      kind: "create-file",
      targetPath: directoryPath,
      value: suggested,
      title: "Create file",
      confirmLabel: "Create",
    });
  }

  async function commitCreateFile(directoryPath: string, name: string) {
    if (!options.workspaceModel) {
      return;
    }

    const noteRootPaths = options.workspaceModel.noteRoots.map((root) => root.path);
    const nextPath = await window.exograph.workspace.createFile(
      joinPath(directoryPath, ensureDefaultExtension(name, directoryPath, noteRootPaths)),
    );
    if (nextPath.toLowerCase().endsWith(".md")) {
      options.requestGeneratedTitleSelection(nextPath);
    }
    await options.reloadTrees();
    await options.openFile(nextPath, options.editorFocusedLeafId);
  }

  async function createUntitledNote() {
    const noteRoot = options.workspaceModel?.noteRoots[0]?.path;
    if (!noteRoot) return;
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const filename = attempt === 1 ? "untitled.md" : `untitled-${attempt}.md`;
      const targetPath = joinPath(noteRoot, filename);
      try {
        await window.exograph.workspace.createFile(targetPath);
        options.requestGeneratedTitleSelection(targetPath);
        await options.reloadTrees();
        await options.openFile(targetPath, options.editorFocusedLeafId);
        return;
      } catch (error) {
        if (error instanceof Error && error.message.includes("Destination already exists")) continue;
        throw error;
      }
    }
    throw new Error("Unable to create an untitled note without overwriting an existing file.");
  }

  function createDirectoryInDirectory(directoryPath: string) {
    setDialog({
      kind: "create-directory",
      targetPath: directoryPath,
      value: "new-folder",
      title: "Create folder",
      confirmLabel: "Create",
    });
  }

  async function commitCreateDirectory(directoryPath: string, name: string) {
    const result = await window.exograph.workspace.createFolder(joinPath(directoryPath, name));
    await options.reloadTrees();
    options.revealExplorerPath(result.directoryPath);
    await options.openFile(result.indexPath, options.editorFocusedLeafId);
  }

  function renameWorkspacePath(sourcePath: string, kind: "file" | "directory") {
    const currentName = sourcePath.split("/").at(-1) ?? sourcePath;
    setDialog({
      kind: "rename",
      preserveMarkdown: kind === "file" && /\.md$/i.test(sourcePath),
      targetPath: sourcePath,
      value: currentName,
      title: "Rename",
      confirmLabel: "Rename",
    });
  }

  async function commitRenameWorkspacePath(sourcePath: string, nextName: string) {
    const currentName = sourcePath.split("/").at(-1) ?? sourcePath;
    if (!nextName || nextName === currentName) {
      return;
    }
    const nextPath = joinPath(directoryOf(sourcePath), nextName);
    const previousPath = sourcePath;
    await window.exograph.workspace.renamePath(sourcePath, nextPath);
    options.remapOpenPaths(previousPath, nextPath);
    await options.reloadTrees();
    if (previousPath === options.activeDocumentPath) {
      await options.openFile(nextPath, options.editorFocusedLeafId);
    }
  }

  async function moveWorkspacePathIntoDirectory(sourcePath: string, targetDirectoryPath: string) {
    const sourceLabel = pathLabel(sourcePath);
    const targetLabel = pathLabel(targetDirectoryPath);
    if (sourcePath === targetDirectoryPath) {
      return;
    }
    if (directoryOf(sourcePath) === targetDirectoryPath) {
      return;
    }
    if (isPathWithin(sourcePath, targetDirectoryPath)) {
      return;
    }

    const nextPath = joinPath(targetDirectoryPath, sourceLabel);
    try {
      await window.exograph.workspace.renamePath(sourcePath, nextPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Destination already exists")) {
        setDialog({
          kind: "move-conflict",
          title: "Destination already exists",
          message: `${sourceLabel} cannot be moved into ${targetLabel} because ${pathLabel(nextPath)} already exists there. Exograph will not merge or overwrite folders automatically.`,
          confirmLabel: "OK",
        });
      }
      throw error;
    }
    options.remapOpenPaths(sourcePath, nextPath);
    await options.reloadTrees();
    options.revealExplorerPath(targetDirectoryPath);
    if (sourcePath === options.activeDocumentPath) {
      await options.openFile(nextPath, options.editorFocusedLeafId);
    }
  }

  function deleteWorkspacePath(targetPath: string) {
    setDialog({
      kind: "delete",
      targetPath,
      title: "Delete path",
      message: `Delete ${targetPath.split("/").at(-1) ?? targetPath}?`,
      confirmLabel: "Delete",
    });
  }

  async function commitDeleteWorkspacePath(targetPath: string) {
    await window.exograph.workspace.deletePath(targetPath);
    options.removeDeletedPaths(targetPath);
    await options.reloadTrees();
  }

  async function recoverDeletedFile(sourcePath: string) {
    await options.recoverDeletedDocument(sourcePath, sourcePath);
    await options.reloadTrees();
    options.revealExplorerPath(sourcePath);
  }

  function saveDeletedFileAs(sourcePath: string) {
    const filename = sourcePath.split("/").at(-1) ?? "recovered.md";
    const extension = filename.toLowerCase().endsWith(".md") ? ".md" : "";
    const stem = extension ? filename.slice(0, -extension.length) : filename;
    setDialog({
      kind: "recover-as",
      sourcePath,
      targetPath: directoryOf(sourcePath),
      value: `${stem}-recovered${extension}`,
      title: "Save recovered file as",
      confirmLabel: "Save copy",
    });
  }

  async function submitDialog() {
    if (!dialog) {
      return;
    }

    if (dialog.kind === "move-conflict") {
      setDialog(null);
      return;
    }

    if (dialog.kind === "delete") {
      await commitDeleteWorkspacePath(dialog.targetPath);
      setDialog(null);
      return;
    }

    const value = dialog.value.trim();
    if (!value) {
      return;
    }

    if (dialog.kind === "save-copy") {
      if (value.includes("/") || value === "." || value === "..") throw new Error("Enter a filename in the current folder.");
      const filename = conflictCopyFilename(value, dialog.sourcePath);
      const nextPath = joinPath(dialog.targetPath, filename);
      await options.saveConflictCopy(dialog.sourcePath, nextPath);
      options.remapOpenPaths(dialog.sourcePath, nextPath);
      await options.reloadTrees();
      await options.openFile(nextPath);
    } else if (dialog.kind === "create-file") {
      await commitCreateFile(dialog.targetPath, value);
    } else if (dialog.kind === "create-directory") {
      await commitCreateDirectory(dialog.targetPath, value);
    } else if (dialog.kind === "recover-as") {
      const nextPath = joinPath(dialog.targetPath, value);
      await options.recoverDeletedDocument(dialog.sourcePath, nextPath);
      options.remapOpenPaths(dialog.sourcePath, nextPath);
      await options.reloadTrees();
      options.revealExplorerPath(nextPath);
    } else {
      await commitRenameWorkspacePath(dialog.targetPath, markdownRenameFilename(value, dialog.preserveMarkdown));
    }

    setDialog(null);
  }

  return {
    dialog,
    copyFilename: dialog?.kind === "save-copy" ? conflictCopyFilename(dialog.value.trim(), dialog.sourcePath) : null,
    renameFilename: dialog?.kind === "rename" ? markdownRenameFilename(dialog.value.trim(), dialog.preserveMarkdown) : null,
    setDialog,
    createFileInDirectory,
    createUntitledNote,
    createDirectoryInDirectory,
    renameWorkspacePath,
    deleteWorkspacePath,
    moveWorkspacePathIntoDirectory,
    dialogError,
    dialogPending,
    saveConflictCopy,
    submitDialog: async () => {
      if (dialogPending) return;
      setDialogPending(true);
      setDialogError(null);
      try { await submitDialog(); }
      catch (error) { setDialogError(error instanceof Error ? error.message : String(error)); }
      finally { setDialogPending(false); }
    },
    recoverDeletedFile,
    saveDeletedFileAs,
  };
}

function joinPath(parentPath: string, name: string): string {
  return `${parentPath.replace(/\/$/, "")}/${name.replace(/^\//, "")}`;
}

function isInsideNoteRoot(targetPath: string, rootPaths: string[]): boolean {
  return rootPaths.some((rootPath) => isPathWithin(rootPath, targetPath));
}

function ensureDefaultExtension(name: string, directoryPath: string, noteRootPaths: string[]): string {
  if (name.includes(".")) {
    return name;
  }

  return isInsideNoteRoot(directoryPath, noteRootPaths) ? `${name}.md` : name;
}

function isPathWithin(parentPath: string, targetPath: string): boolean {
  return targetPath === parentPath || targetPath.startsWith(`${parentPath}/`);
}

function markdownRenameFilename(name: string, preserveMarkdown: boolean): string {
  return name && preserveMarkdown && !/\.md$/i.test(name) ? `${name}.md` : name;
}

function conflictCopyFilename(name: string, sourcePath: string): string {
  return name && /\.md(?:own)?$/i.test(sourcePath) && !/\.md(?:own)?$/i.test(name) ? `${name}.md` : name;
}

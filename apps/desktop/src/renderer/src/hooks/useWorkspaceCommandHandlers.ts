import { useEffect } from "react";
import type { WorkspaceModel } from "@exograph/core";
import type { WorkspaceSettingsSection } from "../../../shared/api";
import { directoryOf } from "../workspaceTree";

interface UseWorkspaceCommandHandlersOptions {
  workspaceModel: WorkspaceModel | null;
  openFile: (filePath: string) => Promise<void>;
  openFolder: (directoryPath: string) => void;
  openSettings: (section: WorkspaceSettingsSection) => Promise<void>;
  reloadTrees: () => Promise<void>;
  refreshTreeDirectory: (directoryPath: string) => Promise<void>;
  scheduleOpenDocumentRefresh: (filePath: string) => void;
  reconcileOpenDocumentFilesystemState: () => Promise<void>;
}

export function useWorkspaceCommandHandlers(options: UseWorkspaceCommandHandlersOptions) {
  useEffect(() => {
    return window.exograph.workspace.onCommandOpenFile((filePath: string) => {
      void options.openFile(filePath);
    });
  }, [options.openFile]);

  useEffect(() => {
    return window.exograph.workspace.onCommandOpenFolder((directoryPath: string) => {
      options.openFolder(directoryPath);
    });
  }, [options.openFolder]);

  useEffect(() => {
    return window.exograph.workspace.onCommandOpenSettings((event) => {
      void options.openSettings(event.section);
    });
  }, [options.openSettings]);

  useEffect(() => {
    const removeWorkspaceChangeListener = window.exograph.workspace.onDidChange((event) => {
      // fs.watch's event type is platform-specific: a structural edit may arrive
      // as either "change" or "rename". Always refresh the root shape, then
      // replace the changed path's immediate parent to invalidate any expanded
      // branch beyond the root's shallow tree depth.
      void options.reloadTrees();
      void options.reconcileOpenDocumentFilesystemState();
      if (event.filePath) {
        const filePath = event.filePath;
        void options.refreshTreeDirectory(directoryOf(filePath));
        options.scheduleOpenDocumentRefresh(filePath);
      }
    });

    return () => {
      removeWorkspaceChangeListener();
    };
  }, [
    options.workspaceModel,
    options.reloadTrees,
    options.refreshTreeDirectory,
    options.scheduleOpenDocumentRefresh,
    options.reconcileOpenDocumentFilesystemState,
  ]);
}

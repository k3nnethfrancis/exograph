import { useEffect } from "react";
import type { WorkspaceModel } from "@exograph/core";
import type { WorkspaceSettingsSection } from "../../../shared/api";

interface UseWorkspaceCommandHandlersOptions {
  workspaceModel: WorkspaceModel | null;
  openFile: (filePath: string) => Promise<void>;
  openFolder: (directoryPath: string) => void;
  openSettings: (section: WorkspaceSettingsSection) => Promise<void>;
  reloadTrees: () => Promise<void>;
  scheduleOpenDocumentRefresh: (filePath: string) => void;
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
      if (event.eventType === "rename" || !event.filePath) {
        void options.reloadTrees();
      }
      if (event.filePath) {
        const filePath = event.filePath;
        options.scheduleOpenDocumentRefresh(filePath);
      }
    });

    return () => {
      removeWorkspaceChangeListener();
    };
  }, [
    options.workspaceModel,
    options.reloadTrees,
    options.scheduleOpenDocumentRefresh,
  ]);
}

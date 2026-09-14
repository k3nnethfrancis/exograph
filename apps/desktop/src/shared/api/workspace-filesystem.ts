import type { FolderIndexResult, FolderOverview, TreeNode } from "@exograph/core";

export type PreviewTarget =
  | { url: string; source: "url"; kind: "web" }
  | { url: string; source: "file"; kind: "html" }
  | { url: string; source: "file"; kind: "pdf"; filePath: string };

export interface WorkspaceFilesystemApi {
  listTree: (
    rootPath: string,
    options?: { markdownOnly?: boolean; allowedFileExtensions?: string[]; maxDepth?: number; includeEmptyDirectories?: boolean; excludedPaths?: string[] },
  ) => Promise<TreeNode[]>;
  getFolderOverview: (directoryPath: string) => Promise<FolderOverview>;
  ensureFolderIndex: (directoryPath: string) => Promise<FolderIndexResult>;
  createFile: (targetPath: string, content?: string) => Promise<string>;
  createFolder: (targetPath: string) => Promise<FolderIndexResult>;
  renamePath: (sourcePath: string, nextPath: string) => Promise<string>;
  deletePath: (targetPath: string) => Promise<void>;
  resolvePreviewTarget: (target: string) => Promise<PreviewTarget>;
  readPdfFile: (filePath: string) => Promise<ArrayBuffer>;
  onDidChange: (callback: (event: { rootPath: string; eventType: string; filePath: string | null }) => void) => () => void;
  onGraphChanged: (callback: () => void) => () => void;
  onOntologyCandidateChanged: (callback: () => void) => () => void;
}

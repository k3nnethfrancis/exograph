import type { PublicationDiagnostic, WorkspaceSettings } from "@exograph/core";
export type { PublicationDiagnostic } from "@exograph/core";

export type PublicationAction = "preview" | "prepare";
export interface PublishingStatus {
  phase: "idle" | "exporting" | "building" | "ready" | "error";
  action?: PublicationAction;
  previewUrl?: string;
  outputPath?: string;
  diagnostics: PublicationDiagnostic[];
  error?: string;
}
export type PublishingScope = Pick<WorkspaceSettings, "workspaceRoot" | "noteRoots" | "publishing">;
export interface PublishingBuildRequest { scope: PublishingScope; action: PublicationAction }

/** Stable publication authority, independent of unrelated settings revisions. */
export function publicationScope(settings: PublishingScope): PublishingScope {
  return {
    workspaceRoot: settings.workspaceRoot.trim(),
    noteRoots: settings.noteRoots.map((root) => root.trim()),
    publishing: settings.publishing ? {
      publicationDirectory: settings.publishing.publicationDirectory.trim(),
      engineDirectory: settings.publishing.engineDirectory.trim(),
      siteUrl: settings.publishing.siteUrl.trim(),
    } : undefined,
  };
}

export interface PublishingApi {
  getStatus: () => Promise<PublishingStatus>;
  build: (input: PublishingBuildRequest) => Promise<PublishingStatus>;
  stop: () => Promise<void>;
  revealOutput: () => Promise<void>;
  onStatus: (callback: (status: PublishingStatus) => void) => () => void;
}

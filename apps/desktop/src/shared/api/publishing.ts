import type { PublicationDiagnostic, WorkspaceSettings } from "@exograph/core";
export type { PublicationDiagnostic } from "@exograph/core";

export type PublicationAction = "preview" | "prepare";
export type PublicationDeployResult =
  | { status: "setup-required"; message: string }
  | { status: "deployed"; deploymentUrl: string; snapshotCommit: string; engineCommit: string; runId: string };
export interface PublishingStatus {
  phase: "idle" | "exporting" | "building" | "ready" | "deploying" | "error";
  action?: PublicationAction;
  design?: "vanilla";
  previewUrl?: string;
  outputPath?: string;
  preparedId?: string;
  deployment?: PublicationDeployResult;
  diagnostics: PublicationDiagnostic[];
  error?: string;
}
export type PublishingScope = Pick<WorkspaceSettings, "workspaceRoot" | "noteRoots" | "publishing">;
export interface PublishingBuildRequest { scope: PublishingScope; action: PublicationAction; design?: "vanilla" }

/** Stable publication authority, independent of unrelated settings revisions. */
export function publicationScope(settings: PublishingScope): PublishingScope {
  return {
    workspaceRoot: settings.workspaceRoot.trim(),
    noteRoots: settings.noteRoots.map((root) => root.trim()),
    publishing: settings.publishing ? {
      publicationDirectory: settings.publishing.publicationDirectory.trim(),
      engineDirectory: settings.publishing.engineDirectory.trim(),
      siteUrl: settings.publishing.siteUrl.trim(),
      destinationRepository: settings.publishing.destinationRepository?.trim() ?? "",
    } : undefined,
  };
}

export interface PublishingApi {
  changeDesign: (input: { scope: PublishingScope; action: "restore" | "undo" }) => Promise<PublishingStatus>;
  getSetupStatus: () => Promise<PublishingAuthStatus>;
  startAuth: () => Promise<PublishingAuthStatus>;
  setup: (input: PublishingSetupRequest) => Promise<PublishingSetupResult>;
  cancelSetup: () => Promise<void>;
  revealTheme: () => Promise<void>;
  getStatus: () => Promise<PublishingStatus>;
  build: (input: PublishingBuildRequest) => Promise<PublishingStatus>;
  publish: (input: { scope: PublishingScope; preparedId: string }) => Promise<PublishingStatus>;
  stop: () => Promise<void>;
  revealOutput: () => Promise<void>;
  onStatus: (callback: (status: PublishingStatus) => void) => () => void;
}

export interface PublishingAuthStatus {
  accounts?: { login: string; kind: "user" | "organization"; canCreate: boolean }[];
  accountsMessage?: string;
  authenticated: boolean;
  login?: string;
  pending?: boolean;
  deviceCode?: string;
  verificationUrl?: string;
  message?: string;
  managed: boolean;
  engineDirectory?: string;
  hasSavedDesign?: boolean;
}
export interface PublishingSetupRequest {
  scope: PublishingScope;
  publicationDirectory: string;
  repository: string;
  createRepository: boolean;
  visibility?: "public" | "private";
  themeDirectory?: string;
  siteUrl?: string;
}
export interface PublishingSetupResult {
  status: "ready" | "setup-required";
  repository: string;
  engineDirectory: string;
  siteUrl: string;
  branch: string;
  message?: string;
}

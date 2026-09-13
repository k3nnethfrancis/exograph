import type { PublicationDiagnostic } from "@exograph/core";
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
export interface PublishingApi {
  getStatus: () => Promise<PublishingStatus>;
  build: (input: { expectedRevision: string | null; action: PublicationAction }) => Promise<PublishingStatus>;
  stop: () => Promise<void>;
  revealOutput: () => Promise<void>;
  onStatus: (callback: (status: PublishingStatus) => void) => () => void;
}

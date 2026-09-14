import type {
  OnboardingStateStore,
  OnboardingProgressDraft,
  OntologyKeepResult,
  OntologyRejectResult,
  OntologyReviewGuard,
  OntologyReviewState,
  WorkspaceModel,
  WorkspaceRegistryEntry,
  WorkspaceSettingsSaveRequest,
  WorkspaceSettingsSnapshot,
} from "@exograph/core";
import type { WorkspaceContentInspection } from "@exograph/core";

export type WorkspaceSettingsSection = "workspace" | "index" | "appearance" | "graph" | "terminal" | "shortcuts" | "agents" | "publishing";

export interface WorkspaceSetupState {
  complete: boolean;
  onboardingComplete: boolean;
  onboarding: OnboardingStateStore;
  onboardingRecovery: { kind: "malformed"; message: string } | null;
  settingsPath: string;
}

export type WorkspaceSettingsRuntimeApplyOutcome =
  | { status: "applied" }
  /** The Workspace committed, but a noncritical post-commit rebind needs attention. */
  | { status: "degraded"; errorMessage: string }
  | { status: "failed"; errorMessage: string };

export interface WorkspaceSettingsSaveOutcome extends WorkspaceSettingsSnapshot {
  runtimeApply: WorkspaceSettingsRuntimeApplyOutcome;
}

export interface WorkspaceSetupApi {
  getModel: () => Promise<WorkspaceModel>;
  getSettings: () => Promise<WorkspaceSettingsSnapshot>;
  getSetupState: () => Promise<WorkspaceSetupState>;
  saveOnboardingProgress: (draft: OnboardingProgressDraft) => Promise<OnboardingStateStore>;
  resetOnboardingProgress: () => Promise<OnboardingStateStore>;
  markOnboardingComplete: () => Promise<OnboardingStateStore>;
  listWorkspaces: () => Promise<WorkspaceRegistryEntry[]>;
  activateWorkspace: (input: { workspaceId: string; expectedRevision: WorkspaceSettingsSaveRequest["expectedRevision"] }) => Promise<WorkspaceSettingsSaveOutcome>;
  saveSettings: (request: WorkspaceSettingsSaveRequest) => Promise<WorkspaceSettingsSaveOutcome>;
  selectFolder: (options?: { title?: string; allowMultiple?: boolean; buttonLabel?: string; defaultPath?: string }) => Promise<string[]>;
  inspectContentScope: (rootPath: string) => Promise<WorkspaceContentInspection>;
  previewOntology: (sourcePath?: string | null) => Promise<OntologyReviewState>;
  keepOntology: (guard: OntologyReviewGuard) => Promise<OntologyKeepResult>;
  rejectOntology: (guard: OntologyReviewGuard) => Promise<OntologyRejectResult>;
  onCommandOpenFile: (callback: (filePath: string) => void) => () => void;
  onCommandOpenSettings: (callback: (event: { section: WorkspaceSettingsSection }) => void) => () => void;
}

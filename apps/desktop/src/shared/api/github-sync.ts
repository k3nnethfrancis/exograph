import type { PublishingAuthStatus } from "./publishing";
/** Sync configuration is local to this Mac and this exact Note Root. */
export interface GitHubSyncConfig {
  enabled: boolean;
  remote: string;
  branch: string;
  remoteBranch?: string;
  cadence: "manual" | "hourly" | "daily";
}
export interface GitHubSyncStatus {
  root: string;
  config: GitHubSyncConfig;
  phase: "idle" | "checking" | "saving" | "fetching" | "merging" | "pushing" | "synced" | "conflict" | "error";
  repository?: string;
  lastAttempt?: string;
  lastSuccess?: string;
  lastSyncedCommit?: string;
  hasLocalChanges?: boolean;
  nextRun?: string;
  message?: string;
  conflicts?: string[];
  excluded: string[];
}
export interface GitHubSyncApi {
  getAccountStatus: () => Promise<PublishingAuthStatus>;
  startAccountAuth: () => Promise<PublishingAuthStatus>;
  cancelSetup: () => Promise<void>;
  onSetupProgress: (callback: (progress: GitHubSyncSetupProgress) => void) => () => void;
  inspectSetup: () => Promise<GitHubSyncSetup>;
  listRepositories: (input: { query?: string; page?: number }) => Promise<{ repositories: GitHubSyncRepositoryInfo[]; nextPage?: number }>;
  inspectRepository: (input: { repository: string }) => Promise<GitHubSyncRepositoryInfo>;
  createAndSync: (input: { root: string; owner: string; name: string; cadence: GitHubSyncConfig["cadence"] }) => Promise<GitHubSyncConnectionResult>;
  connectExisting: (input: { root: string; repository: string; cadence: GitHubSyncConfig["cadence"]; remote?: string }) => Promise<GitHubSyncConnectionResult>;
  downloadRepository: (input: { repository: string }) => Promise<GitHubSyncDownloadResult | null>;

  getStatus: () => Promise<GitHubSyncStatus>;
  configure: (input: { root: string; config: GitHubSyncConfig }) => Promise<GitHubSyncStatus>;
  syncNow: (input: { root: string }) => Promise<GitHubSyncStatus>;
  cancel: () => Promise<GitHubSyncStatus>;
  onStatus: (callback: (status: GitHubSyncStatus) => void) => () => void;
}

export interface GitHubSyncRepositoryInfo {
  id?: number;
  nameWithOwner: string;
  url: string;
  isPrivate: boolean;
  writable: boolean;
  defaultBranch: string;
  empty: boolean;
}
export interface GitHubSyncSetup {
  root: string;
  status: GitHubSyncStatus;
  account?: { login: string; name?: string };
  suggestedName: string;
  local: { isRepository: boolean; branch?: string; upstream?: string; problem?: string };
  candidates: { remote: string; branch: string; remoteBranch?: string; repository: GitHubSyncRepositoryInfo; preferred: boolean }[];
}
export interface GitHubSyncConnectionResult {
  kind: "connected" | "review-required";
  status?: GitHubSyncStatus;
  message?: string;
  repository: GitHubSyncRepositoryInfo;
}
export interface GitHubSyncDownloadResult {
  directory: string;
  repository: GitHubSyncRepositoryInfo;
}

export interface GitHubSyncSetupProgress { phase: "checking" | "creating" | "preparing" | "downloading" | "ready" | "error"; message: string; canCancel: boolean }

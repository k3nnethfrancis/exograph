/** Sync configuration is local to this Mac and this exact Note Root. */
export interface GitHubSyncConfig {
  enabled: boolean;
  remote: string;
  branch: string;
  cadence: "manual" | "hourly" | "daily";
}
export interface GitHubSyncStatus {
  root: string;
  config: GitHubSyncConfig;
  phase: "idle" | "checking" | "saving" | "fetching" | "merging" | "pushing" | "synced" | "conflict" | "error";
  repository?: string;
  lastAttempt?: string;
  lastSuccess?: string;
  nextRun?: string;
  message?: string;
  conflicts?: string[];
  excluded: string[];
}
export interface GitHubSyncApi {
  getStatus: () => Promise<GitHubSyncStatus>;
  configure: (input: { root: string; config: GitHubSyncConfig }) => Promise<GitHubSyncStatus>;
  syncNow: (input: { root: string }) => Promise<GitHubSyncStatus>;
  onStatus: (callback: (status: GitHubSyncStatus) => void) => () => void;
}

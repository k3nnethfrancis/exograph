import { handleDesktopInvoke } from "../typed-ipc";
import type { GitHubSyncService } from "./github-sync-service";

export function registerGitHubSyncIpc(service: GitHubSyncService): void {
  handleDesktopInvoke("github-sync:cancel", () => service.cancel());
  handleDesktopInvoke("github-sync:get-status", () => service.getStatus());
  handleDesktopInvoke("github-sync:configure", (_event, input) => service.configure(input));
  handleDesktopInvoke("github-sync:sync-now", (_event, input) => service.syncNow(input));
}

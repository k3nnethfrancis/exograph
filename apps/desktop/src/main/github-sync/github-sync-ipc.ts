import { handleDesktopInvoke } from "../typed-ipc";
import type { ManagedSiteSetup } from "../publishing/managed-site-setup";
import type { GitHubSyncSetupService } from "./github-sync-setup";
import type { GitHubSyncService } from "./github-sync-service";

export function registerGitHubSyncIpc(service: GitHubSyncService, setup: GitHubSyncSetupService, account: () => ManagedSiteSetup): void {
  handleDesktopInvoke("github-sync:get-account-status", () => account().getAccountStatus());
  handleDesktopInvoke("github-sync:start-account-auth", () => account().startAccountAuth());
  handleDesktopInvoke("github-sync:inspect-setup", () => setup.inspectSetup());
  handleDesktopInvoke("github-sync:list-repositories", (_event, input) => setup.listRepositories(input));
  handleDesktopInvoke("github-sync:inspect-repository", (_event, input) => setup.inspectRepository(input));
  handleDesktopInvoke("github-sync:create-and-sync", (_event, input) => setup.createAndSync(input));
  handleDesktopInvoke("github-sync:connect-existing", (_event, input) => setup.connectExisting(input));
  handleDesktopInvoke("github-sync:download-repository", (_event, input) => setup.downloadRepository(input));
  handleDesktopInvoke("github-sync:cancel-setup", async () => setup.cancel());
  handleDesktopInvoke("github-sync:cancel", () => service.cancel());
  handleDesktopInvoke("github-sync:get-status", () => service.getStatus());
  handleDesktopInvoke("github-sync:configure", (_event, input) => service.configure(input));
  handleDesktopInvoke("github-sync:sync-now", (_event, input) => service.syncNow(input));
}

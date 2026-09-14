import { shell } from "electron";
import { handleDesktopInvoke } from "../typed-ipc";
import type { ManagedSiteSetup } from "./managed-site-setup";
import type { PublishingService } from "./publishing-service";

export function registerPublishingIpc(service: PublishingService, setup: ManagedSiteSetup): void {
  handleDesktopInvoke("publishing:get-setup-status", () => setup.getSetupStatus());
  handleDesktopInvoke("publishing:start-auth", () => setup.startAuth());
  handleDesktopInvoke("publishing:setup", (_event, input) => setup.setup(input));
  handleDesktopInvoke("publishing:cancel-setup", () => setup.cancelSetup());
  handleDesktopInvoke("publishing:reveal-theme", async () => {
    const error = await shell.openPath(await setup.themePath());
    if (error) throw new Error(error);
  });
  handleDesktopInvoke("publishing:get-status", () => service.getStatus());
  handleDesktopInvoke("publishing:build", (_event, input) => service.build(input));
  handleDesktopInvoke("publishing:publish", (_event, input) => service.publish(input));
  handleDesktopInvoke("publishing:stop", () => service.stop());
  handleDesktopInvoke("publishing:reveal-output", async () => {
    const error = await shell.openPath(service.outputPath());
    if (error) throw new Error(error);
  });
}

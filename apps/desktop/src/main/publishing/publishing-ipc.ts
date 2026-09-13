import { shell } from "electron";
import { handleDesktopInvoke } from "../typed-ipc";
import type { PublishingService } from "./publishing-service";

export function registerPublishingIpc(service: PublishingService): void {
  handleDesktopInvoke("publishing:get-status", () => service.getStatus());
  handleDesktopInvoke("publishing:build", (_event, input) => service.build(input));
  handleDesktopInvoke("publishing:publish", (_event, input) => service.publish(input));
  handleDesktopInvoke("publishing:stop", () => service.stop());
  handleDesktopInvoke("publishing:reveal-output", async () => {
    const error = await shell.openPath(service.outputPath());
    if (error) throw new Error(error);
  });
}

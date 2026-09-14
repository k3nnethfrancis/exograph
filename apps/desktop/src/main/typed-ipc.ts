import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { DesktopInvokeChannel, DesktopInvokeHandlers } from "../shared/desktop-ipc";
import { assertTrustedDesktopInvoke } from "./renderer-authority";

type IpcHandler<C extends DesktopInvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: Parameters<DesktopInvokeHandlers[C]>
) => ReturnType<DesktopInvokeHandlers[C]> | Awaited<ReturnType<DesktopInvokeHandlers[C]>>;

export function handleDesktopInvoke<C extends DesktopInvokeChannel>(channel: C, handler: IpcHandler<C>): void {
  ipcMain.handle(channel, ((event: IpcMainInvokeEvent, ...args: unknown[]) => {
    assertTrustedDesktopInvoke(event);
    return handler(event, ...args as Parameters<DesktopInvokeHandlers[C]>);
  }) as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
}

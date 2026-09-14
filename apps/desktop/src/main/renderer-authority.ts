import type { IpcMainInvokeEvent, WebContents } from "electron";

const trustedRendererIds = new Set<number>();

export function trustDesktopRenderer(webContents: Pick<WebContents, "id">): () => void {
  trustedRendererIds.add(webContents.id);
  return () => trustedRendererIds.delete(webContents.id);
}

export function assertTrustedDesktopInvoke(event: IpcMainInvokeEvent): void {
  if (!trustedRendererIds.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Refusing privileged IPC from an untrusted renderer frame.");
  }
}

export function resetTrustedDesktopRenderersForTest(): void {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    throw new Error("Renderer authority can only be reset by tests.");
  }
  trustedRendererIds.clear();
}

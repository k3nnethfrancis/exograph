import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => unknown>() }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) => electronMock.handlers.set(channel, handler),
  },
}));

import { trustDesktopRenderer, resetTrustedDesktopRenderersForTest } from "./renderer-authority";
import { handleDesktopInvoke } from "./typed-ipc";

describe("privileged desktop IPC", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    resetTrustedDesktopRenderersForTest();
  });

  it("accepts only the registered renderer main frame", async () => {
    const mainFrame = {};
    const sender = { id: 42, mainFrame };
    const handler = vi.fn(async () => "ok");
    trustDesktopRenderer(sender as any);
    handleDesktopInvoke("workspace:get-model", handler as any);
    const invoke = electronMock.handlers.get("workspace:get-model")!;

    await expect(invoke({ sender, senderFrame: mainFrame })).resolves.toBe("ok");
    expect(() => invoke({ sender, senderFrame: {} })).toThrow("untrusted renderer frame");
    expect(() => invoke({ sender: { id: 99, mainFrame }, senderFrame: mainFrame })).toThrow("untrusted renderer frame");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

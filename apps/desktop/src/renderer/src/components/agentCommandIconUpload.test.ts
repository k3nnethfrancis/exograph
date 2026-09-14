import { afterEach, describe, expect, it, vi } from "vitest";
import { importAgentCommandIcon } from "./agentCommandIconUpload";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
afterEach(() => vi.unstubAllGlobals());

describe("user-selected command icons", () => {
  it("rejects unsupported and oversized input before decoding", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    await expect(importAgentCommandIcon(new File(["svg"], "icon.svg", { type: "image/svg+xml" }))).rejects.toThrow("PNG or JPEG");
    await expect(importAgentCommandIcon(new File([new Uint8Array(2 * 1024 * 1024 + 1)], "icon.png", { type: "image/png" }))).rejects.toThrow("2 MB");
    expect(decode).not.toHaveBeenCalled();
  });
  it("reports corrupt raster content", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decode")));
    await expect(importAgentCommandIcon(new File(["bad"], "icon.png", { type: "image/png" }))).rejects.toThrow("could not be opened");
  });
  it("resizes to 128px and writes only a canonical PNG, releasing the bitmap", async () => {
    const close = vi.fn();
    const bitmap = { width: 640, height: 320, close };
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toDataURL: () => png };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    vi.stubGlobal("document", { createElement: () => canvas });
    await expect(importAgentCommandIcon(new File(["input"], "icon.jpg", { type: "image/jpeg" }))).resolves.toBe(png);
    expect([canvas.width, canvas.height]).toEqual([128, 64]);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 128, 64);
    expect(close).toHaveBeenCalledOnce();
  });
});

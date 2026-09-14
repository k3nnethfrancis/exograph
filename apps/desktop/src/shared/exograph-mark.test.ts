import { describe, expect, it } from "vitest";

import {
  EXOGRAPH_MARK_ARMS,
  EXOGRAPH_MARK_NODES,
  exographMarkSvgDataUrl,
  exographTrayIconDataUrl,
} from "./exograph-mark";

describe("Exograph mark", () => {
  it("keeps one six-branch geometry for compact product surfaces", () => {
    expect(EXOGRAPH_MARK_ARMS).toHaveLength(6);
    expect(EXOGRAPH_MARK_NODES).toHaveLength(6);

    const dataUrl = exographMarkSvgDataUrl();
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(dataUrl.split(",")[1] ?? "", "base64").toString("utf8");
    expect(svg).toContain('width="18" height="18"');
    expect(svg.match(/<path /g)).toHaveLength(6);
    expect(svg.match(/<circle /g)).toHaveLength(6);
  });

  it("ships a non-empty 18 px PNG derivative for the macOS menu bar", () => {
    const dataUrl = exographTrayIconDataUrl();
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    const png = Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(18);
    expect(png.readUInt32BE(20)).toBe(18);
  });
});

import { expect, test } from "@playwright/test";

import { exographTrayIconDataUrl } from "../../src/shared/exograph-mark";
import { launchExographWorkspaceFixture } from "../helpers";

test("decodes the canonical menu-bar mark in the real Electron runtime", async () => {
  const fixture = await launchExographWorkspaceFixture({ initialNoteLabel: null });
  try {
    const result = await fixture.electronApp.evaluate(({ nativeImage, Tray }, dataUrl) => {
      const image = nativeImage.createFromDataURL(dataUrl);
      image.setTemplateImage(true);
      const tray = new Tray(image);
      const bounds = tray.getBounds();
      const decoded = {
        empty: image.isEmpty(),
        size: image.getSize(),
        scaleFactors: image.getScaleFactors(),
        trayBounds: { width: bounds.width, height: bounds.height },
      };
      tray.destroy();
      return decoded;
    }, exographTrayIconDataUrl());

    expect(result).toMatchObject({
      empty: false,
      size: { width: 18, height: 18 },
    });
    expect(result.scaleFactors.length).toBeGreaterThan(0);
    // Electron can report a zero status-item bound under headless automation,
    // but successful construction proves the decoded image is accepted by Tray.
  } finally {
    await fixture.cleanup();
  }
});

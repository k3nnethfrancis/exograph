import { describe, expect, it } from "vitest";

import { fitWidthScale, nextPdfPage, previousPdfPage, zoomPdf } from "./pdfDocumentModel";

describe("PDF document controls", () => {
  it("keeps page movement within the loaded document", () => {
    expect(previousPdfPage(1)).toBe(1);
    expect(nextPdfPage(3, 3)).toBe(3);
    expect(nextPdfPage(1, 3)).toBe(2);
  });

  it("clamps zoom and fits a page to the available width", () => {
    expect(zoomPdf(1, "in")).toBe(1.2);
    expect(zoomPdf(0.2, "out")).toBe(0.2);
    expect(fitWidthScale(600, 900)).toBeCloseTo(2 / 3);
  });
});

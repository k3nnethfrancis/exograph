const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.2;

export function previousPdfPage(page: number): number {
  return Math.max(1, page - 1);
}

export function nextPdfPage(page: number, totalPages: number): number {
  return Math.min(Math.max(1, totalPages), page + 1);
}

export function zoomPdf(scale: number, direction: "in" | "out"): number {
  const next = scale + (direction === "in" ? ZOOM_STEP : -ZOOM_STEP);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next.toFixed(2))));
}

export function fitWidthScale(availableWidth: number, pageWidth: number): number {
  if (availableWidth <= 0 || pageWidth <= 0) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, availableWidth / pageWidth));
}

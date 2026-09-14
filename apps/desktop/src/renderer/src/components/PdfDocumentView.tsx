import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { ChevronLeft, ChevronRight, Minus, Plus, ScanLine } from "lucide-react";

import { fitWidthScale, nextPdfPage, previousPdfPage, zoomPdf } from "../pdfDocumentModel";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfDocumentViewProps {
  filePath: string;
}

export function PdfDocumentView({ filePath }: PdfDocumentViewProps) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1);
  const [pageWidth, setPageWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const viewRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let loadedDocument: PDFDocumentProxy | null = null;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    setDocument(null);
    setPageNumber(1);
    setScale(1);
    setPageWidth(0);
    setError(null);
    setLoading(true);

    void window.exograph.workspace.readPdfFile(filePath)
      .then((data) => {
        if (cancelled) return null;
        loadingTask = getDocument({ data: new Uint8Array(data) });
        return loadingTask.promise;
      })
      .then((nextDocument) => {
        if (!nextDocument || cancelled) return;
        loadedDocument = nextDocument;
        setDocument(nextDocument);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "Unable to open this PDF.");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
      void loadedDocument?.cleanup();
    };
  }, [filePath]);

  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    let textLayer: TextLayer | null = null;
    const canvas = canvasRef.current;
    const textLayerElement = textLayerRef.current;
    if (!canvas || !textLayerElement) return;
    const pdfDocument = document;

    async function renderPage() {
      try {
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;
        const cssViewport = page.getViewport({ scale });
        const pixelRatio = window.devicePixelRatio || 1;
        const renderViewport = page.getViewport({ scale: scale * pixelRatio });
        const renderingCanvas = canvas!;
        const renderingTextLayer = textLayerElement!;
        const context = renderingCanvas.getContext("2d");
        if (!context) throw new Error("PDF canvas is unavailable.");

        renderingCanvas.width = Math.ceil(renderViewport.width);
        renderingCanvas.height = Math.ceil(renderViewport.height);
        renderingCanvas.style.width = `${Math.ceil(cssViewport.width)}px`;
        renderingCanvas.style.height = `${Math.ceil(cssViewport.height)}px`;
        renderingTextLayer.replaceChildren();
        renderingTextLayer.style.width = `${Math.ceil(cssViewport.width)}px`;
        renderingTextLayer.style.height = `${Math.ceil(cssViewport.height)}px`;
        setPageWidth(page.getViewport({ scale: 1 }).width);

        renderTask = page.render({ canvas: renderingCanvas, viewport: renderViewport });
        const textContent = await page.getTextContent();
        textLayer = new TextLayer({
          textContentSource: textContent,
          container: renderingTextLayer,
          viewport: cssViewport,
        });
        await Promise.all([renderTask.promise, textLayer.render()]);
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "Unable to render this PDF page.");
      }
    }

    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [document, pageNumber, scale]);

  function fitWidth() {
    const availableWidth = (surfaceRef.current?.clientWidth ?? 0) - 40;
    setScale(fitWidthScale(availableWidth, pageWidth));
  }

  function changePage(direction: "previous" | "next") {
    setPageNumber((page) => {
      const nextPage = direction === "previous"
        ? previousPdfPage(page)
        : nextPdfPage(page, document?.numPages ?? page);
      if (nextPage !== page && surfaceRef.current) surfaceRef.current.scrollTop = 0;
      return nextPage;
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    changePage(event.key === "ArrowLeft" ? "previous" : "next");
  }

  function focusReader(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, [contenteditable='true']")) return;
    viewRef.current?.focus({ preventScroll: true });
  }

  if (loading) {
    return <div className="pdf-document-view__state" data-testid="pdf-loading-state">Loading PDF…</div>;
  }
  if (error) {
    return <div className="pdf-document-view__state" data-testid="pdf-error-state" role="alert">{error}</div>;
  }
  if (!document) return null;

  return (
    <section
      aria-label="PDF reader"
      className="pdf-document-view"
      data-testid="pdf-document-view"
      onKeyDown={handleKeyDown}
      onMouseDown={focusReader}
      ref={viewRef}
      tabIndex={0}
    >
      <div className="pdf-document-view__toolbar" aria-label="PDF controls">
        <button aria-label="Previous page" className="browser-pane__button" disabled={pageNumber <= 1} onClick={() => changePage("previous")} title="Previous page" type="button"><ChevronLeft size={15} /></button>
        <span aria-label={`Page ${pageNumber} of ${document.numPages}`} aria-live="polite" className="pdf-document-view__page-count">{pageNumber} / {document.numPages}</span>
        <button aria-label="Next page" className="browser-pane__button" disabled={pageNumber >= document.numPages} onClick={() => changePage("next")} title="Next page" type="button"><ChevronRight size={15} /></button>
        <span className="pdf-document-view__toolbar-spacer" />
        <button aria-label="Zoom out" className="browser-pane__button" disabled={scale <= 0.2} onClick={() => setScale((current) => zoomPdf(current, "out"))} title="Zoom out" type="button"><Minus size={14} /></button>
        <span aria-label={`Zoom ${Math.round(scale * 100)} percent`} className="pdf-document-view__zoom">{Math.round(scale * 100)}%</span>
        <button aria-label="Zoom in" className="browser-pane__button" disabled={scale >= 4} onClick={() => setScale((current) => zoomPdf(current, "in"))} title="Zoom in" type="button"><Plus size={14} /></button>
        <button aria-label="Fit PDF to width" className="browser-pane__button" onClick={fitWidth} title="Fit width" type="button"><ScanLine size={14} /></button>
      </div>
      <div className="pdf-document-view__surface" ref={surfaceRef}>
        <div className="pdf-document-view__page">
          <canvas ref={canvasRef} />
          <div aria-label="Selectable PDF text" className="pdf-document-view__text-layer" ref={textLayerRef} />
        </div>
      </div>
    </section>
  );
}

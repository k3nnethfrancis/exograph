import type { GraphPresentationPlan } from "./graphPresentation";

const TAU = Math.PI * 2;
const MAXIMUM_DPR = 3;

export interface GraphCanvasContext {
  fillStyle: string;
  strokeStyle: string;
  font: string;
  globalAlpha: number;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  textBaseline: CanvasTextBaseline;
  imageSmoothingEnabled: boolean;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  quadraticCurveTo(controlX: number, controlY: number, x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
}

export interface GraphCanvasSurface {
  width: number;
  height: number;
  style?: { width: string; height: string };
  getContext(contextId: "2d", options?: CanvasRenderingContext2DSettings): GraphCanvasContext | null;
}

export interface GraphCanvasRendererOptions {
  reportError?: (error: GraphCanvasRendererError) => void;
  now?: () => number;
}

export interface GraphCanvasRenderMeasurement {
  cpuMilliseconds: number;
  drawCalls: number;
  nodes: number;
  edges: number;
  labels: number;
  width: number;
  height: number;
  dpr: number;
}

export class GraphCanvasRendererError extends Error {
  readonly renderer = "canvas2d";

  constructor(
    readonly code: "context-unavailable" | "invalid-plan" | "draw-failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GraphCanvasRendererError";
  }
}

/** Canvas2D adapter for an already-resolved presentation plan. */
export class GraphCanvasRenderer {
  private readonly context: GraphCanvasContext;
  private readonly now: () => number;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private destroyed = false;
  private readonly colorCache = new Map<number, string>();

  constructor(
    private readonly canvas: GraphCanvasSurface,
    private readonly options: GraphCanvasRendererOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    let context: GraphCanvasContext | null = null;
    try {
      context = canvas.getContext("2d", { alpha: true, desynchronized: true });
    } catch (cause) {
      const error = new GraphCanvasRendererError("context-unavailable", "Canvas2D initialization failed.", { cause });
      options.reportError?.(error);
      throw error;
    }
    if (!context) {
      const error = new GraphCanvasRendererError("context-unavailable", "Canvas2D is unavailable; the graph cannot be drawn.");
      options.reportError?.(error);
      throw error;
    }
    this.context = context;
  }

  resize(viewport: { width: number; height: number; dpr: number }): void {
    if (this.destroyed) return;
    const width = finiteDimension(viewport.width);
    const height = finiteDimension(viewport.height);
    const dpr = clamp(Number.isFinite(viewport.dpr) ? viewport.dpr : 1, 1, MAXIMUM_DPR);
    const physicalWidth = Math.max(1, Math.round(width * dpr));
    const physicalHeight = Math.max(1, Math.round(height * dpr));
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    if (this.canvas.width !== physicalWidth) this.canvas.width = physicalWidth;
    if (this.canvas.height !== physicalHeight) this.canvas.height = physicalHeight;
    // The host owns CSS geometry; renderers only size the backing store.
  }

  render(plan: GraphPresentationPlan): GraphCanvasRenderMeasurement {
    return this.renderLayers(plan, true);
  }

  /** Draw only the scene-owned labels on a transparent overlay canvas. */
  renderLabels(plan: GraphPresentationPlan): GraphCanvasRenderMeasurement {
    return this.renderLayers(plan, false);
  }

  clear(): void {
    if (this.destroyed) return;
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.context.clearRect(0, 0, this.width, this.height);
  }

  private renderLayers(plan: GraphPresentationPlan, includeTopology: boolean): GraphCanvasRenderMeasurement {
    const started = this.now();
    try {
      validatePlan(plan);
      if (this.destroyed) throw new GraphCanvasRendererError("draw-failed", "Canvas2D renderer has been destroyed.");
      if (plan.viewport.width !== this.width || plan.viewport.height !== this.height) {
        this.resize({ ...plan.viewport, dpr: this.dpr });
      }
      const context = this.context;
      context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      context.imageSmoothingEnabled = true;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.clearRect(0, 0, this.width, this.height);
      let drawCalls = 0;
      if (includeTopology && plan.clearColor !== null) {
        context.globalAlpha = 1;
        context.fillStyle = this.color(plan.clearColor);
        context.fillRect(0, 0, this.width, this.height);
        drawCalls += 1;
      }
      if (includeTopology) {
        drawCalls += this.drawEdges(plan);
        drawCalls += this.drawNodeFills(plan);
        drawCalls += this.drawNodeStrokes(plan);
      }
      drawCalls += this.drawLabels(plan);
      context.globalAlpha = 1;
      return {
        cpuMilliseconds: Math.max(0, this.now() - started),
        drawCalls,
        nodes: includeTopology ? plan.nodes.indices.length : 0,
        edges: includeTopology ? plan.edges.indices.length : 0,
        labels: plan.labels.placements.length,
        width: this.width,
        height: this.height,
        dpr: this.dpr,
      };
    } catch (cause) {
      const error = cause instanceof GraphCanvasRendererError
        ? cause
        : new GraphCanvasRendererError("draw-failed", "Canvas2D graph drawing failed.", { cause });
      this.options.reportError?.(error);
      throw error;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.colorCache.clear();
  }

  private drawEdges(plan: GraphPresentationPlan): number {
    const { edges } = plan;
    let drawCalls = 0;
    let start = 0;
    while (start < edges.indices.length) {
      const color = edges.strokeColors[start] ?? 0;
      const opacity = edges.opacities[start] ?? 0;
      const width = edges.widths[start] ?? 0;
      let end = start + 1;
      while (end < edges.indices.length
        && edges.strokeColors[end] === color
        && edges.opacities[end] === opacity
        && edges.widths[end] === width) end += 1;
      const context = this.context;
      context.beginPath();
      for (let cursor = start; cursor < end; cursor += 1) {
        const offset = cursor * 6;
        context.moveTo(edges.curves[offset] ?? 0, edges.curves[offset + 1] ?? 0);
        context.quadraticCurveTo(
          edges.curves[offset + 2] ?? 0,
          edges.curves[offset + 3] ?? 0,
          edges.curves[offset + 4] ?? 0,
          edges.curves[offset + 5] ?? 0,
        );
      }
      context.globalAlpha = opacity;
      context.strokeStyle = this.color(color);
      context.lineWidth = width;
      context.stroke();
      drawCalls += 1;
      start = end;
    }
    return drawCalls;
  }

  private drawNodeFills(plan: GraphPresentationPlan): number {
    const { nodes } = plan;
    let drawCalls = 0;
    let start = 0;
    while (start < nodes.indices.length) {
      const color = nodes.fillColors[start] ?? 0;
      const opacity = nodes.opacities[start] ?? 0;
      let end = start + 1;
      while (end < nodes.indices.length
        && nodes.fillColors[end] === color
        && nodes.opacities[end] === opacity) end += 1;
      const context = this.context;
      context.beginPath();
      for (let cursor = start; cursor < end; cursor += 1) {
        const x = nodes.centers[cursor * 2] ?? 0;
        const y = nodes.centers[cursor * 2 + 1] ?? 0;
        const radius = nodes.radii[cursor] ?? 0;
        context.moveTo(x + radius, y);
        context.arc(x, y, radius, 0, TAU);
      }
      context.globalAlpha = opacity;
      context.fillStyle = this.color(color);
      context.fill();
      drawCalls += 1;
      start = end;
    }
    return drawCalls;
  }

  private drawNodeStrokes(plan: GraphPresentationPlan): number {
    const { nodes } = plan;
    let drawCalls = 0;
    let cursor = 0;
    while (cursor < nodes.indices.length) {
      while (cursor < nodes.indices.length && (nodes.strokeWidths[cursor] ?? 0) <= 0) cursor += 1;
      if (cursor >= nodes.indices.length) break;
      const color = nodes.strokeColors[cursor] ?? 0;
      const width = nodes.strokeWidths[cursor] ?? 0;
      const opacity = nodes.strokeOpacities[cursor] ?? 0;
      let end = cursor + 1;
      while (end < nodes.indices.length
        && nodes.strokeWidths[end] === width
        && nodes.strokeColors[end] === color
        && nodes.strokeOpacities[end] === opacity) end += 1;
      const context = this.context;
      context.beginPath();
      for (let index = cursor; index < end; index += 1) {
        const x = nodes.centers[index * 2] ?? 0;
        const y = nodes.centers[index * 2 + 1] ?? 0;
        const radius = nodes.radii[index] ?? 0;
        context.moveTo(x + radius, y);
        context.arc(x, y, radius, 0, TAU);
      }
      context.globalAlpha = opacity;
      context.strokeStyle = this.color(color);
      context.lineWidth = width;
      context.stroke();
      drawCalls += 1;
      cursor = end;
    }
    return drawCalls;
  }

  private drawLabels(plan: GraphPresentationPlan): number {
    const context = this.context;
    context.textBaseline = "alphabetic";
    context.globalAlpha = plan.labelStyle.opacity;
    for (const placement of plan.labels.placements) {
      context.font = placement.required ? plan.labelStyle.requiredFont : plan.labelStyle.font;
      context.fillStyle = this.color(placement.required ? plan.labelStyle.requiredColor : plan.labelStyle.color);
      context.fillText(placement.text, placement.x, placement.y, Math.max(1, placement.box.right - placement.box.left));
    }
    return plan.labels.placements.length;
  }

  private color(value: number): string {
    const cached = this.colorCache.get(value);
    if (cached) return cached;
    const color = `rgba(${value >>> 24}, ${(value >>> 16) & 0xff}, ${(value >>> 8) & 0xff}, ${(value & 0xff) / 255})`;
    this.colorCache.set(value, color);
    return color;
  }
}

function validatePlan(plan: GraphPresentationPlan): void {
  const nodeCount = plan.nodes.indices.length;
  const edgeCount = plan.edges.indices.length;
  const nodeLengths = [
    plan.nodes.centers.length === nodeCount * 2,
    plan.nodes.depths.length === nodeCount,
    plan.nodes.visualClasses.length === nodeCount,
    plan.nodes.radii.length === nodeCount,
    plan.nodes.opacities.length === nodeCount,
    plan.nodes.fillColors.length === nodeCount,
    plan.nodes.strokeColors.length === nodeCount,
    plan.nodes.strokeWidths.length === nodeCount,
    plan.nodes.strokeOpacities.length === nodeCount,
    plan.nodes.emphasis.length === nodeCount,
  ];
  const edgeLengths = [
    plan.edges.curves.length === edgeCount * 6,
    plan.edges.depths.length === edgeCount,
    plan.edges.visualClasses.length === edgeCount,
    plan.edges.widths.length === edgeCount,
    plan.edges.opacities.length === edgeCount,
    plan.edges.strokeColors.length === edgeCount,
    plan.edges.emphasis.length === edgeCount,
  ];
  if (!nodeLengths.every(Boolean) || !edgeLengths.every(Boolean)) {
    throw new GraphCanvasRendererError("invalid-plan", "Canvas2D received a presentation plan with mismatched parallel arrays.");
  }
  if (!Number.isFinite(plan.viewport.width) || !Number.isFinite(plan.viewport.height)
    || plan.viewport.width <= 0 || plan.viewport.height <= 0) {
    throw new GraphCanvasRendererError("invalid-plan", "Canvas2D received a presentation plan with an invalid viewport.");
  }
}

function finiteDimension(value: number): number {
  return Math.max(1, Math.round(Number.isFinite(value) ? value : 1));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

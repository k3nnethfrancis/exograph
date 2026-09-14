import { describe, expect, it, vi } from "vitest";

import { GraphCanvasRenderer, GraphCanvasRendererError, type GraphCanvasContext, type GraphCanvasSurface } from "./graphCanvasRenderer";
import type { GraphPresentationPlan } from "./graphPresentation";

describe("Canvas graph renderer", () => {
  it("fails visibly when Canvas2D cannot initialize", () => {
    const reportError = vi.fn();
    const canvas = surface(null);
    expect(() => new GraphCanvasRenderer(canvas, { reportError })).toThrow(GraphCanvasRendererError);
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ code: "context-unavailable" }));
  });

  it("owns DPR sizing and draws only the resolved pixels in the plan", () => {
    const context = new MockContext();
    const canvas = surface(context);
    const renderer = new GraphCanvasRenderer(canvas, { now: sequenceClock([2, 5]) });
    renderer.resize({ width: 320, height: 180, dpr: 2.5 });
    const measurement = renderer.render(plan());

    expect(canvas).toMatchObject({ width: 800, height: 450, style: { width: "", height: "" } });
    expect(context.calls[0]).toEqual(["setTransform", 2.5, 0, 0, 2.5, 0, 0]);
    expect(context.count("quadraticCurveTo")).toBe(1);
    expect(context.count("arc")).toBe(3);
    expect(context.count("fillText")).toBe(1);
    expect(measurement).toMatchObject({ cpuMilliseconds: 3, nodes: 2, edges: 1, labels: 1, width: 320, height: 180, dpr: 2.5 });
    expect(measurement.drawCalls).toBeLessThanOrEqual(8);
  });

  it("caps DPR, reports malformed plans, and never fails as a silent blank", () => {
    const context = new MockContext();
    const canvas = surface(context);
    const reportError = vi.fn();
    const renderer = new GraphCanvasRenderer(canvas, { reportError });
    renderer.resize({ width: 100, height: 80, dpr: 9 });
    expect(canvas).toMatchObject({ width: 300, height: 240 });
    const malformed = plan();
    malformed.nodes.centers = new Float32Array(1);
    expect(() => renderer.render(malformed)).toThrow("mismatched parallel arrays");
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid-plan" }));
  });

  it("clears transparently when the presentation plan does not own the surface color", () => {
    const context = new MockContext();
    const renderer = new GraphCanvasRenderer(surface(context));
    const transparent = plan();
    transparent.clearColor = null;

    renderer.render(transparent);

    expect(context.count("clearRect")).toBe(1);
    expect(context.count("fillRect")).toBe(0);
  });

  it("draws the identical resolved label plan on a transparent WebGPU overlay", () => {
    const fullContext = new MockContext();
    const overlayContext = new MockContext();
    const graphPlan = plan();

    new GraphCanvasRenderer(surface(fullContext)).render(graphPlan);
    const measurement = new GraphCanvasRenderer(surface(overlayContext)).renderLabels(graphPlan);

    expect(overlayContext.calls.filter(([name]) => name === "fillText"))
      .toEqual(fullContext.calls.filter(([name]) => name === "fillText"));
    expect(overlayContext.count("arc")).toBe(0);
    expect(overlayContext.count("quadraticCurveTo")).toBe(0);
    expect(overlayContext.count("fillRect")).toBe(0);
    expect(measurement).toMatchObject({ nodes: 0, edges: 0, labels: 1 });
  });
});

class MockContext implements GraphCanvasContext {
  fillStyle = "";
  strokeStyle = "";
  font = "";
  globalAlpha = 1;
  lineWidth = 1;
  lineCap: CanvasLineCap = "butt";
  lineJoin: CanvasLineJoin = "miter";
  textBaseline: CanvasTextBaseline = "alphabetic";
  imageSmoothingEnabled = false;
  calls: unknown[][] = [];
  setTransform(...args: number[]) { this.calls.push(["setTransform", ...args]); }
  clearRect(...args: number[]) { this.calls.push(["clearRect", ...args]); }
  fillRect(...args: number[]) { this.calls.push(["fillRect", ...args]); }
  beginPath() { this.calls.push(["beginPath"]); }
  moveTo(...args: number[]) { this.calls.push(["moveTo", ...args]); }
  quadraticCurveTo(...args: number[]) { this.calls.push(["quadraticCurveTo", ...args]); }
  arc(...args: number[]) { this.calls.push(["arc", ...args]); }
  fill() { this.calls.push(["fill"]); }
  stroke() { this.calls.push(["stroke"]); }
  fillText(text: string, x: number, y: number, maxWidth?: number) { this.calls.push(["fillText", text, x, y, maxWidth]); }
  count(name: string) { return this.calls.filter((call) => call[0] === name).length; }
}

function surface(context: GraphCanvasContext | null): GraphCanvasSurface {
  return { width: 1, height: 1, style: { width: "", height: "" }, getContext: () => context };
}

function sequenceClock(values: number[]) {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

function plan(): GraphPresentationPlan {
  return {
    version: "0.1",
    topologyHash: "topology",
    layoutEpochId: "layout",
    viewport: { width: 320, height: 180 },
    profile: "exploration",
    clearColor: 0xf4f4eeff,
    nodes: {
      indices: new Uint32Array([0, 1]),
      centers: new Float32Array([80, 80, 240, 90]),
      depths: new Float32Array([0.8, 0.2]),
      visualClasses: new Uint8Array([0, 1]),
      radii: new Float32Array([4, 6]),
      opacities: new Float32Array([0.8, 1]),
      fillColors: new Uint32Array([0x3f7d72ff, 0xbf6840ff]),
      strokeColors: new Uint32Array([0, 0x3f7d72ff]),
      strokeWidths: new Float32Array([0, 1.5]),
      strokeOpacities: new Float32Array([0, 1]),
      emphasis: new Uint8Array([0, 1]),
    },
    edges: {
      indices: new Uint32Array([0]),
      curves: new Float32Array([80, 80, 160, 70, 240, 90]),
      depths: new Float32Array([0.5]),
      visualClasses: new Uint8Array([0]),
      widths: new Float32Array([0.75]),
      opacities: new Float32Array([0.14]),
      strokeColors: new Uint32Array([0x2d3432ff]),
      emphasis: new Uint8Array([0]),
    },
    labels: {
      placements: [{ index: 1, text: "Node", x: 250, y: 90, depth: 0.2, required: true, box: { left: 248, top: 76, right: 290, bottom: 94 } }],
      omittedRequired: [],
    },
    labelStyle: { font: "11px monospace", requiredFont: "600 11px monospace", color: 0x2d3432ff, requiredColor: 0x3f7d72ff, opacity: 0.9 },
  };
}

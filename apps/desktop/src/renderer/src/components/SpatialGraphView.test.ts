import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GraphTopology } from "@exograph/core";

import type { GraphCanvasContext, GraphCanvasSurface } from "../graphCanvasRenderer";
import { cssColorToRgba } from "../graphPalette";
import type { GraphPresentationPlan } from "../graphPresentation";
import type { GraphPixelRenderer, GraphPixelRendererMeasurement } from "../graphRendererHost";
import type { GraphFrameDriver } from "../graphRenderScheduler";
import type { GraphGpuRuntime, GraphWebGpuSurface } from "../graphWebGpuRenderer";
import { cameraBasis, DEFAULT_SCENE_CAMERA, projectGraphScene, pickGraphSceneNode } from "../graphSceneFoundation";
import { GraphBuildingIndicator } from "./SpatialGraphView";
import {
  GraphSnapshotRefreshCoordinator,
  SpatialGraphPointerSession,
  SpatialGraphRuntime,
  initialGraphSummaryIndexes,
  pruneGraphSnapshotCache,
  shouldRefreshGraphForWorkspaceChange,
  shouldRevealGraphScene,
  spatialGraphDollyDragScale,
  spatialGraphOrbitDelta,
  spatialGraphPointerAction,
  spatialGraphWheelIntent,
} from "../spatialGraphRuntime";

class FakeFrameDriver implements GraphFrameDriver {
  private nextHandle = 1;
  readonly callbacks = new Map<number, (time: number) => void>();
  request(callback: (time: number) => void): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }
  cancel(handle: number): void { this.callbacks.delete(handle); }
  flush(time = 16): void {
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of pending) callback(time);
  }
  settle(): void {
    let time = 0;
    while (this.callbacks.size) {
      time += 16;
      this.flush(time);
      if (time > 2_000) throw new Error("runtime did not settle");
    }
  }
}

class FakeRefreshTimer {
  private nextHandle = 1;
  readonly callbacks = new Map<number, () => void>();
  schedule(callback: () => void): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }
  cancel(handle: number): void { this.callbacks.delete(handle); }
  flushOne(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!entry) return;
    this.callbacks.delete(entry[0]);
    entry[1]();
  }
}

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
  arcs = 0;
  arcsAtLastClear = 0;
  labels = 0;
  setTransform() {}
  clearRect() { this.arcsAtLastClear = this.arcs; }
  fillRect() {}
  beginPath() {}
  moveTo() {}
  quadraticCurveTo() {}
  arc() { this.arcs += 1; }
  fill() {}
  stroke() {}
  fillText() { this.labels += 1; }
}

class MockPixelRenderer implements GraphPixelRenderer {
  plans: GraphPresentationPlan[] = [];
  viewports: Array<{ width: number; height: number; dpr: number }> = [];
  destroyCalls = 0;
  failure: ((error: Error) => void) | null = null;
  renderError: Error | null = null;

  resize(viewport: { width: number; height: number; dpr: number }): void { this.viewports.push({ ...viewport }); }
  render(plan: GraphPresentationPlan): GraphPixelRendererMeasurement {
    if (this.renderError) {
      const error = this.renderError;
      this.renderError = null;
      throw error;
    }
    this.plans.push(plan);
    return {
      cpuMilliseconds: 0,
      drawCalls: 2,
      nodes: plan.nodes.indices.length,
      edges: plan.edges.indices.length,
      width: plan.viewport.width,
      height: plan.viewport.height,
      dpr: 1,
    };
  }
  destroy(): void { this.destroyCalls += 1; }
}

function surface(context: GraphCanvasContext = new MockContext()): GraphCanvasSurface {
  return { width: 1, height: 1, style: { width: "", height: "" }, getContext: () => context };
}

function topology(nodeCount = 4, sourceSnapshotId = "snapshot-1"): GraphTopology {
  const identityKeys = new Uint32Array(nodeCount * 2);
  const seeds = new Uint32Array(nodeCount);
  const groups = new Uint32Array(nodeCount);
  const degrees = new Uint32Array(nodeCount);
  const endpoints = new Uint32Array(Math.max(0, nodeCount - 1) * 2);
  for (let index = 0; index < nodeCount; index += 1) {
    identityKeys[index * 2] = index + 1;
    identityKeys[index * 2 + 1] = 11;
    seeds[index] = index * 17 + 3;
    groups[index] = index % 3;
    degrees[index] = index * 5;
    if (index > 0) {
      endpoints[(index - 1) * 2] = index - 1;
      endpoints[(index - 1) * 2 + 1] = index;
    }
  }
  return {
    version: "0.1",
    layoutVersion: "finite-force-0.1",
    sourceSnapshotId,
    formatHash: "profile",
    topologyHash: `topology-${nodeCount}`,
    transportHash: `transport-${sourceSnapshotId}`,
    layoutEpochId: `layout-${nodeCount}`,
    seed: 17,
    nodeCount,
    edgeCount: Math.max(0, nodeCount - 1),
    nodes: { identityKeys, seeds, groups, degrees, visualClasses: new Uint8Array(nodeCount) },
    edges: { endpoints, visualClasses: new Uint8Array(Math.max(0, nodeCount - 1)) },
    omitted: { tagConcepts: 0, tagRelations: 0 },
    payloadBytes: identityKeys.byteLength + seeds.byteLength + groups.byteLength + degrees.byteLength + endpoints.byteLength,
  };
}

function palette() {
  return {
    clearColor: null,
    text: 0x202522ff,
    muted: 0x8f9792ff,
    accent: 0x3f7d72ff,
    path: 0xbf6840ff,
    unresolved: 0xbf6840ff,
    external: 0x78699cff,
    nodeColors: new Uint32Array([0x3f7d72ff, 0xbf6840ff, 0x78699cff]),
  };
}

function fakeGpuRuntime(): GraphGpuRuntime {
  return {
    gpu: { requestAdapter: async () => null, getPreferredCanvasFormat: () => "rgba8unorm" },
    bufferUsage: { copyDestination: 1, uniform: 2, storage: 4 },
    shaderStage: { vertex: 1, fragment: 2 },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}

describe("SpatialGraph runtime", () => {
  it("presents graph construction as a concise accessible status", () => {
    const markup = renderToStaticMarkup(createElement(GraphBuildingIndicator));
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Building graph");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup.match(/class="exograph-mark__arm"/g)).toHaveLength(6);
    expect(markup.match(/class="exograph-mark__node"/g)).toHaveLength(6);
    expect(markup).toContain("exograph-mark--animated");
    expect(styles).toContain("animation-iteration-count: infinite");
    expect(styles).toContain("@keyframes exograph-mark-build-arm");
    expect(styles).toContain("@keyframes exograph-mark-build-reduced");
  });

  it("keeps the product component on the typed topology API", () => {
    const source = readFileSync(new URL("./SpatialGraphView.tsx", import.meta.url), "utf8");
    expect(source).toContain("getGraphTopology");
    expect(source).toContain("getGraphConceptSummaries");
    expect(source).toContain("graphConceptLookup");
    expect(source).toContain("getGraphConceptDetailByIndex");
  });

  it("updates overflow labels without resetting camera or graph selection", () => {
    const frames = new FakeFrameDriver();
    const context = new MockContext();
    const runtime = new SpatialGraphRuntime(surface(context), { frameDriver: frames, palette: palette() });
    const graph = topology(30);
    runtime.setTopology(graph, { width: 800, height: 600 });
    runtime.applyLayoutFrame({ topologyHash: graph.topologyHash, layoutEpochId: graph.layoutEpochId, sequence: 1, settled: true, positions: new Float32Array(90) });
    runtime.setSummaries(Array.from({ length: 30 }, (_, index) => ({ index, label: `Synthetic Note ${index}`, filePath: `/notes/${index}.md` })));
    runtime.setSelection(0);
    const scene = runtime.getScene()!;
    frames.settle();
    context.labels = 0;
    runtime.setShowOverflowLabels(false);
    frames.settle();
    const anchoredCount = context.labels;
    expect(anchoredCount).toBeGreaterThan(0);
    const camera = structuredClone(scene.camera);
    context.labels = 0;
    runtime.setShowOverflowLabels(true);
    frames.settle();
    expect(context.labels).toBeGreaterThan(anchoredCount);
    expect(scene.camera).toEqual(camera);
    expect(scene.interaction.selected).toBe(0);
    runtime.setShowOverflowLabels(true);
    expect(frames.callbacks.size).toBe(0);
    runtime.dispose();
  });

  it("draws a deterministic scene immediately, rejects late layout, and becomes quiescent", () => {
    const frames = new FakeFrameDriver();
    const runtime = new SpatialGraphRuntime(surface(), { frameDriver: frames, palette: palette() });
    const graph = topology();
    const scene = runtime.setTopology(graph, { width: 800, height: 600 });
    expect(scene.layout.positions).toHaveLength(12);
    frames.settle();
    expect(runtime.snapshot()).toMatchObject({ renderedFrames: 1, pendingFrame: false, moving: false, pendingWork: 0 });

    runtime.rejectLayoutMessage();
    expect(runtime.applyLayoutFrame({
      topologyHash: "old",
      layoutEpochId: graph.layoutEpochId,
      sequence: 1,
      positions: new Float32Array(scene.layout.positions),
      settled: true,
    })).toBe(false);
    expect(runtime.snapshot()).toMatchObject({ layoutMessages: 2, rejectedLayoutMessages: 2, pendingFrame: false });
    runtime.dispose();
    expect(frames.callbacks.size).toBe(0);
  });

  it("preserves scene state across cold snapshot refreshes and repeats same-node focus", () => {
    const frames = new FakeFrameDriver();
    const runtime = new SpatialGraphRuntime(surface(), { frameDriver: frames, palette: palette() });
    const first = topology(4, "snapshot-1");
    runtime.setTopology(first, { width: 800, height: 600 });
    runtime.setSelection(2);
    runtime.pan(20, -10);
    frames.settle();
    const camera = runtime.getScene()!.camera;
    const layout = runtime.getScene()!.layout;

    const coldRefresh = { ...topology(4, "snapshot-2"), topologyHash: first.topologyHash, layoutEpochId: first.layoutEpochId };
    runtime.setTopology(coldRefresh, { width: 800, height: 600 });
    expect(runtime.getScene()!.camera).toEqual(camera);
    expect(runtime.getScene()!.layout).toBe(layout);
    expect(runtime.getScene()!.interaction.selected).toBe(2);

    runtime.focus(2, false);
    frames.settle();
    const afterFirst = runtime.snapshot().renderedFrames;
    runtime.focus(2, false);
    frames.settle();
    expect(runtime.snapshot().renderedFrames).toBeGreaterThan(afterFirst);
    expect(runtime.snapshot()).toMatchObject({ pendingFrame: false, moving: false, pendingWork: 0 });
  });

  it("surfaces Canvas draw failures and stops scheduling", () => {
    const context = new MockContext();
    context.fill = () => { throw new Error("draw exploded"); };
    const onDrawError = vi.fn();
    const frames = new FakeFrameDriver();
    const runtime = new SpatialGraphRuntime(surface(context), { frameDriver: frames, palette: palette(), onDrawError });
    runtime.setTopology(topology(), { width: 800, height: 600 });
    frames.flush();
    expect(onDrawError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("drawing failed") }));
    expect(runtime.snapshot()).toMatchObject({ pendingFrame: false, moving: false });
  });

  it("draws Canvas during asynchronous WebGPU boot, then keeps one scene through GPU and fallback", async () => {
    const frames = new FakeFrameDriver();
    const context = new MockContext();
    const gpu = new MockPixelRenderer();
    const replacementGpu = new MockPixelRenderer();
    let gpuCreates = 0;
    let resolveGpu!: (renderer: MockPixelRenderer) => void;
    const gpuReady = new Promise<MockPixelRenderer>((resolve) => { resolveGpu = resolve; });
    const transitions: Array<{ kind: string; reason: string; state: object | null }> = [];
    const runtime = new SpatialGraphRuntime(surface(context), {
      frameDriver: frames,
      palette: palette(),
      webGpuSurface: {} as GraphWebGpuSurface,
      webGpuRuntime: fakeGpuRuntime(),
      createWebGpu: async (_surface, _runtime, reportFailure) => {
        gpuCreates += 1;
        const renderer = gpuCreates === 1 ? await gpuReady : replacementGpu;
        renderer.failure = reportFailure;
        return renderer;
      },
      onRendererTransition: (transition) => transitions.push({
        kind: transition.kind,
        reason: transition.reason,
        state: transition.frame?.state ?? null,
      }),
    });
    runtime.setTopology(topology(), { width: 800, height: 600 });
    runtime.setSummaries([{ index: 0, label: "Node", filePath: "/notes/node.md" }]);
    frames.settle();
    const scene = runtime.getScene()!;
    const bootstrapArcs = context.arcs;
    expect(bootstrapArcs).toBeGreaterThan(0);
    expect(runtime.snapshot()).toMatchObject({ rendererKind: null, rendererRecoveryState: "booting" });

    resolveGpu(gpu);
    await waitFor(() => runtime.snapshot().rendererKind === "webgpu");
    expect(gpu.plans).toHaveLength(1);
    expect(context.arcs).toBe(bootstrapArcs);
    frames.settle();
    expect(gpu.plans).toHaveLength(2);
    expect(context.labels).toBeGreaterThan(0);
    expect(transitions[0]).toMatchObject({ kind: "webgpu", reason: "boot", state: scene });
    expect(runtime.getScene()).toBe(scene);

    runtime.focus(2, true);
    const distanceBeforeGpuZoom = runtime.getScene()!.camera.distance;
    runtime.zoomAt(610, 190, 1.35);
    expect(runtime.getScene()!.camera.distance).toBeLessThan(distanceBeforeGpuZoom);
    const pointBeforeGpuPan = runtime.getScene()!.projection.nodes.slice(2 * 4, 2 * 4 + 2);
    runtime.pan(24, 18);
    const pointAfterGpuPan = runtime.getScene()!.projection.nodes.slice(2 * 4, 2 * 4 + 2);
    expect(pointAfterGpuPan[0]).toBeCloseTo((pointBeforeGpuPan[0] ?? 0) + 24, 4);
    expect(pointAfterGpuPan[1]).toBeCloseTo((pointBeforeGpuPan[1] ?? 0) + 18, 4);
    runtime.setSelection(2);
    frames.settle();
    const interactedScene = runtime.getScene()!;
    const interactedCamera = {
      ...interactedScene.camera,
      target: [...interactedScene.camera.target],
    };
    const pickedBeforeFallback = pickGraphSceneNode(
      interactedScene.topology,
      interactedScene.projection,
      interactedScene.camera,
      interactedScene.projection.nodes[2 * 4] ?? 0,
      interactedScene.projection.nodes[2 * 4 + 1] ?? 0,
    );
    expect(pickedBeforeFallback).toBe(2);
    expect(interactedScene.interaction.selected).toBe(2);

    const overlayOnlyArcs = context.arcs;
    gpu.failure?.(new Error("device lost"));
    expect(context.arcs).toBeGreaterThan(overlayOnlyArcs);
    expect(runtime.getScene()).toBe(scene);
    await waitFor(() => runtime.snapshot().rendererTransitionReason === "recreated");
    frames.settle();
    expect(replacementGpu.plans.length).toBeGreaterThan(0);
    expect(runtime.snapshot()).toMatchObject({
      rendererKind: "webgpu",
      rendererRecoveryState: "ready",
      rendererFailures: 1,
      rendererRecreationAttempts: 1,
    });
    expect(runtime.getScene()).toBe(scene);

    runtime.setPalette(palette());
    frames.settle();
    expect(runtime.snapshot().compilerNumericReuseHits).toBeGreaterThan(0);
    await runtime.forceCanvasFallbackForTesting();
    expect(runtime.snapshot()).toMatchObject({
      rendererKind: "canvas2d",
      rendererTransitionReason: "recovery-fallback",
      rendererRecoveryState: "fallback",
      rendererFallbacks: 1,
    });
    expect(runtime.getScene()).toBe(scene);
    expect(runtime.getScene()!.camera).toEqual(interactedCamera);
    expect(runtime.getScene()!.interaction.selected).toBe(2);

    const distanceBeforeCanvasZoom = runtime.getScene()!.camera.distance;
    runtime.zoomAt(400, 300, 1.2);
    expect(runtime.getScene()!.camera.distance).toBeLessThan(distanceBeforeCanvasZoom);
    const pointBeforeCanvasPan = runtime.getScene()!.projection.nodes.slice(2 * 4, 2 * 4 + 2);
    runtime.pan(17, 13);
    const pointAfterCanvasPan = runtime.getScene()!.projection.nodes.slice(2 * 4, 2 * 4 + 2);
    expect(pointAfterCanvasPan[0]).toBeCloseTo((pointBeforeCanvasPan[0] ?? 0) + 17, 4);
    expect(pointAfterCanvasPan[1]).toBeCloseTo((pointBeforeCanvasPan[1] ?? 0) + 13, 4);
    frames.settle();
    expect(context.arcs).toBeGreaterThan(bootstrapArcs);
    expect(pickGraphSceneNode(
      runtime.getScene()!.topology,
      runtime.getScene()!.projection,
      runtime.getScene()!.camera,
      runtime.getScene()!.projection.nodes[2 * 4] ?? 0,
      runtime.getScene()!.projection.nodes[2 * 4 + 1] ?? 0,
    )).toBe(2);
    expect(runtime.snapshot()).toMatchObject({ pendingFrame: false, moving: false });
    runtime.dispose();
    expect(gpu.destroyCalls).toBe(1);
    expect(replacementGpu.destroyCalls).toBe(1);
  });

  it("keeps a complete Canvas frame visible while a synchronous GPU draw failure recovers", async () => {
    const frames = new FakeFrameDriver();
    const context = new MockContext();
    const gpu = new MockPixelRenderer();
    let resolveReplacement!: (renderer: MockPixelRenderer) => void;
    const replacement = new Promise<MockPixelRenderer>((resolve) => { resolveReplacement = resolve; });
    let gpuCreates = 0;
    const runtime = new SpatialGraphRuntime(surface(context), {
      frameDriver: frames,
      palette: palette(),
      webGpuSurface: {} as GraphWebGpuSurface,
      webGpuRuntime: fakeGpuRuntime(),
      createWebGpu: async (_surface, _runtime, reportFailure) => {
        gpuCreates += 1;
        const renderer = gpuCreates === 1 ? gpu : await replacement;
        renderer.failure = reportFailure;
        return renderer;
      },
    });
    runtime.setTopology(topology(), { width: 800, height: 600 });
    frames.settle();
    await waitFor(() => runtime.snapshot().rendererKind === "webgpu");
    frames.settle();

    gpu.renderError = new Error("draw failed");
    runtime.setPalette(palette());
    frames.settle();
    expect(runtime.snapshot().rendererRecoveryState).toBe("recreating");
    expect(context.arcs).toBeGreaterThan(context.arcsAtLastClear);

    resolveReplacement(new MockPixelRenderer());
    await waitFor(() => runtime.snapshot().rendererRecoveryState === "ready");
    runtime.dispose();
  });
});

describe("SpatialGraph pointer session", () => {
  it("maps one pointer to orbit, resets on pointercancel, and ignores its late move", () => {
    const session = new SpatialGraphPointerSession();
    session.begin({ pointerId: 1, x: 10, y: 10, pointerType: "mouse" }, "orbit");
    expect(session.move({ pointerId: 1, x: 20, y: 14, pointerType: "mouse" })).toEqual({ kind: "orbit", deltaX: 10, deltaY: 4 });
    session.cancel(1);
    expect(session.activePointers).toBe(0);
    expect(session.move({ pointerId: 1, x: 30, y: 30, pointerType: "mouse" })).toMatchObject({ kind: "hover" });
  });

  it("maps two pointers to simultaneous pinch and midpoint pan without a click", () => {
    const session = new SpatialGraphPointerSession();
    session.begin({ pointerId: 1, x: 100, y: 100, pointerType: "touch" }, "orbit");
    session.begin({ pointerId: 2, x: 200, y: 100, pointerType: "touch" }, "orbit");
    expect(session.move({ pointerId: 2, x: 230, y: 120, pointerType: "touch" })).toMatchObject({
      kind: "pinch-pan",
      centerX: 165,
      centerY: 110,
      scale: expect.any(Number),
      panX: 15,
      panY: 10,
    });
    expect(session.end(2).click).toBe(false);
    expect(session.end(1).click).toBe(false);
  });

  it("uses conventional orbit, pan, and dolly mouse bindings", () => {
    const input = { pointerType: "mouse", ctrlKey: false, metaKey: false, shiftKey: false };
    expect(spatialGraphPointerAction({ ...input, button: 0 })).toBe("orbit");
    expect(spatialGraphPointerAction({ ...input, button: 1 })).toBe("dolly");
    expect(spatialGraphPointerAction({ ...input, button: 2 })).toBe("pan");
    expect(spatialGraphPointerAction({ ...input, button: 0, metaKey: true })).toBe("pan");
    expect(spatialGraphPointerAction({ ...input, button: 0, ctrlKey: true })).toBe("pan");
    expect(spatialGraphPointerAction({ ...input, button: 0, shiftKey: true })).toBe("pan");
    expect(spatialGraphPointerAction({ ...input, button: 2, shiftKey: true })).toBe("orbit");
    expect(spatialGraphPointerAction({ ...input, pointerType: "touch", button: 0 })).toBe("orbit");
  });

  it("applies the saved inverse-navigation preference only to orbit deltas", () => {
    expect(spatialGraphOrbitDelta(12, -8, true)).toEqual({ x: 12, y: -8 });
    expect(spatialGraphOrbitDelta(12, -8, false)).toEqual({ x: -12, y: 8 });
  });

  it("maps middle-button vertical drag to pointer-anchored dolly", () => {
    const session = new SpatialGraphPointerSession();
    session.begin({ pointerId: 1, x: 100, y: 100, pointerType: "mouse" }, "dolly");
    expect(session.move({ pointerId: 1, x: 105, y: 80, pointerType: "mouse" })).toEqual({
      kind: "dolly",
      x: 105,
      y: 80,
      deltaY: -20,
    });
    expect(spatialGraphDollyDragScale(-20)).toBeGreaterThan(1);
    expect(spatialGraphDollyDragScale(20)).toBeLessThan(1);
  });
});

describe("bounded graph labels", () => {
  it("matches a full deterministic ranking while forcing the focal index once", () => {
    const graph = topology(120);
    const expected = Array.from({ length: graph.nodeCount }, (_, index) => index)
      .sort((left, right) => (graph.nodes.degrees[right] ?? 0) - (graph.nodes.degrees[left] ?? 0) || left - right);
    expect(initialGraphSummaryIndexes(graph, -1, 32)).toEqual(expected.slice(0, 32));
    const focal = initialGraphSummaryIndexes(graph, 3, 32);
    expect(focal[0]).toBe(3);
    expect(focal.filter((index) => index === 3)).toHaveLength(1);
    expect(focal).toHaveLength(32);
  });

  it("selects 64 labels from 100K nodes with bounded allocation and open-time work", () => {
    const graph = topology(100_000);
    const started = performance.now();
    const indexes = initialGraphSummaryIndexes(graph, 42);
    const elapsed = performance.now() - started;
    expect(indexes).toHaveLength(64);
    expect(indexes[0]).toBe(42);
    expect(new Set(indexes).size).toBe(64);
    expect(elapsed).toBeLessThan(250);
  });

  it("converts live CSS palette values to packed RGBA", () => {
    expect(cssColorToRgba("#268bd2")).toBe(0x268bd2ff);
    expect(cssColorToRgba("rgba(108, 168, 216, 0.5)")).toBe(0x6ca8d880);
  });

  it("bounds metadata caches to the accepted snapshot across repeated refreshes", () => {
    const cache = new Map<string, number>();
    for (let snapshot = 0; snapshot < 100; snapshot += 1) {
      for (let index = 0; index < 64; index += 1) cache.set(`snapshot-${snapshot}:${index}`, index);
      expect(pruneGraphSnapshotCache(cache, `snapshot-${snapshot}`)).toBe(64);
    }
    expect(cache.size).toBe(64);
  });
});

describe("graph refresh and wheel policy", () => {
  it("reveals the initial graph only after its final layout is available", () => {
    expect(shouldRevealGraphScene({ initialFramePending: true, layoutSettled: false, workerAvailable: true })).toBe(false);
    expect(shouldRevealGraphScene({ initialFramePending: true, layoutSettled: true, workerAvailable: true })).toBe(true);
    expect(shouldRevealGraphScene({ initialFramePending: true, layoutSettled: false, workerAvailable: false })).toBe(true);
    expect(shouldRevealGraphScene({ initialFramePending: false, layoutSettled: false, workerAvailable: true })).toBe(true);
  });

  it("coalesces changes, retries unchanged snapshots, then becomes idle", () => {
    const timer = new FakeRefreshTimer();
    const refresh = vi.fn();
    const coordinator = new GraphSnapshotRefreshCoordinator(timer, refresh);
    coordinator.observeSnapshot("snapshot-1");
    coordinator.workspaceChanged();
    coordinator.workspaceChanged();
    expect(timer.callbacks.size).toBe(1);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      timer.flushOne();
      coordinator.observeSnapshot("snapshot-1");
    }
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(coordinator.snapshot()).toMatchObject({ awaitingChange: false, pending: false, attempts: 4 });

    coordinator.workspaceChanged();
    timer.flushOne();
    coordinator.observeSnapshot("snapshot-2");
    expect(coordinator.snapshot()).toMatchObject({ awaitingChange: false, pending: false, sourceSnapshotId: "snapshot-2" });
    expect(timer.callbacks.size).toBe(0);
    coordinator.dispose();
  });

  it("uses mouse wheels, pixel trackpads, and pinch wheels for anchored zoom", () => {
    const pixel = spatialGraphWheelIntent({ ctrlKey: false, deltaMode: 0, deltaX: 12, deltaY: -4, viewportHeight: 800 });
    expect(pixel).toMatchObject({ kind: "zoom", scale: expect.any(Number) });
    expect(pixel.scale).toBeGreaterThan(1);
    expect(spatialGraphWheelIntent({ ctrlKey: true, deltaMode: 0, deltaX: 0, deltaY: -10, viewportHeight: 800 }).scale)
      .toBeGreaterThan(pixel.scale);
    expect(spatialGraphWheelIntent({ ctrlKey: false, deltaMode: 1, deltaX: 0, deltaY: 3, viewportHeight: 800 }).kind)
      .toBe("zoom");
    expect(spatialGraphWheelIntent({ ctrlKey: false, deltaMode: 2, deltaX: 0, deltaY: 4, viewportHeight: 800 }).scale)
      .toBeGreaterThanOrEqual(Math.exp(-0.35));
  });

  it("refreshes only for Markdown or global workspace invalidations", () => {
    expect(shouldRefreshGraphForWorkspaceChange({ filePath: null })).toBe(true);
    expect(shouldRefreshGraphForWorkspaceChange({ filePath: "/notes/Idea.MD" })).toBe(true);
    expect(shouldRefreshGraphForWorkspaceChange({ filePath: "/dist/app.js" })).toBe(false);
  });
});


describe("graph viewport camera ownership", () => {
  function fixture() {
    const frames = new FakeFrameDriver();
    const runtime = new SpatialGraphRuntime(surface(), { frameDriver: frames, palette: palette() });
    const graph = topology(2);
    runtime.setTopology(graph, { width: 540, height: 800 });
    const { right } = cameraBasis(DEFAULT_SCENE_CAMERA);
    runtime.applyLayoutFrame({ topologyHash: graph.topologyHash, layoutEpochId: graph.layoutEpochId, sequence: 1, settled: true,
      positions: new Float32Array([...right.map(value => -1000 * value), ...right.map(value => 1000 * value)]) });
    runtime.frameAll();
    return { runtime, frames };
  }
  it("keeps framed nodes inside repeated width and detail-height changes", () => {
    const { runtime } = fixture();
    for (const viewport of [{ width: 230, height: 800 }, { width: 700, height: 500 }, { width: 230, height: 950 }, { width: 540, height: 800 }]) {
      runtime.resize(viewport, 1.1);
      const scene = runtime.getScene()!;
      for (let index = 0; index < 2; index += 1) {
        expect(scene.projection.nodes[index * 4]).toBeGreaterThan(12);
        expect(scene.projection.nodes[index * 4]).toBeLessThan(viewport.width - 12);
      }
    }
    runtime.dispose();
  });
  it("preserves manual context except enough distance to retain a previously visible selection", () => {
    const { runtime } = fixture();
    runtime.setSelection(1);
    runtime.pan(0, 0);
    const before = structuredClone(runtime.getScene()!.camera);
    runtime.resize({ width: 230, height: 800 });
    const scene = runtime.getScene()!;
    expect(scene.camera.target).toEqual(before.target);
    expect(scene.camera.yaw).toBe(before.yaw);
    expect(scene.camera.pitch).toBe(before.pitch);
    expect(scene.camera.distance).toBeGreaterThan(before.distance);
    expect(scene.projection.nodes[4]).toBeLessThanOrEqual(230 - 12 + 0.001);
    const after = structuredClone(scene.camera);
    runtime.resize({ width: 230, height: 800 }, 2);
    expect(scene.camera).toEqual(after);
    runtime.resize({ width: 800, height: 800 });
    expect(scene.camera).toEqual(after);
    runtime.dispose();
  });
  it("preserves the camera on DPR-only changes and manual views that still fit", () => {
    const { runtime } = fixture();
    const framed = structuredClone(runtime.getScene()!.camera);
    runtime.resize({ width: 540, height: 800 }, 2);
    expect(runtime.getScene()!.camera).toEqual(framed);
    runtime.pan(0, 0);
    runtime.setSelection(1);
    runtime.resize({ width: 700, height: 800 });
    expect(runtime.getScene()!.camera).toEqual(framed);
    runtime.setSelection(-1);
    runtime.resize({ width: 230, height: 800 });
    expect(runtime.getScene()!.camera).toEqual(framed);
    runtime.dispose();
  });
  it("does not retrieve an intentionally offscreen selection or reframe on cold refresh", () => {
    const { runtime } = fixture();
    runtime.setSelection(1);
    runtime.pan(2000, 0);
    const before = structuredClone(runtime.getScene()!.camera);
    runtime.resize({ width: 230, height: 800 });
    expect(runtime.getScene()!.camera).toEqual(before);
    runtime.setTopology(topology(2, "cold-refresh"), { width: 230, height: 800 });
    expect(runtime.getScene()!.camera).toEqual(before);
    runtime.dispose();
  });
  it("retains the focused target through a resize during focus animation", () => {
    const { runtime, frames } = fixture();
    runtime.setSelection(1);
    runtime.focus(1, false);
    frames.flush(16);
    runtime.resize({ width: 230, height: 800 });
    frames.settle();
    const scene = runtime.getScene()!;
    expect(scene.camera.target).toEqual([...scene.layout.positions.slice(3, 6)]);
    const projected = projectGraphScene(scene.layout.positions, scene.camera, scene.projection.viewport);
    expect(projected.nodes[4]).toBeCloseTo(115, 2);
    expect(projected.nodes[5]).toBeCloseTo(400, 2);
    runtime.dispose();
  });
});

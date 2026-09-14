import type { GraphConceptSummary, GraphTopology } from "@exograph/core";

import { GraphCanvasRenderer, type GraphCanvasSurface } from "./graphCanvasRenderer";
import {
  GraphPresentationCompiler,
  type GraphPresentationPalette,
  type GraphPresentationPlan,
} from "./graphPresentation";
import { GraphRenderScheduler, type GraphFrameDriver } from "./graphRenderScheduler";
import {
  GraphRendererHost,
  GraphRendererHostError,
  type GraphPixelRenderer,
  type GraphPixelRendererMeasurement,
  type GraphRendererHostSnapshot,
  type GraphRendererTransition,
} from "./graphRendererHost";
import {
  applyGraphSceneLayoutFrame,
  createGraphScene,
  focusGraphCamera,
  frameGraphCamera,
  orbitGraphCamera,
  panGraphCamera,
  planGraphLabels,
  projectGraphScene,
  reconcileGraphScene,
  retainGraphSelectionOnResize,
  selectGraphPath,
  zoomGraphCameraAt,
  type GraphCamera,
  type GraphLayoutFrame,
  type GraphSceneContract,
  type GraphViewport,
} from "./graphSceneFoundation";
import {
  GraphWebGpuRenderer,
  type GraphGpuRuntime,
  type GraphWebGpuSurface,
} from "./graphWebGpuRenderer";

const MAXIMUM_INITIAL_LABELS = 64;
const CAMERA_TRANSITION_MILLISECONDS = 340;

export interface SpatialGraphRuntimeCounters {
  invalidations: number;
  renderedFrames: number;
  layoutMessages: number;
  rejectedLayoutMessages: number;
  labelPlans: number;
  pendingWork: number;
  pendingFrame: boolean;
  moving: boolean;
  rendererKind: GraphRendererHostSnapshot["kind"];
  rendererGeneration: number;
  rendererTransitionReason: GraphRendererHostSnapshot["transitionReason"];
  rendererRecoveryState: GraphRendererHostSnapshot["recoveryState"];
  rendererTransitions: number;
  rendererFailures: number;
  rendererRecreationAttempts: number;
  rendererFallbacks: number;
  rendererStaleCallbacks: number;
  compilerCompilations: number;
  compilerNumericReuseHits: number;
  compilerResidentCapacityBytes: number;
}

export interface SpatialGraphRuntimeOptions {
  frameDriver: GraphFrameDriver;
  palette: GraphPresentationPalette;
  dpr?: number;
  onDrawError?: (error: Error) => void;
  webGpuSurface?: GraphWebGpuSurface;
  /** Undefined uses truthful runtime detection; null is a controlled unavailable runtime. */
  webGpuRuntime?: GraphGpuRuntime | null;
  createWebGpu?: (
    surface: GraphWebGpuSurface,
    runtime: GraphGpuRuntime,
    reportFailure: (error: Error) => void,
  ) => Promise<GraphPixelRenderer>;
  onRendererTransition?: (transition: GraphRendererTransition<GraphSceneContract>) => void;
}

export interface GraphRefreshTimer {
  schedule(callback: () => void, delay: number): number;
  cancel(handle: number): void;
}

export interface GraphSnapshotRefreshSnapshot {
  awaitingChange: boolean;
  attempts: number;
  pending: boolean;
  sourceSnapshotId: string | null;
}

/** Keeps metadata memory proportional to the current graph snapshot. */
export function pruneGraphSnapshotCache<T>(cache: Map<string, T>, sourceSnapshotId: string): number {
  const prefix = `${sourceSnapshotId}:`;
  for (const key of cache.keys()) {
    if (!key.startsWith(prefix)) cache.delete(key);
  }
  return cache.size;
}

export function shouldRefreshGraphForWorkspaceChange(event: { filePath: string | null }): boolean {
  return event.filePath === null || /\.md$/iu.test(event.filePath);
}

export function shouldRevealGraphScene(input: {
  initialFramePending: boolean;
  layoutSettled: boolean;
  workerAvailable: boolean;
}): boolean {
  return !input.initialFramePending || input.layoutSettled || !input.workerAvailable;
}

/** Coalesces watcher bursts and bounds retries while derived graph state catches up. */
export class GraphSnapshotRefreshCoordinator {
  private sourceSnapshotId: string | null = null;
  private awaitingChange = false;
  private attempts = 0;
  private handle: number | null = null;
  private disposed = false;

  constructor(
    private readonly timer: GraphRefreshTimer,
    private readonly refresh: () => void,
    private readonly onPendingChange: () => void = () => {},
    private readonly maximumAttempts = 4,
  ) {}

  workspaceChanged(): void {
    if (this.disposed) return;
    this.awaitingChange = true;
    this.attempts = 0;
    this.schedule(90);
  }

  observeSnapshot(sourceSnapshotId: string): void {
    if (this.disposed) return;
    if (this.sourceSnapshotId === null || sourceSnapshotId !== this.sourceSnapshotId) {
      this.sourceSnapshotId = sourceSnapshotId;
      this.awaitingChange = false;
      this.cancel();
      this.onPendingChange();
      return;
    }
    if (!this.awaitingChange) return;
    if (this.attempts >= this.maximumAttempts) {
      this.awaitingChange = false;
      this.cancel();
      this.onPendingChange();
      return;
    }
    this.schedule(Math.min(800, 100 * (2 ** this.attempts)));
  }

  snapshot(): GraphSnapshotRefreshSnapshot {
    return {
      awaitingChange: this.awaitingChange,
      attempts: this.attempts,
      pending: this.handle !== null,
      sourceSnapshotId: this.sourceSnapshotId,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.awaitingChange = false;
    this.cancel();
    this.onPendingChange();
  }

  private schedule(delay: number): void {
    this.cancel();
    this.handle = this.timer.schedule(() => {
      this.handle = null;
      if (this.disposed) return;
      this.attempts += 1;
      this.onPendingChange();
      this.refresh();
    }, delay);
    this.onPendingChange();
  }

  private cancel(): void {
    if (this.handle === null) return;
    this.timer.cancel(this.handle);
    this.handle = null;
    this.onPendingChange();
  }
}

export interface GraphPointerSample {
  pointerId: number;
  x: number;
  y: number;
  pointerType: string;
}

export type GraphPointerMove =
  | { kind: "none" }
  | { kind: "hover"; sample: GraphPointerSample }
  | { kind: "orbit" | "pan"; deltaX: number; deltaY: number }
  | { kind: "dolly"; x: number; y: number; deltaY: number }
  | { kind: "pinch-pan"; centerX: number; centerY: number; scale: number; panX: number; panY: number };

export type SpatialGraphWheelIntent = { kind: "zoom"; scale: number };
export type SpatialGraphPointerAction = "orbit" | "pan" | "dolly";

interface TrackedPointer extends GraphPointerSample {
  startX: number;
  startY: number;
}

/** Deterministic pointer bookkeeping; the React adapter only owns capture. */
export class SpatialGraphPointerSession {
  private readonly points = new Map<number, TrackedPointer>();
  private moved = false;
  private action: SpatialGraphPointerAction = "orbit";

  begin(sample: GraphPointerSample, action: SpatialGraphPointerAction): void {
    if (this.points.size === 0) {
      this.moved = false;
      this.action = action;
    }
    this.points.set(sample.pointerId, { ...sample, startX: sample.x, startY: sample.y });
  }

  move(sample: GraphPointerSample): GraphPointerMove {
    const previous = this.points.get(sample.pointerId);
    if (!previous) return { kind: "hover", sample };
    if (this.points.size >= 2) {
      const before = pointerPairMetrics([...this.points.values()].slice(0, 2));
      this.points.set(sample.pointerId, { ...previous, ...sample });
      const after = pointerPairMetrics([...this.points.values()].slice(0, 2));
      this.moved = true;
      if (!before || !after) return { kind: "none" };
      return {
        kind: "pinch-pan",
        centerX: after.centerX,
        centerY: after.centerY,
        scale: after.distance / Math.max(1, before.distance),
        panX: after.centerX - before.centerX,
        panY: after.centerY - before.centerY,
      };
    }
    const deltaX = sample.x - previous.x;
    const deltaY = sample.y - previous.y;
    this.points.set(sample.pointerId, { ...previous, ...sample });
    if (Math.hypot(sample.x - previous.startX, sample.y - previous.startY) > 3) this.moved = true;
    if (!this.moved) return { kind: "none" };
    return this.action === "dolly"
      ? { kind: "dolly", x: sample.x, y: sample.y, deltaY }
      : { kind: this.action, deltaX, deltaY };
  }

  end(pointerId: number): { click: boolean; sample: GraphPointerSample | null } {
    const point = this.points.get(pointerId) ?? null;
    const click = this.points.size === 1 && !this.moved && point !== null;
    this.points.delete(pointerId);
    if (this.points.size === 0) this.resetGesture();
    return { click, sample: point };
  }

  cancel(pointerId: number): void {
    this.points.delete(pointerId);
    if (this.points.size === 0) this.resetGesture();
  }

  get activePointers(): number {
    return this.points.size;
  }

  private resetGesture(): void {
    this.moved = false;
    this.action = "orbit";
  }
}

interface CameraTransition {
  from: GraphCamera;
  to: GraphCamera;
  startedAt: number | null;
}

/**
 * Imperative owner for the renderer-neutral scene and Canvas adapter. React
 * coordinates data loading; this object keeps input-to-camera changes direct
 * and makes idle work observable.
 */
export class SpatialGraphRuntime {
  private readonly canvasRenderer: GraphCanvasRenderer;
  private readonly presentationCompiler = new GraphPresentationCompiler();
  private readonly rendererHost: GraphRendererHost<GraphSceneContract>;
  private readonly scheduler: GraphRenderScheduler;
  private scene: GraphSceneContract | null = null;
  private palette: GraphPresentationPalette;
  private summaries = new Map<number, GraphConceptSummary>();
  private transition: CameraTransition | null = null;
  private cameraFramed = true;
  private showOverflowLabels = true;
  private dpr: number;
  private externalPendingWork = 0;
  private layoutMessages = 0;
  private rejectedLayoutMessages = 0;
  private labelPlans = 0;
  private disposed = false;

  constructor(canvas: GraphCanvasSurface, private readonly options: SpatialGraphRuntimeOptions) {
    this.palette = options.palette;
    this.dpr = options.dpr ?? 1;
    this.canvasRenderer = new GraphCanvasRenderer(canvas, { reportError: options.onDrawError });
    const webGpuSurface = options.webGpuSurface;
    this.rendererHost = new GraphRendererHost<GraphSceneContract>({
      webGpuRuntime: webGpuSurface ? options.webGpuRuntime : null,
      createWebGpu: async (runtime, reportFailure) => {
        if (!webGpuSurface) throw new Error("A WebGPU graph surface is unavailable.");
        return options.createWebGpu
          ? options.createWebGpu(webGpuSurface, runtime, reportFailure)
          : GraphWebGpuRenderer.create(webGpuSurface, runtime, { reportFailure });
      },
      createCanvas: () => new SharedGraphCanvasPixelRenderer(this.canvasRenderer),
      onTransition: (transition) => {
        // Keep the last complete Canvas frame until the prepared GPU submission
        // has crossed one display boundary; the next frame swaps to labels only.
        this.scheduler.invalidate("renderer-transition");
        options.onRendererTransition?.(transition);
      },
      onError: (error) => {
        const retained = this.rendererHost.frame;
        if (retained) this.canvasRenderer.render(retained.plan);
        if (error instanceof GraphRendererHostError && error.code === "recovery-failed") {
          options.onDrawError?.(error);
        }
      },
    });
    this.scheduler = new GraphRenderScheduler(options.frameDriver, (time) => this.render(time));
    void this.rendererHost.start().catch((error) => {
      if (!this.disposed) options.onDrawError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  getScene(): GraphSceneContract | null {
    return this.scene;
  }

  setTopology(topology: GraphTopology, viewport: GraphViewport): GraphSceneContract {
    const sameEpoch = this.scene?.topology.topologyHash === topology.topologyHash
      && this.scene.topology.layoutEpochId === topology.layoutEpochId
      && this.scene.topology.nodes.seeds.length === topology.nodeCount;
    const next = sameEpoch && this.scene
      ? { ...this.scene, topology }
      : this.scene ? reconcileGraphScene(this.scene, topology) : createGraphScene(topology, viewport);
    this.scene = next;
    this.resize(viewport, this.dpr);
    this.scheduler.invalidate("topology");
    return next;
  }

  resize(viewport: GraphViewport, dpr = this.dpr): void {
    if (!this.scene || this.disposed) return;
    this.dpr = dpr;
    const previous = this.scene.projection.viewport;
    if (previous.width !== viewport.width || previous.height !== viewport.height) {
      this.scene.camera = this.cameraFramed
        ? frameGraphCamera(this.scene.layout.positions, viewport)
        : retainGraphSelectionOnResize(this.scene.layout.positions, this.scene.camera, this.scene.interaction.selected, previous, viewport);
      if (this.transition) {
        // Continue toward the same focused target in the new viewport.
        this.transition.from = cloneCamera(this.scene.camera);
        this.transition.startedAt = null;
      }
    }
    this.scene.projection = projectGraphScene(this.scene.layout.positions, this.scene.camera, viewport);
    this.resizeRenderers(viewport, dpr);
    this.scheduler.invalidate("resize");
  }

  setPalette(palette: GraphPresentationPalette): void {
    this.palette = palette;
    this.scheduler.invalidate("theme");
  }

  setShowOverflowLabels(show: boolean): void {
    if (this.showOverflowLabels === show) return;
    this.showOverflowLabels = show;
    this.scheduler.invalidate("label-preference");
  }

  setSummaries(summaries: readonly GraphConceptSummary[]): void {
    for (const summary of summaries) this.summaries.set(summary.index, summary);
    this.scheduler.invalidate("labels");
  }

  replaceSummaries(summaries: ReadonlyMap<number, GraphConceptSummary>): void {
    this.summaries = new Map(summaries);
    this.scheduler.invalidate("labels");
  }

  setSelection(selected: number, pathTarget = -1): void {
    if (!this.scene) return;
    this.scene.interaction = selectGraphPath(this.scene.topology, selected, pathTarget, -1);
    this.scheduler.invalidate("selection");
  }

  setHovered(hovered: number): void {
    if (!this.scene || this.scene.interaction.hovered === hovered) return;
    this.scene.interaction = selectGraphPath(
      this.scene.topology,
      this.scene.interaction.selected,
      this.scene.interaction.pathTarget,
      hovered,
    );
    this.scheduler.invalidate("hover");
  }

  clearRoute(): void {
    if (!this.scene || this.scene.interaction.pathTarget < 0) return;
    this.setSelection(this.scene.interaction.selected);
  }

  applyLayoutFrame(frame: GraphLayoutFrame): boolean {
    this.layoutMessages += 1;
    if (!this.scene) {
      this.rejectedLayoutMessages += 1;
      return false;
    }
    const result = applyGraphSceneLayoutFrame(this.scene, frame);
    if (result.rejection) {
      this.rejectedLayoutMessages += 1;
      return false;
    }
    this.scene = result.scene;
    this.scheduler.invalidate("layout");
    return true;
  }

  rejectLayoutMessage(): void {
    this.layoutMessages += 1;
    this.rejectedLayoutMessages += 1;
  }

  orbit(deltaX: number, deltaY: number): void {
    const viewportHeight = this.scene?.projection.viewport.height;
    if (!viewportHeight) return;
    this.mutateCamera(
      (camera) => orbitGraphCamera(camera, deltaX, deltaY, {
        orbitRadiansPerPixel: (2 * Math.PI) / Math.max(360, viewportHeight),
      }),
      "orbit",
    );
  }

  pan(deltaX: number, deltaY: number): void {
    const viewport = this.scene?.projection.viewport;
    if (!viewport) return;
    this.mutateCamera((camera) => panGraphCamera(camera, deltaX, deltaY, viewport), "pan");
  }

  zoomAt(x: number, y: number, scale: number): void {
    const viewport = this.scene?.projection.viewport;
    if (!viewport) return;
    this.mutateCamera((camera) => zoomGraphCameraAt(camera, viewport, x, y, scale), "zoom");
  }

  setCamera(camera: GraphCamera, reason = "camera"): void {
    if (!this.scene) return;
    this.cancelMotion();
    this.cameraFramed = reason === "frame-all";
    this.scene.camera = cloneCamera(camera);
    this.scene.projection = projectGraphScene(this.scene.layout.positions, this.scene.camera, this.scene.projection.viewport);
    this.scheduler.invalidate(reason);
  }

  frameAll(): void {
    if (!this.scene) return;
    this.setCamera(frameGraphCamera(this.scene.layout.positions, this.scene.projection.viewport), "frame-all");
  }

  focus(index: number, reducedMotion: boolean): void {
    if (!this.scene || index < 0 || index >= this.scene.topology.nodes.seeds.length) return;
    this.cameraFramed = false;
    const target = focusGraphCamera(this.scene.layout.positions, index, this.scene.projection.viewport);
    if (reducedMotion) {
      this.setCamera(target, "focus");
      return;
    }
    this.transition = { from: cloneCamera(this.scene.camera), to: target, startedAt: null };
    this.scheduler.startMotion("focus");
  }

  cancelMotion(): void {
    this.transition = null;
    this.scheduler.stopMotion();
  }

  setExternalPendingWork(count: number): void {
    this.externalPendingWork = Math.max(0, Math.floor(count));
  }

  snapshot(): SpatialGraphRuntimeCounters {
    const scheduler = this.scheduler.snapshot();
    const renderer = this.rendererHost.snapshot();
    const compiler = this.presentationCompiler.stats();
    return {
      invalidations: scheduler.invalidations,
      renderedFrames: scheduler.renderedFrames,
      layoutMessages: this.layoutMessages,
      rejectedLayoutMessages: this.rejectedLayoutMessages,
      labelPlans: this.labelPlans,
      pendingWork: this.externalPendingWork + Number(scheduler.pending) + Number(scheduler.moving),
      pendingFrame: scheduler.pending,
      moving: scheduler.moving,
      rendererKind: renderer.kind,
      rendererGeneration: renderer.generation,
      rendererTransitionReason: renderer.transitionReason,
      rendererRecoveryState: renderer.recoveryState,
      rendererTransitions: renderer.transitions,
      rendererFailures: renderer.failures,
      rendererRecreationAttempts: renderer.recreationAttempts,
      rendererFallbacks: renderer.fallbacks,
      rendererStaleCallbacks: renderer.staleCallbacks,
      compilerCompilations: compiler.compilations,
      compilerNumericReuseHits: compiler.numericReuseHits,
      compilerResidentCapacityBytes: compiler.residentCapacityBytes,
    };
  }

  async forceCanvasFallbackForTesting(): Promise<void> {
    await this.rendererHost.forceCanvasFallbackForTesting();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transition = null;
    this.scheduler.dispose();
    this.rendererHost.destroy();
    this.canvasRenderer.destroy();
  }

  private mutateCamera(update: (camera: GraphCamera) => GraphCamera, reason: string): void {
    if (!this.scene) return;
    this.cancelMotion();
    this.cameraFramed = false;
    this.scene.camera = update(this.scene.camera);
    this.scene.projection = projectGraphScene(this.scene.layout.positions, this.scene.camera, this.scene.projection.viewport);
    this.scheduler.invalidate(reason);
  }

  private render(time: number): { continueMotion: boolean } {
    if (!this.scene || this.disposed) return { continueMotion: false };
    const continueMotion = this.advanceTransition(time);
    const candidates = [...this.summaries.values()].map((summary) => ({
      index: summary.index,
      text: summary.label,
      width: Math.min(180, Math.max(24, summary.label.length * 6.55)),
      height: 14,
    }));
    const viewport = this.scene.projection.viewport;
    const labelPlan = planGraphLabels(this.scene.topology, this.scene.projection, this.scene.interaction, candidates, {
      maxLabels: Math.max(6, Math.min(20, Math.floor(viewport.width * viewport.height / 18_000))),
      showOverflowLabels: this.showOverflowLabels,
    });
    this.labelPlans += 1;
    try {
      const plan = this.presentationCompiler.compile(this.scene, labelPlan, { palette: this.palette });
      this.rendererHost.render({ plan, state: this.scene });
      const renderer = this.rendererHost.snapshot();
      if (renderer.kind === "webgpu" && renderer.recoveryState === "ready") {
        this.canvasRenderer.renderLabels(plan);
      } else if (renderer.kind === null || renderer.recoveryState === "recreating") {
        this.canvasRenderer.render(plan);
      }
    } catch (error) {
      this.transition = null;
      this.options.onDrawError?.(error instanceof Error ? error : new Error(String(error)));
      return { continueMotion: false };
    }
    return { continueMotion };
  }

  private resizeRenderers(viewport: GraphViewport, dpr: number): void {
    const next = { ...viewport, dpr };
    this.canvasRenderer.resize(next);
    this.rendererHost.resize(next);
  }

  private advanceTransition(time: number): boolean {
    if (!this.transition || !this.scene) return false;
    if (this.transition.startedAt === null) this.transition.startedAt = time;
    const elapsed = Math.max(0, time - this.transition.startedAt);
    if (elapsed >= CAMERA_TRANSITION_MILLISECONDS) {
      this.scene.camera = cloneCamera(this.transition.to);
      this.transition = null;
      this.scene.projection = projectGraphScene(this.scene.layout.positions, this.scene.camera, this.scene.projection.viewport);
      return false;
    }
    const normalized = elapsed / CAMERA_TRANSITION_MILLISECONDS;
    const response = 1 - (1 + 7 * normalized) * Math.exp(-7 * normalized);
    this.scene.camera = interpolateCamera(this.transition.from, this.transition.to, response);
    this.scene.projection = projectGraphScene(this.scene.layout.positions, this.scene.camera, this.scene.projection.viewport);
    return true;
  }
}

/** Host adapter; the runtime owns the one persistent accessible Canvas surface. */
class SharedGraphCanvasPixelRenderer implements GraphPixelRenderer {
  constructor(private readonly renderer: GraphCanvasRenderer) {}

  resize(viewport: { width: number; height: number; dpr: number }): void {
    this.renderer.resize(viewport);
  }

  render(plan: GraphPresentationPlan): GraphPixelRendererMeasurement {
    return this.renderer.render(plan);
  }

  destroy(): void {
    // The overlay survives renderer transitions and is destroyed by the runtime.
  }
}

export function initialGraphSummaryIndexes(topology: GraphTopology, focalIndex = -1, limit = MAXIMUM_INITIAL_LABELS): number[] {
  const bounded = Math.max(0, Math.min(MAXIMUM_INITIAL_LABELS, Math.floor(limit)));
  if (bounded === 0) return [];
  const focal = focalIndex >= 0 && focalIndex < topology.nodeCount ? focalIndex : -1;
  const heap: number[] = [];
  const heapLimit = bounded - Number(focal >= 0);
  for (let index = 0; index < topology.nodeCount && heapLimit > 0; index += 1) {
    if (index === focal) continue;
    if (heap.length < heapLimit) {
      heap.push(index);
      siftWorstUp(heap, heap.length - 1, topology.nodes.degrees);
      continue;
    }
    if (!isBetterLabelIndex(index, heap[0] ?? index, topology.nodes.degrees)) continue;
    heap[0] = index;
    siftWorstDown(heap, 0, topology.nodes.degrees);
  }
  heap.sort((left, right) => compareLabelIndexes(left, right, topology.nodes.degrees));
  return focal >= 0 ? [focal, ...heap] : heap;
}

/** Standard orbit-control mapping for mouse, pen, and direct-touch input. */
export function spatialGraphPointerAction(input: {
  button: number;
  pointerType: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): SpatialGraphPointerAction {
  if (input.pointerType === "touch") return "orbit";
  const modified = input.ctrlKey || input.metaKey || input.shiftKey;
  if (input.button === 1) return "dolly";
  if (input.button === 2) return modified ? "orbit" : "pan";
  return modified ? "pan" : "orbit";
}

/** Mouse wheels, trackpad scroll, and Chromium's ctrl+wheel pinch all zoom. */
export function spatialGraphWheelIntent(input: {
  ctrlKey: boolean;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  viewportHeight: number;
}): SpatialGraphWheelIntent {
  const pixels = input.deltaMode === 1
    ? input.deltaY * 14
    : input.deltaMode === 2 ? input.deltaY * input.viewportHeight : input.deltaY;
  const sensitivity = input.ctrlKey ? 0.008 : 0.0024;
  return { kind: "zoom", scale: Math.exp(clampZoomExponent(-pixels * sensitivity)) };
}

/** Vertical middle-button drag follows the same dolly direction as the wheel. */
export function spatialGraphDollyDragScale(deltaY: number): number {
  return Math.exp(clampZoomExponent(-deltaY * 0.008));
}

/** Applies the persisted orbit-direction preference before camera math. */
export function spatialGraphOrbitDelta(deltaX: number, deltaY: number, inverse: boolean): { x: number; y: number } {
  const direction = inverse ? 1 : -1;
  return { x: deltaX * direction, y: deltaY * direction };
}

function clampZoomExponent(exponent: number): number {
  return Math.max(-0.35, Math.min(0.35, exponent));
}

function cloneCamera(camera: GraphCamera): GraphCamera {
  return { ...camera, target: [...camera.target] };
}

function interpolateCamera(from: GraphCamera, to: GraphCamera, amount: number): GraphCamera {
  const mix = (left: number, right: number) => left + (right - left) * amount;
  return {
    yaw: mix(from.yaw, to.yaw),
    pitch: mix(from.pitch, to.pitch),
    distance: mix(from.distance, to.distance),
    target: [mix(from.target[0], to.target[0]), mix(from.target[1], to.target[1]), mix(from.target[2], to.target[2])],
    fov: mix(from.fov, to.fov),
    near: mix(from.near, to.near),
    far: mix(from.far, to.far),
  };
}

function pointerPairMetrics(points: readonly TrackedPointer[]) {
  const first = points[0];
  const second = points[1];
  if (!first || !second) return null;
  return {
    centerX: (first.x + second.x) / 2,
    centerY: (first.y + second.y) / 2,
    distance: Math.hypot(first.x - second.x, first.y - second.y),
  };
}

function compareLabelIndexes(left: number, right: number, degrees: Uint32Array): number {
  return (degrees[right] ?? 0) - (degrees[left] ?? 0) || left - right;
}

function isBetterLabelIndex(left: number, right: number, degrees: Uint32Array): boolean {
  return compareLabelIndexes(left, right, degrees) < 0;
}

function siftWorstUp(heap: number[], start: number, degrees: Uint32Array): void {
  let child = start;
  while (child > 0) {
    const parent = Math.floor((child - 1) / 2);
    if (!isBetterLabelIndex(heap[parent] ?? 0, heap[child] ?? 0, degrees)) break;
    [heap[parent], heap[child]] = [heap[child] ?? 0, heap[parent] ?? 0];
    child = parent;
  }
}

function siftWorstDown(heap: number[], start: number, degrees: Uint32Array): void {
  let parent = start;
  while (true) {
    const left = parent * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let worse = left;
    if (right < heap.length && isBetterLabelIndex(heap[left] ?? 0, heap[right] ?? 0, degrees)) worse = right;
    if (!isBetterLabelIndex(heap[parent] ?? 0, heap[worse] ?? 0, degrees)) return;
    [heap[parent], heap[worse]] = [heap[worse] ?? 0, heap[parent] ?? 0];
    parent = worse;
  }
}

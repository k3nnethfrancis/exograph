import { RefreshCw, Scan } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  BoundedGraphConceptDetail,
  GraphConceptLookupReference,
  GraphTopology,
} from "@exograph/core";

import {
  graphNodeDoubleClickDecision,
} from "../graphInteraction";
import {
  createGraphLayoutInput,
  pickGraphSceneNode,
} from "../graphSceneFoundation";
import { resolveGraphPalette } from "../graphPalette";
import { GraphMetadataStore } from "../graphMetadataStore";
import { browserGraphFrameDriver } from "../graphRenderScheduler";
import {
  GraphSnapshotRefreshCoordinator,
  SpatialGraphRuntime,
  initialGraphSummaryIndexes,
  shouldRefreshGraphForWorkspaceChange,
  shouldRevealGraphScene,
  type SpatialGraphRuntimeCounters,
} from "../spatialGraphRuntime";
import type { GraphCanvasSurface } from "../graphCanvasRenderer";
import type { GraphWebGpuSurface } from "../graphWebGpuRenderer";
import type { GraphLayoutWorkerRequest, GraphLayoutWorkerResponse } from "../graphLayoutWorkerProtocol";
import type { GraphFocusRequest, InspectedConcept } from "../hooks/useInspectedConcept";
import { useSpatialGraphInput } from "../hooks/useSpatialGraphInput";
import { ExographMark } from "./ExographMark";
import { GraphConceptDetailPanel } from "./GraphConceptDetailPanel";
import { OntologyReviewRow } from "./OntologyReviewRow";

interface SpatialGraphViewProps {
  inverseNavigation: boolean;
  showOverflowLabels: boolean;
  refreshKey?: string;
  inspectedConcept: InspectedConcept | null;
  focusRequest: GraphFocusRequest | null;
  /** Historical editor context for Escape; Graph focus has no active document. */
  graphReturnPath?: string | null;
  isTargetOpen: (target: string) => boolean;
  onRestoreEditorConcept: (filePath: string) => void;
  onActivateOpenTarget: (filePath: string) => void;
  onOpenTarget: (target: string) => void;
  onStartMaintenance: (filePath: string) => void;
  onFocus: () => void;
}

type DebugCanvas = HTMLCanvasElement & {
  __exographGraphSnapshot?: () => (SpatialGraphRuntimeCounters & {
    metadataCacheEntries: number;
    sourceSnapshotId: string | null;
    selected: number;
    pathTarget: number;
    pathNodeCount: number;
    graphReturnPath: string | null;
    inspectedFilePath: string | null;
    camera: { yaw: number; pitch: number; distance: number; target: [number, number, number] };
  }) | null;
  __exographGraphPointForIndex?: (index: number) => { x: number; y: number; visible: boolean } | null;
  __exographGraphPickAt?: (x: number, y: number) => number;
  __exographGraphForceCanvasFallback?: () => Promise<void>;
};

export function GraphBuildingIndicator() {
  return (
    <div className="spatial-graph__building" role="status">
      <ExographMark animated className="spatial-graph__building-mark" />
      <span>Building graph</span>
    </div>
  );
}

export function SpatialGraphView({
  inverseNavigation,
  showOverflowLabels,
  refreshKey,
  inspectedConcept,
  focusRequest,
  graphReturnPath,
  isTargetOpen,
  onRestoreEditorConcept,
  onActivateOpenTarget,
  onOpenTarget,
  onStartMaintenance,
  onFocus,
}: SpatialGraphViewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keyboardHelpId = useId();
  const webGpuCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<SpatialGraphRuntime | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const refreshCoordinatorRef = useRef<GraphSnapshotRefreshCoordinator | null>(null);
  const topologyRef = useRef<GraphTopology | null>(null);
  const graphReturnPathRef = useRef(graphReturnPath ?? null);
  const inspectedConceptRef = useRef(inspectedConcept);
  graphReturnPathRef.current = graphReturnPath ?? null;
  inspectedConceptRef.current = inspectedConcept;
  const metadataStoreRef = useRef<GraphMetadataStore | null>(null);
  const loadSequenceRef = useRef(0);
  const inspectionSequenceRef = useRef(0);
  const generationRef = useRef(0);
  const activeGenerationRef = useRef(0);
  const topologyPendingRef = useRef(false);
  const layoutPendingRef = useRef(false);
  const initialFramePendingRef = useRef(true);
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const [topology, setTopology] = useState<GraphTopology | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<BoundedGraphConceptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailStatus, setDetailStatus] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [rendererNonce, setRendererNonce] = useState(0);
  const [routeNodeCount, setRouteNodeCount] = useState(0);
  const [sceneReady, setSceneReady] = useState(false);

  const updatePendingWork = useCallback(() => {
    runtimeRef.current?.setExternalPendingWork(
      Number(topologyPendingRef.current)
        + (metadataStoreRef.current?.pendingCount ?? 0)
        + Number(layoutPendingRef.current)
        + Number(Boolean(
          refreshCoordinatorRef.current?.snapshot().pending
          || refreshCoordinatorRef.current?.snapshot().awaitingChange,
        )),
    );
  }, []);

  const refreshForStaleRead = useCallback((sourceSnapshotId: string) => {
    if (topologyRef.current?.sourceSnapshotId !== sourceSnapshotId) return;
    setReloadNonce((value) => value + 1);
  }, []);

  if (!metadataStoreRef.current) {
    metadataStoreRef.current = new GraphMetadataStore({
      port: {
        getGraphConceptSummaries: (indexes, sourceSnapshotId) => window.exograph.notes.getGraphConceptSummaries([...indexes], sourceSnapshotId),
        getGraphConceptDetailByIndex: (index, sourceSnapshotId) => window.exograph.notes.getGraphConceptDetailByIndex(index, sourceSnapshotId),
        graphConceptLookup: (reference, sourceSnapshotId) => window.exograph.notes.graphConceptLookup(reference, sourceSnapshotId),
      },
      currentSnapshot: () => topologyRef.current,
      onPendingChange: updatePendingWork,
      onStale: refreshForStaleRead,
      onStatus: setDetailStatus,
      onSummaries: (summaries) => runtimeRef.current?.setSummaries(summaries),
    });
  }

  const readSummaries = useCallback((indexes: readonly number[], sourceSnapshotId: string) => (
    metadataStoreRef.current?.readSummaries(indexes, sourceSnapshotId) ?? Promise.resolve()
  ), []);

  const readDetail = useCallback((index: number, sourceSnapshotId: string) => (
    metadataStoreRef.current?.readDetail(index, sourceSnapshotId) ?? Promise.resolve(null)
  ), []);

  const resolveConcept = useCallback(async (concept: InspectedConcept, sourceSnapshotId: string) => {
    const reference = lookupReference(concept);
    if (!reference) return null;
    return metadataStoreRef.current?.resolve(reference, sourceSnapshotId) ?? null;
  }, []);

  const inspectIndex = useCallback(async (index: number) => {
    const currentTopology = topologyRef.current;
    if (!currentTopology || index < 0 || index >= currentTopology.nodeCount) return;
    const sequence = ++inspectionSequenceRef.current;
    runtimeRef.current?.setSelection(index);
    setRouteNodeCount(0);
    if (!metadataStoreRef.current?.hasSummary(index, currentTopology.sourceSnapshotId)) {
      void readSummaries([index], currentTopology.sourceSnapshotId);
    }
    const detail = await readDetail(index, currentTopology.sourceSnapshotId);
    if (!detail || sequence !== inspectionSequenceRef.current
      || topologyRef.current?.sourceSnapshotId !== currentTopology.sourceSnapshotId) return;
    setSelectedDetail(detail);
    setDetailStatus(null);
  }, [readDetail, readSummaries]);

  const restoreGraphSelection = useCallback(async (filePath: string) => {
    const currentTopology = topologyRef.current;
    if (!currentTopology) return;
    const summary = await resolveConcept({ filePath }, currentTopology.sourceSnapshotId);
    if (!summary || topologyRef.current?.sourceSnapshotId !== currentTopology.sourceSnapshotId) return;
    await inspectIndex(summary.index);
    onRestoreEditorConcept(filePath);
  }, [inspectIndex, onRestoreEditorConcept, resolveConcept]);

  useEffect(() => {
    const canvas = canvasRef.current as DebugCanvas | null;
    const webGpuCanvas = webGpuCanvasRef.current;
    const viewportElement = viewportRef.current;
    if (!canvas || !webGpuCanvas || !viewportElement) return;
    setError(null);
    let runtime: SpatialGraphRuntime;
    try {
      initialFramePendingRef.current = true;
      setSceneReady(false);
      runtime = new SpatialGraphRuntime(canvas as unknown as GraphCanvasSurface, {
        frameDriver: browserGraphFrameDriver(),
        palette: resolveGraphPalette(canvas),
        dpr: window.devicePixelRatio || 1,
        webGpuSurface: webGpuCanvas as unknown as GraphWebGpuSurface,
        onDrawError: (reason) => setError(reason.message),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    runtimeRef.current = runtime;
    if (window.exograph.test?.graphHooks) canvas.__exographGraphSnapshot = () => {
      const snapshot = runtimeRef.current?.snapshot();
      if (!snapshot) return null;
      return {
        ...snapshot,
        metadataCacheEntries: metadataStoreRef.current?.cacheEntryCount ?? 0,
        sourceSnapshotId: topologyRef.current?.sourceSnapshotId ?? null,
        selected: runtimeRef.current?.getScene()?.interaction.selected ?? -1,
        pathTarget: runtimeRef.current?.getScene()?.interaction.pathTarget ?? -1,
        pathNodeCount: runtimeRef.current?.getScene()?.interaction.pathNodes.reduce((count, value) => count + Number(value > 0), 0) ?? 0,
        graphReturnPath: graphReturnPathRef.current,
        inspectedFilePath: inspectedConceptRef.current?.filePath ?? null,
        camera: {
          yaw: runtimeRef.current?.getScene()?.camera.yaw ?? 0,
          pitch: runtimeRef.current?.getScene()?.camera.pitch ?? 0,
          distance: runtimeRef.current?.getScene()?.camera.distance ?? 0,
          target: [...(runtimeRef.current?.getScene()?.camera.target ?? [0, 0, 0])],
        },
      };
    };
    if (window.exograph.test?.graphHooks) canvas.__exographGraphPointForIndex = (index) => {
      const scene = runtimeRef.current?.getScene();
      if (!scene || index < 0 || index >= scene.topology.nodes.seeds.length) return null;
      const offset = index * 4;
      return {
        x: scene.projection.nodes[offset] ?? 0,
        y: scene.projection.nodes[offset + 1] ?? 0,
        visible: scene.projection.nodes[offset + 3] === 1,
      };
    };
    if (window.exograph.test?.graphHooks) canvas.__exographGraphPickAt = (x, y) => {
      const scene = runtimeRef.current?.getScene();
      if (!scene) return -1;
      return pickGraphSceneNode(scene.topology, scene.projection, scene.camera, x, y, { pointer: "fine" });
    };
    if (window.exograph.test?.graphHooks) {
      canvas.__exographGraphForceCanvasFallback = () => runtime.forceCanvasFallbackForTesting();
    }
    const refreshCoordinator = new GraphSnapshotRefreshCoordinator(
      {
        schedule: (callback, delay) => window.setTimeout(callback, delay),
        cancel: (handle) => window.clearTimeout(handle),
      },
      () => setReloadNonce((value) => value + 1),
      updatePendingWork,
    );
    refreshCoordinatorRef.current = refreshCoordinator;
    const unsubscribeWorkspace = window.exograph.workspace.onDidChange((event) => {
      if (shouldRefreshGraphForWorkspaceChange(event)) refreshCoordinator.workspaceChanged();
    });
    const unsubscribeGraph = window.exograph.workspace.onGraphChanged(() => refreshCoordinator.workspaceChanged());
    const revealInitialScene = () => {
      if (!initialFramePendingRef.current) return;
      runtime.frameAll();
      initialFramePendingRef.current = false;
      setSceneReady(true);
      setLoading(false);
    };
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL("../workers/graphLayout.worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      worker.onmessage = ({ data }: MessageEvent<GraphLayoutWorkerResponse>) => {
        if (data.generation !== activeGenerationRef.current) {
          runtime.rejectLayoutMessage();
          return;
        }
        if (data.type === "error") {
          layoutPendingRef.current = false;
          updatePendingWork();
          revealInitialScene();
          setError(data.message);
          return;
        }
        const accepted = runtime.applyLayoutFrame(data.frame);
        if (accepted && data.frame.settled) revealInitialScene();
        layoutPendingRef.current = accepted && !data.frame.settled;
        updatePendingWork();
        if (!accepted) {
          revealInitialScene();
          setError("Graph layout returned an invalid frame.");
        }
      };
      worker.onerror = (event) => {
        layoutPendingRef.current = false;
        updatePendingWork();
        revealInitialScene();
        setError(event.message || "Graph layout worker failed.");
      };
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Graph layout worker could not start.");
    }
    const resize = () => {
      const rect = viewportElement.getBoundingClientRect();
      runtime.resize(
        { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) },
        window.devicePixelRatio || 1,
      );
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(viewportElement);
    const themeObserver = new MutationObserver(() => runtime.setPalette(resolveGraphPalette(canvas)));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-appearance-mode"] });
    setRuntimeVersion((value) => value + 1);
    return () => {
      const generation = ++generationRef.current;
      worker?.postMessage({ type: "dispose", generation } satisfies GraphLayoutWorkerRequest);
      worker?.terminate();
      workerRef.current = null;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      unsubscribeWorkspace();
      unsubscribeGraph();
      refreshCoordinator.dispose();
      refreshCoordinatorRef.current = null;
      runtime.dispose();
      runtimeRef.current = null;
      delete canvas.__exographGraphSnapshot;
      delete canvas.__exographGraphPointForIndex;
      delete canvas.__exographGraphPickAt;
      delete canvas.__exographGraphForceCanvasFallback;
    };
  }, [rendererNonce, updatePendingWork]);

  useEffect(() => {
    runtimeRef.current?.setShowOverflowLabels(showOverflowLabels);
  }, [showOverflowLabels, rendererNonce]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const request = ++loadSequenceRef.current;
    topologyPendingRef.current = true;
    updatePendingWork();
    setLoading(topologyRef.current === null);
    setError(null);
    void window.exograph.notes.getGraphTopology().then((next) => {
      if (request !== loadSequenceRef.current || runtimeRef.current !== runtime) return;
      const previous = topologyRef.current;
      if (previous?.sourceSnapshotId !== next.sourceSnapshotId) {
        setSelectedDetail(null);
        setDetailStatus(null);
      }
      metadataStoreRef.current?.prune(next.sourceSnapshotId);
      topologyRef.current = next;
      setTopology(next);
      refreshCoordinatorRef.current?.observeSnapshot(next.sourceSnapshotId);
      const rect = viewportRef.current?.getBoundingClientRect();
      const viewport = { width: Math.max(1, Math.round(rect?.width ?? 1)), height: Math.max(1, Math.round(rect?.height ?? 1)) };
      const scene = runtime.setTopology(next, viewport);
      setRouteNodeCount(scene.interaction.pathNodes.reduce((count, value) => count + Number(value > 0), 0));
      const cachedSummaries = metadataStoreRef.current?.cachedSummaries(next.sourceSnapshotId) ?? [];
      runtime.replaceSummaries(new Map(cachedSummaries.map((summary) => [summary.index, summary])));
      void readSummaries(initialGraphSummaryIndexes(next, scene.interaction.selected), next.sourceSnapshotId);
      const sameLayoutEpoch = previous?.topologyHash === next.topologyHash && previous.layoutEpochId === next.layoutEpochId;
      const needsLayout = !sameLayoutEpoch || !scene.layout.settled;
      const workerAvailable = workerRef.current !== null;
      if (needsLayout && workerRef.current) {
        const generation = ++generationRef.current;
        activeGenerationRef.current = generation;
        layoutPendingRef.current = true;
        workerRef.current.postMessage({
          type: "init",
          generation,
          input: createGraphLayoutInput(next, scene.layout),
        } satisfies GraphLayoutWorkerRequest);
      }
      if (shouldRevealGraphScene({
        initialFramePending: initialFramePendingRef.current,
        layoutSettled: scene.layout.settled,
        workerAvailable,
      })) {
        if (initialFramePendingRef.current) {
          runtime.frameAll();
          initialFramePendingRef.current = false;
        }
        setSceneReady(true);
        setLoading(false);
      } else {
        setLoading(true);
      }
    }).catch((reason) => {
      if (request !== loadSequenceRef.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
      layoutPendingRef.current = false;
    }).finally(() => {
      if (request !== loadSequenceRef.current) return;
      topologyPendingRef.current = false;
      updatePendingWork();
    });
    return () => { loadSequenceRef.current += 1; };
  }, [readSummaries, refreshKey, reloadNonce, runtimeVersion, updatePendingWork]);

  useEffect(() => {
    const currentTopology = topologyRef.current;
    if (!inspectedConcept || !currentTopology) return;
    const sequence = ++inspectionSequenceRef.current;
    let cancelled = false;
    void resolveConcept(inspectedConcept, currentTopology.sourceSnapshotId).then(async (summary) => {
      if (cancelled || !summary || topologyRef.current?.sourceSnapshotId !== currentTopology.sourceSnapshotId) return;
      runtimeRef.current?.setSelection(summary.index);
      setRouteNodeCount(0);
      const detail = await readDetail(summary.index, currentTopology.sourceSnapshotId);
      if (cancelled || sequence !== inspectionSequenceRef.current || !detail
        || topologyRef.current?.sourceSnapshotId !== currentTopology.sourceSnapshotId) return;
      setSelectedDetail(detail);
      setDetailStatus(null);
    });
    return () => {
      cancelled = true;
      inspectionSequenceRef.current += 1;
    };
  }, [inspectedConcept?.conceptId, inspectedConcept?.filePath, readDetail, resolveConcept, topology?.sourceSnapshotId]);

  useEffect(() => {
    const currentTopology = topologyRef.current;
    if (!focusRequest || !currentTopology) return;
    let cancelled = false;
    void resolveConcept(focusRequest.concept, currentTopology.sourceSnapshotId).then((summary) => {
      if (cancelled || !summary || topologyRef.current?.sourceSnapshotId !== currentTopology.sourceSnapshotId) return;
      runtimeRef.current?.setSelection(summary.index);
      setRouteNodeCount(0);
      runtimeRef.current?.focus(summary.index, prefersReducedMotion());
    });
    return () => { cancelled = true; };
  }, [focusRequest?.sequence, resolveConcept, topology?.sourceSnapshotId]);

  async function openIndex(index: number) {
    const currentTopology = topologyRef.current;
    if (!currentTopology) return;
    const sequence = ++inspectionSequenceRef.current;
    const detail = await readDetail(index, currentTopology.sourceSnapshotId);
    if (!detail || sequence !== inspectionSequenceRef.current
      || topologyRef.current?.sourceSnapshotId !== currentTopology.sourceSnapshotId) return;
    runtimeRef.current?.setSelection(index);
    setRouteNodeCount(0);
    setSelectedDetail(detail);
    setDetailStatus(null);
    const target = detail.concept.filePath ?? null;
    const decision = graphNodeDoubleClickDecision(target, Boolean(target && isTargetOpen(target)));
    if (decision === "focus-node") {
      runtimeRef.current?.focus(index, prefersReducedMotion());
      return;
    }
    if (decision === "focus" && target) {
      runtimeRef.current?.focus(index, prefersReducedMotion());
      onActivateOpenTarget(target);
    }
    if (decision === "open" && target) onOpenTarget(target);
  }

  const graphInput = useSpatialGraphInput({
    canvasRef,
    runtimeRef,
    topologyRef,
    inverseNavigation,
    graphReturnPath,
    selectedFilePath: selectedDetail?.concept.filePath,
    inspectIndex,
    openIndex,
    restoreSelection: restoreGraphSelection,
    readSummaries,
    setRouteNodeCount,
  });

  return (
    <div className="spatial-graph" data-testid="spatial-graph">
      <div className="spatial-graph__toolbar">
        <span className="spatial-graph__count">{topology?.nodeCount ?? 0} · {topology?.edgeCount ?? 0}</span>
        {routeNodeCount > 0 ? <span data-testid="graph-route-status">Route · {routeNodeCount}</span> : null}
        <OntologyReviewRow compact />
        <button aria-label="Frame graph" onClick={() => runtimeRef.current?.frameAll()} title="Frame graph" type="button"><Scan size={14} /></button>
        <button aria-label="Refresh graph" onClick={() => setReloadNonce((value) => value + 1)} title="Refresh graph" type="button"><RefreshCw size={14} /></button>
      </div>
      <div ref={viewportRef} className="spatial-graph__viewport" data-scene-ready={sceneReady ? "true" : "false"}>
        <canvas
          ref={webGpuCanvasRef}
          aria-hidden="true"
          className="spatial-graph__pixels"
        />
        <canvas
          ref={canvasRef}
          aria-describedby={keyboardHelpId}
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight + - [ ] Space Enter Escape"
          aria-label="Interactive knowledge graph"
          aria-roledescription="spatial knowledge graph"
          className="spatial-graph__interaction"
          onContextMenu={(event) => event.preventDefault()}
          onDoubleClick={graphInput.onDoubleClick}
          onKeyDown={graphInput.onKeyDown}
          onLostPointerCapture={graphInput.onPointerCancel}
          onPointerCancel={graphInput.onPointerCancel}
          onPointerDown={graphInput.onPointerDown}
          onFocus={onFocus}
          onPointerLeave={graphInput.onPointerLeave}
          onPointerMove={graphInput.onPointerMove}
          onPointerUp={graphInput.onPointerUp}
          onWheel={graphInput.onWheel}
          tabIndex={0}
        />
        <p className="sr-only" id={keyboardHelpId}>Left and right brackets select the previous or next Note. Arrow keys orbit. Plus and minus zoom. Space or F focuses the selected Note. O frames the graph. Enter opens the selected Note. Escape returns to editor context.</p>
        {loading ? <div className="spatial-graph__state spatial-graph__state--building"><GraphBuildingIndicator /></div> : null}
        {error ? (
          <button
            className="spatial-graph__state spatial-graph__state--error"
            onClick={() => { setError(null); setRendererNonce((value) => value + 1); }}
            type="button"
          >Graph unavailable · retry</button>
        ) : null}
      </div>
      <GraphConceptDetailPanel
        detail={selectedDetail}
        detailStatus={detailStatus}
        degree={runtimeRef.current?.getScene()?.interaction.selected ?? -1}
        topology={topology}
        onOpenTarget={onOpenTarget}
        onStartMaintenance={onStartMaintenance}
      />
    </div>
  );
}

function lookupReference(concept: InspectedConcept): GraphConceptLookupReference | null {
  if (concept.conceptId) return { conceptId: concept.conceptId };
  if (concept.filePath) return { filePath: concept.filePath };
  return null;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

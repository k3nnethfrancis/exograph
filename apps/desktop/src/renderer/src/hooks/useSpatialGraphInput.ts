import { useCallback, useRef, type KeyboardEvent, type PointerEvent, type RefObject, type WheelEvent } from "react";
import type { GraphTopology } from "@exograph/core";

import {
  graphEscapeDecision,
  graphNodeClickDecision,
  graphNodeDoubleClickIndex,
} from "../graphInteraction";
import {
  graphKeyboardIntent,
  panGraphCamera,
  pickGraphSceneNode,
  zoomGraphCameraAt,
} from "../graphSceneFoundation";
import {
  SpatialGraphPointerSession,
  type SpatialGraphRuntime,
  spatialGraphDollyDragScale,
  spatialGraphOrbitDelta,
  spatialGraphPointerAction,
  spatialGraphWheelIntent,
} from "../spatialGraphRuntime";

interface RecentGraphPick { index: number; clientX: number; clientY: number; at: number }

interface SpatialGraphInputOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  runtimeRef: RefObject<SpatialGraphRuntime | null>;
  topologyRef: RefObject<GraphTopology | null>;
  inverseNavigation: boolean;
  graphReturnPath?: string | null;
  selectedFilePath?: string;
  inspectIndex: (index: number) => Promise<void>;
  openIndex: (index: number) => Promise<void>;
  restoreSelection: (filePath: string) => Promise<void>;
  readSummaries: (indexes: readonly number[], sourceSnapshotId: string) => Promise<void>;
  setRouteNodeCount: (count: number) => void;
}

/** Adapts browser input into renderer-neutral graph navigation commands. */
export function useSpatialGraphInput(options: SpatialGraphInputOptions) {
  const pointerSessionRef = useRef(new SpatialGraphPointerSession());
  const recentPickRef = useRef<RecentGraphPick | null>(null);

  const pickAt = useCallback((clientX: number, clientY: number, pointerType = "mouse") => {
    const canvas = options.canvasRef.current;
    const scene = options.runtimeRef.current?.getScene();
    if (!canvas || !scene) return -1;
    const rect = canvas.getBoundingClientRect();
    return pickGraphSceneNode(
      scene.topology,
      scene.projection,
      scene.camera,
      clientX - rect.left,
      clientY - rect.top,
      { pointer: pointerType === "touch" || pointerType === "pen" ? "coarse" : "fine" },
    );
  }, [options.canvasRef, options.runtimeRef]);

  function onPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    if (pointerSessionRef.current.activePointers === 0) options.runtimeRef.current?.cancelMotion();
    pointerSessionRef.current.begin(pointerSample(event), spatialGraphPointerAction({
      button: event.button,
      pointerType: event.pointerType,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    }));
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const move = pointerSessionRef.current.move(pointerSample(event));
    if (move.kind === "hover") options.runtimeRef.current?.setHovered(pickAt(move.sample.x, move.sample.y, move.sample.pointerType));
    if (move.kind === "orbit") {
      const delta = spatialGraphOrbitDelta(move.deltaX, move.deltaY, options.inverseNavigation);
      options.runtimeRef.current?.orbit(delta.x, delta.y);
    }
    if (move.kind === "pan") options.runtimeRef.current?.pan(move.deltaX, move.deltaY);
    if (move.kind === "dolly") {
      const rect = options.canvasRef.current?.getBoundingClientRect();
      if (rect) options.runtimeRef.current?.zoomAt(move.x - rect.left, move.y - rect.top, spatialGraphDollyDragScale(move.deltaY));
    }
    if (move.kind !== "pinch-pan") return;
    const rect = options.canvasRef.current?.getBoundingClientRect();
    const runtime = options.runtimeRef.current;
    const scene = runtime?.getScene();
    if (!runtime || !scene || !rect) return;
    const zoomed = zoomGraphCameraAt(scene.camera, scene.projection.viewport, move.centerX - rect.left, move.centerY - rect.top, move.scale);
    runtime.setCamera(panGraphCamera(zoomed, move.panX, move.panY, scene.projection.viewport), "pinch-pan");
  }

  function onPointerUp(event: PointerEvent<HTMLCanvasElement>) {
    const ended = pointerSessionRef.current.end(event.pointerId);
    releasePointer(event);
    if (!ended.click || !ended.sample) return;
    const picked = pickAt(event.clientX, event.clientY, ended.sample.pointerType);
    if (picked >= 0) recentPickRef.current = { index: picked, clientX: event.clientX, clientY: event.clientY, at: performance.now() };
    const scene = options.runtimeRef.current?.getScene();
    const decision = graphNodeClickDecision(picked, scene?.interaction.selected ?? -1, event.shiftKey);
    if (decision.kind === "clear-route") {
      options.runtimeRef.current?.clearRoute();
      options.setRouteNodeCount(0);
    }
    if (decision.kind === "route") {
      options.runtimeRef.current?.setSelection(scene?.interaction.selected ?? -1, decision.index);
      options.setRouteNodeCount(pathNodeCount(options.runtimeRef.current));
      void options.readSummaries([decision.index], options.topologyRef.current?.sourceSnapshotId ?? "");
    }
    if (decision.kind === "inspect") void options.inspectIndex(decision.index);
  }

  function onPointerCancel(event: PointerEvent<HTMLCanvasElement>) {
    pointerSessionRef.current.cancel(event.pointerId);
    releasePointer(event);
  }

  function onDoubleClick(event: PointerEvent<HTMLCanvasElement>) {
    const recent = recentPickRef.current;
    const picked = graphNodeDoubleClickIndex({
      picked: pickAt(event.clientX, event.clientY, event.pointerType),
      recentIndex: recent?.index ?? -1,
      recentAgeMilliseconds: recent ? performance.now() - recent.at : Number.POSITIVE_INFINITY,
      recentDistancePixels: recent ? Math.hypot(event.clientX - recent.clientX, event.clientY - recent.clientY) : Number.POSITIVE_INFINITY,
    });
    recentPickRef.current = null;
    if (picked >= 0) void options.openIndex(picked);
  }

  function onWheel(event: WheelEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const canvas = options.canvasRef.current;
    const scene = options.runtimeRef.current?.getScene();
    if (!canvas || !scene) return;
    const rect = canvas.getBoundingClientRect();
    const intent = spatialGraphWheelIntent({
      ctrlKey: event.ctrlKey,
      deltaMode: event.deltaMode,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      viewportHeight: scene.projection.viewport.height,
    });
    options.runtimeRef.current?.zoomAt(event.clientX - rect.left, event.clientY - rect.top, intent.scale);
  }

  function onKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    const runtime = options.runtimeRef.current;
    const scene = runtime?.getScene();
    if (!runtime || !scene) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (runtime.snapshot().moving) return runtime.cancelMotion();
      const decision = graphEscapeDecision(scene.interaction.pathTarget >= 0, options.graphReturnPath, options.selectedFilePath);
      if (decision === "clear-route") {
        runtime.clearRoute();
        options.setRouteNodeCount(0);
      } else if (decision === "restore-editor" && options.graphReturnPath) {
        void options.restoreSelection(options.graphReturnPath);
      } else {
        runtime.setSelection(-1);
        options.setRouteNodeCount(0);
      }
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      if (scene.interaction.selected >= 0) runtime.focus(scene.interaction.selected, prefersReducedMotion());
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (scene.interaction.selected >= 0) void options.openIndex(scene.interaction.selected);
      return;
    }
    if (event.key === "[" || event.key === "]") {
      event.preventDefault();
      const nodeCount = options.topologyRef.current?.nodeCount ?? 0;
      if (nodeCount === 0) return;
      const direction = event.key === "]" ? 1 : -1;
      const selected = scene.interaction.selected;
      void options.inspectIndex(selected < 0 ? (direction > 0 ? 0 : nodeCount - 1) : (selected + direction + nodeCount) % nodeCount);
      return;
    }
    const intent = graphKeyboardIntent(scene.camera, event.key, scene.projection.viewport, event.shiftKey);
    if (intent.kind !== "none") event.preventDefault();
    if (intent.kind === "camera") runtime.setCamera(intent.camera, "keyboard");
    if (intent.kind === "frame") runtime.frameAll();
    if (intent.kind === "focus" && scene.interaction.selected >= 0) runtime.focus(scene.interaction.selected, prefersReducedMotion());
  }

  return {
    onDoubleClick,
    onKeyDown,
    onPointerCancel,
    onPointerDown,
    onPointerLeave: () => pointerSessionRef.current.activePointers === 0 && options.runtimeRef.current?.setHovered(-1),
    onPointerMove,
    onPointerUp,
    onWheel,
  };
}

function pathNodeCount(runtime: SpatialGraphRuntime | null): number {
  return runtime?.getScene()?.interaction.pathNodes.reduce((count, value) => count + Number(value > 0), 0) ?? 0;
}

function releasePointer(event: PointerEvent<HTMLCanvasElement>): void {
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
}

function pointerSample(event: PointerEvent<HTMLCanvasElement>) {
  return { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pointerType: event.pointerType };
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

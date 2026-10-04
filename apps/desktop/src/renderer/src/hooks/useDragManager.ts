/**
 * Manual drag manager — replaces HTML5 DnD which doesn't work in Electron.
 *
 * Tracks mousedown → mousemove → mouseup on draggable elements.
 * A drag starts after the mouse moves past a threshold (5px).
 * Drop targets are identified by finding the pane leaf under the cursor
 * and computing which edge zone the cursor falls in.
 * Documents can be rearranged or split only within editor panes. Preview and
 * Terminal are independent utility destinations, never canvas leaves.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DragPayload =
  | { kind: "document"; filePath: string; sourcePaneId?: string }
  | { kind: "terminal"; terminalId: string; sourcePaneId?: string }
  | { kind: "preview"; previewId: string; sourcePaneId?: string }
  | { kind: "workspace-path"; path: string; nodeKind: "file" | "directory"; paths?: string[] };

export interface DragState {
  payload: DragPayload;
  /** Current mouse position (viewport coords) */
  mouseX: number;
  mouseY: number;
}

export interface DragManager {
  /** Current drag in progress, or null */
  drag: DragState | null;
  /** Whether any drag is active (convenience for conditional rendering) */
  dragActive: boolean;
  /** Call from onMouseDown on a draggable element */
  startDrag: (event: React.MouseEvent, payload: DragPayload) => void;
  /** Which drop edge is currently hovered */
  hoverEdge: DragDropTarget | null;
}

export type DropEdge = "top" | "bottom" | "left" | "right" | "center";
export type PaneDropKind = "editor" | "terminal" | "browser";
export type PaneDropZone = "workspace";
export type DragDropTarget =
  | { kind: "pane"; leafId: string; edge: DropEdge; paneKind: PaneDropKind; paneZone: PaneDropZone }
  /**
   * A utility surface is a typed return destination. A terminal may return only
   * to the terminal surface and a preview only to Preview; neither is a drop
   * target for the other kind of live surface.
   */
  | { kind: "utility"; destination: "terminal" | "preview" }
  | { kind: "explorer"; targetPath: string; targetKind: "directory" | "file" };

const DRAG_THRESHOLD = 5;

export function acceptsUtilitySurface(
  payload: DragPayload,
  destination: string | undefined,
): destination is "terminal" | "preview" {
  return (payload.kind === "terminal" || payload.kind === "preview") && destination === payload.kind;
}

/** Canvas panes are a free composition surface: every pane kind may split with every payload kind. */
export function acceptsCanvasPane(
  paneKind: string | undefined,
  paneZone: string | undefined,
  payload: DragPayload,
): paneKind is PaneDropKind {
  if (paneZone !== "workspace") return false;
  return payload.kind === "document" || payload.kind === "terminal" || payload.kind === "preview" || (payload.kind === "workspace-path" && payload.nodeKind === "file")
    ? paneKind === "editor" || paneKind === "terminal" || paneKind === "browser"
    : false;
}

function acceptsTabTarget(tabKind: string | undefined, payload: DragPayload): tabKind is PaneDropKind {
  if (payload.kind === "document" || payload.kind === "terminal" || payload.kind === "preview") {
    return tabKind === "editor" || tabKind === "terminal" || tabKind === "browser";
  }
  if (payload.kind === "workspace-path") {
    return payload.nodeKind === "file" && (tabKind === "editor" || tabKind === "terminal" || tabKind === "browser");
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDragManager(
  onDrop: (target: DragDropTarget, payload: DragPayload) => void,
): DragManager {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hoverEdge, setHoverEdge] = useState<DragDropTarget | null>(null);

  // Refs to avoid stale closures in window event listeners
  const pendingRef = useRef<{
    payload: DragPayload;
    startX: number;
    startY: number;
  } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const startDrag = useCallback((event: React.MouseEvent, payload: DragPayload) => {
    // Only left button
    if (event.button !== 0) return;
    event.preventDefault();
    pendingRef.current = {
      payload,
      startX: event.clientX,
      startY: event.clientY,
    };
  }, []);

  useEffect(() => {
    function findExplorerTarget(x: number, y: number, payload: DragPayload): DragDropTarget | null {
      if (payload.kind !== "workspace-path") {
        return null;
      }

      const elements = document.elementsFromPoint(x, y);
      for (const element of elements) {
        const target = element instanceof HTMLElement ? element.closest<HTMLElement>("[data-explorer-drop-path]") : null;
        const targetPath = target?.dataset.explorerDropPath;
        if (!targetPath) continue;
        const targetKind = target.dataset.explorerDropKind === "file" ? "file" : "directory";
        return { kind: "explorer", targetPath, targetKind };
      }
      return null;
    }

    function findTabTarget(x: number, y: number, payload: DragPayload): DragDropTarget | null {
      const elements = document.elementsFromPoint(x, y);
      for (const element of elements) {
        const tab = element instanceof HTMLElement ? element.closest<HTMLElement>("[data-tab-drop-pane-id]") : null;
        if (!tab) continue;

        const leafId = tab.dataset.tabDropPaneId;
        if (!leafId || !acceptsTabTarget(tab.dataset.tabDropKind, payload)) continue;
        return { kind: "pane", leafId, edge: "center", paneKind: tab.dataset.tabDropKind, paneZone: "workspace" };
      }
      return null;
    }

    function findUtilityTarget(x: number, y: number, payload: DragPayload): DragDropTarget | null {
      if (payload.kind !== "terminal" && payload.kind !== "preview") {
        return null;
      }

      const elements = document.elementsFromPoint(x, y);
      for (const element of elements) {
        const target = element instanceof HTMLElement ? element.closest<HTMLElement>("[data-utility-drop-kind]") : null;
        const destination = target?.dataset.utilityDropKind;
        if (!acceptsUtilitySurface(payload, destination)) {
          continue;
        }
        return { kind: "utility", destination };
      }
      return null;
    }

    function findDropTarget(x: number, y: number, payload: DragPayload): DragDropTarget | null {
      const explorerTarget = findExplorerTarget(x, y, payload);
      if (explorerTarget) {
        return explorerTarget;
      }

      const utilityTarget = findUtilityTarget(x, y, payload);
      if (utilityTarget) {
        return utilityTarget;
      }

      const tabTarget = findTabTarget(x, y, payload);
      if (tabTarget) {
        return tabTarget;
      }

      const leaves = document.querySelectorAll<HTMLElement>("[data-pane-id]");
      for (const leaf of leaves) {
        if (!acceptsCanvasPane(leaf.dataset.paneKind, leaf.dataset.paneZone, payload)) continue;

        const rect = leaf.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;

        const leafId = leaf.dataset.paneId!;
        const relX = (x - rect.left) / rect.width;
        const relY = (y - rect.top) / rect.height;

        let edge: DropEdge;
        if (relY < 0.25) edge = "top";
        else if (relY > 0.75) edge = "bottom";
        else if (relX < 0.25) edge = "left";
        else if (relX > 0.75) edge = "right";
        else edge = "center";

        return {
          kind: "pane",
          leafId,
          edge,
          paneKind: leaf.dataset.paneKind,
          paneZone: "workspace",
        };
      }
      return null;
    }

    function onMouseMove(event: MouseEvent) {
      const pending = pendingRef.current;
      if (pending && !dragRef.current) {
        const dx = event.clientX - pending.startX;
        const dy = event.clientY - pending.startY;
        if (Math.abs(dx) + Math.abs(dy) >= DRAG_THRESHOLD) {
          const state: DragState = {
            payload: pending.payload,
            mouseX: event.clientX,
            mouseY: event.clientY,
          };
          dragRef.current = state;
          setDrag(state);
          setHoverEdge(findDropTarget(event.clientX, event.clientY, state.payload));
          document.body.style.cursor = "grabbing";
        }
        return;
      }

      if (dragRef.current) {
        const state: DragState = {
          ...dragRef.current,
          mouseX: event.clientX,
          mouseY: event.clientY,
        };
        dragRef.current = state;
        setDrag(state);

        // Update hover edge for visual feedback
        const hit = findDropTarget(event.clientX, event.clientY, state.payload);
        setHoverEdge(hit);
      }
    }

    function onMouseUp(event: MouseEvent) {
      const wasDragging = dragRef.current;

      if (wasDragging) {
        const hit = findDropTarget(event.clientX, event.clientY, wasDragging.payload);
        if (hit) {
          onDropRef.current(hit, wasDragging.payload);
        }

        // Suppress the click that would fire after drag ends
        window.addEventListener("click", suppressClick, { capture: true, once: true });
      }

      // Clean up
      pendingRef.current = null;
      dragRef.current = null;
      setDrag(null);
      setHoverEdge(null);
      document.body.style.cursor = "";
    }

    function suppressClick(event: MouseEvent) {
      event.stopPropagation();
      event.preventDefault();
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return {
    drag,
    dragActive: drag !== null,
    startDrag,
    hoverEdge,
  };
}

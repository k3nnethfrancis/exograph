import type { GraphProjectionState, GraphTopologyArrays } from "./graphSceneFoundation";

export type GraphNodeClickDecision =
  | { kind: "inspect"; index: number }
  | { kind: "route"; index: number }
  | { kind: "clear-route" };

export function graphNodeClickDecision(
  picked: number,
  selected: number,
  shiftKey: boolean,
): GraphNodeClickDecision {
  if (picked < 0) return { kind: "clear-route" };
  if (shiftKey && selected >= 0 && picked !== selected) return { kind: "route", index: picked };
  return { kind: "inspect", index: picked };
}

export type GraphNodeDoubleClickDecision = "open" | "focus" | "focus-node";

export function graphNodeDoubleClickDecision(target: string | null, alreadyOpen: boolean): GraphNodeDoubleClickDecision {
  if (!target) return "focus-node";
  return alreadyOpen ? "focus" : "open";
}

export function graphConceptDisplayKind(concept: {
  filePath?: string;
  resolution: "resolved" | "unresolved" | "ambiguous" | "external";
  conceptTypes: readonly string[];
}): string {
  if (concept.filePath) return concept.conceptTypes.join(" · ") || "Note";
  if (concept.resolution === "external") return "External reference";
  if (concept.resolution === "ambiguous") return "Ambiguous reference";
  if (concept.resolution === "unresolved") return "Unresolved reference";
  return concept.conceptTypes.join(" · ") || "Graph concept";
}

export function graphNodeDoubleClickIndex(input: {
  picked: number;
  recentIndex: number;
  recentAgeMilliseconds: number;
  recentDistancePixels: number;
}): number {
  const recentPickIsSameGesture = input.recentIndex >= 0
    && input.recentAgeMilliseconds <= 650
    && input.recentDistancePixels <= 7;
  return recentPickIsSameGesture ? input.recentIndex : input.picked;
}

export type GraphEscapeDecision = "clear-route" | "restore-editor" | "none";

export function graphEscapeDecision(
  hasRoute: boolean,
  activeEditorPath: string | null | undefined,
  inspectedPath: string | null | undefined,
): GraphEscapeDecision {
  if (hasRoute) return "clear-route";
  if (activeEditorPath && activeEditorPath !== inspectedPath) return "restore-editor";
  return "none";
}

/** Follow an incident edge in screen space; never jump to an unrelated node. */
export function graphDirectionalNeighbor(
  topology: GraphTopologyArrays,
  projection: GraphProjectionState,
  selected: number,
  key: string,
): number {
  const direction = key === "ArrowLeft" ? [-1, 0] : key === "ArrowRight" ? [1, 0]
    : key === "ArrowUp" ? [0, -1] : key === "ArrowDown" ? [0, 1] : null;
  if (!direction) return -1;
  const count = topology.nodes.seeds.length;
  if (selected < 0 || selected >= count) {
    let nearest = -1;
    let distance = Infinity;
    for (let index = 0; index < count; index += 1) {
      if (projection.nodes[index * 4 + 3] !== 1) continue;
      const next = Math.hypot(projection.nodes[index * 4] - projection.viewport.width / 2,
        projection.nodes[index * 4 + 1] - projection.viewport.height / 2);
      if (next < distance) { nearest = index; distance = next; }
    }
    return nearest;
  }
  const x = projection.nodes[selected * 4];
  const y = projection.nodes[selected * 4 + 1];
  let best = -1;
  let bestAlignment = -Infinity;
  let bestDistance = Infinity;
  for (let offset = 0; offset < topology.edges.endpoints.length; offset += 2) {
    const source = topology.edges.endpoints[offset];
    const target = topology.edges.endpoints[offset + 1];
    const candidate = source === selected ? target : target === selected ? source : -1;
    if (candidate < 0 || candidate >= count || candidate === selected) continue;
    const depth = projection.nodes[candidate * 4 + 2];
    if (!(depth > 0 && depth <= 1)) continue;
    const dx = projection.nodes[candidate * 4] - x;
    const dy = projection.nodes[candidate * 4 + 1] - y;
    const forward = dx * direction[0] + dy * direction[1];
    if (forward <= 0) continue;
    const distance = Math.hypot(dx, dy);
    const alignment = forward / distance;
    if (alignment > bestAlignment || (alignment === bestAlignment
      && (distance < bestDistance || (distance === bestDistance && candidate < best)))) {
      best = candidate;
      bestAlignment = alignment;
      bestDistance = distance;
    }
  }
  return best;
}

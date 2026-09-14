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

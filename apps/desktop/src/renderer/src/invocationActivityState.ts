import type { AgentCommand, InvocationRecord } from "@exograph/core";
import {
  invocationActivityLabel,
  type InvocationActivityEvent,
} from "@exograph/core/invocation-activity";

import type { InvocationActivityKind as InvocationSurfaceKind } from "./components/invocation";

export interface InvocationActivityState {
  invocationId: string | null;
  paneId?: string;
  kind: InvocationSurfaceKind;
  commandHandle: string;
  commandLabel: string;
  commandAppearance?: AgentCommand["appearance"];
  label?: string;
  errorDetail?: string;
  providerSessionId?: string;
  protocolInvocationId?: string;
}

const INVOCATION_ERROR_DETAIL_LIMIT = 180;
const MAX_EARLY_INVOCATION_IDS = 8;
const MAX_EARLY_INVOCATION_EVENTS = 16;

export type EarlyInvocationActivityEvents = Map<string, InvocationActivityEvent[]>;

export function bufferEarlyInvocationActivityEvent(
  buffered: EarlyInvocationActivityEvents,
  event: InvocationActivityEvent,
) {
  const events = buffered.get(event.invocationId) ?? [];
  buffered.delete(event.invocationId);
  buffered.set(event.invocationId, [...events, event].slice(-MAX_EARLY_INVOCATION_EVENTS));
  while (buffered.size > MAX_EARLY_INVOCATION_IDS) {
    const oldest = buffered.keys().next().value;
    if (oldest === undefined) break;
    buffered.delete(oldest);
  }
}

export function takeEarlyInvocationActivityEvents(
  buffered: EarlyInvocationActivityEvents,
  invocationId: string,
): InvocationActivityEvent[] {
  const events = buffered.get(invocationId) ?? [];
  buffered.clear();
  return events;
}

export function beginInvocationActivity(
  command: Pick<AgentCommand, "handle" | "label" | "appearance">,
  paneId?: string,
  protocolInvocationId?: string,
): InvocationActivityState {
  return {
    invocationId: null,
    ...(paneId ? { paneId } : {}),
    ...(protocolInvocationId ? { protocolInvocationId } : {}),
    kind: "working",
    commandHandle: command.handle,
    commandLabel: command.label,
    ...(command.appearance ? { commandAppearance: command.appearance } : {}),
  };
}

/** A synchronous, truthful acknowledgement while Exograph checks launch authority. */
export function acknowledgeInvocationActivity(
  command: Pick<AgentCommand, "handle" | "label" | "appearance">,
  paneId?: string,
  protocolInvocationId?: string,
): InvocationActivityState {
  return {
    invocationId: null,
    ...(paneId ? { paneId } : {}),
    ...(protocolInvocationId ? { protocolInvocationId } : {}),
    kind: "checking",
    commandHandle: command.handle,
    commandLabel: command.label,
    ...(command.appearance ? { commandAppearance: command.appearance } : {}),
  };
}

export function failInvocationActivity(
  command: Pick<AgentCommand, "handle" | "label" | "appearance">,
  error?: unknown,
  paneId?: string,
): InvocationActivityState {
  return {
    invocationId: null,
    ...(paneId ? { paneId } : {}),
    kind: "failed",
    commandHandle: command.handle,
    commandLabel: command.label,
    ...(command.appearance ? { commandAppearance: command.appearance } : {}),
    errorDetail: boundedInvocationErrorDetail(error),
  };
}

export function failActiveInvocationActivity(
  current: InvocationActivityState | null,
  error?: unknown,
): InvocationActivityState | null {
  if (!current) return null;
  return {
    ...current,
    kind: "failed",
    label: undefined,
    errorDetail: boundedInvocationErrorDetail(error),
  };
}

export function applyInvocationActivityEvent(
  current: InvocationActivityState | null,
  event: InvocationActivityEvent,
): InvocationActivityState | null {
  if (!current || current.kind === "review" || current.kind === "done" || current.kind === "stopped" || current.kind === "failed") return current;
  // An event cannot establish identity. Launch returns the authoritative
  // record; callers may buffer early events until that exact ID is known.
  if (!current.invocationId || current.invocationId !== event.invocationId) return current;
  const label = invocationActivityLabel(event.label);
  if (event.kind === "done" || event.kind === "stopped" || event.kind === "failed") {
    return { ...current, kind: event.kind, label: undefined, errorDetail: undefined };
  }
  return {
    ...current,
    invocationId: event.invocationId,
    // Trace adapters enrich the copy only. The command process owns lifecycle.
    kind: "working",
    errorDetail: undefined,
    ...(label ? { label: activitySummary(event.kind, label) } : { label: undefined }),
  };
}

function activitySummary(kind: InvocationActivityEvent["kind"], label: string): string {
  if (kind === "reading") return `Reading ${label}`;
  if (kind === "searching") return `Searching ${label}`;
  if (kind === "editing") return `Editing ${label}`;
  if (kind === "running") return `Running ${label}`;
  return label;
}

export function bindInvocationActivity(
  current: InvocationActivityState | null,
  record: InvocationRecord,
  earlyEvents: readonly InvocationActivityEvent[],
): InvocationActivityState {
  return earlyEvents
    .filter((event) => event.invocationId === record.id)
    .reduce<InvocationActivityState>(
      (state, event) => applyInvocationActivityEvent(state, event) ?? state,
      applyInvocationRecord(current, record),
    );
}

export function applyInvocationRecord(
  current: InvocationActivityState | null,
  record: InvocationRecord,
): InvocationActivityState {
  if (current?.invocationId && current.invocationId !== record.id) return current;
  const sameInvocation = current?.invocationId === null || current?.invocationId === record.id;
  const activeKind = sameInvocation && current && current.kind !== "done" && current.kind !== "stopped" && current.kind !== "failed"
    ? current.kind
    : "working";
  const reviewReady = Boolean(record.changeset?.files.some((change) =>
    change.decision.status === "pending" || change.decision.status === "conflict"));
  const reviewResolvedWhileRunning = Boolean(record.changeset && !reviewReady && (record.status === "pending" || record.status === "running"));
  const kind: InvocationSurfaceKind = record.status === "failed" || record.status === "orphaned"
    ? "failed"
    : record.status === "user-ended"
      ? "stopped"
      : reviewReady
        ? "review"
      : reviewResolvedWhileRunning
        ? "done"
      : record.status === "pending" || record.status === "running"
        ? activeKind
        : "done";
  return {
    invocationId: record.id,
    ...(current?.paneId ? { paneId: current.paneId } : {}),
    kind,
    commandHandle: record.command.handle,
    commandLabel: record.command.label,
    ...(record.command.appearance ? { commandAppearance: record.command.appearance } : {}),
    ...(kind === "failed" ? { errorDetail: boundedInvocationErrorDetail(record.failureReason) } : {}),
    ...(kind === activeKind && current?.label ? { label: current.label } : {}),
    ...(record.providerSessionId ? { providerSessionId: record.providerSessionId } : {}),
    ...(record.protocolInvocationId ? { protocolInvocationId: record.protocolInvocationId } : current?.protocolInvocationId ? { protocolInvocationId: current.protocolInvocationId } : {}),
  };
}

export function resolveInvocationActivityPaneId(
  originPaneId: string | undefined,
  editorPaneIds: readonly string[],
  focusedPaneId: string,
): string | null {
  if (originPaneId && editorPaneIds.includes(originPaneId)) return originPaneId;
  if (editorPaneIds.includes(focusedPaneId)) return focusedPaneId;
  return editorPaneIds[0] ?? null;
}

/** Keep provider failures useful without turning the activity shell into a log viewer. */
export function boundedInvocationErrorDetail(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "The invocation could not finish.";
  const normalized = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/(^|[\s(\"'=])\/(?:[^\s\"'<>()[\]{}]+\/?)+/g, "$1this folder")
    .replace(/\s+/g, " ")
    .trim() || "The invocation could not finish.";
  return normalized.length <= INVOCATION_ERROR_DETAIL_LIMIT
    ? normalized
    : `${normalized.slice(0, INVOCATION_ERROR_DETAIL_LIMIT - 1).trimEnd()}…`;
}

export function invocationCommandPresentation(
  handle: string,
  commands: readonly AgentCommand[],
): Pick<AgentCommand, "handle" | "label" | "appearance"> {
  const configured = commands.find((command) => command.handle === handle);
  return configured
    ? { handle: configured.handle, label: configured.label, ...(configured.appearance ? { appearance: configured.appearance } : {}) }
    : { handle, label: handle.charAt(0).toUpperCase() + handle.slice(1) };
}

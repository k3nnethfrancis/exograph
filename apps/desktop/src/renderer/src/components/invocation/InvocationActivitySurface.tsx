import {
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleStop,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, type CSSProperties, type FocusEvent, type MouseEvent, type ReactNode } from "react";

import { AgentCommandIcon } from "../AgentCommandIcon";
import type { AgentCommandAppearance } from "@exograph/core/agent-command-configuration";
import "./invocation-ui.css";
import type { InvocationReviewPosition } from "./InvocationReviewControls";

export type InvocationActivityKind =
  | "checking"
  | "working"
  | "review"
  | "done"
  | "stopped"
  | "failed";

export interface InvocationActivitySurfaceProps {
  kind: InvocationActivityKind;
  commandHandle: string;
  commandAppearance?: AgentCommandAppearance;
  commandLabel?: string;
  label?: string;
  errorDetail?: string;
  autoDismissMs?: number;
  onStop?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
  onResume?: () => void;
  onShowDetails?: () => void;
  position?: InvocationReviewPosition;
}

export function InvocationActivitySurface({
  kind,
  commandHandle,
  commandAppearance,
  commandLabel,
  label,
  errorDetail,
  autoDismissMs = 1_800,
  onStop,
  onRetry,
  onDismiss,
  onResume,
  onShowDetails,
  position,
}: InvocationActivitySurfaceProps) {
  const autoDismiss = useHoverFocusAutoDismiss({
    enabled: (kind === "done" || kind === "stopped") && Boolean(onDismiss),
    delayMs: autoDismissMs,
    onDismiss,
  });
  const failed = kind === "failed";
  const terminal = kind === "done" || kind === "stopped";
  const active = !failed && !terminal && kind !== "review";
  const style = position ? {
    "--invocation-activity-left": `${position.left}px`,
    "--invocation-activity-top": `${position.top}px`,
    "--invocation-activity-origin": position.origin ?? "top left",
  } as CSSProperties : undefined;

  return (
    <aside
      aria-atomic="true"
      aria-live="polite"
      className={`invocation-activity invocation-activity--${failed ? "failed" : terminal ? "done" : "active"}`}
      data-testid="invocation-activity"
      onBlur={autoDismiss.onBlur}
      onFocus={autoDismiss.onFocus}
      onMouseEnter={autoDismiss.onMouseEnter}
      onMouseLeave={autoDismiss.onMouseLeave}
      role="status"
      data-positioned={position ? "true" : "false"}
      style={style}
    >
      <span className={`invocation-agent-mark invocation-agent-mark--${agentKind(commandHandle)}`}>
        <AgentCommandIcon command={{ handle: commandHandle, appearance: commandAppearance }} size={15} />
      </span>
      <ActivityStateIcon kind={kind} />
      <div className="invocation-activity__copy">
        <strong>{activityTitle(kind)}</strong>
        <span>{failed ? errorDetail ?? `${commandLabel ?? commandHandle} could not finish.` : label ?? commandLabel ?? `@${commandHandle}`}</span>
      </div>
      <div aria-label="Invocation actions" className="invocation-activity__actions" role="group">
        {active && onStop ? (
          <IconAction label="Stop" onClick={onStop}><CircleStop size={14} /></IconAction>
        ) : null}
        {failed && onRetry ? (
          <IconAction label="Retry" onClick={onRetry}><RotateCcw size={14} /></IconAction>
        ) : null}
        {onResume ? (
          <IconAction label="Resume in Terminal" onClick={onResume}><ArrowUpRight size={14} /></IconAction>
        ) : null}
        {failed && errorDetail && onShowDetails ? (
          <button className="invocation-activity__details" onClick={onShowDetails} type="button">Details</button>
        ) : null}
        {(failed || terminal) && onDismiss ? (
          <IconAction label="Dismiss" onClick={onDismiss}><X size={14} /></IconAction>
        ) : null}
      </div>
    </aside>
  );
}

function ActivityStateIcon({ kind }: { kind: InvocationActivityKind }) {
  if (kind === "review") return <Check aria-hidden="true" className="invocation-activity__state" size={15} />;
  if (kind === "done") return <Check aria-hidden="true" className="invocation-activity__state" size={15} />;
  if (kind === "stopped") return <CircleStop aria-hidden="true" className="invocation-activity__state" size={15} />;
  if (kind === "failed") return <CircleAlert aria-hidden="true" className="invocation-activity__state" size={15} />;
  return <LoaderCircle aria-hidden="true" className="invocation-activity__state invocation-activity__state--working" size={15} />;
}

function agentKind(handle: string): "claude" | "codex" | "default" {
  return handle === "claude" || handle === "codex" ? handle : "default";
}

export function activityTitle(kind: InvocationActivityKind): string {
  const base = kind === "checking" ? "Starting"
    : kind === "working" ? "Working"
      : kind === "review" ? "Review"
      : kind === "done" ? "Done"
        : kind === "stopped" ? "Stopped"
        : "Failed";
  return base;
}

function IconAction({ label, onClick, children }: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button aria-label={label} className="invocation-icon-action" onClick={onClick} title={label} type="button">
      {children}
    </button>
  );
}

interface AutoDismissInput {
  enabled: boolean;
  delayMs: number;
  onDismiss?: () => void;
}

export function useHoverFocusAutoDismiss({ enabled, delayMs, onDismiss }: AutoDismissInput) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remainingRef = useRef(delayMs);
  const startedAtRef = useRef(0);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const start = useCallback(() => {
    clear();
    if (!enabled || !onDismiss) return;
    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(onDismiss, Math.max(0, remainingRef.current));
  }, [clear, enabled, onDismiss]);

  const pause = useCallback(() => {
    if (!timerRef.current) return;
    remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
    clear();
  }, [clear]);

  useEffect(() => {
    remainingRef.current = delayMs;
    start();
    return clear;
  }, [clear, delayMs, start]);

  const resume = useCallback(() => {
    if (hoveredRef.current || focusedRef.current) return;
    if (remainingRef.current <= 0) remainingRef.current = delayMs;
    start();
  }, [delayMs, start]);

  return {
    onMouseEnter: (_event: MouseEvent<HTMLElement>) => {
      hoveredRef.current = true;
      pause();
    },
    onMouseLeave: (_event: MouseEvent<HTMLElement>) => {
      hoveredRef.current = false;
      resume();
    },
    onFocus: (_event: FocusEvent<HTMLElement>) => {
      focusedRef.current = true;
      pause();
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        focusedRef.current = false;
        resume();
      }
    },
  };
}

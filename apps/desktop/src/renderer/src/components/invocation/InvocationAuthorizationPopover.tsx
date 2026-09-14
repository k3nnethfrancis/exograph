import { ChevronDown } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { AgentCommandIcon } from "../AgentCommandIcon";
import type { AgentCommandAppearance } from "@exograph/core/agent-command-configuration";
import "./invocation-ui.css";

export type InvocationAuthorizationDecision = "once" | "workspace";

export interface InvocationAuthorizationDetails {
  command: string;
  cwd: string;
  adapter: string;
  continuity: string;
  fingerprint?: string | null;
  reason: string;
}

export interface InvocationPopoverPosition {
  left: number;
  top: number;
  origin?: string;
}

export interface InvocationAuthorizationPopoverProps {
  commandLabel: string;
  commandHandle: string;
  commandAppearance?: AgentCommandAppearance;
  request: string;
  details: InvocationAuthorizationDetails;
  position?: InvocationPopoverPosition;
  onAuthorize: (decision: InvocationAuthorizationDecision) => void;
  onCancel: () => void;
  onReturnFocus?: () => void;
}

export function InvocationAuthorizationPopover({
  commandLabel,
  commandHandle,
  commandAppearance,
  request,
  details,
  position,
  onAuthorize,
  onCancel,
  onReturnFocus,
}: InvocationAuthorizationPopoverProps) {
  const titleId = useId();
  const descriptionId = useId();
  const popoverRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    popoverRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, []);

  const close = (decision: () => void) => {
    const previousFocus = previousFocusRef.current;
    decision();
    requestAnimationFrame(() => {
      if (onReturnFocus) {
        onReturnFocus();
      } else {
        previousFocus?.focus();
      }
    });
  };
  const cancel = () => close(onCancel);
  const authorize = (decision: InvocationAuthorizationDecision) => close(() => onAuthorize(decision));

  const style = position
    ? ({
        "--invocation-popover-left": `${position.left}px`,
        "--invocation-popover-top": `${position.top}px`,
        "--invocation-popover-origin": position.origin ?? "top left",
      } as CSSProperties)
    : undefined;

  return (
    <section
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="invocation-authorization-popover"
      data-positioned={position ? "true" : "false"}
      onKeyDown={(event) => trapAuthorizationFocus(event, popoverRef.current, cancel)}
      ref={popoverRef}
      role="dialog"
      style={style}
    >
      <header className="invocation-authorization-popover__header">
        <span className={`invocation-agent-mark invocation-agent-mark--${agentKind(commandHandle)}`}>
          <AgentCommandIcon command={{ handle: commandHandle, appearance: commandAppearance }} size={15} />
        </span>
        <div>
          <strong id={titleId}>Run {commandLabel}?</strong>
          <span>@{commandHandle}</span>
        </div>
      </header>

      <p className="invocation-authorization-popover__request">{request}</p>
      <p className="invocation-authorization-popover__disclosure" id={descriptionId}>
        Runs locally with this agent&apos;s existing permissions.
      </p>

      <details className="invocation-authorization-popover__details">
        <summary>
          <ChevronDown aria-hidden="true" size={13} strokeWidth={1.8} />
          Details
        </summary>
        <dl>
          <DetailRow label="Command" value={details.command} />
          <DetailRow label="Folder" value={details.cwd} />
          <DetailRow label="Adapter" value={details.adapter} />
          <DetailRow label="Context" value={details.continuity} />
          {details.fingerprint ? <DetailRow label="Fingerprint" value={details.fingerprint} /> : null}
          <DetailRow label="Reason" value={details.reason} />
        </dl>
      </details>

      <footer className="invocation-authorization-popover__actions">
        <button className="invocation-ui-button invocation-ui-button--quiet" onClick={cancel} type="button">
          Cancel
        </button>
        <button
          className="invocation-ui-button"
          data-autofocus
          onClick={() => authorize("once")}
          type="button"
        >
          Run once
        </button>
        <button
          className="invocation-ui-button invocation-ui-button--primary"
          onClick={() => authorize("workspace")}
          type="button"
        >
          Always allow here
        </button>
      </footer>
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd title={value}>{value}</dd></div>;
}

function agentKind(handle: string): "claude" | "codex" | "default" {
  return handle === "claude" || handle === "codex" ? handle : "default";
}

export function trapAuthorizationFocus(
  event: KeyboardEvent<HTMLElement>,
  container: HTMLElement | null,
  cancel: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancel();
    return;
  }
  if (event.key !== "Tab" || !container) return;

  const focusable = authorizationFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const nextIndex = nextAuthorizationFocusIndex(
    focusable.indexOf(document.activeElement as HTMLElement),
    focusable.length,
    event.shiftKey,
  );
  if (nextIndex === null) return;
  event.preventDefault();
  focusable[nextIndex]?.focus();
}

export function nextAuthorizationFocusIndex(
  currentIndex: number,
  length: number,
  backwards: boolean,
): number | null {
  if (length <= 0) return null;
  if (currentIndex < 0) return backwards ? length - 1 : 0;
  if (!backwards && currentIndex === length - 1) return 0;
  if (backwards && currentIndex === 0) return length - 1;
  return currentIndex + (backwards ? -1 : 1);
}

function authorizationFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not([disabled]), summary, [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])",
  )).filter((element) => !element.hasAttribute("hidden"));
}

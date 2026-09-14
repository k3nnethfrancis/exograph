import { useEffect, useRef } from "react";
import { Plus, SquareTerminal, X } from "lucide-react";

import type { TerminalSessionInfo } from "../../../shared/api";
import { isTerminalInputEnabled } from "../terminalSessions";
import type { ExographThemeVariant } from "../theme/types";
import { ChromeTab } from "./Chrome";
import type { TerminalHydrationReason } from "./terminalHydration";
import type { DragManager } from "../hooks/useDragManager";
import { focusTerminal } from "./terminalRegistry";
import { TerminalView } from "./TerminalView";

interface TerminalDockProps {
  paneId: string;
  theme: ExographThemeVariant;
  compact: boolean;
  empty: boolean;
  focused: boolean;
  sessions: TerminalSessionInfo[];
  activeTerminalId: string | null;
  hydrationSnapshots: Record<string, string>;
  hydrationVersions: Record<string, number>;
  hydrationReasons: Record<string, TerminalHydrationReason>;
  hydratingTerminalIds: ReadonlySet<string>;
  fontSize: number;
  scrollbackLines: number;
  onFocus: () => void;
  onHydrate: (id: string, options?: { force?: boolean; reason?: "bootstrap" | "refresh" }) => void;
  onHydrated: (id: string) => void;
  onSetActiveTerminal: (id: string) => void;
  onWrite: (id: string, data: string) => void;
  onGeometryMeasured: (id: string, cols: number, rows: number) => void;
  onKill: (id: string) => void;
  onCreateTerminal: () => void;
  dragManager?: DragManager;
  onClosePane?: () => void;
}

export function TerminalDock(props: TerminalDockProps) {
  const {
    paneId,
    theme,
    compact,
    empty,
    focused,
    sessions,
    activeTerminalId,
    hydrationSnapshots,
    hydrationVersions,
    hydrationReasons,
    hydratingTerminalIds,
    fontSize,
    scrollbackLines,
    onFocus,
    onHydrate,
    onHydrated,
    onSetActiveTerminal,
    onWrite,
    onGeometryMeasured,
    onKill,
    onCreateTerminal,
    dragManager,
    onClosePane,
  } = props;
  const activeSession = sessions.find((session) => session.id === activeTerminalId) ?? null;
  const terminalWritable = activeSession ? isTerminalInputEnabled(activeSession) : true;
  const terminalHydrating = Boolean(activeSession && hydratingTerminalIds.has(activeSession.id));
  const inputEnabled = terminalWritable && !terminalHydrating;
  const hydrateRef = useRef(onHydrate);

  useEffect(() => {
    hydrateRef.current = onHydrate;
  }, [onHydrate]);

  useEffect(() => {
    if (activeSession) {
      focusTerminalAfterPaneActivation(activeSession.id);
    }
  }, [activeSession?.id]);

  function focusTerminalAfterPaneActivation(sessionId: string | null) {
    if (!sessionId) {
      return;
    }
    // Pane/tab activation can commit React layout before xterm has measurable
    // dimensions. Focus once after paint and once after the current event loop
    // so first-click terminal input works without forcing a hydration replay.
    window.requestAnimationFrame(() => {
      focusTerminal(sessionId);
      window.setTimeout(() => focusTerminal(sessionId), 0);
    });
  }

  return (
    <section
      className={`terminal-dock ${compact ? "terminal-dock--compact" : ""} ${empty ? "terminal-dock--empty" : ""}`}
      data-testid="terminal-dock"
      onMouseDown={() => {
        onFocus();
        focusTerminalAfterPaneActivation(activeTerminalId);
      }}
    >
      <div className="terminal-dock__main">
        <div className="terminal-dock__content">
          <div className="terminal-dock__header">
            <div className="terminal-dock__tabs">
              {sessions.map((session) => (
                <ChromeTab
                  key={session.id}
                  active={session.id === activeTerminalId}
                  className="terminal-tab"
                  testId={`terminal-tab-${session.kind}`}
                  itemId={session.id}
                  dropPaneId={paneId}
                  dropKind="terminal"
                  onClick={() => {
                    onSetActiveTerminal(session.id);
                    focusTerminalAfterPaneActivation(session.id);
                  }}
                  onMouseDown={(event) => dragManager?.startDrag(event, { kind: "terminal", terminalId: session.id, sourcePaneId: paneId })}
                  title={`${session.title} · ${session.health ?? session.status}${session.healthDetail ? ` · ${session.healthDetail}` : ""}`}
                  leading={<SquareTerminal size={12} />}
                  closeLabel={onClosePane ? `Return ${session.title} to utility panel` : `Close ${session.title}`}
                  closeTestId={`close-terminal-${session.kind}`}
                  closeIcon={<X size={12} />}
                  onClose={(event) => {
                    event.stopPropagation();
                    if (onClosePane) onClosePane();
                    else onKill(session.id);
                  }}
                >
                  <span className={`status-dot status-dot--${session.health ?? session.status}`} />
                  {session.title}
                </ChromeTab>
              ))}
              <button aria-label="New terminal" className="terminal-dock__new" data-testid="new-terminal" onClick={onCreateTerminal} title="New terminal" type="button">
                <Plus size={14} aria-hidden="true" />
              </button>
            </div>
          </div>

          {activeSession ? (
            <div className="terminal-dock__terminal-frame">
              <TerminalView
                key={`${activeSession.id}:${activeSession.attachGeneration}`}
                theme={theme}
                session={activeSession}
                focused={focused}
                hydrationSnapshot={hydrationSnapshots[activeSession.id] ?? ""}
                hydrationVersion={hydrationVersions[activeSession.id] ?? 0}
                hydrationReason={hydrationReasons[activeSession.id] ?? "bootstrap"}
                fontSize={fontSize}
                scrollbackLines={scrollbackLines}
                onFocus={onFocus}
                onInput={onWrite}
                onGeometryMeasured={onGeometryMeasured}
                onReady={(id) => hydrateRef.current(id)}
                onHydrated={onHydrated}
                inputEnabled={inputEnabled}
              />
            </div>
          ) : !empty ? (
            <div className="terminal-dock__empty">No terminals yet.</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

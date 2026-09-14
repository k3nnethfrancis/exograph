import { X } from "lucide-react";

import type { GraphFocusRequest, InspectedConcept } from "../hooks/useInspectedConcept";
import { SpatialGraphView } from "./SpatialGraphView";
import { ExographMark } from "./ExographMark";

interface GraphPaneProps {
  inverseNavigation: boolean;
  showOverflowLabels: boolean;
  onClose: () => void;
  onFocus: () => void;
  onOpenTarget: (target: string) => void;
  inspectedConcept: InspectedConcept | null;
  focusRequest: GraphFocusRequest | null;
  graphReturnPath?: string | null;
  isTargetOpen: (target: string) => boolean;
  onRestoreEditorConcept: (filePath: string) => void;
  onActivateOpenTarget: (filePath: string) => void;
  onStartMaintenance: (filePath: string) => void;
}

export function GraphPane(props: GraphPaneProps) {
  return (
    <section className="graph-pane" data-testid="graph-pane">
      <header className="graph-pane__header">
        <div className="graph-pane__title"><ExographMark size={14} /><span>Graph</span></div>
        <button aria-label="Close graph" onClick={props.onClose} title="Close graph" type="button"><X size={14} /></button>
      </header>
      <SpatialGraphView
        inverseNavigation={props.inverseNavigation}
        showOverflowLabels={props.showOverflowLabels}
        inspectedConcept={props.inspectedConcept}
        focusRequest={props.focusRequest}
        graphReturnPath={props.graphReturnPath}
        isTargetOpen={props.isTargetOpen}
        onRestoreEditorConcept={props.onRestoreEditorConcept}
        onActivateOpenTarget={props.onActivateOpenTarget}
        onOpenTarget={props.onOpenTarget}
        onStartMaintenance={props.onStartMaintenance}
        onFocus={props.onFocus}
      />
    </section>
  );
}

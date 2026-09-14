import { Link2 } from "lucide-react";
import type { BoundedGraphConceptDetail, GraphTopology } from "@exograph/core";

import { graphConceptDisplayKind } from "../graphInteraction";

interface GraphConceptDetailPanelProps {
  detail: BoundedGraphConceptDetail | null;
  detailStatus: string | null;
  degree: number;
  topology: GraphTopology | null;
  onOpenTarget: (target: string) => void;
  onStartMaintenance: (filePath: string) => void;
}

/** Presents bounded graph metadata without participating in graph navigation. */
export function GraphConceptDetailPanel({
  detail,
  detailStatus,
  degree,
  topology,
  onOpenTarget,
  onStartMaintenance,
}: GraphConceptDetailPanelProps) {
  if (!detail) {
    return <div aria-live="polite" className="spatial-graph__hint">{detailStatus ?? "Drag to orbit · right-drag to pan · scroll to zoom"}</div>;
  }

  const concept = detail.concept;
  const properties = detail.properties.filter(({ key }) => !["title", "tags", "type"].includes(key)).slice(0, 4);
  return (
    <div aria-live="polite" className="spatial-graph__detail">
      <div className="spatial-graph__detail-heading">
        {concept.filePath
          ? <button className="spatial-graph__detail-title" onClick={() => onOpenTarget(concept.filePath!)} type="button">{concept.label}</button>
          : <span className="spatial-graph__detail-title spatial-graph__detail-title--reference">{concept.label}</span>}
        <span className="spatial-graph__detail-count">{degree >= 0 ? topology?.nodes.degrees[degree] ?? 0 : 0} links</span>
      </div>
      <details className="spatial-graph__disclosure">
        <summary>Details</summary>
        <div className="spatial-graph__detail-meta">{graphConceptDisplayKind(concept)}</div>
        {concept.relativePath ? <div className="spatial-graph__path">{concept.relativePath}</div> : null}
        {properties.length ? <div className="spatial-graph__detail-properties">{properties.map(({ key, value }) => <span key={key}><b>{key}</b>{compactValue(value)}</span>)}</div> : null}
        {concept.filePath ? (
          <button
            className="spatial-graph__maintenance"
            onClick={() => onStartMaintenance(concept.filePath!)}
            type="button"
          >
            <Link2 aria-hidden="true" size={14} />
            Find relevant connections
          </button>
        ) : null}
      </details>
      {detail.findings.length ? <div className="spatial-graph__finding">{detail.findings[0]?.message}</div> : null}
      {detailStatus ? <div className="spatial-graph__finding">{detailStatus}</div> : null}
    </div>
  );
}

function compactValue(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return rendered.length > 42 ? `${rendered.slice(0, 39)}…` : rendered;
}

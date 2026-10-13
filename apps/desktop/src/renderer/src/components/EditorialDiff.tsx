import type { ReactNode } from "react";
import { presentableDiff } from "@codemirror/merge";
export function EditorialDiff({base,replacement}:{base:string;replacement:string}) {
  const parts:ReactNode[]=[];let at=0;
  for(const [index,change] of presentableDiff(base,replacement).entries()) {
    parts.push(base.slice(at,change.fromA));
    if(change.toA>change.fromA)parts.push(<del className="editorial-diff__removed" key={`d${index}`}>{base.slice(change.fromA,change.toA)}</del>);
    if(change.toB>change.fromB)parts.push(<ins className="editorial-diff__added" key={`i${index}`}>{replacement.slice(change.fromB,change.toB)}</ins>);
    at=change.toA;
  }
  parts.push(base.slice(at));return <div className="editorial-panel__excerpt editorial-note__diff">{parts}</div>;
}

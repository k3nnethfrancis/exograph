import { reconcileEditorialTargets, type EditorialSpan } from "@exograph/core/editorial-notes";
export interface EditorialProjectedEdit { from:number; to:number; base:string; replacement:string; targetId:string }
export function editorialProjection(source:string, span:EditorialSpan | undefined): { edits:EditorialProjectedEdit[]; error:string|null } {
  if (!span || span.error || span.legacy || span.note.status !== "open" || !span.note.edits.length) return {edits:[],error:null};
  const resolutions=reconcileEditorialTargets(source,span.note.targets);
  const edits:EditorialProjectedEdit[]=[];
  for (const edit of span.note.edits) {
    const index=span.note.targets.findIndex(target=>target.id===edit.targetId);
    const resolution=resolutions[index]; const target=span.note.targets[index];
    if (!target || !resolution || !["unchanged","moved"].includes(resolution.state) || resolution.from===undefined || resolution.to===undefined) return {edits:[],error:"Repair the changed or ambiguous passages before viewing this proposal inline."};
    edits.push({from:resolution.from,to:resolution.to,base:target.base,replacement:edit.replacement,targetId:target.id});
  }
  edits.sort((a,b)=>a.from-b.from);
  if (edits.some((edit,index)=>index>0 && (edit.from<edits[index-1].to || edit.from===edits[index-1].from))) return {edits:[],error:"This proposal contains overlapping passages. Retarget or remove a passage."};
  return {edits,error:null};
}

import { captureEditorialTarget, migrateLegacyEditorialNote, reconcileEditorialTarget, type EditorialNote, type EditorialSpan } from "@exograph/core/editorial-notes";
import type { EditorialAction } from "./editorialTypes";
/** Annotation changes are separate values; author source is read-only input. */
export function changeEditorialNotes(notes:readonly EditorialNote[], action:EditorialAction, source:string, selection:{from:number;to:number}, legacySpan?:EditorialSpan):EditorialNote[] {
  const matches=notes.filter(note=>note.id===action.noteId);
  if(matches.length!==1)throw new Error("The selected editorial note changed. Refresh and review it first.");
  const note=matches[0];let next=note;
  const capture=(id?:string)=>{if(selection.from===selection.to)throw new Error("Select the intended passage in the editor first.");return captureEditorialTarget(source,selection.from,selection.to,id);};
  switch(action.kind) {
    case "field":next={...note,[action.field]:action.value};break;
    case "replacement":if(!note.targets.some(target=>target.id===action.targetId))throw new Error("This passage no longer exists.");next={...note,edits:[...note.edits.filter(edit=>edit.targetId!==action.targetId),{targetId:action.targetId,replacement:action.value}]};break;
    case "status":next={...note,status:action.status};break;
    case "remove-target":next={...note,targets:note.targets.filter(target=>target.id!==action.targetId),edits:note.edits.filter(edit=>edit.targetId!==action.targetId)};break;
    case "remove-replacement":next={...note,edits:note.edits.filter(edit=>edit.targetId!==action.targetId)};break;
    case "add-target":{const target=capture();next=legacySpan?.legacy ? {...migrateLegacyEditorialNote(legacySpan,target),id:note.id} : {...note,targets:[...note.targets,target]};break;}
    case "retarget":case "rebase":{
      const target=note.targets.find(target=>target.id===action.targetId);if(!target)throw new Error("This passage no longer exists.");
      const resolution=reconcileEditorialTarget(source,target);
      if(action.kind==="rebase" && (resolution.state!=="modified" || resolution.from===undefined || resolution.to===undefined))throw new Error("Select the intended passage and retarget it.");
      const replacement=action.kind==="retarget" ? capture(target.id) : captureEditorialTarget(source,resolution.from!,resolution.to!,target.id);
      next={...note,targets:note.targets.map(item=>item.id===target.id?replacement:item)};break;
    }
    default:throw new Error("This action requires the editorial command owner.");
  }
  return notes.map(item=>item.id===note.id?next:item);
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditorialNote } from "@exograph/core/editorial-notes";
import type { EditorialSnapshot } from "../../../shared/api";
import { enqueueEditorialAnnotation, ensureEditorialAnnotations, flushEditorialAnnotations, getEditorialAnnotationState, retryEditorialAnnotations, subscribeEditorialAnnotations } from "./editorialAnnotationCoordinator";
function fixture() {
  const path=`/fixture/${crypto.randomUUID()}.md`;
  let snapshot:EditorialSnapshot={version:1,documentId:crypto.randomUUID(),notes:[createEditorialNote({id:"mine",commentary:"Before"}),createEditorialNote({id:"other",commentary:"Other"})],revision:"v1",sourceRevision:"author-v1",inlineNoteIds:[]};
  const read=vi.fn(async()=>snapshot),save=vi.fn(async(_path:string,notes:EditorialSnapshot["notes"],revision:string)=>{expect(revision).toBe(snapshot.revision);snapshot={...snapshot,notes,revision:crypto.randomUUID()};return{status:"saved" as const,snapshot};});
  const authorSave=vi.fn();vi.stubGlobal("window",{exograph:{editorial:{read,save,onChanged:()=>()=>{}},notes:{save:authorSave}}});
  return{path,read,save,authorSave,get snapshot(){return snapshot;},set snapshot(value:EditorialSnapshot){snapshot=value;}};
}
afterEach(()=>vi.unstubAllGlobals());
describe("annotation persistence coordinator",()=>{
  it("retains and drains queued annotation edits after subscribers navigate away",async()=>{
    const f=fixture();await ensureEditorialAnnotations(f.path);
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const save=f.save.getMockImplementation()!;
    f.save.mockImplementationOnce(async(...args)=>{await gate;return save(...args);});
    const dispose=subscribeEditorialAnnotations(f.path,()=>{});
    enqueueEditorialAnnotation(f.path,notes=>notes.map(note=>note.id==="mine"?{...note,commentary:"Typed one"}:note));
    enqueueEditorialAnnotation(f.path,notes=>notes.map(note=>note.id==="mine"?{...note,title:"Typed two"}:note));
    dispose();expect(getEditorialAnnotationState(f.path).snapshot?.notes[0].title).toBe("Typed two");
    let settled=false;const flush=flushEditorialAnnotations(f.path).then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);
    release();await flush;expect(f.snapshot.notes[0]).toMatchObject({commentary:"Typed one",title:"Typed two"});expect(f.save).toHaveBeenCalledTimes(2);expect(f.authorSave).not.toHaveBeenCalled();
  });
  it("preserves conflicted local edits and blocks lifecycle flush until explicit retry",async()=>{
    const f=fixture();await ensureEditorialAnnotations(f.path);
    f.snapshot={...f.snapshot,revision:"external",notes:f.snapshot.notes.map(note=>note.id==="other"?{...note,commentary:"External update"}:note)};
    f.save.mockImplementationOnce(async()=>({status:"conflict" as never,snapshot:f.snapshot}));
    enqueueEditorialAnnotation(f.path,notes=>notes.map(note=>note.id==="mine"?{...note,commentary:"My retained edit"}:note));
    await expect(flushEditorialAnnotations(f.path)).rejects.toThrow("retained");
    expect(getEditorialAnnotationState(f.path).snapshot?.notes[0].commentary).toBe("My retained edit");
    expect(getEditorialAnnotationState(f.path).pending).toBe(true);
    await retryEditorialAnnotations(f.path);
    expect(f.snapshot.notes[0].commentary).toBe("My retained edit");expect(f.snapshot.notes[1].commentary).toBe("External update");expect(getEditorialAnnotationState(f.path).pending).toBe(false);expect(f.authorSave).not.toHaveBeenCalled();
  });
});

import type { EditorialNote } from "@exograph/core/editorial-notes";
import type { EditorialSnapshot } from "../../../shared/api";
export type EditorialAnnotationOperation=(notes:EditorialNote[])=>EditorialNote[];
export interface EditorialAnnotationState { snapshot:EditorialSnapshot|null; error:string|null; pending:boolean }
interface Entry {path:string;confirmed:EditorialSnapshot|null;operations:EditorialAnnotationOperation[];state:EditorialAnnotationState;listeners:Set<()=>void>;queue:Promise<void>;running:boolean;blocked:boolean;loading:Promise<void>|null;readEpoch:number}
const entries=new Map<string,Entry>();
let apiIdentity:unknown;let dispose:undefined|(()=>void);
function entryFor(path:string):Entry {
  let entry=entries.get(path);if(!entry){entry={path,confirmed:null,operations:[],state:{snapshot:null,error:null,pending:false},listeners:new Set(),queue:Promise.resolve(),running:false,blocked:false,loading:null,readEpoch:0};entries.set(path,entry);}return entry;
}
function publish(entry:Entry,error=entry.state.error) {
  let snapshot=entry.confirmed;
  try {if(snapshot)snapshot={...snapshot,notes:entry.operations.reduce((notes,operation)=>operation(notes),snapshot.notes)};}
  catch(failure){error=failure instanceof Error?failure.message:String(failure);snapshot=entry.state.snapshot;entry.blocked=true;}
  entry.state={snapshot,error,pending:entry.operations.length>0||entry.running};entry.listeners.forEach(listener=>listener());
}
function ensureEvents() {
  const api=window.exograph.editorial;if(api===apiIdentity)return;dispose?.();apiIdentity=api;
  dispose=api.onChanged(event=>{const entry=entries.get(event.filePath);if(!entry||entry.operations.length||entry.running)return;if(event.snapshot){entry.readEpoch++;entry.confirmed=event.snapshot;publish(entry,null);}else void reloadEditorialAnnotations(event.filePath);});
}
export function getEditorialAnnotationState(path:string):EditorialAnnotationState {return entryFor(path).state;}
export function subscribeEditorialAnnotations(path:string,listener:()=>void) {const entry=entryFor(path);entry.listeners.add(listener);ensureEvents();return ()=>entry.listeners.delete(listener);}
export function ensureEditorialAnnotations(path:string):Promise<void> {
  ensureEvents();const entry=entryFor(path);if(entry.operations.length||entry.blocked)return Promise.resolve();if(entry.loading)return entry.loading;
  entry.loading=reloadEditorialAnnotations(path).finally(()=>{entry.loading=null;});return entry.loading;
}
export async function reloadEditorialAnnotations(path:string):Promise<void> {
  const entry=entryFor(path);const epoch=++entry.readEpoch;try {const snapshot=await window.exograph.editorial.read(path);if(epoch!==entry.readEpoch||entry.operations.length)return;entry.confirmed=snapshot;publish(entry,null);}catch(error){publish(entry,error instanceof Error?error.message:String(error));}
}
function run(entry:Entry) {
  if(entry.running||entry.blocked)return;
  entry.running=true;publish(entry);
  entry.queue=(async()=>{
    try {
      while(entry.operations.length&&!entry.blocked) {
        const operation=entry.operations[0];const base=entry.confirmed;
        if(!base)throw new Error("Editorial notes are still loading.");
        const result=await window.exograph.editorial.save(entry.path,operation(base.notes),base.revision);
        entry.readEpoch++;entry.confirmed=result.snapshot;
        if(result.status!=="saved")throw new Error("Editorial notes changed elsewhere. Your edits are retained here; retry annotation changes after reviewing the latest notes.");
        entry.operations.shift();publish(entry,null);
      }
    }catch(error){entry.blocked=true;publish(entry,error instanceof Error?error.message:String(error));}
    finally {entry.running=false;publish(entry);}
  })();
}
export function enqueueEditorialAnnotation(path:string,operation:EditorialAnnotationOperation) {
  const entry=entryFor(path);if(!entry.confirmed)throw new Error("Editorial notes are still loading.");
  // Validate before staging so a rejected action cannot poison the retained queue.
  operation(entry.state.snapshot?.notes??entry.confirmed.notes);
  entry.operations.push(operation);publish(entry);run(entry);
}
export async function retryEditorialAnnotations(path:string) {
  const entry=entryFor(path);await entry.queue;
  entry.confirmed=await window.exograph.editorial.read(path);entry.blocked=false;publish(entry,null);run(entry);await flushEditorialAnnotations(path);
}
export function adoptEditorialSnapshot(path:string,snapshot:EditorialSnapshot) {
  const entry=entryFor(path);entry.readEpoch++;entry.confirmed=snapshot;publish(entry,null);
}
/** Lifecycle barrier: pending operations survive navigation and reject shutdown on conflict. */
export async function flushEditorialAnnotations(path?:string):Promise<void> {
  const relevant=path?[entryFor(path)]:[...entries.values()];
  await Promise.all(relevant.map(async entry=>{if(entry.loading)await entry.loading;while(entry.running){const queue=entry.queue;await queue;if(queue===entry.queue)break;}if(entry.operations.length||entry.blocked)throw new Error(`${entry.path}: ${entry.state.error??"Editorial annotation edits have not been saved."}`);}));
}

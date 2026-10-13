import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { ExternalChange } from "@uiw/react-codemirror";
import { Prec, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { diff } from "@codemirror/merge";
import { createEditorialNote, parseEditorialNotes, type EditorialSpan } from "@exograph/core/editorial-notes";
import type { AgentCommand } from "@exograph/core";
import type { LaunchEditorialDraftInput } from "../../../shared/api/invocation-commands";
import type { EditorialAction, EditorialPaneController } from "./editorialTypes";
import { getEditorialApplicationHistory, recordEditorialApplication } from "./editorialApplicationHistory";
import { changeEditorialNotes } from "./editorialNoteOperations";
import { selectedEditorialTarget } from "./editorialSelection";
import { useEditorialPreferences, setEditorialPreferences, getEditorialPreferences } from "./editorialPreferences";
import type { markdownLivePreview } from "./markdownLivePreview";
import { editorialNotesExtension } from "./editorialNotes";
import { adoptEditorialSnapshot, ensureEditorialAnnotations, enqueueEditorialAnnotation, flushEditorialAnnotations, getEditorialAnnotationState, retryEditorialAnnotations, subscribeEditorialAnnotations } from "./editorialAnnotationCoordinator";

type DraftInput=Omit<LaunchEditorialDraftInput,"authorization"|"expectedFingerprint">;
interface Options {
  paneId:string;filePath:string;body:string;enabled:boolean;disabled?:string;invocationBusy:boolean;defaultAgent?:AgentCommand;
  getView:()=>EditorView|null;rawMarkdown?:boolean;
  previewRendering?:Parameters<typeof markdownLivePreview>[0];
  sourceBarrier?:(paneId:string,filePath:string,enabled:boolean)=>void;
  register?:(paneId:string,controller:EditorialPaneController|null)=>void;
  open?:(paneId:string,filePath:string)=>void;
  prepareSource?:(filePath:string)=>Promise<void>;
  pauseSource?:(filePath:string)=>Promise<()=>void>;
  reloadSource?:(filePath:string)=>Promise<void>;
  draft?:(input:DraftInput,onSettled:()=>void)=>void;
}
export function useEditorialEditor(options:Options) {
  const latest=useRef(options);latest.current=options;
  const subscribe=useCallback((listener:()=>void)=>options.enabled?subscribeEditorialAnnotations(options.filePath,listener):()=>{},[options.filePath,options.enabled]);
  const getSnapshot=useCallback(()=>getEditorialAnnotationState(options.filePath),[options.filePath]);
  const state=useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
  const [selection,setSelection]=useState<{path:string;id:string}|null>(null);
  const [localError,setLocalError]=useState<{path:string;message:string}|null>(null);
  const [barrier,setBarrier]=useState(false);const [draftPending,setDraftPending]=useState(false);
  const activeSources=useRef(new Set<string>());const preferences=useEditorialPreferences();
  const identity=`${options.paneId}\0${options.filePath}`;const identityRef=useRef(identity);identityRef.current=identity;
  const bound=useCallback(()=>{if(identityRef.current!==identity)throw new Error("The selected document changed. Select its current note again.");return latest.current;},[identity]);
  const fail=useCallback((error:unknown)=>{if(identityRef.current===identity)setLocalError({path:options.filePath,message:error instanceof Error?error.message:String(error)});},[identity,options.filePath]);
  useEffect(()=>{setBarrier(false);setDraftPending(false);if(options.enabled)void ensureEditorialAnnotations(options.filePath).catch(fail);return ()=>{if(!activeSources.current.has(identity))latest.current.sourceBarrier?.(options.paneId,options.filePath,false);};},[options.filePath,options.paneId,options.enabled,fail,identity]);
  const selectNote=useCallback((id:string)=>{try{const current=bound();setSelection({path:current.filePath,id});current.open?.(current.paneId,current.filePath);}catch(error){fail(error);}},[bound,fail]);
  const createNote=useCallback(()=>{
    try {const current=bound();const view=current.getView();if(!view||current.disabled||barrier||draftPending)return;const display=getEditorialPreferences();const canCapture=current.rawMarkdown||display.mode!=="preview"||display.hidden;const target=view.state.selection.main.empty||!canCapture?null:selectedEditorialTarget(view);const note=createEditorialNote({targets:target?[target]:[]});enqueueEditorialAnnotation(current.filePath,notes=>[...notes,note]);setSelection({path:current.filePath,id:note.id});setEditorialPreferences({...preferences,hidden:false});current.open?.(current.paneId,current.filePath);setLocalError(null);}catch(error){fail(error);}
  },[bound,barrier,draftPending,preferences,fail]);
  const mutateDocument=useCallback(async(kind:"apply"|"migrate"|"undo"|"redo",noteId?:string)=>{
    let current:Options;try {current=bound();}catch(error){fail(error);return;}
    const view=current.getView();if(!view||current.disabled||barrier||draftPending)return;
    const path=current.filePath;const before=view.state.doc.toString();
    activeSources.current.add(identity);
    flushSync(()=>{setBarrier(true);current.sourceBarrier?.(current.paneId,path,true);});setLocalError(null);
    try {
      await flushEditorialAnnotations(path);await current.prepareSource?.(path);
      if(identityRef.current!==identity||current.getView()?.state.doc.toString()!==before)throw new Error("The document changed while preparing. Review it and try again.");
      const base=await window.exograph.editorial.read(path);const proposal=getEditorialAnnotationState(path).snapshot?.notes.find(note=>note.id===noteId);
      if(kind==="apply"&&JSON.stringify(base.notes.find(note=>note.id===noteId))!==JSON.stringify(proposal)){adoptEditorialSnapshot(path,base);throw new Error("This proposal changed elsewhere. Review it before applying.");}
      const historyKey=base.documentId ?? path;const history=getEditorialApplicationHistory(historyKey);const receipt=history?.entries[kind==="undo"?history.index-1:history.index];
      if(kind!=="apply"&&kind!=="migrate"&&!receipt)throw new Error("No matching editorial application to undo or redo.");
      const result=kind==="apply"?await window.exograph.editorial.apply(path,noteId!,base.sourceRevision,base.revision):kind==="migrate"?await window.exograph.editorial.migrate(path,base.inlineNoteIds,base.sourceRevision,base.revision):await window.exograph.editorial[kind](path,receipt!.id,base.sourceRevision,base.revision);
      adoptEditorialSnapshot(path,result.snapshot);if(result.status!=="applied")throw new Error(result.error);
      if(kind==="apply"||kind==="migrate")recordEditorialApplication(historyKey,result.snapshot.documentId??historyKey,{id:result.transactionId,before,after:result.document.body});else if(history)history.index+=kind==="undo"?-1:1;
      if(identityRef.current!==identity)return;
      const live=current.getView();if(live)live.dispatch({changes:diff(live.state.doc.toString(),result.document.body).map(change=>({from:change.fromA,to:change.toA,insert:result.document.body.slice(change.fromB,change.toB)})),annotations:[ExternalChange.of(true),Transaction.addToHistory.of(false)]});
      await current.reloadSource?.(path);
    }catch(error){fail(error);}
    finally {activeSources.current.delete(identity);current.sourceBarrier?.(current.paneId,path,false);if(identityRef.current===identity)setBarrier(false);}
  },[bound,barrier,draftPending,identity,fail]);
  const action=useCallback((action:EditorialAction)=>{
    try {
      const current=bound();const view=current.getView();if(!view||current.disabled||barrier||draftPending)return;setLocalError(null);
      if(action.kind==="apply"){void mutateDocument("apply",action.noteId);return;}
      if(action.kind==="agent"){
        if(!current.defaultAgent||!current.draft)throw new Error("Choose an enabled default agent in Settings.");
        activeSources.current.add(identity);
        flushSync(()=>{setDraftPending(true);current.sourceBarrier?.(current.paneId,current.filePath,true);});
        let resume:(()=>void)|undefined;
        const settled=()=>{resume?.();activeSources.current.delete(identity);if(identityRef.current===identity)setDraftPending(false);current.sourceBarrier?.(current.paneId,current.filePath,false);};
        void(async()=>{try {
          resume=await current.pauseSource?.(current.filePath);
          await flushEditorialAnnotations(current.filePath);
          if(identityRef.current!==identity){settled();return;}
          const saved=getEditorialAnnotationState(current.filePath).snapshot;if(!saved)throw new Error("Annotations are still loading.");
          current.draft!({handle:current.defaultAgent!.handle,documentPath:current.filePath,documentBody:view.state.doc.toString(),noteId:action.noteId,annotationRevision:saved.revision},settled);
        }catch(error){settled();fail(error);}})();return;
      }
      const source=view.state.doc.toString();const selection=view.state.selection.main;if(action.kind==="add-target"||action.kind==="retarget"){const display=getEditorialPreferences();if(!current.rawMarkdown&&display.mode==="preview"&&!display.hidden)throw new Error("Select Original to attach or retarget a passage.");selectedEditorialTarget(view);}
      const legacy=parseEditorialNotes(source).find(span=>span.note.id===action.noteId);
      enqueueEditorialAnnotation(current.filePath,notes=>changeEditorialNotes(notes,action,source,{from:selection.from,to:selection.to},legacy));
    }catch(error){fail(error);}
  },[bound,barrier,draftPending,mutateDocument,identity,fail]);
  const spans=useMemo<EditorialSpan[]>(()=>{const inline=parseEditorialNotes(options.body);return(state.snapshot?.notes??inline.map(span=>span.note)).map(note=>{const span=inline.find(span=>span.note.id===note.id);return span?{...span,note}:{from:-1,to:-1,raw:"",legacy:false,note};});},[state.snapshot,options.body]);
  const selected=selection?.path===options.filePath?selection.id:null;
  const selectedId=spans.some(span=>span.note.id===selected)?selected:spans.find(span=>span.note.status==="open")?.note.id??spans[0]?.note.id??null;
  const mutationDisabled=options.disabled??(!state.snapshot&&options.enabled?"Editorial notes are loading":undefined)??(barrier||draftPending?"Wait for the current editorial action to finish":undefined);
  const captureDisabled=!options.rawMarkdown&&preferences.mode==="preview"&&!preferences.hidden?"Select Original to attach a passage":undefined;
  const error=localError?.path===options.filePath?localError.message:state.error;
  const retry=useCallback(()=>{try{const current=bound();void retryEditorialAnnotations(current.filePath).catch(fail);}catch(error){fail(error);}},[bound,fail]);
  const relink=useCallback((documentId:string)=>{let current:Options;try{current=bound();}catch(error){fail(error);return;}void(async()=>{try{await flushEditorialAnnotations(current.filePath);const base=getEditorialAnnotationState(current.filePath).snapshot;if(!base)throw new Error("Annotations are still loading.");const result=await window.exograph.editorial.relink(current.filePath,documentId,base.revision);adoptEditorialSnapshot(current.filePath,result.snapshot);if(result.status!=="saved")throw new Error("Annotations changed while associating the moved notes. Review and retry.");}catch(error){fail(error);}})();},[bound,fail]);
  const controller=useMemo<EditorialPaneController>(()=>({paneId:options.paneId,filePath:options.filePath,source:options.body,spans,selectedNoteId:selectedId,mutationDisabled,captureDisabled,agentDisabled:mutationDisabled??(!options.defaultAgent?"Choose an enabled default agent in Settings":undefined),error,selectNote,createNote,action,clearError:()=>setLocalError(null),retrySave:state.error&&state.pending?retry:undefined,inlineNoteIds:state.snapshot?.inlineNoteIds,migrate:()=>void mutateDocument("migrate"),orphans:state.snapshot?.orphans,relink}),[options.paneId,options.filePath,options.body,spans,selectedId,mutationDisabled,captureDisabled,options.defaultAgent,error,selectNote,createNote,action,retry,state.error,state.pending,state.snapshot?.orphans,state.snapshot?.inlineNoteIds,relink,mutateDocument]);
  useEffect(()=>{options.register?.(options.paneId,options.enabled?controller:null);},[controller,options.register,options.paneId,options.enabled]);
  useEffect(()=>()=>latest.current.register?.(latest.current.paneId,null),[]);
  const extension=useMemo(()=>editorialNotesExtension({hidden:preferences.hidden,mode:preferences.mode,selectedNoteId:selectedId,annotations:spans,onSelect:selectNote,previewRendering:options.previewRendering}),[preferences,selectedId,spans,selectNote,options.previewRendering]);
  const commands=useMemo(()=>Prec.high(keymap.of([{key:"Mod-Shift-e",run:()=>{createNote();return true;}},{key:"Mod-z",run:view=>{const history=getEditorialApplicationHistory(state.snapshot?.documentId ?? options.filePath);const receipt=history?.entries[history.index-1];if(!receipt||view.state.doc.toString()!==receipt.after)return false;void mutateDocument("undo");return true;}},{key:"Mod-Shift-z",run:view=>{const history=getEditorialApplicationHistory(state.snapshot?.documentId ?? options.filePath);const receipt=history?.entries[history.index];if(!receipt||view.state.doc.toString()!==receipt.before)return false;void mutateDocument("redo");return true;}}])),[createNote,mutateDocument,options.filePath,state.snapshot?.documentId]);
  return {extension,commands,createNote,barrier:barrier||draftPending,preview:options.enabled&&!options.rawMarkdown&&preferences.mode==="preview"&&!preferences.hidden,error,controller};
}

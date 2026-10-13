import { useEffect, useRef, useState } from "react";
import { EditorialDiff } from "./EditorialDiff";
import { EditorialDraftReview } from "./EditorialDraftReview";
import { reconcileEditorialTargets, type EditorialNote, type EditorialTarget } from "@exograph/core/editorial-notes";
import type { EditorialAction, EditorialPaneController } from "./editorialTypes";
import { editorialProjection } from "./editorialProjection";
import { setEditorialPreferences, useEditorialPreferences } from "./editorialPreferences";

function Field({label,value,onChange,disabled,multiline=false,autoFocus=false}:{label:string;value:string;onChange:(value:string)=>void;disabled?:boolean;multiline?:boolean;autoFocus?:boolean}) {
  const [draft,setDraft]=useState(value);const focused=useRef(false);
  useEffect(()=>{if(!focused.current)setDraft(value);},[value]);
  const common={"aria-label":label,value:draft,disabled,autoFocus,onFocus:()=>{focused.current=true;},onBlur:()=>{focused.current=false;},onChange:(event:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>{setDraft(event.target.value);onChange(event.target.value);}};
  return <label className="editorial-panel__field"><span>{label}</span>{multiline ? <textarea {...common} rows={4}/> : <input {...common}/>}</label>;
}
function Target({target,index,note,source,action,disabled,completed,mode,captureDisabled}:{target:EditorialTarget;index:number;note:EditorialNote;source:string;action:(action:EditorialAction)=>void;disabled:boolean;completed:boolean;mode:string;captureDisabled?:string}) {
  const resolution=reconcileEditorialTargets(source,[target])[0];
  const edit=note.edits.find(edit=>edit.targetId===target.id);
  const repair=!completed && !["unchanged","moved"].includes(resolution.state);
  return <details className="editorial-panel__target" open={index===0} data-testid="editorial-target" data-editorial-target-id={target.id}>
    <summary><span>Passage {index+1}</span><span className={`editorial-panel__target-status editorial-panel__target-status--${resolution.state}`}>{completed ? "Retained" : resolution.state}</span></summary>
    <details className="editorial-panel__original"><summary>Original passage</summary><div className="editorial-panel__excerpt">{target.base || "Insertion point"}</div></details>
    {repair ? <div className="editorial-panel__repair"><p>{resolution.state==="modified" ? "The wording changed. Review its current text, then rebase or retarget." : "This passage needs an exact target. Select its intended text in the editor, then retarget."}</p>
      {resolution.current!==undefined ? <div className="editorial-panel__excerpt"><strong>Current wording</strong>{"\n"}{resolution.current}</div> : null}
      <div className="editorial-panel__actions">
        {resolution.state==="modified" && resolution.from!==undefined ? <button type="button" disabled={disabled} onClick={()=>action({kind:"rebase",noteId:note.id,targetId:target.id})}>Rebase to current text</button> : null}
        <button type="button" disabled={disabled||Boolean(captureDisabled)} title={captureDisabled} onClick={()=>action({kind:"retarget",noteId:note.id,targetId:target.id})}>Retarget to selection</button>
      </div></div> : null}
    {completed ? edit ? mode==="diff" ? <EditorialDiff base={target.base} replacement={edit.replacement}/> : <div className="editorial-panel__excerpt">{edit.replacement || "Delete this passage"}</div> : <p className="editorial-panel__muted">No replacement proposed.</p> : edit ? <>
      <Field label={`Proposed wording for passage ${index+1}`} value={edit.replacement} multiline disabled={disabled} onChange={value=>action({kind:"replacement",noteId:note.id,targetId:target.id,value})}/>
      {edit.replacement==="" ? <p className="editorial-panel__muted">This proposal deletes the passage.</p> : null}
      <details className="editorial-panel__more"><summary>Passage actions</summary><div className="editorial-panel__actions">
        <button type="button" disabled={disabled} onClick={()=>action({kind:"replacement",noteId:note.id,targetId:target.id,value:""})}>Propose deletion</button>
        <button type="button" disabled={disabled} onClick={()=>action({kind:"remove-replacement",noteId:note.id,targetId:target.id})}>Remove replacement</button>
        <button type="button" disabled={disabled||Boolean(captureDisabled)} title={captureDisabled} onClick={()=>action({kind:"retarget",noteId:note.id,targetId:target.id})}>Retarget to selection</button>
        <button type="button" disabled={disabled} onClick={()=>action({kind:"remove-target",noteId:note.id,targetId:target.id})}>Remove passage</button>
      </div></details>
    </> : <div className="editorial-panel__actions"><button type="button" disabled={disabled} onClick={()=>action({kind:"replacement",noteId:note.id,targetId:target.id,value:target.base})}>Add replacement</button><button type="button" disabled={disabled} onClick={()=>action({kind:"replacement",noteId:note.id,targetId:target.id,value:""})}>Propose deletion</button><button type="button" disabled={disabled} onClick={()=>action({kind:"remove-target",noteId:note.id,targetId:target.id})}>Remove passage</button></div>}
  </details>;
}
export function EditorialNotesPanel({controller}:{controller:EditorialPaneController|null}) {
  const preferences=useEditorialPreferences();
  if(!controller)return <div className="footer-empty">Select a Markdown document to review editorial notes.</div>;
  const selected=controller.spans.find(span=>span.note.id===controller.selectedNoteId) ?? controller.spans.find(span=>span.note.status==="open") ?? controller.spans[0];
  const note=selected?.note;const disabled=Boolean(controller.mutationDisabled);const completed=note?.status!=="open";
  const projection=editorialProjection(controller.source,selected);
  return <section className="editorial-panel" data-testid="editorial-notes-panel">
    <div className="editorial-panel__toolbar"><span>{controller.spans.length} {controller.spans.length===1 ? "note" : "notes"}</span><button type="button" aria-label="Add editorial note" data-testid="editorial-pane-add" disabled={disabled} onClick={controller.createNote}>Add note</button></div>
    <div className="editorial-mode-controls" role="group" aria-label="Editorial display">
      {([['original','Original'],['diff','Show diff'],['preview','Preview change']] as const).map(([mode,label])=><button key={mode} type="button" aria-pressed={preferences.mode===mode} data-testid={`editorial-mode-${mode}`} onClick={()=>setEditorialPreferences({...preferences,mode})}>{label}</button>)}
    </div>
    {preferences.mode==="preview" && !preferences.hidden ? <p className="editorial-panel__muted" role="status">Preview — select Original to edit.</p> : null}
    <button className="editorial-panel__visibility" type="button" aria-label={preferences.hidden ? "Show editorial notes" : "Hide editorial notes"} onClick={()=>setEditorialPreferences({...preferences,hidden:!preferences.hidden})}>{preferences.hidden ? "Show markers" : "Hide markers"}</button>
    <div className="editorial-panel__scroll" data-testid="editorial-panel-scroll">
    <EditorialDraftReview filePath={controller.filePath}/>
    {controller.error ? <div className="editorial-panel__error" role="alert">{controller.error}{controller.retrySave ? <button type="button" onClick={controller.retrySave}>Retry annotation changes</button> : null}<button type="button" onClick={controller.clearError}>Dismiss</button></div> : null}
    <nav className="editorial-panel__list" aria-label="Editorial notes" data-testid="editorial-note-list">{controller.spans.map(span=><button key={span.note.id} type="button" aria-pressed={span.note.id===note?.id} onClick={()=>controller.selectNote(span.note.id)} data-editorial-note-id={span.note.id} className={span.note.edits.length ? "editorial-panel__list-note editorial-panel__list-note--suggestion" : "editorial-panel__list-note"}><span>{span.note.title || "Editorial note"}</span><small>{span.note.status!=="open" ? span.note.status : span.note.targets.length ? `${span.note.targets.length} ${span.note.targets.length===1?'passage':'passages'}` : "General"}</small></button>)}</nav>
    {!note ? <p className="editorial-panel__muted">Select text in the editor, then add a note. Without a selection, add a general note.</p> : <article key={note.id} className="editorial-panel__selected" data-testid="editorial-selected-note" data-editorial-note-id={note.id}>
      <header><h3>{note.title || "Editorial note"}</h3><span className="editorial-panel__status">{note.status}</span></header>
      {selected?.error ? <p className="editorial-panel__error">{selected.error} Switch to raw Markdown to repair its source.</p> : <>
        {completed ? <><p className="editorial-panel__comment">{note.commentary}</p>{note.targets.length ? <details data-testid="editorial-retained-proposal" className="editorial-panel__history"><summary>View proposal</summary>{note.targets.map((target,index)=><Target key={target.id} {...{target,index,note,source:controller.source,action:controller.action,disabled:true,completed:true,mode:preferences.mode,captureDisabled:controller.captureDisabled}}/>)}</details> : null}<button type="button" disabled={disabled} onClick={()=>controller.action({kind:"status",noteId:note.id,status:"open"})}>Reopen</button></> : <>
          <Field label="Comment" value={note.commentary} multiline disabled={disabled} onChange={value=>controller.action({kind:"field",noteId:note.id,field:"commentary",value})}/>
          <details className="editorial-panel__more"><summary>Edit title</summary><Field label="Title" value={note.title} disabled={disabled} onChange={value=>controller.action({kind:"field",noteId:note.id,field:"title",value})}/></details>
          {projection.error ? <p className="editorial-panel__error" role="status">{projection.error}</p> : null}
          {note.targets.map((target,index)=><Target key={target.id} {...{target,index,note,source:controller.source,action:controller.action,disabled,completed:false,mode:preferences.mode,captureDisabled:controller.captureDisabled}}/>)}
          <button className="editorial-panel__attach" type="button" disabled={disabled||Boolean(controller.captureDisabled)} title={controller.captureDisabled} onClick={()=>controller.action({kind:"add-target",noteId:note.id})}>Add selected passage</button>
          {selected?.legacy ? <p className="editorial-panel__muted">Attach a selected passage to convert this feedback into a structured proposal.</p> : null}
          <div className="editorial-panel__primary-actions"><button className="editorial-panel__apply" type="button" disabled={disabled || !note.edits.length || Boolean(projection.error)} title={controller.mutationDisabled ?? projection.error ?? undefined} onClick={()=>controller.action({kind:"apply",noteId:note.id})}>Apply proposal</button><button type="button" disabled={Boolean(controller.agentDisabled) || selected?.legacy} title={controller.agentDisabled} onClick={()=>controller.action({kind:"agent",noteId:note.id})}>{note.edits.length ? "Revise suggestion with agent" : "Draft suggestion with agent"}</button></div>
          <details className="editorial-panel__more"><summary>Note actions</summary><div className="editorial-panel__actions"><button type="button" disabled={disabled} onClick={()=>controller.action({kind:"status",noteId:note.id,status:"resolved"})}>Resolve</button><button type="button" disabled={disabled} onClick={()=>controller.action({kind:"status",noteId:note.id,status:"dismissed"})}>Dismiss</button></div></details>
        </>}
      </>}
    </article>}
    {controller.inlineNoteIds?.length ? <details className="editorial-panel__more" data-testid="editorial-inline-migration"><summary>Inline notes</summary><p className="editorial-panel__muted">Preserves prose and editorial history.</p><button type="button" disabled={disabled} onClick={controller.migrate}>Move notes out of Markdown</button></details> : null}
    {controller.orphans?.length ? <details className="editorial-panel__more" data-testid="editorial-moved-notes"><summary>Notes from moved files</summary>{controller.orphans.map(orphan=><div className="editorial-panel__orphan" key={orphan.documentId}><span>{orphan.relativePath}</span><small>{orphan.noteCount} notes</small><button type="button" disabled={disabled} onClick={()=>controller.relink?.(orphan.documentId)}>Associate with this document</button></div>)}</details> : null}
    </div>
  </section>;
}

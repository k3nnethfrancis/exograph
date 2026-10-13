import { describe, expect, it } from "vitest";
import { history, undo, redo } from "@codemirror/commands";
import { ExternalChange } from "@uiw/react-codemirror";
import { Compartment, Transaction, EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { captureEditorialTarget, createEditorialNote, parseEditorialNotes, serializeEditorialNote, type EditorialSpan } from "@exograph/core/editorial-notes";
import { changeEditorialNotes } from "./editorialNoteOperations";
import { editorialNotesExtension } from "./editorialNotes";
import { editorialProjection } from "./editorialProjection";
import { markdownPreviewInlineContent } from "./markdownLivePreview";
function fixture() {
  const source="First paragraph.\n\nSecond paragraph.";
  const one=captureEditorialTarget(source,0,16,"one"),two=captureEditorialTarget(source,18,35,"two");
  const note=createEditorialNote({id:"note-1",title:"Clarity",commentary:"Make both direct.",targets:[one,two],edits:[{targetId:"one",replacement:"Revised first."},{targetId:"two",replacement:"Revised second."}]});
  const span:EditorialSpan={from:-1,to:-1,raw:"",legacy:false,note};return{source,note,span};
}
describe("editorial presentation and annotation operations",()=>{
  it("edits commentary, grouped replacements, deletion and state separately from author source",()=>{
    const {source,note}=fixture();let notes=[note];
    const apply=(action:Parameters<typeof changeEditorialNotes>[1])=>{notes=changeEditorialNotes(notes,action,source,{from:0,to:16});};
    apply({kind:"field",noteId:note.id,field:"commentary",value:"Updated comment."});
    apply({kind:"replacement",noteId:note.id,targetId:"one",value:""});apply({kind:"status",noteId:note.id,status:"dismissed"});
    expect(notes[0].commentary).toBe("Updated comment.");expect(notes[0].edits.find(edit=>edit.targetId==="one")?.replacement).toBe("");expect(notes[0].status).toBe("dismissed");
    expect(source).toBe("First paragraph.\n\nSecond paragraph.");
  });
  it("retargets only through an explicit selection and preserves unrelated annotation",()=>{
    const {source,note}=fixture();const other=createEditorialNote({id:"other",commentary:"Keep."});
    expect(()=>changeEditorialNotes([note],{kind:"retarget",noteId:note.id,targetId:"one"},source,{from:0,to:0})).toThrow("Select");
    const next=changeEditorialNotes([note,other],{kind:"retarget",noteId:note.id,targetId:"one"},source,{from:18,to:35});
    expect(next[0].targets[0].base).toBe("Second paragraph.");expect(next[1]).toBe(other);
  });
  it("suppresses the whole grouped projection when any target is stale or overlaps",()=>{
    const {source,span}=fixture();expect(editorialProjection(source,span).edits).toHaveLength(2);
    expect(editorialProjection(source.replace("Second paragraph.","Different."),span).edits).toEqual([]);
    const overlap={...span,note:{...span.note,targets:[span.note.targets[0],{...span.note.targets[0],id:"two"}]}};
    expect(editorialProjection(source,overlap).error).toContain("overlapping");
  });
  it("Original, Diff and Preview are display-only; preview rejects prose typing",()=>{
    const {source,span}=fixture();for(const mode of ["original","diff","preview"] as const) {
      let calls=0;const state=EditorState.create({doc:source,extensions:[editorialNotesExtension({hidden:false,mode,selectedNoteId:span.note.id,annotations:[span],onSelect:()=>calls++})]});
      expect(state.doc.toString()).toBe(source);expect(calls).toBe(0);
      const typed=state.update({changes:{from:0,insert:"Typed"},userEvent:"input.type"}).state;
      expect(typed.doc.toString()).toBe(mode==="preview"?source:`Typed${source}`);
      expect(state.facet(EditorView.atomicRanges).flatMap(provider=>{const ranges:Array<{from:number;to:number}>=[];provider({state} as EditorView).between(0,source.length,(from,to)=>{ranges.push({from,to});});return ranges;})).toEqual([]);
    }
  });
  it("blocks native author Undo/Redo in Preview while paired external journal updates remain allowed",()=>{
    const {source,span}=fixture();const display=new Compartment();
    const extension=(mode:"original"|"preview")=>editorialNotesExtension({hidden:false,mode,annotations:[span],selectedNoteId:span.note.id});
    const view:{state:EditorState;dispatch:(spec:TransactionSpec|Transaction)=>void}={state:EditorState.create({doc:source,extensions:[history(),display.of(extension("original"))]}),dispatch:spec=>{view.state=spec instanceof Transaction?spec.state:view.state.update(spec).state;}};
    view.dispatch({changes:{from:0,insert:"Authored "},userEvent:"input.type"});const authored=view.state.doc.toString();
    view.dispatch({effects:display.reconfigure(extension("preview"))});
    undo(view as unknown as EditorView);expect(view.state.doc.toString()).toBe(authored);
    view.dispatch({effects:display.reconfigure(extension("original"))});undo(view as unknown as EditorView);expect(view.state.doc.toString()).toBe(source);
    view.dispatch({effects:display.reconfigure(extension("preview"))});redo(view as unknown as EditorView);expect(view.state.doc.toString()).toBe(source);
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:"Paired journal result"},annotations:[ExternalChange.of(true),Transaction.addToHistory.of(false)]});
    expect(view.state.doc.toString()).toBe("Paired journal result");
  });
  it("hides legacy metadata atomically while malformed source remains editable",()=>{
    const note=createEditorialNote({id:"inline"});const metadata=serializeEditorialNote(note);const source=`Author.\n\n${metadata}\n`;
    const state=EditorState.create({doc:source,extensions:[editorialNotesExtension({hidden:true,mode:"original"})]});const ranges:Array<{from:number;to:number}>=[];
    for(const provider of state.facet(EditorView.atomicRanges))provider({state} as EditorView).between(0,source.length,(from,to)=>{ranges.push({from,to});});
    expect(ranges).toEqual([{from:source.indexOf("```editorial")-1,to:source.length}]);
    const malformed="```editorial\n{bad json}\n```";const raw=EditorState.create({doc:malformed,extensions:[editorialNotesExtension({hidden:true})]});let count=0;for(const provider of raw.facet(EditorView.atomicRanges))provider({state:raw} as EditorView).between(0,malformed.length,()=>{count++;});expect(count).toBe(0);
    expect(parseEditorialNotes(source)[0].raw).toBe(metadata);
  });
  it("uses safe existing Markdown grammar fragments for preview emphasis and links",()=>{
    const fragments=markdownPreviewInlineContent("A **bold** and *soft* [link](https://example.com) `code`");
    expect(fragments).toContainEqual({kind:"strong",children:[{kind:"text",text:"bold"}]});
    expect(fragments).toContainEqual({kind:"link",target:"https://example.com",children:[{kind:"text",text:"link"}]});
    expect(markdownPreviewInlineContent("<script>alert(1)</script>")).toEqual([{kind:"text",text:"<script>alert(1)</script>"}]);
  });
});

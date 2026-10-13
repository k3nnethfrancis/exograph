import { ChangeSet, EditorSelection, EditorState, Transaction, StateField, type Extension } from "@codemirror/state";
import { Decoration, WidgetType, EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { markdownLivePreview, markdownPreviewInlineContent } from "./markdownLivePreview";
import { presentableDiff } from "@codemirror/merge";
import { parseEditorialNotes, reconcileEditorialTargets, type EditorialSpan } from "@exograph/core/editorial-notes";
import type { EditorialDisplayMode } from "./editorialTypes";
import { editorialProjection } from "./editorialProjection";

class EditorialInsertionWidget extends WidgetType {
  constructor(private text: string) { super(); }
  eq(other: EditorialInsertionWidget) { return this.text === other.text; }
  toDOM() { const span = document.createElement("ins"); span.className = "editorial-diff__added editorial-diff__inline"; span.textContent = this.text; span.setAttribute("aria-label", "Proposed insertion"); return span; }
}
class EditorialMarkerWidget extends WidgetType {
  constructor(private id:string, private title:string, private suggested:boolean, private offset:number, private selected:boolean, private select:(id:string)=>void) {super();}
  eq(other:EditorialMarkerWidget) {return this.id===other.id && this.title===other.title && this.suggested===other.suggested && this.offset===other.offset && this.selected===other.selected && this.select===other.select;}
  toDOM() {
    const button=document.createElement("button");button.type="button";
    button.className=`editorial-marker ${this.suggested ? "editorial-marker--suggestion" : ""} ${this.selected ? "editorial-marker--selected" : ""}`;
    button.style.right=`${this.offset * 8 + 3}px`;button.dataset.testid="editorial-marker";button.dataset.editorialNoteId=this.id;
    button.setAttribute("aria-label",`Open editorial note: ${this.title}`);button.title=this.title;
    button.onmousedown=event=>event.preventDefault();button.onclick=()=>this.select(this.id);return button;
  }
}
const previewViews=new WeakMap<HTMLElement,EditorView>();
class EditorialPreviewWidget extends WidgetType {
  constructor(private text:string, private block:boolean, private noteId:string, private title:string, private select:(id:string)=>void, private rendering?:Parameters<typeof markdownLivePreview>[0]) {super();}
  eq(other:EditorialPreviewWidget) {return this.text===other.text&&this.block===other.block&&this.noteId===other.noteId&&this.title===other.title&&this.select===other.select&&this.rendering===other.rendering;}
  toDOM() {
    const node=document.createElement(this.block ? "div" : "span");node.className=`editorial-preview-change ${this.block ? "editorial-preview-change--block" : "editorial-preview-change--inline"}`;node.dataset.testid="editorial-preview-change";node.setAttribute("aria-label","Proposed wording preview");
    if(this.block&&this.text&&this.rendering) {
      const content=document.createElement("div");node.append(content);
      const body=this.text+"\n";
      const view=new EditorView({parent:content,state:EditorState.create({doc:body,selection:{anchor:body.length},extensions:[markdown(),EditorView.lineWrapping,EditorState.readOnly.of(true),EditorView.editable.of(false),EditorState.transactionFilter.of(tr=>tr.docChanged?[]:tr),...markdownLivePreview(this.rendering),EditorView.decorations.of(Decoration.set([Decoration.mark({class:"editorial-preview-text"}).range(0,this.text.length)])),EditorView.theme({"&":{backgroundColor:"transparent",font:"inherit"},".cm-content":{padding:"0",fontFamily:"inherit"},".cm-line":{padding:"0"},".cm-scroller":{overflow:"visible",font:"inherit"},"&.cm-focused":{outline:"none"}})]})});
      previewViews.set(node,view);
    } else if(this.text&&this.rendering) {
      const append=(parent:HTMLElement|DocumentFragment,nodes:ReturnType<typeof markdownPreviewInlineContent>)=>{
        for(const fragment of nodes) {
          if(fragment.kind==="text"){parent.append(document.createTextNode(fragment.text));continue;}
          const tag=fragment.kind==="strong"?"strong":fragment.kind==="emphasis"?"em":fragment.kind==="code"?"code":"a";
          const child=document.createElement(tag);
          if(fragment.kind==="link") {child.setAttribute("href",/^(https?:|mailto:|#|[^:]*$)/i.test(fragment.target)?fragment.target:"#");child.onclick=event=>{event.preventDefault();this.rendering!.onOpenTarget(fragment.target);};}
          append(child,fragment.children);parent.append(child);
        }
      };
      append(node,markdownPreviewInlineContent(this.text));
    } else node.textContent=this.text || "[Passage removed in preview]";
    if(this.block)node.append(new EditorialMarkerWidget(this.noteId,this.title,true,0,true,this.select).toDOM());
    return node;
  }
  destroy(dom:HTMLElement) {previewViews.get(dom)?.destroy();previewViews.delete(dom);}
}
interface EditorialOptions {
  hidden:boolean;
  mode?:EditorialDisplayMode;
  showDiff?:boolean;
  selectedNoteId?:string|null;
  onSelect?:(id:string)=>void;
  onAction?:unknown;
  annotations?:readonly EditorialSpan[];
  previewRendering?:Parameters<typeof markdownLivePreview>[0];
}
export function editorialNotesExtension(options: EditorialOptions): Extension {
  const field = StateField.define({
    create: state => { const spans = options.annotations ?? parseEditorialNotes(state.doc.toString()); return { spans, ...build(state.doc.toString(), spans) }; },
    update: (value, tr) => {
      if (!tr.docChanged) return value;
      const source = tr.state.doc.toString(); const spans = options.annotations ?? parseEditorialNotes(source);
      return { spans, ...build(source, spans) };
    },
    provide: field => [
      EditorView.decorations.from(field, value => value.decorations),
      EditorView.atomicRanges.of(view => view.state.field(field).atomicRanges),
      EditorState.transactionFilter.of(tr => {
        const event = tr.annotation(Transaction.userEvent);
        const mode=options.mode ?? (options.showDiff ? "diff" : "original");
        if (!options.hidden && mode==="preview" && event && (event.startsWith("input") || event.startsWith("delete") || event==="undo" || event==="redo") && event!=="input.editorial" && event!=="input.complete") return [];
        if (!tr.docChanged || !event?.startsWith("input") || event === "input.editorial" || event === "input.complete") return tr;
        const spans = tr.startState.field(field).spans.filter(span => !span.error);
        const framing: Array<{from:number;insert:string}> = [];
        tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
          if (fromA !== toA || !inserted.length) return;
          const text = inserted.toString();
          // At document edges there is no existing author line to land on.
          // Add framing outside the note, preserving every byte of its metadata.
          if (fromA === 0 && spans.some(span => span.from === 0) && !text.endsWith("\n")) framing.push({from:toB,insert:"\n\n"});
          if (fromA === tr.startState.doc.length && spans.some(span => span.to === fromA) && !text.startsWith("\n")) framing.push({from:fromB,insert:"\n\n"});
        });
        if (!framing.length) return tr;
        framing.sort((a,b) => a.from-b.from);
        const changes = ChangeSet.of(framing, tr.newDoc.length);
        const selection = EditorSelection.create(tr.newSelection.ranges.map(range => range.map(changes, -1)), tr.newSelection.mainIndex);
        return [tr, { changes, selection, sequential:true }];
      }),
    ],
  });
  const preview=!options.hidden&&(options.mode??(options.showDiff?"diff":"original"))==="preview";
  return [field,EditorState.readOnly.of(preview)];
  function build(source: string, spans: readonly EditorialSpan[]) {
    const ranges=[];const atoms=[];
    for(const span of spans) {
      if(span.error || span.from < 0 || span.to <= span.from) continue;
      const from=span.from>0 && source[span.from-1]==="\n" ? span.from-1 : span.from;
      const to=span.to<source.length && source[span.to]==="\n" ? span.to+1 : span.to;
      atoms.push(Decoration.mark({}).range(from,to));
      ranges.push(Decoration.replace({block:true}).range(span.from,span.to));
    }
    if(!options.hidden) {
      const byLine=new Map<number,Array<{id:string;title:string;suggested:boolean}>>();
      const targets=spans.flatMap(span=>span.note.targets);
      const resolved=reconcileEditorialTargets(source,targets);let offset=0;
      for(const span of spans) {
        for(const target of span.note.targets) {
          const resolution=resolved[offset++];
          if(span.error || span.note.status!=="open" || !["unchanged","moved"].includes(resolution.state) || resolution.from===undefined || resolution.to===undefined) continue;
          const first=source.slice(0,resolution.from).split("\n").length;
          const last=source.slice(0,Math.max(resolution.from,resolution.to-1)).split("\n").length;
          for(let line=first;line<=last;line++) {
            const entries=byLine.get(line) ?? [];
            const suggested=span.note.edits.some(edit=>edit.targetId===target.id);
            const previous=entries.find(entry=>entry.id===span.note.id);
            if(previous) previous.suggested ||= suggested; else entries.push({id:span.note.id,title:span.note.title || "Editorial note",suggested});
            byLine.set(line,entries);
          }
        }
      }
      const lineStarts=[0];for(let at=0;at<source.length;at++)if(source[at]==="\n")lineStarts.push(at+1);
      for(const [line,entries] of byLine) {
        const from=lineStarts[line-1];const to=line<lineStarts.length ? lineStarts[line]-1 : source.length;
        ranges.push(Decoration.line({class:"editorial-marked-line"}).range(from));
        entries.forEach((entry,index)=>ranges.push(Decoration.widget({widget:new EditorialMarkerWidget(entry.id,entry.title,entry.suggested,index,entry.id===options.selectedNoteId,options.onSelect ?? (()=>{})),side:1}).range(to)));
      }
      const mode=options.mode ?? (options.showDiff ? "diff" : "original");
      const selected=spans.find(span=>span.note.id===options.selectedNoteId);
      const projection=editorialProjection(source,selected);
      for(const edit of mode==="original" ? [] : projection.edits) {
        if(mode==="preview") ranges.push(Decoration.replace({block:edit.base.includes("\n") || edit.replacement.includes("\n"),widget:new EditorialPreviewWidget(edit.replacement,edit.base.includes("\n")||edit.replacement.includes("\n"),selected!.note.id,selected!.note.title,options.onSelect??(()=>{}),options.previewRendering)}).range(edit.from,edit.to));
        else for(const change of presentableDiff(edit.base,edit.replacement)) {
          if(change.toA>change.fromA)ranges.push(Decoration.mark({class:"editorial-diff__removed"}).range(edit.from+change.fromA,edit.from+change.toA));
          if(change.toB>change.fromB)ranges.push(Decoration.widget({widget:new EditorialInsertionWidget(edit.replacement.slice(change.fromB,change.toB)),side:1}).range(edit.from+change.toA));
        }
      }
    }
    return {decorations:Decoration.set(ranges,true),atomicRanges:Decoration.set(atoms,true)};
  }
}

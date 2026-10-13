import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
export type MarkdownPreviewInlineNode = {kind:"text";text:string}|{kind:"strong"|"emphasis"|"code";children:MarkdownPreviewInlineNode[]}|{kind:"link";target:string;children:MarkdownPreviewInlineNode[]};
/** Display-only fragments from the editor's existing Markdown grammar; never HTML. */
export function markdownPreviewInlineContent(source:string):MarkdownPreviewInlineNode[] {
  const state=EditorState.create({doc:source,extensions:[markdown()]});
  type Node=ReturnType<typeof syntaxTree>["topNode"];
  function children(node:Node,from=node.from,to=node.to):MarkdownPreviewInlineNode[] {
    const result:MarkdownPreviewInlineNode[]=[];let at=from;
    for(let child=node.firstChild;child;child=child.nextSibling) {
      if(child.from<from||child.to>to)continue;
      if(child.from>at)result.push({kind:"text",text:source.slice(at,child.from)});
      if(["EmphasisMark","CodeMark","LinkMark"].includes(child.name)){at=child.to;continue;}
      if(child.name==="StrongEmphasis"||child.name==="Emphasis"||child.name==="InlineCode")result.push({kind:child.name==="StrongEmphasis"?"strong":child.name==="Emphasis"?"emphasis":"code",children:children(child)});
      else if(child.name==="Link") {
        const url=child.getChild("URL");const marks=child.getChildren("LinkMark");
        if(url&&marks.length>=2)result.push({kind:"link",target:source.slice(url.from,url.to),children:children(child,marks[0].to,marks[1].from)});
        else result.push({kind:"text",text:source.slice(child.from,child.to)});
      } else if(child.name==="Paragraph"||child.name==="Document")result.push(...children(child));
      else result.push({kind:"text",text:source.slice(child.from,child.to)});
      at=child.to;
    }
    if(at<to)result.push({kind:"text",text:source.slice(at,to)});return result;
  }
  return children(syntaxTree(state).topNode);
}

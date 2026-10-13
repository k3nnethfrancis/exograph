import { EditorView } from "@codemirror/view";
import { captureEditorialTarget, parseEditorialNotes } from "@exograph/core/editorial-notes";
import { findDocumentAgentEnvelopes } from "@exograph/core/document-agent-protocol";
export function selectedEditorialTarget(view:EditorView,id?:string) {
  const selection=view.state.selection.main;
  if(selection.empty)throw new Error("Select the passage in the editor first.");
  const source=view.state.doc.toString();
  const protectedRanges=[...parseEditorialNotes(source),...findDocumentAgentEnvelopes(source)];
  if(protectedRanges.some(range=>selection.from<range.to&&selection.to>range.from))throw new Error("Select author prose outside editorial notes and agent requests.");
  return captureEditorialTarget(source,selection.from,selection.to,id);
}

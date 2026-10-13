import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { safeStoreSegment, type InvocationRecord, type InvocationStore } from "@exograph/core";
import { serializeEditorialNote, validateEditorialDraftProposal, type EditorialNote } from "@exograph/core/editorial-notes";

export interface EditorialDraftRequestArtifact {
  version: 1;
  documentPath: string;
  note: EditorialNote;
  annotationRevision: string;
  sourceRevision: string;
}
export interface EditorialDraftProposalArtifact { note: EditorialNote; message: string }
function location(store: InvocationStore, id: string, filename: "request.json" | "document.md" | "result.json" | "proposal.json") {
  return path.join(store.layout.invocationsDir, safeStoreSegment(id), filename);
}
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
export async function stageEditorialDraft(store: InvocationStore, record: InvocationRecord, note: EditorialNote, body: string) {
  const draft = record.editorialDraft!;
  const request: EditorialDraftRequestArtifact = {version:1, documentPath:record.taggedDocumentPath!, note, annotationRevision:draft.annotationRevision, sourceRevision:draft.sourceRevision};
  const requestText = JSON.stringify(request, null, 2);
  await mkdir(path.dirname(location(store, record.id, "request.json")), {recursive:true});
  await writeFile(location(store,record.id,"request.json"), requestText, {flag:"wx", mode:0o400});
  await writeFile(location(store,record.id,"document.md"), body, {flag:"wx", mode:0o400});
  return { requestSha256:hash(requestText), documentSha256:hash(body) };
}
async function readOwnedText(filename: string): Promise<string> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!(await file.stat()).isFile()) throw new Error("Editorial artifact is not a regular file."); return await file.readFile("utf8"); }
  finally { await file.close(); }
}
export async function readEditorialDraftRequest(store: InvocationStore, record: InvocationRecord) {
  const draft = record.editorialDraft;
  if (!draft?.requestSha256 || !draft.documentSha256) throw new Error("The immutable editorial request is unavailable.");
  const requestText = await readOwnedText(location(store,record.id,"request.json"));
  const body = await readOwnedText(location(store,record.id,"document.md"));
  if (hash(requestText) !== draft.requestSha256 || hash(body) !== draft.documentSha256) throw new Error("The agent changed its immutable editorial reference artifacts.");
  const request = JSON.parse(requestText) as EditorialDraftRequestArtifact;
  serializeEditorialNote(request.note);
  if (request.version !== 1 || request.documentPath !== record.taggedDocumentPath || request.note.id !== draft.noteId || request.annotationRevision !== draft.annotationRevision || request.sourceRevision !== draft.sourceRevision) throw new Error("The editorial request does not match its invocation.");
  return { request, body };
}
export function editorialDraftArtifactPrompt(store: InvocationStore, record: InvocationRecord): string {
  return `Draft a proposal for the selected editorial annotation. Do not write to the author's document, its live annotation store, or any other workspace file. Read the immutable request and author reference artifacts below. Preserve note id, version, title, commentary and status exactly. Preserve existing captured targets exactly; revise only edits. For a general note, add targets verified against the exact author reference with fresh ids, exact base, up to 96 characters of prefix/suffix context, body from/to offsets and atStart/atEnd booleans. Empty replacement means deletion. Write only the proposal output artifact as valid JSON {"note": <complete proposed EditorialNote>, "message": <concise receipt or explanation>}. Do not apply proposed wording. If the request is ambiguous, retain the note and explain the uncertainty in message. Completion requires the output file to exist; stdout alone is insufficient.\n\nEditorial request artifact: ${location(store,record.id,"request.json")}\nAuthor reference artifact: ${location(store,record.id,"document.md")}\nProposal output artifact: ${location(store,record.id,"result.json")}`;
}
export async function captureEditorialDraftProposal(store: InvocationStore, record: InvocationRecord): Promise<EditorialDraftProposalArtifact & {sha256:string}> {
  const {request,body} = await readEditorialDraftRequest(store, record);
  try {
    const captured = await readOwnedText(location(store,record.id,"proposal.json"));
    const existing = await readEditorialDraftProposal(store,record);
    return {...existing,sha256:hash(captured)};
  } catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const raw = await readOwnedText(location(store,record.id,"result.json"));
  const proposal = JSON.parse(raw) as EditorialDraftProposalArtifact;
  if (!proposal || typeof proposal.message !== "string" || !proposal.note) throw new Error("The agent did not write a valid editorial result {note,message}.");
  serializeEditorialNote(proposal.note);
  const error = validateEditorialDraftProposal(request.note, proposal.note, body);
  if (error) throw new Error(error);
  // Only the app-owned captured proposal is used for review/import. The agent's
  // mutable result file is never read again after this commit.
  const captured = JSON.stringify(proposal);
  try { await writeFile(location(store,record.id,"proposal.json"), captured, {flag:"wx",mode:0o400}); }
  catch(error) {
    // A crash can commit the captured artifact before its record update. Never
    // substitute a newer mutable result for that already captured proposal.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readEditorialDraftProposal(store,record);
    const existingText = await readOwnedText(location(store,record.id,"proposal.json"));
    return {...existing,sha256:hash(existingText)};
  }
  return {...proposal,sha256:hash(captured)};
}
export async function readEditorialDraftProposal(store: InvocationStore, record: InvocationRecord): Promise<EditorialDraftProposalArtifact> {
  const {request,body} = await readEditorialDraftRequest(store,record);
  const captured = await readOwnedText(location(store,record.id,"proposal.json"));
  if (record.editorialDraft?.proposalSha256 && hash(captured) !== record.editorialDraft.proposalSha256) throw new Error("The captured editorial proposal changed after settlement.");
  const proposal = JSON.parse(captured) as EditorialDraftProposalArtifact;
  if (typeof proposal.message !== "string") throw new Error("The captured editorial proposal is invalid.");
  serializeEditorialNote(proposal.note);
  const error = validateEditorialDraftProposal(request.note,proposal.note,body);
  if (error) throw new Error(error);
  return proposal;
}

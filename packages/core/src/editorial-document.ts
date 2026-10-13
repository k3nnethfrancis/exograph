import type { EditorialNote } from './editorial-notes.js';
import type { VersionedNoteDocument } from './document-persistence.js';
export interface EditorialSnapshot { version: 1; documentId: string | null; notes: EditorialNote[]; revision: string; sourceRevision: string; inlineNoteIds: string[]; orphans?: Array<{documentId:string;relativePath:string;noteCount:number}> }
export type EditorialSaveResult = {status:'saved';snapshot:EditorialSnapshot} | {status:'conflict';snapshot:EditorialSnapshot};
export type EditorialMutationResult = {status:'applied';snapshot:EditorialSnapshot;document:VersionedNoteDocument;transactionId:string} | {status:'conflict';snapshot:EditorialSnapshot;error:string};
export interface EditorialChangedEvent { filePath: string; snapshot?: EditorialSnapshot }

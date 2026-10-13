import type { EditorialNote } from '@exograph/core/editorial-notes';
import type { EditorialSnapshot, EditorialSaveResult, EditorialMutationResult, EditorialChangedEvent } from '@exograph/core/editorial-document';
export type { EditorialSnapshot, EditorialSaveResult, EditorialMutationResult, EditorialChangedEvent } from '@exograph/core/editorial-document';
export interface EditorialApi {
 read(filePath:string):Promise<EditorialSnapshot>;
 save(filePath:string,notes:EditorialNote[],expectedRevision:string):Promise<EditorialSaveResult>;
 apply(filePath:string,noteId:string,expectedSourceRevision:string,expectedRevision:string):Promise<EditorialMutationResult>;
 migrate(filePath:string,noteIds:string[],expectedSourceRevision:string,expectedRevision:string):Promise<EditorialMutationResult>;
 undo(filePath:string,transactionId:string,expectedSourceRevision:string,expectedRevision:string):Promise<EditorialMutationResult>;
 redo(filePath:string,transactionId:string,expectedSourceRevision:string,expectedRevision:string):Promise<EditorialMutationResult>;
 relink(filePath:string,documentId:string,expectedRevision:string):Promise<EditorialSaveResult>;
 onChanged(listener:(event:EditorialChangedEvent)=>void):()=>void;
}

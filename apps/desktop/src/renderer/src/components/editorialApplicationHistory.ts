export interface EditorialApplicationReceipt {id:string;before:string;after:string}
export interface EditorialApplicationHistory {entries:EditorialApplicationReceipt[];index:number}
const histories=new Map<string,EditorialApplicationHistory>();
/** Shared across editor remounts so a supported rename retains paired Undo. */
export function getEditorialApplicationHistory(documentId:string) {return histories.get(documentId);}
export function recordEditorialApplication(previousKey:string,documentId:string,receipt:EditorialApplicationReceipt) {
  const history=histories.get(previousKey)??histories.get(documentId)??{entries:[],index:0};
  history.entries=history.entries.slice(0,history.index);history.entries.push(receipt);history.index=history.entries.length;
  histories.set(documentId,history);histories.set(previousKey,history);return history;
}

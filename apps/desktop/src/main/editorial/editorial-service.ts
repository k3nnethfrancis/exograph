import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { EditorialStore } from '@exograph/core/editorial-store';
import { DocumentPersistence, WorkspaceFiles, renameWorkspacePath, type WorkspaceModel } from '@exograph/core';
import type { EditorialNote } from '@exograph/core/editorial-notes';
import type { EditorialApi } from '../../shared/api/editorial';
import type { EditorialChangedEvent } from '@exograph/core/editorial-document';

export class EditorialService {
 private readonly stores=new Map<string,EditorialStore>();
 private readonly watchers=new Map<string,FSWatcher>();
 private readonly tracked=new Set<string>();
 private readonly debounce=new Map<string,ReturnType<typeof setTimeout>>();
 constructor(private readonly getModel:()=>WorkspaceModel,private readonly persistence:DocumentPersistence,private readonly onChanged:(event:EditorialChangedEvent)=>void=()=>{}) {}
 private root(filePath:string):string {const absolute=path.resolve(filePath);const root=this.getModel().noteRoots.map(r=>path.resolve(r.path)).filter(r=>{const relative=path.relative(r,absolute);return relative!=='' && !relative.startsWith('..') && !path.isAbsolute(relative);}).sort((a,b)=>b.length-a.length)[0];if(!root) throw new Error('Editorial document is outside the configured Note Roots.');return root;}
 private store(filePath:string):EditorialStore {const root=this.root(filePath);let store=this.stores.get(root);if(!store){store=new EditorialStore(root,this.persistence);this.stores.set(root,store);}this.tracked.add(path.resolve(filePath));return store;}
 private observe(store:EditorialStore):void {
  if(this.watchers.has(store.noteRoot)) return;
  try {const watcher=watch(store.directory,{recursive:true},()=>{if(!this.getModel().noteRoots.some(r=>path.resolve(r.path)===store.noteRoot)) return;clearTimeout(this.debounce.get(store.noteRoot));this.debounce.set(store.noteRoot,setTimeout(()=>{for(const filePath of this.tracked) {try{if(this.root(filePath)===store.noteRoot) this.onChanged({filePath});}catch{/* Former workspace paths are not active authority. */}}},30));});this.watchers.set(store.noteRoot,watcher);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
 }
 relink:EditorialApi['relink']=async(filePath,id,revision)=>{const store=this.store(filePath),result=await store.relink(filePath,id,revision);this.observe(store);if(result.status==='saved') this.onChanged({filePath,snapshot:result.snapshot});return result;};
 read:EditorialApi['read']=async filePath=>{const store=this.store(filePath),snapshot=await store.read(filePath);this.observe(store);return snapshot;};
 save:EditorialApi['save']=async(filePath,notes,revision)=>{const store=this.store(filePath),result=await store.save(filePath,notes,revision);this.observe(store);if(result.status==='saved') this.onChanged({filePath,snapshot:result.snapshot});return result;};
 apply:EditorialApi['apply']=async(filePath,id,sourceRevision,revision)=>{const store=this.store(filePath),result=await store.apply(filePath,id,sourceRevision,revision);this.observe(store);if(result.status==='applied') this.onChanged({filePath,snapshot:result.snapshot});return result;};
 migrate:EditorialApi['migrate']=async(filePath,ids,sourceRevision,revision)=>{const store=this.store(filePath),result=await store.migrate(filePath,ids,sourceRevision,revision);this.observe(store);if(result.status==='applied') this.onChanged({filePath,snapshot:result.snapshot});return result;};
 undo:EditorialApi['undo']=async(filePath,id,sourceRevision,revision)=>{const result=await this.store(filePath).undo(filePath,id,sourceRevision,revision);if(result.status==='applied') this.onChanged({filePath,snapshot:result.snapshot});return result;};
 redo:EditorialApi['redo']=async(filePath,id,sourceRevision,revision)=>{const result=await this.store(filePath).redo(filePath,id,sourceRevision,revision);if(result.status==='applied') this.onChanged({filePath,snapshot:result.snapshot});return result;};
 async importProposal(filePath:string,noteId:string,expectedRevision:string,proposal:EditorialNote,documentBody:string,expectedSourceRevision?:string) {const store=this.store(filePath),result=await store.importProposal(filePath,noteId,expectedRevision,proposal,documentBody,expectedSourceRevision);this.observe(store);if(result.status==='saved') this.onChanged({filePath,snapshot:result.snapshot});return result;}
 /** Called by main for source watcher events; no sidecar write or automatic rebasing. */
 sourceChanged(filePath:string):void {if(this.tracked.has(path.resolve(filePath))) this.onChanged({filePath});}
 async renamePath(sourcePath:string,nextPath:string):Promise<string> {
  const sourceStore=this.store(sourcePath),nextRoot=this.root(nextPath);const files=new WorkspaceFiles(this.getModel().noteRoots.map(r=>r.path));await files.writable(sourcePath);await files.writable(nextPath);
  const result=sourceStore.noteRoot===nextRoot
   ? await sourceStore.renamePath(sourcePath,nextPath,renameWorkspacePath)
   : await sourceStore.moveUnannotated(sourcePath,()=>renameWorkspacePath(sourcePath,nextPath));for(const old of [...this.tracked]) if(old===sourcePath || old.startsWith(sourcePath+path.sep)) {this.tracked.delete(old);this.tracked.add(nextPath+old.slice(sourcePath.length));}this.onChanged({filePath:nextPath});return result;
 }
 dispose():void {for(const watcher of this.watchers.values()) watcher.close();for(const timer of this.debounce.values()) clearTimeout(timer);this.watchers.clear();this.debounce.clear();}
}

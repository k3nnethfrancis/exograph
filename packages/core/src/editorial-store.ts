import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { DocumentPersistence } from './document-persistence.js';
import { WorkspaceFiles } from './workspace-files.js';
import { parseWorkspaceDocument } from './notes.js';
import { applyEditorialEdits, captureEditorialTarget, reconcileEditorialTarget, isValidEditorialNote, parseEditorialNotes, validateEditorialDraftProposal, type EditorialNote } from './editorial-notes.js';
import type { EditorialSnapshot, EditorialSaveResult, EditorialMutationResult } from './editorial-document.js';

interface EditorialRecord { version:1; id:string; relativePath:string; sourceHash:string; notes:EditorialNote[] }
interface EditorialCatalog { version:1; documents:Record<string,string> }
interface EditorialJournal {version:1;id:string;relativePath:string;documentId:string;beforeSource:string;afterSource:string;beforeRecord:EditorialRecord|null;afterRecord:EditorialRecord;state:'prepared'|'complete'|'undone'|'conflict';beforeSourceHash:string;afterSourceHash:string;restore?:{redo:boolean;beforeRecord:EditorialRecord|null;afterRecord:EditorialRecord|null};error?:string}
interface AnnotationCommitJournal {version:1;id:string;relativePath:string;documentId:string;beforeRecordText:string|null;afterRecordText:string;beforeCatalogText:string|null;afterCatalogText:string;state:'prepared'|'complete'|'conflict'}
class EditorialWriteConflict extends Error {}
interface EditorialMoveJournal {version:1;id:string;source:string;next:string;dev:number;ino:number;beforeCatalog:EditorialCatalog;afterCatalog:EditorialCatalog;records:Array<{before:EditorialRecord;after:EditorialRecord}>;transactions?:Array<{before:EditorialJournal;after:EditorialJournal}>;state:'prepared'|'complete'|'aborted'|'conflict'}
const hash=(source:string)=>createHash('sha256').update(source).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rootQueues=new Map<string,Promise<unknown>>();
function validRelative(value:unknown):value is string {return typeof value==='string' && value.length>0 && !path.isAbsolute(value) && !value.split(/[\\/]/).some(segment=>segment==='..' || segment==='.' || segment==='.exograph') && !value.includes('\\');}
function validCatalog(value:unknown):value is EditorialCatalog {if(!value || typeof value!=='object') return false;const c=value as EditorialCatalog;return c.version===1 && !!c.documents && typeof c.documents==='object' && !Array.isArray(c.documents) && Object.entries(c.documents).every(([relative,id])=>validRelative(relative) && typeof id==='string' && uuid.test(id));}
function validMove(value:unknown):value is EditorialMoveJournal {if(!value || typeof value!=='object') return false;const m=value as EditorialMoveJournal;return m.version===1 && uuid.test(m.id) && validRelative(m.source) && validRelative(m.next) && typeof m.dev==='number' && typeof m.ino==='number' && validCatalog(m.beforeCatalog) && validCatalog(m.afterCatalog) && Array.isArray(m.records) && m.records.every(r=>r && validRecord(r.before) && validRecord(r.after) && r.before.id===r.after.id) && (!m.transactions || Array.isArray(m.transactions) && m.transactions.every(t=>validJournal(t.before) && validJournal(t.after) && t.before.id===t.after.id && t.before.documentId===t.after.documentId)) && ['prepared','complete','aborted','conflict'].includes(m.state);}
function validRecord(value:unknown):value is EditorialRecord {if(!value || typeof value!=='object') return false;const record=value as EditorialRecord;return record.version===1 && uuid.test(record.id) && validRelative(record.relativePath) && /^[a-f0-9]{64}$/.test(record.sourceHash) && validNotes(record.notes);}
function validJournal(value:unknown):value is EditorialJournal {if(!value || typeof value!=='object') return false;const j=value as EditorialJournal;return j.version===1 && uuid.test(j.id) && uuid.test(j.documentId) && validRelative(j.relativePath) && typeof j.beforeSource==='string' && typeof j.afterSource==='string' && hash(j.beforeSource)===j.beforeSourceHash && hash(j.afterSource)===j.afterSourceHash && validRecord(j.afterRecord) && j.afterRecord.id===j.documentId && j.afterRecord.relativePath===j.relativePath && j.afterRecord.sourceHash===j.afterSourceHash && (j.beforeRecord===null || validRecord(j.beforeRecord) && j.beforeRecord.id===j.documentId && j.beforeRecord.relativePath===j.relativePath) && ['prepared','complete','undone','conflict'].includes(j.state) && (!j.restore || typeof j.restore.redo==='boolean' && (j.restore.beforeRecord===null || validRecord(j.restore.beforeRecord)) && (j.restore.afterRecord===null || validRecord(j.restore.afterRecord)));}
function validNotes(notes:unknown):notes is EditorialNote[] {return Array.isArray(notes) && notes.every(isValidEditorialNote) && new Set(notes.map(n=>n.id)).size===notes.length;}

/** Authored review data, not a disposable runtime cache. All writes are root-scoped and revision checked. */
export class EditorialStore {
 readonly directory:string;
 constructor(readonly noteRoot:string, private readonly persistence=new DocumentPersistence()) {this.noteRoot=path.resolve(noteRoot);this.directory=path.join(this.noteRoot,'.exograph','editorial','v1');}
 private async locked<T>(action:()=>Promise<T>):Promise<T> {
  const previous=rootQueues.get(this.noteRoot) ?? Promise.resolve();const pending=previous.catch(()=>{}).then(action);rootQueues.set(this.noteRoot,pending);
  try{return await pending;}finally{if(rootQueues.get(this.noteRoot)===pending) rootQueues.delete(this.noteRoot);}
 }
 private relative(filePath:string):string {const relative=path.relative(this.noteRoot,path.resolve(filePath));if(!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).includes('.exograph')) throw new Error('Editorial document is outside the authorized Note Root.');return relative.split(path.sep).join('/');}
 private async authorize(filePath:string,existing=true):Promise<string> {this.relative(filePath);const files=new WorkspaceFiles([this.noteRoot]);return existing?files.existing(filePath):files.writable(filePath);}
 private recordPath(id:string):string {if(!uuid.test(id)) throw new Error('Invalid editorial document identity.');return path.join(this.directory,'documents',`${id}.json`);}
 private journalPath(id:string):string {if(!uuid.test(id)) throw new Error('Invalid editorial transaction identity.');return path.join(this.directory,'transactions',`${id}.json`);}
 private async text(file:string):Promise<string|null> {await new WorkspaceFiles([this.noteRoot]).writable(file);try{return await readFile(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') return null;throw error;}}
 private async json(file:string):Promise<unknown|null> {await new WorkspaceFiles([this.noteRoot]).writable(file);try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') return null;throw error;}}
 private async atomic(file:string,value:unknown,guard?:()=>Promise<boolean>):Promise<void> {
  await new WorkspaceFiles([this.noteRoot]).writable(file);await mkdir(path.dirname(file),{recursive:true});const temporary=`${file}.${randomUUID()}.tmp`;
  try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});const handle=await open(temporary,'r');try{await handle.sync();}finally{await handle.close();}if(guard && !await guard()) throw new EditorialWriteConflict('Editorial state changed during staged save; outside edits were preserved.');await rename(temporary,file);const dir=await open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}}finally{await rm(temporary,{force:true});}
 }
 private async catalog():Promise<EditorialCatalog> {
  const value=await this.json(path.join(this.directory,'catalog.json'));
  if(value===null) return {version:1,documents:{}};
  const catalog=value as EditorialCatalog;
  if(!validCatalog(catalog)) throw new Error('Unsupported or invalid editorial catalog; original retained.');
  return catalog;
 }
 private async record(id:string):Promise<EditorialRecord|null> {
  const value=await this.json(this.recordPath(id));if(value===null) return null;const record=value as EditorialRecord;
  if(!validRecord(record) || record.id!==id) throw new Error('Unsupported or invalid editorial record; original retained.');return record;
 }
 private async state(filePath:string):Promise<{source:string;body:string;record:EditorialRecord|null;catalog:EditorialCatalog;recordText:string|null;catalogText:string|null;snapshot:EditorialSnapshot}> {
  await this.authorize(filePath);const source=await readFile(filePath,'utf8'),body=parseWorkspaceDocument(filePath,source).body;const catalogText=await this.text(path.join(this.directory,'catalog.json')),catalog:EditorialCatalog=catalogText===null?{version:1,documents:{}}:JSON.parse(catalogText);if(!validCatalog(catalog)) throw new Error('Unsupported or invalid editorial catalog; original retained.');
  const relative=this.relative(filePath),id=Object.hasOwn(catalog.documents,relative)?catalog.documents[relative]:undefined,recordText=id?await this.text(this.recordPath(id)):null,record:EditorialRecord|null=recordText===null?null:JSON.parse(recordText);if(record && (!validRecord(record) || record.id!==id)) throw new Error('Unsupported or invalid editorial record; original retained.');
  if(record && record.relativePath!==relative) throw new Error('Editorial record path differs from catalog; recovery required.');
  if(id && !record) throw new Error('Editorial catalog references a missing record; annotations need recovery.');
  const inline=parseEditorialNotes(body).filter(span=>!span.error),notes=[...(record?.notes ?? [])];
  for(const span of inline) if(!notes.some(note=>note.id===span.note.id)) notes.push(span.note);
  return {source,body,record,catalog,recordText,catalogText,snapshot:{version:1,documentId:record?.id ?? null,notes,revision:hash(JSON.stringify({recordText,inline:inline.map(s=>s.raw)})),sourceRevision:hash(source),inlineNoteIds:inline.map(s=>s.note.id),orphans:await this.orphans(catalog)}};
 }
 async read(filePath:string):Promise<EditorialSnapshot> {return this.locked(async()=>{await this.authorize(filePath);await this.recoverAnnotationCommits();await this.recoverMoves();await this.recoverCatalog(filePath);await this.recoverUnlocked(filePath);await this.reconnectExact(filePath);return (await this.state(filePath)).snapshot;});}
 async save(filePath:string,notes:EditorialNote[],expectedRevision:string):Promise<EditorialSaveResult> {
  if(!validNotes(notes)) throw new Error('Invalid or duplicate editorial notes.');
  return this.locked(async()=>{await this.recoverAnnotationCommits();await this.recoverMoves();await this.recoverUnlocked(filePath);const current=await this.state(filePath);if(current.snapshot.revision!==expectedRevision) return {status:'conflict',snapshot:current.snapshot};
   const id=current.record?.id ?? randomUUID(),record:EditorialRecord={...current.record,version:1,id,relativePath:this.relative(filePath),sourceHash:hash(current.source),notes};
   try{await this.commitAnnotations(current,record);}catch(error){if(error instanceof EditorialWriteConflict) return {status:'conflict',snapshot:(await this.state(filePath)).snapshot};throw error;}return {status:'saved',snapshot:(await this.state(filePath)).snapshot};});
 }
 async importProposal(filePath:string,noteId:string,expectedRevision:string,proposal:EditorialNote,documentBody:string,expectedSourceRevision?:string):Promise<EditorialSaveResult> {
  return this.locked(async()=>{await this.recoverAnnotationCommits();await this.recoverMoves();await this.recoverUnlocked(filePath);const current=await this.state(filePath);const already=current.snapshot.notes.find(n=>n.id===noteId);if(already && JSON.stringify(already)===JSON.stringify(proposal)) return {status:'saved',snapshot:current.snapshot};if(current.snapshot.revision!==expectedRevision || expectedSourceRevision && current.snapshot.sourceRevision!==expectedSourceRevision && current.body!==documentBody) return {status:'conflict',snapshot:current.snapshot};
   const prior=current.snapshot.notes.find(n=>n.id===noteId);if(!prior) throw new Error('Selected editorial note no longer exists.');const error=validateEditorialDraftProposal(prior,proposal,documentBody);if(error) throw new Error(error);
   const id=current.record?.id ?? randomUUID(),record:EditorialRecord={...current.record,version:1,id,relativePath:this.relative(filePath),sourceHash:hash(current.source),notes:current.snapshot.notes.map(n=>n.id===noteId?proposal:n)};
   try{await this.commitAnnotations(current,record);}catch(error){if(error instanceof EditorialWriteConflict) return {status:'conflict',snapshot:(await this.state(filePath)).snapshot};throw error;}return {status:'saved',snapshot:(await this.state(filePath)).snapshot};});
 }
 private async commitAnnotations(current:Awaited<ReturnType<EditorialStore['state']>>,record:EditorialRecord):Promise<void> {
  const catalog:EditorialCatalog={...current.catalog,documents:{...current.catalog.documents,[record.relativePath]:record.id}};
  const journal:AnnotationCommitJournal={version:1,id:randomUUID(),relativePath:record.relativePath,documentId:record.id,beforeRecordText:current.recordText,afterRecordText:JSON.stringify(record,null,2)+'\n',beforeCatalogText:current.catalogText,afterCatalogText:JSON.stringify(catalog,null,2)+'\n',state:'prepared'};
  const journalPath=path.join(this.directory,'annotation-transactions',journal.id+'.json');await this.atomic(journalPath,journal);
  try {
   await this.atomic(this.recordPath(record.id),record,async()=>await this.text(this.recordPath(record.id))===current.recordText && await this.text(path.join(this.directory,'catalog.json'))===current.catalogText);
   await this.atomic(path.join(this.directory,'catalog.json'),catalog,async()=>await this.text(path.join(this.directory,'catalog.json'))===current.catalogText && await this.text(this.recordPath(record.id))===journal.afterRecordText);
   journal.state='complete';await this.atomic(journalPath,journal);await rm(journalPath,{force:true});
  }catch(error){if(error instanceof EditorialWriteConflict){journal.state='conflict';await this.atomic(journalPath,journal);}throw error;}
 }
 private async recoverAnnotationCommits():Promise<void> {
  const directory=path.join(this.directory,'annotation-transactions');await new WorkspaceFiles([this.noteRoot]).writable(directory);let names:string[];try{names=await readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') return;throw error;}
  for(const name of names.filter(name=>name.endsWith('.json'))) {
   const value=await this.json(path.join(directory,name)) as AnnotationCommitJournal|null;
   if(!value || value.version!==1 || !uuid.test(value.id) || !uuid.test(value.documentId) || !validRelative(value.relativePath) || !['prepared','complete','conflict'].includes(value.state) || typeof value.afterRecordText!=='string' || typeof value.afterCatalogText!=='string' || value.beforeRecordText!==null && typeof value.beforeRecordText!=='string' || value.beforeCatalogText!==null && typeof value.beforeCatalogText!=='string') throw new Error('Invalid editorial annotation journal; originals retained.');
   const afterRecord=JSON.parse(value.afterRecordText),afterCatalog=JSON.parse(value.afterCatalogText),beforeRecord=value.beforeRecordText===null?null:JSON.parse(value.beforeRecordText),beforeCatalog=value.beforeCatalogText===null?{version:1,documents:{}}:JSON.parse(value.beforeCatalogText);
   if(!validRecord(afterRecord) || afterRecord.id!==value.documentId || afterRecord.relativePath!==value.relativePath || !validCatalog(afterCatalog) || afterCatalog.documents[value.relativePath]!==value.documentId || beforeRecord!==null && (!validRecord(beforeRecord) || beforeRecord.id!==value.documentId || beforeRecord.relativePath!==value.relativePath) || !validCatalog(beforeCatalog)) throw new Error('Invalid editorial annotation recovery snapshots; originals retained.');
   if(value.state==='complete') {await rm(path.join(directory,name),{force:true});continue;}
   if(value.state!=='prepared') continue;
   const recordText=await this.text(this.recordPath(value.documentId)),catalogText=await this.text(path.join(this.directory,'catalog.json'));
   if(![value.beforeRecordText,value.afterRecordText].includes(recordText) || ![value.beforeCatalogText,value.afterCatalogText].includes(catalogText)){value.state='conflict';await this.atomic(path.join(directory,name),value);continue;}
   await this.atomic(this.recordPath(value.documentId),afterRecord,async()=>await this.text(this.recordPath(value.documentId))===recordText && await this.text(path.join(this.directory,'catalog.json'))===catalogText);
   await this.atomic(path.join(this.directory,'catalog.json'),afterCatalog,async()=>await this.text(path.join(this.directory,'catalog.json'))===catalogText && await this.text(this.recordPath(value.documentId))===value.afterRecordText);
   value.state='complete';await this.atomic(path.join(directory,name),value);await rm(path.join(directory,name),{force:true});
  }
 }
 async apply(filePath:string,noteId:string,expectedSourceRevision:string,expectedRevision:string):Promise<EditorialMutationResult> {
  return this.mutate(filePath,expectedSourceRevision,expectedRevision,(body,notes)=>{const note=notes.find(n=>n.id===noteId);if(!note) throw new Error('Selected editorial note no longer exists.');const applied=applyEditorialEdits(body,note);if(!applied.ok) throw new Error(applied.error);let nextBody=applied.source;
   // Explicit Apply also migrates this selected inline annotation; others stay exact.
   const spans=parseEditorialNotes(nextBody).filter(s=>s.note.id===noteId && !s.error);for(const span of spans.sort((a,b)=>b.from-a.from)) nextBody=nextBody.slice(0,span.from)+nextBody.slice(span.to);
   return {body:nextBody,notes:notes.map(n=>n.id===noteId?{...n,status:'resolved' as const}:n)};});
 }
 async migrate(filePath:string,noteIds:string[],expectedSourceRevision:string,expectedRevision:string):Promise<EditorialMutationResult> {
  return this.mutate(filePath,expectedSourceRevision,expectedRevision,(body,notes)=>{const spans=parseEditorialNotes(body).filter(s=>noteIds.includes(s.note.id));if(spans.length!==new Set(noteIds).size || spans.some(s=>s.error)) throw new Error('Select valid current inline annotations before migrating.');let nextBody=body;for(const span of spans.sort((a,b)=>b.from-a.from)) nextBody=nextBody.slice(0,span.from)+nextBody.slice(span.to);
   const migrated=notes.map(note=>!noteIds.includes(note.id)?note:{...note,targets:note.targets.map(target=>{const result=reconcileEditorialTarget(nextBody,target);if(result.state!=='unchanged' && result.state!=='moved') return target;const captured=captureEditorialTarget(nextBody,result.from!,result.to!,target.id);return {...target,from:captured.from,to:captured.to,prefix:captured.prefix,suffix:captured.suffix,atStart:captured.atStart,atEnd:captured.atEnd};})});return {body:nextBody,notes:migrated};});
 }
 private async mutate(filePath:string,expectedSourceRevision:string,expectedRevision:string,transform:(body:string,notes:EditorialNote[])=>{body:string;notes:EditorialNote[]}):Promise<EditorialMutationResult> {
  return this.locked(async()=>{await this.recoverAnnotationCommits();await this.recoverMoves();await this.recoverUnlocked(filePath);const current=await this.state(filePath);if(current.snapshot.revision!==expectedRevision || current.snapshot.sourceRevision!==expectedSourceRevision) return {status:'conflict',snapshot:current.snapshot,error:'Author prose or annotations changed; refresh before applying.'};
   let transformed;try{transformed=transform(current.body,current.snapshot.notes);}catch(error){return {status:'conflict',snapshot:current.snapshot,error:(error as Error).message};}
   if(!current.source.endsWith(current.body)) throw new Error('Cannot identify exact author body.');const afterSource=current.source.slice(0,current.source.length-current.body.length)+transformed.body,id=current.record?.id ?? randomUUID();
   const afterRecord:EditorialRecord={...current.record,version:1,id,relativePath:this.relative(filePath),sourceHash:hash(afterSource),notes:transformed.notes};
   const journal:EditorialJournal={version:1,id:randomUUID(),relativePath:afterRecord.relativePath,documentId:id,beforeSource:current.source,afterSource,beforeRecord:current.record,afterRecord,beforeSourceHash:hash(current.source),afterSourceHash:hash(afterSource),state:'prepared'};
   await this.atomic(this.journalPath(journal.id),journal);const saved=await this.persistence.saveRaw(filePath,afterSource,expectedSourceRevision);
   if(saved.status!=='saved'){journal.state='conflict';journal.error='Author source changed during the guarded save.';await this.atomic(this.journalPath(journal.id),journal);return {status:'conflict',snapshot:(await this.state(filePath)).snapshot,error:journal.error};}
   await this.finishJournal(journal,current.catalog);return {status:'applied',snapshot:(await this.state(filePath)).snapshot,document:await this.persistence.read(filePath),transactionId:journal.id};});
 }
 private async finishJournal(journal:EditorialJournal,_catalog:EditorialCatalog):Promise<void> {
  const catalog=await this.catalog(),current=await this.record(journal.documentId),mapped=catalog.documents[journal.relativePath];
  if(mapped && mapped!==journal.documentId || JSON.stringify(current)!==JSON.stringify(journal.beforeRecord) && JSON.stringify(current)!==JSON.stringify(journal.afterRecord)) throw new Error('Annotations changed while author prose was committed; recovery snapshots retained.');
  await this.atomic(this.recordPath(journal.documentId),journal.afterRecord);catalog.documents[journal.relativePath]=journal.documentId;await this.atomic(path.join(this.directory,'catalog.json'),catalog);journal.state='complete';await this.atomic(this.journalPath(journal.id),journal);
 }
 private async recoverUnlocked(filePath:string):Promise<void> {
  const dir=path.join(this.directory,'transactions');await new WorkspaceFiles([this.noteRoot]).writable(dir);let files:string[];try{files=await readdir(dir);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') return;throw error;}
  for(const name of files.filter(name=>name.endsWith('.json'))) {const value=await this.json(path.join(dir,name));if(!validJournal(value)) throw new Error('Invalid editorial recovery journal; snapshots retained without writes.');const journal=value;if(journal.relativePath!==this.relative(filePath) || journal.state!=='prepared') continue;
   const source=await readFile(filePath,'utf8'),catalog=await this.catalog(),record=await this.record(journal.documentId);
   if(journal.restore) {
    const restore=journal.restore,desiredSource=restore.redo?journal.afterSource:journal.beforeSource;
    if(source===desiredSource && (JSON.stringify(record)===JSON.stringify(restore.beforeRecord) || JSON.stringify(record)===JSON.stringify(restore.afterRecord))) {await this.restoreRecord(journal,catalog,restore.afterRecord);journal.state=restore.redo?'complete':'undone';delete journal.restore;await this.atomic(this.journalPath(journal.id),journal);}
    else if(source===(restore.redo?journal.beforeSource:journal.afterSource) && JSON.stringify(record)===JSON.stringify(restore.beforeRecord)) {journal.state=restore.redo?'undone':'complete';delete journal.restore;await this.atomic(this.journalPath(journal.id),journal);}
    else {journal.state='conflict';journal.error='Interrupted restore could not safely settle; snapshots retained.';await this.atomic(this.journalPath(journal.id),journal);}
    continue;
   }
   if(source===journal.afterSource && (JSON.stringify(record)===JSON.stringify(journal.beforeRecord) || JSON.stringify(record)===JSON.stringify(journal.afterRecord))) await this.finishJournal(journal,catalog);
   else if(source===journal.beforeSource && JSON.stringify(record)===JSON.stringify(journal.beforeRecord)) {journal.state='conflict';journal.error='Interrupted before author source was committed; no changes applied.';await this.atomic(this.journalPath(journal.id),journal);}
   else {journal.state='conflict';journal.error='Outside changes prevent editorial recovery; snapshots retained.';await this.atomic(this.journalPath(journal.id),journal);}
  }
 }
 async undo(filePath:string,transactionId:string,expectedSourceRevision:string,expectedRevision:string):Promise<EditorialMutationResult> {return this.restore(filePath,transactionId,expectedSourceRevision,expectedRevision,false);}
 async redo(filePath:string,transactionId:string,expectedSourceRevision:string,expectedRevision:string):Promise<EditorialMutationResult> {return this.restore(filePath,transactionId,expectedSourceRevision,expectedRevision,true);}
 private async restore(filePath:string,transactionId:string,expectedSourceRevision:string,expectedRevision:string,redo:boolean):Promise<EditorialMutationResult> {
  return this.locked(async()=>{await this.recoverAnnotationCommits();await this.recoverMoves();await this.recoverUnlocked(filePath);const current=await this.state(filePath),value=await this.json(this.journalPath(transactionId));if(value!==null && !validJournal(value)) throw new Error('Invalid editorial journal; original retained.');const journal=value as EditorialJournal|null;if(!journal || journal.relativePath!==this.relative(filePath) || (redo?journal.state!=='undone':journal.state!=='complete')) return {status:'conflict',snapshot:current.snapshot,error:'This editorial transaction cannot be restored.'};
   const expectedSource=redo?journal.beforeSource:journal.afterSource,expectedRecord=redo?journal.beforeRecord:journal.afterRecord;if(JSON.stringify(current.record)!==JSON.stringify(expectedRecord) || current.snapshot.revision!==expectedRevision || current.snapshot.sourceRevision!==expectedSourceRevision || current.source!==expectedSource) return {status:'conflict',snapshot:current.snapshot,error:'Prose or annotations changed after this transaction; recovery snapshots retained.'};
   const desiredSource=redo?journal.afterSource:journal.beforeSource,desiredRecord=redo?journal.afterRecord:journal.beforeRecord;
   journal.restore={redo,beforeRecord:current.record,afterRecord:desiredRecord};journal.state='prepared';await this.atomic(this.journalPath(transactionId),journal);
   const saved=await this.persistence.saveRaw(filePath,desiredSource,expectedSourceRevision);if(saved.status!=='saved') return {status:'conflict',snapshot:(await this.state(filePath)).snapshot,error:'Author source changed while restoring.'};
   if(JSON.stringify(await this.record(journal.documentId))!==JSON.stringify(current.record)) throw new Error('Annotations changed during restore; recovery snapshots retained.');
   await this.restoreRecord(journal,await this.catalog(),desiredRecord);delete journal.restore;journal.state=redo?'complete':'undone';await this.atomic(this.journalPath(transactionId),journal);return {status:'applied',snapshot:(await this.state(filePath)).snapshot,document:await this.persistence.read(filePath),transactionId};});
 }
 private async restoreRecord(journal:EditorialJournal,catalog:EditorialCatalog,record:EditorialRecord|null):Promise<void> {
  if(record) {await this.atomic(this.recordPath(journal.documentId),record);catalog.documents[journal.relativePath]=journal.documentId;await this.atomic(path.join(this.directory,'catalog.json'),catalog);}
  else {delete catalog.documents[journal.relativePath];await this.atomic(path.join(this.directory,'catalog.json'),catalog);await rm(this.recordPath(journal.documentId),{force:true});}
 }
 /** Preserve ordinary moves when no portable editorial identity needs migration.
  * The main caller authorizes the destination; this root owns the source check
  * and queue so a local annotation save cannot race the move decision. */
 async moveUnannotated(sourcePath:string,move:()=>Promise<string>):Promise<string> {
  return this.locked(async()=>{
   await this.authorize(sourcePath);await this.recoverAnnotationCommits();await this.recoverMoves();
   const source=this.relative(sourcePath),catalog=await this.catalog();
   if(Object.keys(catalog.documents).some(key=>key===source || key.startsWith(source+'/'))) throw new Error('Cross-Note-Root moves of annotated files require moving their portable annotation records together.');
   return move();
  });
 }
 /** One main-owned mutation for the author path and its portable catalog. */
 async renamePath(sourcePath:string,nextPath:string,renameFile:(source:string,next:string)=>Promise<string>):Promise<string> {
  return this.locked(async()=>{
   await this.authorize(sourcePath);await this.authorize(nextPath,false);await this.recoverAnnotationCommits();await this.recoverMoves();const source=this.relative(sourcePath),next=this.relative(nextPath),catalog=await this.catalog();
   const updates=Object.entries(catalog.documents).filter(([key])=>key===source || key.startsWith(source+'/'));
   const records:Array<{before:EditorialRecord;after:EditorialRecord}>=[];
   for(const [key,id] of updates){const destination=next+key.slice(source.length);if(catalog.documents[destination] && catalog.documents[destination]!==id) throw new Error('Destination already has editorial annotations.');const record=await this.record(id);if(!record) throw new Error('Cannot move a missing editorial record.');records.push({before:record,after:{...record,relativePath:destination}});}
   if(!records.length) return renameFile(sourcePath,nextPath);
   const afterCatalog:EditorialCatalog={...catalog,version:1,documents:{...catalog.documents}};for(const {before,after} of records){delete afterCatalog.documents[before.relativePath];afterCatalog.documents[after.relativePath]=after.id;}
   const transactions=await this.transactionRemaps(records);
   const identity=await stat(sourcePath),journal:EditorialMoveJournal={version:1,id:randomUUID(),source,next,dev:identity.dev,ino:identity.ino,beforeCatalog:catalog,afterCatalog,records,transactions,state:'prepared'};
   const journalPath=path.join(this.directory,'moves',journal.id+'.json');await this.atomic(journalPath,journal);
   const result=await renameFile(sourcePath,nextPath);
   for(const {after} of records) await this.atomic(this.recordPath(after.id),after);for(const {after} of transactions) await this.atomic(this.journalPath(after.id),after);await this.atomic(path.join(this.directory,'catalog.json'),afterCatalog);journal.state='complete';await this.atomic(journalPath,journal);return result;
  });
 }
 private async transactionRemaps(records:Array<{before:EditorialRecord;after:EditorialRecord}>):Promise<Array<{before:EditorialJournal;after:EditorialJournal}>> {
  const directory=path.join(this.directory,'transactions');await new WorkspaceFiles([this.noteRoot]).writable(directory);let names:string[];try{names=await readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') return [];throw error;}
  const result:Array<{before:EditorialJournal;after:EditorialJournal}>=[];
  for(const name of names.filter(name=>name.endsWith('.json'))) {const journal=await this.json(path.join(directory,name));if(!validJournal(journal)) throw new Error('Invalid editorial transaction; rename stopped before moving source.');const moved=records.find(record=>record.before.id===journal.documentId);if(!moved) continue;const relativePath=moved.after.relativePath;
   const remap=(record:EditorialRecord|null)=>record?{...record,relativePath}:null;
   result.push({before:journal,after:{...journal,relativePath,beforeRecord:remap(journal.beforeRecord),afterRecord:remap(journal.afterRecord)!,...(journal.restore?{restore:{...journal.restore,beforeRecord:remap(journal.restore.beforeRecord),afterRecord:remap(journal.restore.afterRecord)}}:{})}});
  }
  return result;
 }
 private async recoverMoves():Promise<void> {
  const directory=path.join(this.directory,'moves');await new WorkspaceFiles([this.noteRoot]).writable(directory);let names:string[];try{names=await readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') return;throw error;}
  const probe=async(relative:string)=>{try{return await stat(path.join(this.noteRoot,relative));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') return null;throw error;}};
  for(const name of names.filter(n=>n.endsWith('.json'))) {const value=await this.json(path.join(directory,name));if(!validMove(value)) throw new Error('Invalid editorial move journal; originals retained.');if(value.state!=='prepared') continue;
   const source=await probe(value.source),next=await probe(value.next),catalog=await this.catalog();
   if(!source && next?.dev===value.dev && next.ino===value.ino && [JSON.stringify(value.beforeCatalog),JSON.stringify(value.afterCatalog)].includes(JSON.stringify(catalog))) {
    let unchanged=true;for(const record of value.records){const current=await this.record(record.before.id);if(![JSON.stringify(record.before),JSON.stringify(record.after)].includes(JSON.stringify(current))) unchanged=false;}
    for(const transaction of value.transactions ?? []) {const current=await this.json(this.journalPath(transaction.before.id));if(![JSON.stringify(transaction.before),JSON.stringify(transaction.after)].includes(JSON.stringify(current))) unchanged=false;}
    if(unchanged) {for(const {after} of value.transactions ?? []) await this.atomic(this.journalPath(after.id),after);for(const {after} of value.records) await this.atomic(this.recordPath(after.id),after);await this.atomic(path.join(this.directory,'catalog.json'),value.afterCatalog);value.state='complete';}else value.state='conflict';
   }else if(source?.dev===value.dev && source.ino===value.ino && !next) value.state='aborted';else value.state='conflict';
   await this.atomic(path.join(directory,name),value);
  }
 }
 private async recoverCatalog(filePath:string):Promise<void> {
  const catalog=await this.catalog(),relative=this.relative(filePath);if(Object.hasOwn(catalog.documents,relative)) return;
  const directory=path.join(this.directory,'documents');await new WorkspaceFiles([this.noteRoot]).writable(directory);let names:string[];try{names=await readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') return;throw error;}
  const known=new Set(Object.values(catalog.documents)),candidates:EditorialRecord[]=[];
  for(const name of names.filter(name=>name.endsWith('.json'))) {const id=name.slice(0,-5);if(!uuid.test(id) || known.has(id)) continue;const record=await this.record(id);if(record?.relativePath===relative) candidates.push(record);}
  if(candidates.length===1) {catalog.documents[relative]=candidates[0].id;await this.atomic(path.join(this.directory,'catalog.json'),catalog);}
 }
 /** Reconnect only a unique, exact, unchanged orphan; changed or duplicate evidence stays orphaned. */
 private async reconnectExact(filePath:string):Promise<void> {
  const catalog=await this.catalog(),relative=this.relative(filePath);if(Object.hasOwn(catalog.documents,relative)) return;
  const fingerprint=hash(await readFile(filePath,'utf8')),candidates:Array<{key:string;record:EditorialRecord}>=[];
  for(const [key,id] of Object.entries(catalog.documents)) {try{await stat(path.join(this.noteRoot,key));continue;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}const record=await this.record(id);if(record?.sourceHash===fingerprint) candidates.push({key,record});}
  if(candidates.length!==1) return;
  let matches=0;
  const visit=async(directory:string):Promise<void>=>{for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.isSymbolicLink() || entry.name.startsWith('.')) continue;const target=path.join(directory,entry.name);if(entry.isDirectory()) await visit(target);else if(entry.isFile() && path.extname(target)===path.extname(filePath) && hash(await readFile(target,'utf8'))===fingerprint) matches++;if(matches>1) return;}};
  await visit(this.noteRoot);if(matches!==1) return;
  const candidate=candidates[0];candidate.record.relativePath=relative;await this.atomic(this.recordPath(candidate.record.id),candidate.record);delete catalog.documents[candidate.key];catalog.documents[relative]=candidate.record.id;await this.atomic(path.join(this.directory,'catalog.json'),catalog);
 }
 private async orphans(catalog:EditorialCatalog):Promise<Array<{documentId:string;relativePath:string;noteCount:number}>> {
  const values=await Promise.all(Object.entries(catalog.documents).map(async([relativePath,documentId])=>{try{await stat(path.join(this.noteRoot,relativePath));return null;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}const record=await this.record(documentId);return record?{documentId,relativePath,noteCount:record.notes.length}:null;}));
  return values.filter((value):value is NonNullable<typeof value>=>value!==null);
 }
 async relink(filePath:string,documentId:string,expectedRevision:string):Promise<EditorialSaveResult> {
  return this.locked(async()=>{await this.recoverAnnotationCommits();await this.recoverMoves();const current=await this.state(filePath);if(current.snapshot.revision!==expectedRevision) return {status:'conflict',snapshot:current.snapshot};
   const entry=Object.entries(current.catalog.documents).find(([,id])=>id===documentId);if(!entry) throw new Error('Orphan annotation identity no longer exists.');
   const [oldRelative]=entry;try{await stat(path.join(this.noteRoot,oldRelative));throw new Error('The original annotated file still exists; no relink performed.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
   if(current.record || current.snapshot.notes.length) throw new Error('This document already has annotations; choose an unannotated destination before relinking.');
   const record=await this.record(documentId);if(!record) throw new Error('Orphan annotation record is missing.');const relative=this.relative(filePath),after={...record,relativePath:relative},afterCatalog:EditorialCatalog={...current.catalog,version:1,documents:{...current.catalog.documents}};delete afterCatalog.documents[oldRelative];afterCatalog.documents[relative]=documentId;
   const transactions=await this.transactionRemaps([{before:record,after}]);
   const identity=await stat(filePath),journal:EditorialMoveJournal={version:1,id:randomUUID(),source:oldRelative,next:relative,dev:identity.dev,ino:identity.ino,beforeCatalog:current.catalog,afterCatalog,records:[{before:record,after}],transactions,state:'prepared'},journalPath=path.join(this.directory,'moves',journal.id+'.json');
   await this.atomic(journalPath,journal);await this.atomic(this.recordPath(documentId),after);for(const {after:transaction} of transactions) await this.atomic(this.journalPath(transaction.id),transaction);await this.atomic(path.join(this.directory,'catalog.json'),afterCatalog);journal.state='complete';await this.atomic(journalPath,journal);return {status:'saved',snapshot:(await this.state(filePath)).snapshot};
  });
 }
}

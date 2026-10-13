import { fromMarkdown } from 'mdast-util-from-markdown';
import { findDocumentAgentEnvelopes } from './document-agent-protocol.js';

export interface EditorialTarget { id: string; base: string; prefix: string; suffix: string; from: number; to: number; atStart?: boolean; atEnd?: boolean }
export interface EditorialEdit { targetId: string; replacement: string }
export interface EditorialNote { version: 1; id: string; title: string; commentary: string; status: 'open' | 'resolved' | 'dismissed'; targets: EditorialTarget[]; edits: EditorialEdit[] }
export interface EditorialSpan { from: number; to: number; note: EditorialNote; legacy: boolean; raw: string; error?: string }
export interface EditorialResolution { state: 'unchanged' | 'moved' | 'modified' | 'ambiguous' | 'missing'; from?: number; to?: number; current?: string }
export type EditorialApplyResult = { ok: true; source: string } | { ok: false; error: string };
export function createEditorialNote(input: Partial<Omit<EditorialNote, 'version'>> = {}): EditorialNote {
  return { version: 1, id: input.id ?? globalThis.crypto.randomUUID(), title: input.title ?? 'Editorial note', commentary: input.commentary ?? '', status: input.status ?? 'open', targets: input.targets ?? [], edits: input.edits ?? [] };
}
export function isValidEditorialNote(value: unknown): value is EditorialNote {
  if (!value || typeof value !== 'object') return false;
  const n = value as EditorialNote;
  return n.version === 1 && typeof n.id === 'string' && n.id.length > 0 && typeof n.title === 'string' && typeof n.commentary === 'string' && ['open','resolved','dismissed'].includes(n.status) && Array.isArray(n.targets) && Array.isArray(n.edits) && n.targets.every(t => t && typeof t.id === 'string' && t.id.length > 0 && (t.atStart === undefined || typeof t.atStart === 'boolean') && (t.atEnd === undefined || typeof t.atEnd === 'boolean') && typeof t.base === 'string' && typeof t.prefix === 'string' && typeof t.suffix === 'string' && Number.isInteger(t.from) && Number.isInteger(t.to) && t.from >= 0 && t.to >= t.from) && n.edits.every(e => e && typeof e.targetId === 'string' && typeof e.replacement === 'string') && new Set(n.targets.map(t => t.id)).size === n.targets.length && new Set(n.edits.map(e => e.targetId)).size === n.edits.length && n.edits.every(e => n.targets.some(t => t.id === e.targetId));
}
/** Protocol examples inside Markdown code are prose, never invocation provenance. */
function markdownCodeRanges(source: string): Array<{from:number;to:number}> {
  const code: Array<{from:number;to:number}> = [];
  const visit = (node: {type:string;position?:{start:{offset?:number};end:{offset?:number}};children?:unknown[]}) => {
    if((node.type==='code' || node.type==='inlineCode') && node.position) code.push({from:node.position.start.offset ?? 0,to:node.position.end.offset ?? source.length});
    for(const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
  };
  visit(fromMarkdown(source));
  return code;
}
function actualEnvelopes(source: string) {
  const code = markdownCodeRanges(source);
  return findDocumentAgentEnvelopes(source).filter(e => !code.some(c => e.from >= c.from && e.to <= c.to));
}
function closedEditorialFence(raw: string): boolean {
  const opening = /^[^\r\n]*?(`{3,}|~{3,})editorial\b/.exec(raw);
  if (!opening) return false;
  const lines = raw.split(/\r?\n/);
  const fence = opening[1];
  const closing = new RegExp('^[ \t>]*' + fence[0] + '{' + fence.length + ',}[ \t]*$');
  return lines.length > 1 && closing.test(lines.at(-1) ?? '');
}
/** Markdown's parser supplies exact ranges and excludes fenced examples inside larger fences. */
export function parseEditorialNotes(source: string, includeNested = false): EditorialSpan[] {
  const protocol = actualEnvelopes(source);
  const spans: EditorialSpan[] = [];
  const visit = (node: ReturnType<typeof fromMarkdown> | { type: string; lang?: string | null; value?: string; position?: {start:{offset?:number};end:{offset?:number}}; children?: unknown[] }, topLevel = false) => {
    if (topLevel && node.type === 'blockquote' && node.position) {
      const from = node.position.start.offset ?? 0, to = node.position.end.offset ?? source.length;
      const raw = source.slice(from,to);
      if (protocol.some(p => from >= p.from && to <= p.to)) return;
      if (/^>\s*\*\*Editorial (?:comment|note)\b/i.test(raw)) {
        const content = raw.split(/\r?\n/).map(line => line.replace(/^ {0,3}>[ \t]?/, '')).join('\n');
        const header = /^\*\*(Editorial (?:comment|note)[^*\n]*)\*\*[ \t]*(.*)/i.exec(content);
        const title = header?.[1] ?? 'Editorial note';
        const commentary = header ? header[2] + content.slice(header[0].length) : content;
        spans.push({from,to,raw,legacy:true,note:createEditorialNote({id:`legacy-${from}`,title,commentary})});
        return;
      }
    }
    if ((topLevel || includeNested) && node.type === 'code' && 'lang' in node && node.lang === 'editorial') {
      const from = node.position?.start.offset ?? 0, to = node.position?.end.offset ?? source.length;
      if (protocol.some(p => from >= p.from && to <= p.to)) return;
      const raw = source.slice(from,to), value = 'value' in node ? node.value ?? '' : '';
      let note: EditorialNote; let legacy = true; let error: string | undefined;
      if (value.trimStart().startsWith('{')) {
        legacy = false;
        try { const parsed: unknown = JSON.parse(value); if (!isValidEditorialNote(parsed)) throw new Error('Invalid editorial schema'); note = parsed; }
        catch { note = createEditorialNote({ id: `invalid-${from}`, commentary: value }); error = 'Invalid editorial JSON; edit source to repair.'; }
      } else {
        const titleMatch = /^#\s+([^\n]+)\n?/.exec(value);
        const content = titleMatch ? value.slice(titleMatch[0].length) : value;
        note = createEditorialNote({id:`legacy-${from}`,title:titleMatch?.[1] ?? 'Editorial note',commentary:content});
      }
      if (!closedEditorialFence(raw)) error = 'Incomplete editorial fence; close the fence before editing or hiding this note.';
      spans.push({from,to,note,legacy,raw,...(error ? {error} : {})});
    }
    if ('children' in node && node.children) for (const child of node.children) visit(child as Parameters<typeof visit>[0], node.type === 'root');
  };
  visit(fromMarkdown(source)); return spans;
}
export function serializeEditorialNote(note: EditorialNote): string {
  if (!isValidEditorialNote(note)) throw new Error('Invalid editorial schema');
  // JSON escapes newlines; literal backticks cannot close a fence inside a JSON line.
  return '```editorial\n' + JSON.stringify(note, null, 2) + '\n```';
}
export function updateEditorialNote(source: string, span: EditorialSpan, note: EditorialNote): string {
  if (source.slice(span.from, span.to) !== span.raw) throw new Error('Editorial note changed; refresh before editing.');
  return source.slice(0,span.from) + serializeEditorialNote(note) + source.slice(span.to);
}
export function captureEditorialTarget(source: string, from: number, to: number, id: string = globalThis.crypto.randomUUID()): EditorialTarget {
  if (from < 0 || to < from || to > source.length) throw new Error('Selection is outside the document.');
  const ranges = protectedRanges(source);
  if (!allowed(from,to,ranges)) throw new Error('References must select author prose outside editorial notes and agent envelopes.');
  // Anchor context is contiguous author text. Metadata edits must not change a
  // passage's identity, and skipped annotations may never be concatenated.
  const left = ranges.filter(range => range.to <= from).reduce((boundary,range)=>Math.max(boundary,range.to),Math.max(0,from-96));
  const right = ranges.filter(range => range.from >= to).reduce((boundary,range)=>Math.min(boundary,range.from),Math.min(source.length,to+96));
  return {id,base:source.slice(from,to),prefix:source.slice(left,from),suffix:source.slice(to,right),from,to,atStart:from===0,atEnd:to===source.length};
}
function protectedRanges(source: string): Array<{from:number;to:number}> { return [...parseEditorialNotes(source), ...actualEnvelopes(source)]; }
function allowed(from:number,to:number,ranges:Array<{from:number;to:number}>):boolean { return !ranges.some(r => from < r.to && to > r.from || from === to && from >= r.from && from < r.to); }
export function reconcileEditorialTarget(source: string, target: EditorialTarget): EditorialResolution {
  return reconcileTarget(source, target, protectedRanges(source));
}
/** One source-generation parse for editor cards and inline reference decorations. */
export function reconcileEditorialTargets(source: string, targets: readonly EditorialTarget[]): EditorialResolution[] {
  const ranges = protectedRanges(source);
  return targets.map(target => reconcileTarget(source,target,ranges));
}
function reconcileTarget(source: string, target: EditorialTarget, ranges: Array<{from:number;to:number}>): EditorialResolution {
  const candidates: number[] = [];
  if (target.base) { let at = source.indexOf(target.base); while (at >= 0) { if (allowed(at,at+target.base.length,ranges)) candidates.push(at); at = source.indexOf(target.base,at+1); } }
  else { for(let at=0;at<=source.length;at++) if (allowed(at,at,ranges) && source.slice(Math.max(0,at-target.prefix.length),at)===target.prefix && source.slice(at,at+target.suffix.length)===target.suffix) candidates.push(at); }
  const contextual = candidates.filter(at => source.slice(Math.max(0,at-target.prefix.length),at)===target.prefix && source.slice(at+target.base.length,at+target.base.length+target.suffix.length)===target.suffix);
  const matches = contextual.length ? contextual : candidates;
  if (contextual.length === 1) { const from = contextual[0]; return {state:from===target.from?'unchanged':'moved',from,to:from+target.base.length,current:target.base}; }
  if (contextual.length > 1) return {state:'ambiguous'};
  // Only return a modified range when both captured context boundaries identify it uniquely.
  if ((target.prefix || target.atStart) && (target.suffix || target.atEnd)) {
    const starts: number[] = []; let at=target.prefix ? source.indexOf(target.prefix) : -1;
    if(target.atStart && !target.prefix) starts.push(0);
    while(at>=0) { starts.push(at+target.prefix.length); at=source.indexOf(target.prefix,at+1); }
    const pairs: Array<{from:number;to:number}> = [];
    for(const from of starts) {
      if(!target.suffix && target.atEnd) {
        // Notes appended after authored prose carry their framing separator.
        const following=ranges.filter(r=>r.from>=from).sort((a,b)=>a.from-b.from)[0];
        let to=following?.from ?? source.length;
        if(following && source.slice(to-2,to)==='\n\n') to-=2;
        else if(following && source.slice(to-1,to)==='\n') to-=1;
        if(allowed(from,to,ranges)) pairs.push({from,to});
      } else {let to=source.indexOf(target.suffix,from); while(to>=0) {if(allowed(from,to,ranges)) pairs.push({from,to});to=source.indexOf(target.suffix,to+1);}}
    }
    if(pairs.length===1) {const {from,to}=pairs[0];return {state:'modified',from,to,current:source.slice(from,to)};}
    if(pairs.length>1) return {state:'ambiguous'};
  }
  if (matches.length === 1) { const from = matches[0]; return {state:from===target.from?'unchanged':'moved',from,to:from+target.base.length,current:target.base}; }
  return {state:matches.length > 1 ? 'ambiguous' : 'missing'};
}
export function migrateLegacyEditorialNote(span: EditorialSpan, target?: EditorialTarget): EditorialNote {
  if (!span.legacy) return span.note;
  const content = span.note.commentary;
  const fences: Array<{from:number;to:number}> = [];
  const visit = (node:{type:string;position?:{start:{offset?:number};end:{offset?:number}};children?:unknown[]}) => {if(node.type==='code' && node.position) fences.push({from:node.position.start.offset ?? 0,to:node.position.end.offset ?? content.length});for(const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);};
  visit(fromMarkdown(content));
  const split = [...content.matchAll(/\n---[ \t]*\r?\n/g)].find(match => !fences.some(f => match.index! + 1 >= f.from && match.index! + 1 < f.to));
  return createEditorialNote({ title:span.note.title, commentary:split ? span.note.commentary.slice(0,split.index) : span.note.commentary, targets:target?[target]:[], edits:split && target?[{targetId:target.id,replacement:span.note.commentary.slice(split.index+split[0].length)}]:[] });
}
export function applyEditorialProposal(source: string, noteId: string): EditorialApplyResult {
  const matches = parseEditorialNotes(source).filter(s => s.note.id===noteId);
  if(matches.length!==1 || matches[0].error || matches[0].legacy) return {ok:false,error:'Select one valid structured editorial note.'};
  const span=matches[0], note=span.note;
  if(note.status!=='open' || !note.edits.length) return {ok:false,error:'This note has no open proposal.'};
  const operations: Array<{from:number;to:number;text:string}> = [];
  const protectedSourceRanges = protectedRanges(source);
  for(const edit of note.edits) {
    const target=note.targets.find(t=>t.id===edit.targetId)!; const result=reconcileTarget(source,target,protectedSourceRanges);
    if(result.state!=='unchanged' && result.state!=='moved') return {ok:false,error:`Target ${target.id} is ${result.state}; retarget or rebase before applying.`};
    operations.push({from:result.from!,to:result.to!,text:edit.replacement});
  }
  operations.sort((a,b)=>a.from-b.from);
  for(let i=1;i<operations.length;i++) if(operations[i].from < operations[i-1].to || operations[i].from===operations[i-1].from) return {ok:false,error:'Proposed edits overlap.'};
  operations.push({from:span.from,to:span.to,text:serializeEditorialNote({...note,status:'resolved'})});
  let result=source;
  for(const op of operations.sort((a,b)=>b.from-a.from)) result=result.slice(0,op.from)+op.text+result.slice(op.to);
  return {ok:true,source:result};
}
/** Fail closed on incomplete private annotations; accepted prose is never truncated. */
export function stripEditorialNotesForPublication(source: string): string {
  const annotations = parseEditorialNotes(source,true);
  if (annotations.some(span => !/^>\s*\*\*Editorial (?:comment|note)\b/i.test(span.raw) && !closedEditorialFence(span.raw))) throw new Error('Cannot export an incomplete editorial fence. Close or remove it before exporting.');
  const code = markdownCodeRanges(source), envelopes = actualEnvelopes(source);
  for (const opening of source.matchAll(/<(?:exograph|exo)-(?:invocation|agent-response)\b/g)) {
    const from = opening.index!;
    if (!code.some(c => from >= c.from && from < c.to) && !envelopes.some(e => from === e.from)) throw new Error('Cannot export an incomplete agent envelope. Close or remove it before exporting.');
  }
  const ranges: Array<{from:number;to:number}> = [...parseEditorialNotes(source,true), ...actualEnvelopes(source)];
  const tree = fromMarkdown(source);
  for (const node of tree.children) {
    if (node.type === 'blockquote' && node.position) {
      const from = node.position.start.offset ?? 0, to = node.position.end.offset ?? from;
      if (/^>\s*\*\*Editorial (?:comment|note)\b/i.test(source.slice(from,to))) ranges.push({from,to});
    }
  }
  ranges.sort((a,b)=>a.from-b.from);
  const union: Array<{from:number;to:number}> = [];
  for(const range of ranges) {const previous=union.at(-1);if(previous && range.from<=previous.to) previous.to=Math.max(previous.to,range.to);else union.push({from:range.from,to:range.to});}
  let result=source; for(const r of union.reverse()) result=result.slice(0,r.from)+result.slice(r.to);
  return result;
}
export const stripEditorialNotesForExport = stripEditorialNotesForPublication;

/** Guard agent drafting at the domain boundary: prose and every unrelated note stay exact. */
export function validateEditorialDraftChange(before: string, after: string, noteId: string, invocationId?: string): string | null {
  const beforeNotes = parseEditorialNotes(before).filter(s => s.note.id === noteId);
  const afterNotes = parseEditorialNotes(after).filter(s => s.note.id === noteId);
  if (beforeNotes.length !== 1 || afterNotes.length !== 1 || beforeNotes[0].error || afterNotes[0].error) return 'The selected editorial note must remain valid and retain its identity.';
  const prior = beforeNotes[0].note, next = afterNotes[0].note;
  if (next.status !== prior.status) return 'Drafting may not accept, dismiss or resolve the selected note.';
  if (next.title !== prior.title || next.commentary !== prior.commentary) return 'Drafting may not rewrite the note title or commentary.';
  if (prior.targets.length) {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])) : value;
    if (JSON.stringify(canonical(next.targets)) !== JSON.stringify(canonical(prior.targets))) return 'Drafting may not change, remove or rebase existing references.';
  } else {
    const ranges: Array<{from:number;to:number}> = [];
    for (const target of next.targets) {
      const resolution = reconcileEditorialTarget(before,target);
      if ((resolution.state !== 'unchanged' && resolution.state !== 'moved') || resolution.current !== target.base) return 'A drafted reference must identify unchanged current author prose.';
      ranges.push({from:resolution.from!,to:resolution.to!});
    }
    ranges.sort((a,b)=>a.from-b.from);
    for(let i=1;i<ranges.length;i++) if(ranges[i].from<ranges[i-1].to || ranges[i].from===ranges[i-1].from) return 'Drafted references overlap.';
  }
  const matchingEnvelopes = (source: string) => actualEnvelopes(source).filter(e => invocationId && (e.kind === 'invocation' ? e.id === invocationId : e.invocationId === invocationId));
  const beforeEnvelopes = matchingEnvelopes(before);
  const withoutDraft = (source: string, span: EditorialSpan, allowNewSeparators: boolean): string[] => {
    const envelopes = matchingEnvelopes(source);
    if (envelopes.filter(e => e.kind === 'invocation').length > 1 || envelopes.filter(e => e.kind === 'response').length > 1) return [];
    const ranges = [span, ...envelopes].sort((a,b)=>b.from-a.from);
    let results = [source];
    for(const range of ranges) {
      const froms = [range.from], tos = [range.to];
      // Only framing LF/CRLF separators around a newly inserted linked envelope
      // may differ. Everything else must still compare byte-for-byte.
      if (allowNewSeparators && 'kind' in range && !beforeEnvelopes.some(e => e.kind === range.kind)) {
        for (const separator of ['\n','\n\n','\r\n','\r\n\r\n']) {
          if(source.slice(range.from-separator.length,range.from)===separator) froms.push(range.from-separator.length);
          if(source.slice(range.to,range.to+separator.length)===separator) tos.push(range.to+separator.length);
        }
      }
      results = results.flatMap(result => froms.flatMap(from => tos.map(to => result.slice(0,from) + result.slice(to))));
    }
    return results;
  };
  const expected = withoutDraft(before,beforeNotes[0],false)[0];
  if (expected === undefined || !withoutDraft(after,afterNotes[0],true).includes(expected)) return 'Drafting changed author prose or unrelated notes.';
  return null;
}

/** Validates a staged sidecar proposal without writing or fabricating Markdown metadata. */
export function validateEditorialDraftProposal(prior: EditorialNote, proposal: EditorialNote, documentBody: string): string | null {
 if(!isValidEditorialNote(proposal) || proposal.id!==prior.id) return 'Draft must retain one valid selected note.';
 if(proposal.title!==prior.title || proposal.commentary!==prior.commentary || proposal.status!==prior.status) return 'Draft must preserve title, commentary and status.';
 const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
 if(prior.targets.length && JSON.stringify(canonical(prior.targets))!==JSON.stringify(canonical(proposal.targets))) return 'Draft may not rebase existing references.';
 if(!prior.targets.length) {
   const resolved=reconcileEditorialTargets(documentBody,proposal.targets);
   if(resolved.some(r=>r.state!=='unchanged' && r.state!=='moved')) return 'Drafted references must identify exact current author prose.';
   const ordered=resolved.map(r=>({from:r.from!,to:r.to!})).sort((a,b)=>a.from-b.from);
   for(let i=1;i<ordered.length;i++) if(ordered[i].from<ordered[i-1].to || ordered[i].from===ordered[i-1].from) return 'Drafted references overlap.';
 }
 return null;
}
/** Explicit deterministic Apply for annotations stored outside Markdown. */
export function applyEditorialEdits(source: string, note: EditorialNote): EditorialApplyResult {
 if(!isValidEditorialNote(note) || note.status!=='open' || !note.edits.length) return {ok:false,error:'This note has no valid open proposal.'};
 const results=reconcileEditorialTargets(source,note.edits.map(edit=>note.targets.find(t=>t.id===edit.targetId)!));
 const operations:Array<{from:number;to:number;text:string}>=[];
 for(let i=0;i<results.length;i++) {const result=results[i];if(result.state!=='unchanged' && result.state!=='moved') return {ok:false,error:`Target is ${result.state}; retarget or rebase before applying.`};operations.push({from:result.from!,to:result.to!,text:note.edits[i].replacement});}
 operations.sort((a,b)=>a.from-b.from);
 for(let i=1;i<operations.length;i++) if(operations[i].from<operations[i-1].to || operations[i].from===operations[i-1].from) return {ok:false,error:'Proposed edits overlap.'};
 let result=source;for(const op of operations.reverse()) result=result.slice(0,op.from)+op.text+result.slice(op.to);
 return {ok:true,source:result};
}

import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEditorialNote, captureEditorialTarget, serializeEditorialNote, parseEditorialNotes, reconcileEditorialTarget, type EditorialNote } from '@exograph/core/editorial-notes';
import { EditorialStore } from '@exograph/core/editorial-store';
import { launchExographWorkspaceFixture } from '../helpers';

const prose = '# Editorial fixture\n\nFirst paragraph.\n\nSecond paragraph.\n\nUntouched closing.\n';
function notes():EditorialNote[] {
  const first=captureEditorialTarget(prose,prose.indexOf('First paragraph.'),prose.indexOf('First paragraph.')+16,'first');
  const second=captureEditorialTarget(prose,prose.indexOf('Second paragraph.'),prose.indexOf('Second paragraph.')+17,'second');
  return [createEditorialNote({id:'group',title:'Clarify both',commentary:'Keep the tone.',targets:[first,second],edits:[{targetId:'first',replacement:'New first paragraph.\n\nAnother paragraph.'},{targetId:'second',replacement:'New second paragraph.'}]}),createEditorialNote({id:'general',title:'General thought',commentary:'Think about the closing.'})];
}
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
async function fixture(scenario='draft',realAgent=false,legacy=false) {
  let notePath='',promptPath='';
  const f=await launchExographWorkspaceFixture({mutable:true,initialNoteLabel:null,...(realAgent?{env:{HOME:process.env.HOME!}}:{}),
    prepareWorkspace:async root=>{
      const noteRoot=path.join(root,'notes/test-notes');notePath=path.join(noteRoot,'editorial-fixture.md');promptPath=path.join(root,'editorial-prompt.txt');
      for(const name of ['editorial-fixture','second-editorial']) {
        const file=path.join(noteRoot,`${name}.md`);await writeFile(file,legacy?prose+'\n'+notes().map(serializeEditorialNote).join('\n\n')+'\n':prose);
        if(!legacy){const store=new EditorialStore(noteRoot);const initial=await store.read(file);await store.save(file,notes(),initial.revision);}
      }
    },
    prepareSettings:async({settingsPath,workspaceRoot})=>{
      const installed=realAgent?JSON.parse(await readFile(path.join(process.env.HOME!,'Library/Application Support/Exograph/workspace-settings.json'),'utf8')):null;
      const agent=installed?.agentCommands.find((c:any)=>c.id===installed.defaultAgentCommandId&&c.enabled);
      const command=scenario==='missing'?'/nonexistent/editorial-agent':[process.execPath,path.resolve('tests/fixtures/editorial-agent.mjs'),promptPath,scenario,notePath].map(quote).join(' ');
      await writeFile(settingsPath,JSON.stringify({workspaceRoot,defaultTerminalCwd:workspaceRoot,noteRoots:[path.join(workspaceRoot,'notes/test-notes')],indexedRoots:[],defaultAgentCommandId:agent?.id??'editor',agentCommands:agent?[agent]:[{id:'editor',handle:'editor',label:'Editorial fixture',command,adapter:'generic',continuityPolicy:'fresh',cwdPolicy:'workspace_root',promptDelivery:'stdin',version:1,enabled:true}],indexing:{enabled:false,mode:'off',backend:'qmd'},appearanceMode:'system',colorThemeId:'exograph-neutral',editorFontSize:15,terminalFontSize:13,explorerScale:1,indexUpdateStrategy:'on-save'}));
    }});
  await f.page.getByRole('button',{name:'editorial-fixture, file'}).first().click();
  await expect(f.page.getByTestId('editorial-marker').first()).toBeVisible();
  await f.page.getByTestId('editorial-marker').first().click();await expect(f.page.getByTestId('editorial-notes-panel')).toBeVisible();await expect(f.page.getByTestId('editorial-selected-note')).toBeVisible();
  return {...f,notePath,promptPath};
}
async function body(page:Page):Promise<string>{return page.evaluate(()=>(document.querySelector('.cm-content') as any)?.cmView?.rootView?.view?.state.doc.toString()??'');}
async function snapshot(page:Page,filePath:string){return page.evaluate(filePath=>(window as any).exograph.editorial.read(filePath),filePath);}
async function select(page:Page,text:string){await page.getByTestId('editorial-mode-original').click();await page.evaluate(text=>{const view=(document.querySelector('.cm-content') as any).cmView.rootView.view;const from=view.state.doc.toString().indexOf(text);if(from<0)throw Error('Missing passage');view.dispatch({selection:{anchor:from,head:from+text.length},scrollIntoView:true});view.focus();},text);}
async function mutate(page:Page,before:string,after:string){await page.getByTestId('editorial-mode-original').click();await page.evaluate(({before,after})=>{const view=(document.querySelector('.cm-content') as any).cmView.rootView.view;const from=view.state.doc.toString().indexOf(before);view.dispatch({changes:{from,to:from+before.length,insert:after},selection:{anchor:0}});},{before,after});}
const panel=(page:Page)=>page.getByTestId('editorial-notes-panel');
const selected=(page:Page)=>page.getByTestId('editorial-selected-note');
async function choose(page:Page,id:string){await page.getByTestId('editorial-note-list').locator(`[data-editorial-note-id="${id}"]`).click();}
async function target(page:Page,index:number){const t=selected(page).getByTestId('editorial-target').nth(index);if(!await t.evaluate((el:HTMLDetailsElement)=>el.open))await t.locator('summary').first().click();return t;}
async function noteActions(page:Page){await selected(page).getByText('Note actions',{exact:true}).click();}
async function runAgent(page:Page){await selected(page).getByRole('button',{name:/^(Draft suggestion|Revise suggestion) with agent$/}).click();const trust=page.getByRole('dialog',{name:/^Run /});await expect(trust).toBeVisible();await trust.getByRole('button',{name:'Run once'}).click();}
const review=(page:Page)=>page.getByTestId('editorial-draft-review');

test('markers and Original/diff/preview are visible, non-destructive and persistent',async()=>{
  const f=await fixture();try{
    await f.page.setViewportSize({width:1280,height:800});
    await expect(f.page.getByTestId('connections-tab-editing')).toHaveAttribute('aria-selected','true');
    await expect(f.page.locator('.cm-content .editorial-note')).toHaveCount(0);
    await expect(f.page.locator('.editorial-marker--suggestion').first()).toBeVisible();
    const before=await body(f.page);const annotation=(await snapshot(f.page,f.notePath)).revision;
    await panel(f.page).getByRole('button',{name:'Show diff',exact:true}).click();await expect(f.page.locator('.cm-content .editorial-diff__added').first()).toBeVisible();
    await panel(f.page).getByRole('button',{name:'Preview change',exact:true}).click();await expect(f.page.getByTestId('editorial-preview-change').first()).toContainText('New first paragraph.');
    await expect(f.page.locator('.editor-surface .cm-content').first()).toHaveAttribute('contenteditable','false');
    expect(await body(f.page)).toBe(before);expect(await readFile(f.notePath,'utf8')).toBe(prose);expect((await snapshot(f.page,f.notePath)).revision).toBe(annotation);
    await selected(f.page).getByText('Note actions',{exact:true}).scrollIntoViewIfNeeded();await expect(f.page.getByTestId('editorial-mode-preview')).toBeInViewport();await expect(f.page.getByTestId('editorial-mode-preview')).toHaveAttribute('aria-pressed','true');
    await f.page.screenshot({path:'test-results/editorial-pane-preview.png'});
    await choose(f.page,'general');await expect(f.page.getByTestId('editorial-mode-preview')).toHaveAttribute('aria-pressed','true');await expect(selected(f.page)).toContainText('General thought');
    await f.page.getByRole('button',{name:'second-editorial, file'}).first().click();await expect(f.page.getByTestId('editorial-mode-preview')).toHaveAttribute('aria-pressed','true');
    await f.page.reload();await f.page.getByRole('button',{name:'second-editorial, file'}).first().click();await f.page.getByTestId('editorial-marker').first().click();await expect(f.page.getByTestId('editorial-mode-preview')).toHaveAttribute('aria-pressed','true');
    await panel(f.page).getByRole('button',{name:'Original',exact:true}).click();await expect(f.page.locator('.editor-surface .cm-content').first()).toHaveAttribute('contenteditable','true');
  }finally{await f.cleanup();}
});

test('pane edits persist only annotations, grouped Apply and Undo restore both',async()=>{
  const f=await fixture();try{
    const c=selected(f.page);await c.getByLabel('Comment',{exact:true}).fill('Comment revised.');
    const replacement=c.getByLabel('Proposed wording for passage 1',{exact:true});await replacement.fill('Manually revised first.\n\nSecond replacement paragraph.');await replacement.press('End');await replacement.pressSequentially(' Added.');await expect(replacement).toBeFocused();
    await (await target(f.page,1)).getByLabel('Proposed wording for passage 2',{exact:true}).fill('');
    await expect.poll(async()=>(await snapshot(f.page,f.notePath)).notes[0].edits.find((e:any)=>e.targetId==='second').replacement).toBe('');
    expect(await body(f.page)).toBe(prose);expect(await readFile(f.notePath,'utf8')).toBe(prose);
    const before=(await snapshot(f.page,f.notePath)).notes;
    await c.getByRole('button',{name:'Apply proposal',exact:true}).click();await expect(c).toContainText('resolved');
    const applied=await body(f.page);expect(applied).toContain('Manually revised first.');expect(applied).not.toContain('Second paragraph.');expect(applied).toContain('Untouched closing.');expect(applied).not.toContain('```editorial');
    await c.getByText('View proposal',{exact:true}).click();await expect(c.getByTestId('editorial-retained-proposal')).toContainText('Manually revised first.');expect(await body(f.page)).toBe(applied);
    await f.page.evaluate(()=>(document.querySelector('.cm-content') as any).cmView.rootView.view.focus());await f.page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');
    await expect.poll(()=>body(f.page)).toBe(prose);await expect.poll(async()=>(await snapshot(f.page,f.notePath)).notes).toEqual(before);
    await noteActions(f.page);await c.getByRole('button',{name:'Dismiss',exact:true}).click();await expect(c).toContainText('dismissed');await c.getByRole('button',{name:'Reopen',exact:true}).click();await expect(c).toContainText('open');expect(await readFile(f.notePath,'utf8')).toBe(prose);
  }finally{await f.cleanup();}
});

test('selected and general note creation and marker visibility never change Markdown',async()=>{
  const f=await fixture();try{
    await select(f.page,'First paragraph.');await f.page.keyboard.press(process.platform==='darwin'?'Meta+Shift+e':'Control+Shift+e');await expect.poll(async()=>(await snapshot(f.page,f.notePath)).notes.length).toBe(3);
    expect((await snapshot(f.page,f.notePath)).notes[2].targets[0].base).toBe('First paragraph.');await expect(f.page.locator('.editorial-marker:not(.editorial-marker--suggestion)').first()).toBeVisible();
    await panel(f.page).getByRole('button',{name:'Hide editorial notes'}).click();await expect(f.page.getByTestId('editorial-marker')).toHaveCount(0);expect(await body(f.page)).toBe(prose);
    await panel(f.page).getByRole('button',{name:'Show editorial notes'}).click();
    await f.page.evaluate(()=>{const v=(document.querySelector('.cm-content') as any).cmView.rootView.view;v.dispatch({selection:{anchor:0}});});await panel(f.page).getByTestId('editorial-pane-add').click();await expect.poll(async()=>(await snapshot(f.page,f.notePath)).notes.length).toBe(4);
    expect((await snapshot(f.page,f.notePath)).notes[3].targets).toEqual([]);expect(await readFile(f.notePath,'utf8')).toBe(prose);
  }finally{await f.cleanup();}
});

test('changed target blocks grouped projection and Apply until explicit rebase',async()=>{
  const f=await fixture();try{
    await mutate(f.page,'First paragraph.','New author wording.');await expect(selected(f.page)).toContainText('modified');await expect(selected(f.page).getByRole('button',{name:'Apply proposal',exact:true})).toBeDisabled();
    await panel(f.page).getByRole('button',{name:'Preview change',exact:true}).click();await expect(f.page.getByTestId('editorial-preview-change')).toHaveCount(0);await expect(selected(f.page)).toContainText('Repair');
    await panel(f.page).getByRole('button',{name:'Original',exact:true}).click();await selected(f.page).getByRole('button',{name:'Rebase to current text'}).click();await expect(selected(f.page).getByRole('button',{name:'Apply proposal',exact:true})).toBeEnabled();
    await selected(f.page).getByRole('button',{name:'Apply proposal',exact:true}).click();await expect.poll(()=>body(f.page)).toContain('New second paragraph.');
  }finally{await f.cleanup();}
});

test('agent drafting stages proposal, Keep imports annotations without writing prose',async()=>{
  const f=await fixture();try{
    const prior=(await snapshot(f.page,f.notePath)).notes;await runAgent(f.page);await expect(review(f.page)).toBeVisible({timeout:20_000});
    expect(await body(f.page)).toBe(prose);expect(await readFile(f.notePath,'utf8')).toBe(prose);expect((await snapshot(f.page,f.notePath)).notes).toEqual(prior);
    expect(await readFile(f.promptPath,'utf8')).toContain('Proposal output artifact:');await review(f.page).getByRole('button',{name:'Keep draft',exact:true}).click();
    await expect.poll(async()=>(await snapshot(f.page,f.notePath)).notes[0].edits[0].replacement).toBe('Agent proposal for first.');expect(await readFile(f.notePath,'utf8')).toBe(prose);
  }finally{await f.cleanup();}
});

test('Draft retains a dirty author buffer without autosaving it during observation',async()=>{
  const f=await fixture('slow-draft');try{
    await mutate(f.page,'Untouched closing.','Unsaved author closing.');const local=await body(f.page);
    await runAgent(f.page);await f.page.waitForTimeout(2300);
    expect(await readFile(f.notePath,'utf8')).toBe(prose);expect(await body(f.page)).toBe(local);
    await expect(review(f.page)).toBeVisible({timeout:15_000});await review(f.page).getByRole('button',{name:'Reject draft',exact:true}).click();
    await expect.poll(()=>readFile(f.notePath,'utf8'),{timeout:8_000}).toBe(local);expect((await snapshot(f.page,f.notePath)).notes[0].edits[0].replacement).toBe('New first paragraph.\n\nAnother paragraph.');
  }finally{await f.cleanup();}
});

test('agent author rewrite is rejected and restored instead of becoming a proposal',async()=>{
  const f=await fixture('illegal');try{await runAgent(f.page);await expect(f.page.getByTestId('invocation-activity')).toContainText(/failed|rejected|prose/i,{timeout:20_000});await expect.poll(()=>readFile(f.notePath,'utf8')).toBe(prose);await expect(review(f.page).getByRole('button',{name:'Keep draft',exact:true})).toHaveCount(0);}finally{await f.cleanup();}
});

test('trust cancellation and missing executable preserve prose and restore editing',async()=>{
  for(const scenario of ['draft','missing']){const f=await fixture(scenario);try{
    await selected(f.page).getByRole('button',{name:'Revise suggestion with agent'}).click();
    if(scenario==='draft'){const trust=f.page.getByRole('dialog',{name:/^Run /});await expect(trust).toBeVisible();await trust.getByRole('button',{name:'Cancel',exact:true}).click();}else await expect(f.page.getByTestId('invocation-activity')).toContainText(/failed|unavailable|not found|launch/i,{timeout:10_000});
    await expect(f.page.locator('.editor-surface .cm-content').first()).toHaveAttribute('contenteditable','true');expect(await body(f.page)).toBe(prose);expect(await readFile(f.notePath,'utf8')).toBe(prose);
  }finally{await f.cleanup();}}
});

test('external save conflict blocks Apply and preserves both disk and local author wording',async()=>{
  const f=await fixture();try{
    await mutate(f.page,'Untouched closing.','Local closing.');const local=await body(f.page);const external=prose.replace('Untouched closing.','External closing.');await writeFile(f.notePath,external);
    await expect(f.page.getByTestId('save-conflict-notice')).toBeVisible({timeout:8_000});await expect(selected(f.page).getByRole('button',{name:'Apply proposal',exact:true})).toBeDisabled();expect(await readFile(f.notePath,'utf8')).toBe(external);expect(await body(f.page)).toBe(local);
  }finally{if(!f.page.isClosed()&&await f.page.getByTestId('save-conflict-notice').count().catch(()=>0))f.electronApp.process().kill('SIGKILL');await f.cleanup();}
});

test('nested Markdown and overlapping targets remain exact and grouped',async()=>{
  const f=await fixture();try{
    const markdown="## Revised passage\n\n**Strong proposal** with [a link](https://example.com).\n\n- First item\n- Second item\n\n```js\nconsole.log('safe');\n```";
    await selected(f.page).getByLabel('Proposed wording for passage 1').fill(markdown);await panel(f.page).getByRole('button',{name:'Preview change',exact:true}).click();await expect(f.page.getByTestId('editorial-preview-change').first()).toContainText("console.log('safe')");await expect(f.page.getByTestId('editorial-preview-change').first().locator('.exograph-md-line--h2')).toContainText('Revised passage');await expect(f.page.getByTestId('editorial-preview-change').first().locator('.exograph-md-strong')).toHaveText('Strong proposal');await expect(f.page.getByTestId('editorial-preview-change').first().locator('.exograph-md-link')).toHaveAttribute('data-exograph-link-target','https://example.com');await expect(f.page.getByTestId('editorial-preview-change').first().locator('.exograph-md-line--list-start')).toHaveCount(2);expect(await readFile(f.notePath,'utf8')).toBe(prose);
    await selected(f.page).getByRole('button',{name:'Apply proposal',exact:true}).click();await expect.poll(()=>body(f.page)).toContain(markdown);expect(await body(f.page)).toContain('Untouched closing.');
  }finally{await f.cleanup();}
  const g=await fixture();try{await select(g.page,'First paragraph.');await selected(g.page).getByRole('button',{name:'Add selected passage'}).click();const t=await target(g.page,2);await t.getByRole('button',{name:'Add replacement'}).click();await t.getByLabel('Proposed wording for passage 3').fill('Conflicting replacement.');await expect(selected(g.page)).toContainText('overlapping');await expect(selected(g.page).getByRole('button',{name:'Apply proposal'})).toBeDisabled();expect(await body(g.page)).toBe(prose);}finally{await g.cleanup();}
});

test('explicit legacy migration preserves proposal and author bytes with recoverable Undo',async()=>{
  const f=await fixture('draft',false,true);try{
    const original=await body(f.page);const before=await snapshot(f.page,f.notePath);
    await panel(f.page).getByText('Inline notes',{exact:true}).click();
    await panel(f.page).getByRole('button',{name:'Move notes out of Markdown',exact:true}).click();
    await expect.poll(async()=>(await snapshot(f.page,f.notePath)).inlineNoteIds.length).toBe(0);
    let expected=original;for(const span of parseEditorialNotes(original).sort((a,b)=>b.from-a.from))expected=expected.slice(0,span.from)+expected.slice(span.to);
    expect(await readFile(f.notePath,'utf8')).toBe(expected);expect(await body(f.page)).toBe(expected);const migrated=(await snapshot(f.page,f.notePath)).notes;
    const meaning=(notes:EditorialNote[])=>notes.map(note=>({...note,targets:note.targets.map(target=>({id:target.id,base:target.base}))}));
    expect(meaning(migrated)).toEqual(meaning(before.notes));for(const note of migrated)for(const target of note.targets)expect(reconcileEditorialTarget(expected,target).state).toBe('unchanged');
    await f.page.evaluate(()=>(document.querySelector('.cm-content') as any).cmView.rootView.view.focus());await f.page.keyboard.press(process.platform==='darwin'?'Meta+z':'Control+z');
    await expect.poll(()=>readFile(f.notePath,'utf8')).toBe(original);await expect.poll(()=>body(f.page)).toBe(original);expect((await snapshot(f.page,f.notePath)).notes).toEqual(before.notes);
  }finally{await f.cleanup();}
});

test('real saved default stages a grouped proposal and Keep leaves author Markdown unchanged',async()=>{
  test.skip(!process.env.EXOGRAPH_EDITORIAL_REAL_AGENT,'Requires current local agent authentication');test.setTimeout(180_000);const f=await fixture('draft',true);try{
    await runAgent(f.page);await expect(review(f.page)).toBeVisible({timeout:150_000});expect(await readFile(f.notePath,'utf8')).toBe(prose);expect(await body(f.page)).toBe(prose);
    await f.page.screenshot({path:'test-results/editorial-real-default-agent.png'});await review(f.page).getByRole('button',{name:'Keep draft',exact:true}).click();await expect(review(f.page)).toBeHidden();const current=await snapshot(f.page,f.notePath);expect(current.notes[0].status).toBe('open');expect(current.notes[0].targets).toHaveLength(2);expect(current.notes[0].edits).toHaveLength(2);expect(current.notes[1].title).toBe('General thought');expect(await readFile(f.notePath,'utf8')).toBe(prose);
  }finally{await f.cleanup();}
});

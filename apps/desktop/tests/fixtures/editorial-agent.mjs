import { readFile, writeFile } from 'node:fs/promises';
const [output, scenario, notePath] = process.argv.slice(2);
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
await writeFile(output, prompt, 'utf8');
if (scenario === 'fail') { process.stderr.write('Editorial fixture failure\n'); process.exitCode = 23; }
else {
 if (scenario === 'slow-draft') await new Promise(resolve => setTimeout(resolve, 5000));
 const requestPath = /^Editorial request artifact: (.+)$/m.exec(prompt)?.[1];
 const resultPath = /^Proposal output artifact: (.+)$/m.exec(prompt)?.[1];
 if (!requestPath || !resultPath) throw new Error('Missing staged editorial artifact paths');
 const request = JSON.parse(await readFile(requestPath, 'utf8'));
 const note = request.note;
 note.edits = note.targets.map(target => ({targetId:target.id,replacement:`Agent proposal for ${target.id}.`}));
 if (scenario === 'illegal') {
  const source = await readFile(notePath, 'utf8');
  await writeFile(notePath, source.replace('First paragraph.', 'Unwanted rewrite.'), 'utf8');
 }
 await writeFile(resultPath, JSON.stringify({note,message:'Drafted proposal.'}), 'utf8');
}

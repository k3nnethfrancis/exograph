import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const app = process.env.EXOGRAPH_PACKAGED_APP_PATH;
test('packaged npm installs and runs lifecycle Node without a host Node installation', { skip: !app }, async () => {
  const executable = app.endsWith('.app') ? path.join(app, 'Contents/MacOS/Exograph') : app;
  const contents = path.dirname(path.dirname(executable));
  const npm = path.join(contents, 'Resources/app.asar/node_modules/npm/bin/npm-cli.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'exo-packaged-npm-test-'));
  try {
    const bin = path.join(root, 'bin'); await mkdir(bin);
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    await writeFile(path.join(bin, 'node'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(executable)} "$@"\n`, { mode: 0o700 });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'packaged-npm-proof', version: '1.0.0', scripts: { postinstall: 'node lifecycle.cjs' } }));
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'packaged-npm-proof', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'packaged-npm-proof', version: '1.0.0', hasInstallScript: true } } }));
    await writeFile(path.join(root, 'lifecycle.cjs'), "require('node:fs').writeFileSync('proof.json', JSON.stringify({execPath:process.execPath,version:process.version}))");
    await promisify(execFile)(executable, [npm, 'ci', '--offline', '--no-audit', '--no-fund'], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: `${bin}:/usr/bin:/bin` }, timeout: 60_000 });
    assert.equal(JSON.parse(await readFile(path.join(root, 'proof.json'), 'utf8')).execPath, executable);
  } finally { await rm(root, { recursive: true, force: true }); }
});

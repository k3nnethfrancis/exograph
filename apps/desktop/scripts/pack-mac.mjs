#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { collectPackageEvidence } from './package-evidence.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const defaultPackagingTimeoutMs = 20 * 60 * 1000;
const defaultPackagingIdleTimeoutMs = 5 * 60 * 1000;

export function macOutputDirectories(releaseDir) {
  if (!existsSync(releaseDir)) {
    return [];
  }

  return readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^mac(?:-|$)/.test(entry.name))
    .map((entry) => path.join(releaseDir, entry.name));
}

export function cleanMacOutputDirectories(root = repoRoot, { log = () => {} } = {}) {
  const releaseDir = path.join(root, 'release');
  const directories = macOutputDirectories(releaseDir);

  for (const directory of directories) {
    log(`removing stale mac package output: ${path.relative(root, directory)}`);
    rmSync(directory, { recursive: true, force: true });
  }

  return directories;
}

export async function generatePackageEvidence(root = repoRoot) {
  const releaseDir = path.join(root, 'release');
  const appPaths = macOutputDirectories(releaseDir)
    .map((directory) => path.join(directory, 'Exograph.app'))
    .filter(existsSync);
  if (appPaths.length === 0) {
    throw new Error('electron-builder completed without producing Exograph.app');
  }
  for (const appPath of appPaths) {
    const architecture = path.basename(path.dirname(appPath));
    await collectPackageEvidence(appPath, path.join(releaseDir, 'evidence', architecture));
  }
}

export function packagingFailureDiagnostic(output) {
  if (!output.includes('ERR_SQLITE_ERROR')) {
    return '';
  }

  return [
    '',
    'Exograph mac packaging failed while electron-builder asked pnpm to collect the dependency tree.',
    'pnpm reported ERR_SQLITE_ERROR. On macOS this can happen when the pnpm store/index SQLite files are inaccessible from a sandboxed shell.',
    'Generated release/mac-* app output was removed so a partial Electron.app or stale Exograph.app is not mistaken for an installable build.',
    '',
    'Try again from a normal terminal with access to your pnpm store/cache, or verify pnpm can inspect dependencies:',
    '  pnpm --dir apps/desktop why @tobilu/qmd better-sqlite3 sqlite-vec --prod',
  ].join('\n');
}

function parsePositiveInteger(value) {
  if (value === undefined || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

export function packMacTimeouts(env = process.env) {
  return {
    timeoutMs: parsePositiveInteger(env.EXOGRAPH_PACK_MAC_TIMEOUT_MS) ?? defaultPackagingTimeoutMs,
    idleTimeoutMs: parsePositiveInteger(env.EXOGRAPH_PACK_MAC_IDLE_TIMEOUT_MS) ?? defaultPackagingIdleTimeoutMs,
  };
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

export function packagingTimeoutDiagnostic({ kind, label = 'electron-builder packaging', timeoutMs }) {
  const duration = formatDuration(timeoutMs);
  const reason = kind === 'idle'
    ? `produced no output for ${duration}`
    : `exceeded ${duration}`;

  return [
    '',
    `Exograph mac packaging stopped because ${label} ${reason}.`,
    'If the last output is "searching for node modules", the likely stuck phase is electron-builder dependency collection through pnpm workspace metadata or pnpm store/cache access.',
    '',
    'Capture a focused debug log and verify pnpm can inspect the production dependency tree:',
    '  DEBUG=electron-builder,electron-builder:* pnpm pack:mac',
    '  pnpm --dir apps/desktop why @tobilu/qmd better-sqlite3 sqlite-vec --prod',
    '',
    'Timeouts can be adjusted with EXOGRAPH_PACK_MAC_TIMEOUT_MS and EXOGRAPH_PACK_MAC_IDLE_TIMEOUT_MS.',
  ].join('\n');
}

function killChildProcess(child, signal) {
  try {
    if (child.pid && process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the direct child below.
  }

  try {
    child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

function run(command, args, { cwd = repoRoot, label = `${command} ${args.join(' ')}`, timeoutMs, idleTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let timedOut = null;
    let timeoutTimer = null;
    let idleTimer = null;

    const clearTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
    };

    const timeout = (kind, configuredTimeoutMs) => {
      if (timedOut) {
        return;
      }
      timedOut = { kind, timeoutMs: configuredTimeoutMs, label };
      const message = `[exograph pack:mac] ${label} ${kind === 'idle' ? 'idle timed out' : 'timed out'} after ${formatDuration(configuredTimeoutMs)}; stopping process`;
      output += `${message}\n`;
      console.error(message);
      killChildProcess(child, 'SIGTERM');
      setTimeout(() => killChildProcess(child, 'SIGKILL'), 5000).unref();
    };

    const armIdleTimer = () => {
      if (!idleTimeoutMs) {
        return;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => timeout('idle', idleTimeoutMs), idleTimeoutMs);
      idleTimer.unref();
    };

    if (timeoutMs) {
      timeoutTimer = setTimeout(() => timeout('total', timeoutMs), timeoutMs);
      timeoutTimer.unref();
    }
    armIdleTimer();

    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
      armIdleTimer();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
      armIdleTimer();
    });
    child.on('error', (error) => {
      clearTimers();
      error.output = output;
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimers();
      if (timedOut) {
        const error = new Error(`${label} ${timedOut.kind === 'idle' ? 'idle timed out' : 'timed out'} after ${formatDuration(timedOut.timeoutMs)}`);
        error.code = code;
        error.signal = signal;
        error.output = output;
        error.packagingTimeout = timedOut;
        reject(error);
        return;
      }
      if (code === 0) {
        resolve(output);
        return;
      }
      const error = new Error(`${command} ${args.join(' ')} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`);
      error.code = code;
      error.output = output;
      reject(error);
    });
  });
}

export function restoreLocalElectronRuntime(runCommand = run) {
  return runCommand('pnpm', ['--filter', '@exograph/desktop', 'setup:runtime'], {
    label: 'restore local Electron runtime',
  });
}

export async function withElectronRuntimeRestore(
  buildPackage,
  { restore = restoreLocalElectronRuntime, log = (message) => console.error(message) } = {},
) {
  let packagingError;
  try {
    return await buildPackage();
  } catch (error) {
    packagingError = error;
    throw error;
  } finally {
    try {
      await restore();
    } catch (error) {
      if (!packagingError) {
        throw error;
      }
      log(`[exograph pack:mac] failed to restore local Electron runtime after packaging failure: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function main() {
  const builderArgs = process.argv.slice(2);
  if (builderArgs.length === 0) {
    builderArgs.push('--mac', 'dir');
  }

  cleanMacOutputDirectories(repoRoot, { log: (message) => console.error(`[exograph pack:mac] ${message}`) });

  try {
    await run('pnpm', ['build']);
    const timeouts = packMacTimeouts();
    console.error(
      `[exograph pack:mac] electron-builder timeout ${formatDuration(timeouts.timeoutMs)}, idle timeout ${formatDuration(timeouts.idleTimeoutMs)}`,
    );
    await withElectronRuntimeRestore(() => run('electron-builder', ['--projectDir', 'apps/desktop', ...builderArgs], {
      label: 'electron-builder packaging',
      timeoutMs: timeouts.timeoutMs,
      idleTimeoutMs: timeouts.idleTimeoutMs,
    }));
    await generatePackageEvidence(repoRoot);
  } catch (error) {
    cleanMacOutputDirectories(repoRoot, { log: (message) => console.error(`[exograph pack:mac] ${message}`) });
    if (error.packagingTimeout) {
      console.error(packagingTimeoutDiagnostic(error.packagingTimeout));
    }
    const diagnostic = packagingFailureDiagnostic(String(error.output ?? error.message ?? error));
    if (diagnostic) {
      console.error(diagnostic);
    }
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

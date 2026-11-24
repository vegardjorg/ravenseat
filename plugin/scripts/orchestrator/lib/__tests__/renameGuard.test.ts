// =============================================================
// renameGuard.test.ts: no raw fs.renameSync in the plugin's source outside lib/stateFile.js and a short allow list.
//
// Why: on Windows a rename over a file another process holds open for a moment (the board reading it, an antivirus or
// indexer scan) fails with EPERM, EBUSY or EACCES. lib/stateFile.js renameWithRetry retries those with a short backoff.
// Every atomic write (temporary file, then a rename over the real one) goes through it, so a new raw rename fails this
// test. The allow list holds only renames where one attempt IS the meaning (taking over a stale lock), each with a reason.
// Tests (__tests__) and node_modules are not scanned.
// A new state file: register its family in lib/store/families.js and write it with lib/store/fileBackend.js (writeJson or
// writeText), which renames through renameWithRetry and removes its tmp file on a failure (ARCHITECTURE.md, the storage layer).
// =============================================================
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
const ROOTS = ['plugin', 'scripts'].map((d) => path.join(REPO, d));

/** File (repo-relative, forward slashes) -> how many raw renames it may have, and why. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'plugin/scripts/orchestrator/lib/store/memoryBackend.js': { count: 1, why: 'the in-memory fs defines renameSync itself; it renames nothing on disk' },
  'plugin/scripts/orchestrator/lib/stateFile.js': { count: 1, why: 'renameWithRetry itself' },
  'plugin/scripts/orchestrator/lib/gateQueue.js': {
    count: 2,
    why: 'taking over a stale gate slot: the rename aside is the atomic claim (a second taker must fail at once); a failed claim is looked at again next round by design',
  },
};

const RAW = /\brenameSync\s*\(/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.(c|m)?js$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Raw renames per file, comment lines left out. */
function rawRenames(): Record<string, number[]> {
  const found: Record<string, number[]> = {};
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      const rel = path.relative(REPO, file).split(path.sep).join('/');
      fs.readFileSync(file, 'latin1')
        .split('\n')
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*')) return;
          if (RAW.test(line)) (found[rel] ??= []).push(i + 1);
        });
    }
  }
  return found;
}

describe('raw renames', () => {
  it('go through renameWithRetry everywhere except the allow list', () => {
    const found = rawRenames();
    const extra = Object.entries(found)
      .filter(([file, lines]) => lines.length > (ALLOWED[file]?.count ?? 0))
      .map(([file, lines]) => `${file}:${lines.join(',')}`);
    expect(extra).toEqual([]);
  });

  it('the allow list is not stale (each entry still has its renames)', () => {
    const found = rawRenames();
    for (const [file, { count }] of Object.entries(ALLOWED)) expect([file, found[file]?.length ?? 0]).toEqual([file, count]);
  });
});

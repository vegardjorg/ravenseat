// =============================================================
// scriptSyntax.test.ts: every script the plugin ships parses (node --check).
//
// Many scripts (setup.mjs, install.mjs, the hooks) are never imported by a test, so a syntax error in them, such as a
// broken regular expression, would pass the rest of the suite and only show up when a user runs them. This test runs
// `node --check` on every .mjs and .js file under scripts/orchestrator and the repo's scripts/ folder.
//
// The checks run a few at a time: after the split into modules there are well over 100 files, and one Node start
// can take about 2 s on a busy machine, so running them one after another no longer fits the timeout.
// =============================================================
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

const orchestrator = join(__dirname, '..', '..');
const repoScripts = join(orchestrator, '..', '..', '..', 'scripts');
/** How many `node --check` processes run at the same time. */
const PARALLEL = 8;

/** All .mjs and .js files under a folder, without tests and node_modules. */
function scripts(folder: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(folder)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const p = join(folder, name);
    if (statSync(p).isDirectory()) out.push(...scripts(p));
    else if (/\.m?js$/.test(name)) out.push(p);
  }
  return out;
}

/** Runs `node --check <file>`; resolves with null when it parses, otherwise with the first error line. */
function check(file: string): Promise<string | null> {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['--check', file]);
    let err = '';
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('error', (e) => done(`${file}: ${e.message}`));
    p.on('close', (code) =>
      done(code === 0 ? null : `${file}: ${err.split('\n').find((l) => /Error/.test(l)) ?? 'error'}`),
    );
  });
}

describe('every shipped script parses', () => {
  it('node --check passes for all scripts', async () => {
    const files = [...scripts(orchestrator), ...scripts(repoScripts)];
    expect(files.length).toBeGreaterThan(20); // guard against the check silently finding nothing
    const broken: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const r = await check(files[next++]);
        if (r) broken.push(r);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    expect(broken.sort()).toEqual([]);
  }, 240_000);
});

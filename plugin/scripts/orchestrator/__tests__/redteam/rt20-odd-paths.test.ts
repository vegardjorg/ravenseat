// =============================================================
// redteam/rt20-odd-paths.test.ts: scenario 20 "a folder with spaces and æøå in its name works the whole way"
// (plans/redteam-plan.md, R3).
//
// Why: a Norwegian user's projects often live in "C:\Users\Kåre\Mine prosjekter". Paths reach git, a shell (the gate
// commands), the hooks and the board, and each of them can split on a space or mangle a non-ASCII letter. The repo, its
// origin and the queue folder all get names with spaces and æøå, the gate is a script in such a folder, and a local
// track and a cloud track both go all the way to done, with the user's uncommitted work in place.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { expectUserThingsIntact, snapshot, userMess } from './lab';
import { project, queueSpace, tmp } from './project';

/** A green gate script in a folder with a space and æøå; it also checks that it runs in the track's own checkout. */
function gateInOddFolder() {
  const dir = tmp('rt20 gate æøå ');
  const file = path.join(dir, 'sjekk ø.cjs');
  fs.writeFileSync(file, "process.exit(require('fs').existsSync('README.md') ? 0 : 3);\n");
  return `node "${file}"`;
}

describe('RT-20: a folder with spaces and æøå in its name works the whole way', () => {
  it('a local track: receive with the gate, merge, done; the user\'s work intact', () => {
    const p = project({ oddPaths: true, gates: [gateInOddFolder()] });
    expect(p.repo).toMatch(/ mappe æøå /);
    userMess(p.repo);
    const scratch = p.localDelivers('A');
    const before = snapshot(p.repo, p.folder);
    const r = p.run('receive', 'A', '--scratchpad', scratch);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Gates GREEN/);
    const m = p.run('merge', 'A', '--scratchpad', scratch);
    expect(m.code, m.out).toBe(0);
    expect(p.taskOf('A')?.status).toBe('done');
    expect(p.g(['show', 'main:lib/A.ts'])).toBe('from the track');
    expectUserThingsIntact(before, { untracked: ['.claude/'], branches: ['queue/A'], files: ['lib/A.ts'], done: ['A'] });
  }, 240_000);

  it('a cloud track: collected and merged; doctor reads the odd paths', () => {
    const p = project({ oddPaths: true, gates: [gateInOddFolder()] });
    p.cloudDelivers('A');
    const before = snapshot(p.repo, p.folder);
    const c = p.run('cloud', 'collect', 'A');
    expect(c.code, c.out).toBe(0);
    const m = p.merge('A');
    expect(m.code, m.out).toBe(0);
    expect(p.taskOf('A')?.status).toBe('done');
    expect(p.g(['show', 'main:lib/A.ts'])).toBe('from the cloud');
    const d = p.run('doctor');
    expect(d.out).toMatch(/OK\s+queue\s+queue\.json parses/);
    expect(d.out).not.toMatch(/^FAIL\s/m);
    expect(d.out).toMatch(/\b0 FAIL\b/);
    expectUserThingsIntact(before, { ...queueSpace(), files: ['lib/A.ts'], done: ['A'], remoteRefs: ['refs/heads/claude/A'] });
  }, 240_000);
});

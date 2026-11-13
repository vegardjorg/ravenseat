// =============================================================
// missionReadFirst.test.ts: the "read these in your first turn, all in the same turn" list at the top of a mission.
//
// Locks: (1) readFirstPaths takes repo-relative paths named in the mission text, keeps a :line, :a-b or § section
// suffix, puts a "Read also" section first, deduplicates, keeps the order and caps the list; (2) it never lets through
// a URL, a glob, an absolute path, a ".." escape or a path that does not exist (the mission text is untrusted data);
// (3) repoFileExists only answers true for a file inside one of the roots; (4) make-mission.mjs writes the block at the
// top of the prompt, before the shared protocol and the track block, and writes no block when the list is empty.
// =============================================================
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readFirstPaths, readFirstBlock, repoFileExists, READ_FIRST_MAX } from '../missionText';

/** An exists function over a fixed set of repo-relative files. */
const only = (...files: string[]) => {
  const set = new Set(files);
  return (rel: string) => set.has(rel);
};

describe('readFirstPaths', () => {
  it('takes existing paths in order and keeps a line, range or section suffix', () => {
    const text = [
      'Change `src/a.ts:40` and the helper in src/lib/b.js:10-20, see docs/guide.md § 3.2.',
      'Also CHANGELOG.md, and the range in src/c.ts:5\u20139.',
    ].join('\n');
    const exists = only('src/a.ts', 'src/lib/b.js', 'docs/guide.md', 'CHANGELOG.md', 'src/c.ts');
    expect(readFirstPaths(text, exists)).toEqual([
      'src/a.ts:40',
      'src/lib/b.js:10-20',
      'docs/guide.md § 3.2',
      'CHANGELOG.md',
      'src/c.ts:5-9',
    ]);
  });

  it('skips paths that do not exist, and never invents one', () => {
    expect(readFirstPaths('Edit src/real.ts and src/missing.ts.', only('src/real.ts'))).toEqual(['src/real.ts']);
    expect(readFirstPaths('Nothing here names a file.', only('src/real.ts'))).toEqual([]);
  });

  it('deduplicates and keeps the first mention', () => {
    const text = 'Read src/a.ts, then src/b.ts, then src/a.ts again and `src/b.ts`.';
    expect(readFirstPaths(text, only('src/a.ts', 'src/b.ts'))).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('caps the list', () => {
    const files = Array.from({ length: READ_FIRST_MAX + 5 }, (_, i) => `src/f${i}.ts`);
    const list = readFirstPaths(files.join(' '), only(...files));
    expect(list).toHaveLength(READ_FIRST_MAX);
    expect(list[0]).toBe('src/f0.ts');
    expect(READ_FIRST_MAX).toBeGreaterThanOrEqual(8);
    expect(READ_FIRST_MAX).toBeLessThanOrEqual(15);
  });

  it('puts the paths of a "Read also" section first', () => {
    const text = [
      'Build the thing in src/main.ts.',
      '',
      'Read also:',
      '- docs/spec.md',
      '- src/helper.ts:12',
      '',
      '1. Then change src/other.ts.',
    ].join('\n');
    const exists = only('src/main.ts', 'docs/spec.md', 'src/helper.ts', 'src/other.ts');
    expect(readFirstPaths(text, exists)).toEqual(['docs/spec.md', 'src/helper.ts:12', 'src/main.ts', 'src/other.ts']);
  });

  it('takes the mission text before the queue lines (heading, ownership, reads, done command), which only fill what is left', () => {
    const owned = Array.from({ length: READ_FIRST_MAX }, (_, i) => `src/own${i}.ts`);
    const text = [
      '## TRACK T1 (one; source: docs/source.md; class K, estimate 30 min)',
      '',
      `**Ownership in the queue:** files ${owned.join(', ')}; DB none; shared patch none. Do not touch anything else.`,
      '**Reads (not owned):** src/read.ts. You build on these.',
      '',
      '**Done command (binding):** `npm test -- src/done.test.ts` must exit 0 in your worktree.',
      '',
      'Read also:',
      '- docs/spec.md',
      '',
      'Change src/mission.ts:12 as the spec says.',
    ].join('\n');
    const exists = only(...owned, 'docs/source.md', 'src/read.ts', 'src/done.test.ts', 'docs/spec.md', 'src/mission.ts');
    const list = readFirstPaths(text, exists);
    expect(list).toHaveLength(READ_FIRST_MAX);
    expect(list.slice(0, 2)).toEqual(['docs/spec.md', 'src/mission.ts:12']);
    // With room left, the queue lines follow the mission paths, in the order they stand.
    expect(readFirstPaths(text, exists, 40)).toEqual([
      'docs/spec.md',
      'src/mission.ts:12',
      'docs/source.md',
      ...owned,
      'src/read.ts',
      'src/done.test.ts',
    ]);
  });

  it('never mistakes a URL, a glob or markdown for a path', () => {
    const exists = () => true; // even if everything "exists", these must not come through
    const text = [
      'See https://example.com/docs/a.md and http://host/x.ts:12, or file:///etc/passwd.',
      'Globs: src/**/*.ts, docs/*.md, lib/[ab].js, test/{a,b}.ts and src/x?.ts.',
      'Bold **docs/bold.md** and a link [docs/text.md](docs/link.md).',
    ].join('\n');
    expect(readFirstPaths(text, exists)).toEqual(['docs/bold.md', 'docs/link.md']);
  });

  it('refuses absolute paths, home paths, backslashes and ".." escapes, whatever exists says', () => {
    const exists = () => true;
    const text = [
      '/etc/passwd, C:/Windows/win.ini, C:\\Windows\\win.ini, ~/secret.txt, ../outside/file.ts,',
      'src/../../escape.ts, ./src/ok.ts, src/./x.ts, .git/config and %APPDATA%/x.json.',
    ].join('\n');
    expect(readFirstPaths(text, exists)).toEqual(['src/ok.ts']);
  });

  it('gives only strings that are bare paths with a known suffix form, never other text', () => {
    const text = 'Run `npm test -- src/a.ts` and "src/b.ts:12:3" and src/c.ts:abc and src/d.ts§ 2.';
    const out = readFirstPaths(text, only('src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'));
    expect(out).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts § 2']);
    for (const p of out) expect(p).toMatch(/^[\w@+.-]+(?:\/[\w@+.-]+)*(?::\d+(?:-\d+)?| § \d+(?:\.\d+)*)?$/);
  });
});

describe('readFirstBlock', () => {
  it('is empty for an empty list', () => {
    expect(readFirstBlock([])).toBe('');
  });
  it('says to read them all in the same turn, one path per line', () => {
    const b = readFirstBlock(['src/a.ts:40', 'docs/x.md § 2']);
    expect(b.split('\n')).toEqual([
      'Read these in your first turn, all in the same turn:',
      '- src/a.ts:40',
      '- docs/x.md § 2',
    ]);
  });
});

describe('repoFileExists', () => {
  it('answers true only for a file inside one of the roots', () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-readfirst-'));
    try {
      const repo = path.join(top, 'repo');
      const second = path.join(top, 'main');
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.mkdirSync(second);
      fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'x\n');
      fs.writeFileSync(path.join(second, 'notes.md'), 'x\n');
      fs.writeFileSync(path.join(top, 'outside.ts'), 'x\n');
      const exists = repoFileExists([repo, second]);
      expect(exists('src/a.ts')).toBe(true);
      expect(exists('notes.md')).toBe(true); // found in the second root
      expect(exists('src')).toBe(false); // a folder is not a file
      expect(exists('src/missing.ts')).toBe(false);
      expect(exists('../outside.ts')).toBe(false);
      expect(exists('src/../../outside.ts')).toBe(false);
      expect(exists(path.join(top, 'outside.ts'))).toBe(false);
    } finally {
      fs.rmSync(top, { recursive: true, force: true });
    }
  });
});

describe('make-mission.mjs writes the read-first block at the top', () => {
  const SCRIPT = path.resolve(__dirname, '..', 'make-mission.mjs');
  it('before the shared protocol and the track block, and not at all when nothing exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-readfirst-mm-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.mkdirSync(path.join(root, 'docs'));
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x\n');
      fs.writeFileSync(path.join(root, 'docs', 'spec.md'), '# Spec\n\n## 2 Part\n\ntext\n');
      const common = path.join(root, 'common.md');
      fs.writeFileSync(common, '## SHARED PROTOCOL FOR TRACKS (binding)\n\nTrack __TRACK__ on __BRANCH__ from __HEAD__.\n');
      const track = path.join(root, 'track.md');
      fs.writeFileSync(
        track,
        [
          '=====T1=====',
          'TITLE: TRACK T1 (one)',
          'BRANCH: queue/T1',
          '',
          '## TRACK T1 (one; class K, estimate 30 min)',
          '',
          'Change src/a.ts:3 as docs/spec.md § 2 says. Ignore src/missing.ts and https://example.com/a.md.',
          '=====T2=====',
          'TITLE: TRACK T2 (two)',
          'BRANCH: queue/T2',
          '',
          '## TRACK T2 (two; class K, estimate 30 min)',
          '',
          'Change src/missing.ts only.',
          '',
        ].join('\n'),
      );
      const r = spawnSync(process.execPath, [SCRIPT, '--common', common, '--track', track, '--head', 'abc1234'], {
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, QUEUE_ROOT: root, QUEUE_CONFIG: path.join(root, 'no-config.json') },
      });
      expect(r.status, r.stderr).toBe(0);
      const t1 = fs.readFileSync(path.join(root, 'prompt-T1.md'), 'utf8');
      const lines = t1.split('\n');
      expect(lines[0]).toBe('# TRACK T1 (one)');
      expect(lines[1]).toBe('');
      expect(lines[2]).toBe('Read these in your first turn, all in the same turn:');
      expect(lines[3]).toBe('- src/a.ts:3');
      expect(lines[4]).toMatch(/^- docs\/spec\.md § 2 \(line 3.5\)$/);
      expect(lines[5]).toBe('');
      const at = (s: string) => t1.indexOf(s);
      expect(at('Read these in your first turn')).toBeLessThan(at('## SHARED PROTOCOL'));
      expect(at('## SHARED PROTOCOL')).toBeLessThan(at('## TRACK T1'));
      expect(t1).not.toMatch(/^- src\/missing\.ts/m);

      const t2 = fs.readFileSync(path.join(root, 'prompt-T2.md'), 'utf8');
      expect(t2).not.toContain('Read these in your first turn');
      expect(t2.startsWith('# TRACK T2 (two)\n\n## SHARED PROTOCOL')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

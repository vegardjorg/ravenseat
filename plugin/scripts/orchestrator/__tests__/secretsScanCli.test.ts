// =============================================================
// secretsScanCli.test.ts: `ravenseat secrets scan|ignore|unignore` and the doctor row keyscan, through the real CLI in a
// temporary project (roadmap 6b, lib/repoSecretScan.js).
//
// Why: a key already in a tracked file or in an old commit is never seen by the push check. The scan names each one by
// file, line or commit, rule and a hash, NEVER the value: not in the output, the JSON, the result file or the time log.
// The same key has the same hash on every run, so a false alarm set aside by its hash stays aside. The scan is the
// owner's: refused from a track worktree. The fake keys are joined from random characters at run time, so no key-shaped
// text is in this file.
// =============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { project } from './redteam/project';

function fakeKey() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return ['AK', 'IA', Array.from(crypto.randomBytes(16), (b) => abc[b % abc.length]).join('')].join('');
}

/** A project with one key in a tracked file and one that a later commit deleted again. */
function scanProject() {
  const p = project();
  const live = fakeKey();
  const gone = fakeKey();
  const put = (file: string, body: string | null, msg: string) => {
    const full = path.join(p.repo, ...file.split('/'));
    if (body === null) fs.rmSync(full);
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    p.g(['add', '-A']);
    p.g(['commit', '-q', '-m', msg]);
  };
  put('src/app.js', `const one = 1;\nconst aws = "${live}";\n`, 'app');
  put('old.js', `k = "${gone}"\n`, 'old key');
  const added = p.g(['rev-parse', '--short=7', 'HEAD']);
  put('old.js', null, 'remove the old key');
  const read = (f: string) => (fs.existsSync(path.join(p.folder, f)) ? fs.readFileSync(path.join(p.folder, f), 'utf8') : '');
  const noKey = (text: string) => {
    for (const k of [live, gone]) {
      expect(text).not.toContain(k);
      expect(text).not.toContain(k.slice(2, -2));
    }
  };
  return { ...p, live, gone, added, read, noKey };
}

describe('ravenseat secrets scan', () => {
  it('names the tracked hit and, with --history, the deleted one with its commit; never a value anywhere', () => {
    const p = scanProject();
    const r = p.run('secrets', 'scan');
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('src/app.js:2');
    expect(r.out).toContain('aws-access-key');
    expect(r.out).not.toContain('old.js');
    p.noKey(r.out);

    const h = p.run('secrets', 'scan', '--history');
    expect(h.code, h.out).toBe(1);
    expect(h.out).toContain(`${p.added} old.js:1`);
    expect(h.out).toMatch(/rotate/i);
    expect(h.out).toContain('git filter-repo');
    p.noKey(h.out);

    const j = p.run('secrets', 'scan', '--history', '--json');
    const json = JSON.parse(j.out);
    // The live key is in the tree and (marked inTree) in the history; the deleted one only in the history.
    const where = json.findings.map((f: { where: string; file: string; inTree?: boolean }) => `${f.where}:${f.file}:${f.inTree ?? '-'}`).sort();
    expect(where).toEqual(['history:old.js:false', 'history:src/app.js:true', 'tree:src/app.js:-']);
    expect(json.open).toBe(2);
    p.noKey(j.out);
    p.noKey(p.read('secret-scan.json'));
    p.noKey(p.read('secret-scan-ignore.json'));
    p.noKey(p.read('times.jsonl'));
    expect(p.read('times.jsonl')).toContain('secrets-scan');
    expect(JSON.parse(p.read('secret-scan.json')).history.commits).toBe(4);
  }, 90_000);

  it('the same key has the same hash on every run; ignore by hash sets it aside, unignore brings it back', () => {
    const p = scanProject();
    const first = JSON.parse(p.run('secrets', 'scan', '--json').out);
    const second = JSON.parse(p.run('secrets', 'scan', '--json').out);
    const hash = first.findings[0].hash;
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(second.findings[0].hash).toBe(hash);

    const ig = p.run('secrets', 'ignore', hash, '--note', 'a test value');
    expect(ig.code, ig.out).toBe(0);
    const after = p.run('secrets', 'scan');
    expect(after.code, after.out).toBe(0);
    expect(after.out).toMatch(/1 set aside/);
    expect(p.run('secrets', 'ignore', 'nothex').code).toBe(1);

    expect(p.run('secrets', 'unignore', hash).code).toBe(0);
    expect(p.run('secrets', 'scan').code).toBe(1);
  }, 90_000);

  it('doctor: INFO before the first scan, WARN with the counts after it; doctor itself scans nothing', () => {
    const p = scanProject();
    const before = JSON.parse(p.run('doctor', '--json').out).checks.find((c: { name: string }) => c.name === 'keyscan');
    expect(before.status).toBe('INFO');
    expect(before.fix).toContain('secrets scan');
    expect(p.read('secret-scan.json')).toBe('');
    p.run('secrets', 'scan', '--history');
    const out = p.run('doctor', '--json').out;
    const row = JSON.parse(out).checks.find((c: { name: string }) => c.name === 'keyscan');
    expect(row.status).toBe('WARN');
    expect(row.message).toMatch(/2 possible key\(s\).*1 in tracked files, 1 only in the history/);
    p.noKey(out);
  }, 120_000);

  it('queue agents may not run any `secrets` command (it stays out of the push guard\'s agent list)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PG = require('../lib/pushGuard.js');
    expect(Object.keys(PG.AGENT_QUEUE_COMMANDS)).not.toContain('secrets');
  });

  it('is refused from a track worktree, and writes nothing', () => {
    const p = scanProject();
    p.g(['checkout', '-q', '-b', 'queue/T1']);
    const r = p.run('secrets', 'scan');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/track worktree/);
    expect(p.run('secrets', 'ignore', '0123456789abcdef').code).toBe(1);
    expect(p.read('secret-scan.json')).toBe('');
    p.noKey(r.out);
  }, 60_000);
});

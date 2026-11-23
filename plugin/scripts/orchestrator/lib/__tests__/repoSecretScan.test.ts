// =============================================================
// repoSecretScan.test.ts: the scan of every tracked file and the history (lib/repoSecretScan.js, roadmap 6b).
//
// Why: the push check only sees what is on its way out. A key already in a tracked file, or in an old commit and deleted
// since, is never seen by it. This scan reads them, and must never store, print or log the value: a finding has the
// file, the line (or the commit), the rule, at most a short preview and a salted hash, so the same key is known again
// across runs and a false alarm can be set aside by its hash. Temporary git repos; the fake keys are built at run time
// from random characters, so no key-shaped text is in this file.
// =============================================================
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RS = require('../repoSecretScan.js');

/** A fake AWS-shaped access key id, new on each call: the prefix and random uppercase characters joined at run time. */
function fakeKey() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const tail = Array.from(crypto.randomBytes(16), (b) => abc[b % abc.length]).join('');
  return ['AK', 'IA', tail].join('');
}

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(d);
  return d;
}

/** A repo with one commit per entry of `steps`: each step writes (string or Buffer) or deletes (null) files. */
function repo(steps: Record<string, string | Buffer | null>[]) {
  const dir = tmpDir('ravenseat-reposcan-');
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-C', dir, ...args], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
  g('init', '-q', '-b', 'main');
  steps.forEach((files, i) => {
    for (const [f, body] of Object.entries(files)) {
      const full = path.join(dir, ...f.split('/'));
      if (body === null) fs.rmSync(full, { force: true });
      else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
      }
    }
    g('add', '-A');
    g('commit', '-q', '--allow-empty', '-m', `step ${i}`);
  });
  return { dir, g };
}

describe('scanTracked', () => {
  it('finds a key in a tracked file with file, line and rule, and never the value', () => {
    const key = fakeKey();
    const r = repo([{ 'src/config.js': `const a = 1;\nconst aws = "${key}";\n`, 'README.md': 'hello\n' }]);
    const out = RS.scanTracked({ cwd: r.dir });
    expect(out.files).toBe(2);
    expect(out.findings).toHaveLength(1);
    const f = RS.finalize(out.findings, { salt: 'abc' })[0];
    expect(f).toMatchObject({ where: 'tree', file: 'src/config.js', line: 2, rule: 'aws-access-key' });
    expect(f.hash).toMatch(/^[0-9a-f]{16}$/);
    // At most the first and last two characters.
    expect(f.preview).toBe(`${key.slice(0, 2)}...${key.slice(-2)}`);
    expect(JSON.stringify(f)).not.toContain(key);
    expect(JSON.stringify(f)).not.toContain(key.slice(2, -2));
  });

  it('skips a binary file and a file over maxBytes, and counts them', () => {
    const key = fakeKey();
    const bin = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\n${key}\n`)]);
    const big = `${'x'.repeat(300)}\n${key}\n`;
    const r = repo([{ 'img.bin': bin, 'big.txt': big, 'ok.txt': 'fine\n' }]);
    const out = RS.scanTracked({ cwd: r.dir, maxBytes: 200 });
    expect(out.findings).toHaveLength(0);
    expect(out.skipped).toEqual({ binary: 1, large: 1 });
    expect(out.files).toBe(1);
  });

  it('a repo without a commit scans nothing and says so', () => {
    const dir = tmpDir('ravenseat-reposcan-empty-');
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'pipe' });
    const out = RS.scanTracked({ cwd: dir });
    expect(out.findings).toEqual([]);
    expect(out.incomplete).toMatch(/no commit/);
  });
});

describe('scanHistory', () => {
  it('finds a key that a later commit deleted again, with the commit that added it', async () => {
    const key = fakeKey();
    const r = repo([{ 'a.txt': 'start\n' }, { 'old.env.js': `x = "${key}"\n` }, { 'old.env.js': null }, { 'a.txt': 'later\n' }]);
    const added = r.g('rev-list', '--skip=2', '-n', '1', 'HEAD').trim();
    const tree = RS.scanTracked({ cwd: r.dir });
    expect(tree.findings).toHaveLength(0);
    const h = await RS.scanHistory({ cwd: r.dir, depth: 50 });
    expect(h.commits).toBe(4);
    expect(h.findings).toHaveLength(1);
    expect(h.findings[0]).toMatchObject({ file: 'old.env.js', rule: 'aws-access-key', commit: added.slice(0, 7) });
    const [f] = RS.finalize([...tree.findings, ...h.findings], { salt: 's' });
    expect(f.where).toBe('history');
    expect(f.inTree).toBe(false);
    expect(JSON.stringify(f)).not.toContain(key);
  });

  it('depth limits the commits read; all reads every one', async () => {
    const key = fakeKey();
    const r = repo([{ 'k.js': `k = "${key}"\n` }, { 'k.js': null }, { 'a.txt': '1\n' }, { 'a.txt': '2\n' }]);
    expect((await RS.scanHistory({ cwd: r.dir, depth: 2 })).findings).toHaveLength(0);
    const all = await RS.scanHistory({ cwd: r.dir, all: true });
    expect(all.findings).toHaveLength(1);
    expect(all.commits).toBe(4);
  });

  it('a key still in the tree is one finding in the tree, with the history entry marked inTree', async () => {
    const key = fakeKey();
    const r = repo([{ 'k.js': `k = "${key}"\n` }, { 'a.txt': '1\n' }]);
    const tree = RS.scanTracked({ cwd: r.dir });
    const h = await RS.scanHistory({ cwd: r.dir, depth: 10 });
    const all = RS.finalize([...tree.findings, ...h.findings], { salt: 's' });
    expect(all.map((f: { where: string }) => f.where).sort()).toEqual(['history', 'tree']);
    expect(all.find((f: { where: string }) => f.where === 'history').inTree).toBe(true);
    expect(all[0].hash).toBe(all[1].hash);
  });
});

describe('hashes and the ignore list', () => {
  it('the hash is stable for one salt, differs across salts, and is not a plain hash of the value', () => {
    const key = fakeKey();
    const raw = [{ where: 'tree', file: 'a', line: 1, rule: 'aws-access-key', value: key }];
    const a1 = RS.finalize(raw, { salt: 'one' })[0].hash;
    expect(RS.finalize(raw, { salt: 'one' })[0].hash).toBe(a1);
    expect(RS.finalize(raw, { salt: 'two' })[0].hash).not.toBe(a1);
    expect(crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)).not.toBe(a1);
  });

  it('the salt is made once and kept in the data folder; ignore and unignore by hash', () => {
    const folder = tmpDir('ravenseat-reposcan-folder-');
    const s1 = RS.ensureSalt(folder);
    expect(RS.ensureSalt(folder)).toBe(s1);
    expect(RS.readIgnore(folder).ignored).toEqual([]);
    expect(RS.addIgnore(folder, '0123456789abcdef', { note: 'test value' })).toBe(true);
    expect(RS.addIgnore(folder, '0123456789abcdef')).toBe(false);
    expect(RS.ignoredSet(folder).has('0123456789abcdef')).toBe(true);
    expect(RS.removeIgnore(folder, '0123456789abcdef')).toBe(true);
    expect(RS.ignoredSet(folder).has('0123456789abcdef')).toBe(false);
    expect(RS.ensureSalt(folder)).toBe(s1);
  });

  it('summary leaves ignored findings out of the open count', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    const result = {
      scannedAt: '2026-11-20T12:00:00Z',
      history: { depth: 200, commits: 10 },
      findings: [
        { where: 'tree', file: 'a', line: 1, rule: 'r', hash: 'aaaaaaaaaaaaaaaa' },
        { where: 'history', file: 'b', line: 1, rule: 'r', hash: 'bbbbbbbbbbbbbbbb', commit: 'abcdef1', inTree: false },
      ],
    };
    const s = RS.summary(result, { ignored: new Set(['aaaaaaaaaaaaaaaa']), now, rescanDays: 14 });
    expect(s).toMatchObject({ ageDays: 3, open: 1, tree: 0, historyOnly: 1, ignored: 1, due: false });
    expect(RS.summary(result, { ignored: new Set(), now, rescanDays: 2 }).due).toBe(true);
    expect(RS.summary(result, { ignored: new Set(), now, rescanDays: 0 }).due).toBe(false);
  });
});

describe('doctorRows', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  it('never run: an INFO row that suggests the command; rescanDays 0: nothing', () => {
    const rows = RS.doctorRows({ result: null, ignored: new Set(), now, rescanDays: 14, cli: 'ravenseat' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'INFO', name: 'keyscan' });
    expect(rows[0].fix).toContain('ravenseat secrets scan');
    expect(RS.doctorRows({ result: null, ignored: new Set(), now, rescanDays: 0, cli: 'ravenseat' })).toEqual([]);
  });

  it('open findings: WARN with the counts and the actions; never a value', () => {
    const result = { scannedAt: '2026-11-22T12:00:00Z', history: null, findings: [{ where: 'tree', file: 'a', line: 1, rule: 'r', hash: 'aaaaaaaaaaaaaaaa', preview: 'AK...7Q' }] };
    const [row] = RS.doctorRows({ result, ignored: new Set(), now, rescanDays: 14, cli: 'ravenseat' });
    expect(row.status).toBe('WARN');
    expect(row.message).toMatch(/1 possible key/);
    expect(row.fix).toMatch(/rotate|change/i);
    expect(row.fix).toContain('secrets ignore');
  });

  it('clean and fresh: OK; clean and old: INFO to scan again', () => {
    const fresh = { scannedAt: '2026-11-22T12:00:00Z', history: { depth: 200, commits: 9 }, findings: [] };
    expect(RS.doctorRows({ result: fresh, ignored: new Set(), now, rescanDays: 14, cli: 'ravenseat' })[0].status).toBe('OK');
    const old = { ...fresh, scannedAt: '2026-10-01T12:00:00Z' };
    const [row] = RS.doctorRows({ result: old, ignored: new Set(), now, rescanDays: 14, cli: 'ravenseat' });
    expect(row.status).toBe('INFO');
    expect(row.message).toMatch(/53 days ago/);
  });
});

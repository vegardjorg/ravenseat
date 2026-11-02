// =============================================================
// secretScan.test.ts: the secret precheck before a push (lib/secretScan.js) and its wiring in hook-push-guard.mjs.
//
// Why: a key that reaches the remote stays in its history. The guard must name file:line on a hit, NEVER the value
// (the dialog and the transcript would copy it), stay quiet on placeholders and test files, skip a diff over the cap
// and a first push, and fail open. Temporary git repos with a bare remote; the fake keys are built at run time so
// this file holds none of them literally.
// =============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { addedLines, isQuietFile, question, scanLines, scanPush } from '../secretScan';

// Fake keys in the providers' formats, joined at run time.
const AWS = ['AK', 'IA', 'QX7TFAKE', 'KEY4PUSH'].join('');
const GH = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
const STRIPE = ['sk', '_live_', '4eC39HqLyjWDarjtT1zdp7dc'].join('');
const PEM = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');
const GENERIC_VALUE = 'q8Zr2Lm9Xw4Tb7Kd1Vn6';

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

/** A repo with a bare remote, one pushed commit, and `files` committed on top (not pushed). */
function repo(files: Record<string, string>, { push = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-secret-'));
  temporary.push(dir);
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  const g = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' });
  fs.mkdirSync(work);
  g(dir, 'init', '-q', '--bare', remote);
  g(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'README.md'), 'start\n');
  g(work, 'add', '.');
  g(work, 'commit', '-q', '-m', 'start');
  g(work, 'remote', 'add', 'origin', remote);
  if (push) g(work, 'push', '-q', 'origin', 'main');
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    fs.writeFileSync(path.join(work, f), text);
  }
  g(work, 'add', '.');
  g(work, 'commit', '-q', '-m', 'more');
  return { work, remote, g };
}

process.env.QUEUE_SECRET_SCANNER = 'builtin';

describe('addedLines', () => {
  it('reads files and new line numbers from a unified diff, only + lines', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,0 +4,2 @@',
      '+one',
      '+two',
      '@@ -10 +12 @@',
      '-old',
      '+new',
      'diff --git a/gone.txt b/gone.txt',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n');
    expect(addedLines(diff)).toEqual([
      { file: 'src/a.ts', line: 4, text: 'one' },
      { file: 'src/a.ts', line: 5, text: 'two' },
      { file: 'src/a.ts', line: 12, text: 'new' },
    ]);
  });
});

describe('scanLines', () => {
  const at = (text: string, file = 'src/config.ts') => scanLines([{ file, line: 7, text }]);
  it('finds the provider formats and a private key header', () => {
    expect(at(`const k = "${AWS}";`)).toEqual([{ file: 'src/config.ts', line: 7, rule: 'aws-access-key' }]);
    expect(at(`token: ${GH}`)[0].rule).toBe('github-token');
    expect(at(`STRIPE=${STRIPE}`)[0].rule).toBe('stripe-live-key');
    expect(at(PEM, 'deploy/key.txt')[0].rule).toBe('private-key');
  });
  it('the generic rule: a long mixed value hits, references and placeholders do not', () => {
    expect(at(`DB_PASSWORD=${GENERIC_VALUE}`)[0].rule).toBe('generic-secret');
    expect(at(`apiKey: "${GENERIC_VALUE}"`)[0].rule).toBe('generic-secret');
    expect(at('password = process.env.DB_PASSWORD_VALUE_123')).toEqual([]);
    expect(at('secret: ${{ secrets.DEPLOY_TOKEN_2024 }}')).toEqual([]);
    expect(at('password=your-password-here-123')).toEqual([]);
    expect(at('token = getToken(config123456789)')).toEqual([]);
    expect(at('password=short1')).toEqual([]);
    expect(at('the secret of the year is unknown')).toEqual([]);
  });
  it('skips the generic rule in test, fixture, example and docs files, but not the provider formats', () => {
    expect(at(`password=${GENERIC_VALUE}`, 'src/__tests__/login.test.ts')).toEqual([]);
    expect(at(`password=${GENERIC_VALUE}`, 'fixtures/users.json')).toEqual([]);
    expect(at(`password=${GENERIC_VALUE}`, 'README.md')).toEqual([]);
    expect(at(`password=${GENERIC_VALUE}`, '.env.example')).toEqual([]);
    expect(at(`k=${AWS}`, 'src/__tests__/aws.test.ts')[0].rule).toBe('aws-access-key');
    expect(isQuietFile('src/app.ts')).toBe(false);
    expect(isQuietFile('pkg/handler_test.go')).toBe(true);
  });
});

describe('question', () => {
  it('names file:line and the rule, never the value; null without hits', () => {
    const q = question({ scanner: 'built-in', hits: [{ file: 'src/a.ts', line: 3, rule: 'aws-access-key' }] });
    expect(q).toMatch(/src\/a\.ts:3 \(aws-access-key\)/);
    expect(q).not.toContain(AWS);
    expect(question({ scanner: 'built-in', hits: [] })).toBeNull();
    const many = Array.from({ length: 7 }, (_, i) => ({ file: `f${i}.ts`, line: i, rule: 'generic-secret' }));
    expect(question({ scanner: 'built-in', hits: many })).toMatch(/and 2 more/);
  });
});

describe('scanPush (temporary repos)', () => {
  it('hit: the added line of the unpushed commit, with its line number', () => {
    const r = repo({ 'src/config.ts': `export const a = 1;\nexport const key = "${AWS}";\n` });
    const out = scanPush({ cwd: r.work, remote: 'origin', branch: 'main' });
    expect(out).toEqual({ scanner: 'built-in', hits: [{ file: 'src/config.ts', line: 2, rule: 'aws-access-key' }] });
  });
  it('miss: clean changes give no hits', () => {
    const r = repo({ 'src/app.ts': 'export const port = 3000;\n' });
    expect(scanPush({ cwd: r.work, remote: 'origin', branch: 'main' })?.hits).toEqual([]);
  });
  it('cap: a diff over maxBytes is skipped (null), and so is a first push without a remote ref', () => {
    const r = repo({ 'src/config.ts': `${'x'.repeat(5000)}\nkey = "${AWS}"\n` });
    expect(scanPush({ cwd: r.work, remote: 'origin', branch: 'main', setup: { maxBytes: 1000 } })).toBeNull();
    const first = repo({ 'src/config.ts': `key = "${AWS}"\n` }, { push: false });
    expect(scanPush({ cwd: first.work, remote: 'origin', branch: 'main' })).toBeNull();
  });
  it('fails open on a folder that is not a repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-secret-norepo-'));
    temporary.push(dir);
    expect(scanPush({ cwd: dir, remote: 'origin', branch: 'main' })).toBeNull();
  });
  const hasGitleaks = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!hasGitleaks)('uses gitleaks when it is on PATH (and still never shows the value)', () => {
    const r = repo({ 'deploy/id_key': `${PEM}\n${'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun'.repeat(4)}\n-----END RSA PRIVATE KEY-----\n` });
    const prev = process.env.QUEUE_SECRET_SCANNER;
    delete process.env.QUEUE_SECRET_SCANNER;
    try {
      const out = scanPush({ cwd: r.work, remote: 'origin', branch: 'main', setup: { timeoutMs: 15000 } });
      expect(out?.scanner).toBe('gitleaks');
      expect(out?.hits.length).toBeGreaterThan(0);
      expect(question(out)).not.toContain('MIIEowIBAAKCAQEA');
    } finally {
      process.env.QUEUE_SECRET_SCANNER = prev;
    }
  }, 30_000);
});

describe('hook-push-guard.mjs: secret check and deploy commands', () => {
  const hook = path.resolve(__dirname, '..', '..', 'hook-push-guard.mjs');
  /** Runs the hook in `cwd` with a config; returns { decision, reason } or null. */
  const run = (cwd: string, config: object, payload: object) => {
    const configFile = path.join(cwd, '..', 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    const folder = path.join(cwd, '..', 'q');
    fs.mkdirSync(folder, { recursive: true });
    const env = { ...process.env, QUEUE_ROOT: cwd, QUEUE_CONFIG: configFile, QUEUE_FOLDER: folder, QUEUE_SECRET_SCANNER: 'builtin' };
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ ...payload, cwd }), encoding: 'utf8', env });
    if (!r.stdout) return null;
    const o = JSON.parse(r.stdout).hookSpecificOutput;
    return { decision: o.permissionDecision, reason: o.permissionDecisionReason as string };
  };
  const quiet = { push: { minTasks: 0 } };

  it('asks on a plain push of the base branch with a secret in it, naming file:line, never the value', () => {
    const r = repo({ 'src/config.ts': `const k = "${AWS}";\n` });
    const a = run(r.work, quiet, { tool_input: { command: 'git push origin main' } });
    expect(a?.decision).toBe('ask');
    expect(a?.reason).toMatch(/src\/config\.ts:1 \(aws-access-key\)/);
    expect(a?.reason).not.toContain(AWS);
    // A queue agent never pushes the base branch through this path: no scan question for it.
    expect(run(r.work, quiet, { agent_type: 'general-purpose', tool_input: { command: 'git push origin main' } })).toBeNull();
    // Switched off: no question.
    expect(run(r.work, { ...quiet, secretScan: { enabled: false } }, { tool_input: { command: 'git push origin main' } })).toBeNull();
  }, 30_000);

  it('no question for a clean push; a force push is still denied', () => {
    const r = repo({ 'src/app.ts': 'export const port = 3000;\n' });
    expect(run(r.work, quiet, { tool_input: { command: 'git push origin main' } })).toBeNull();
    expect(run(r.work, quiet, { tool_input: { command: 'git push --force origin main' } })?.decision).toBe('deny');
  }, 30_000);

  it('deployCommands: asks for the main session and for an agent; nothing when the list is empty', () => {
    const r = repo({ 'src/app.ts': 'x\n' });
    const cfg = { deployCommands: ['vercel --prod', 'fly deploy'] };
    const a = run(r.work, cfg, { tool_input: { command: 'vercel --prod' } });
    expect(a?.decision).toBe('ask');
    expect(a?.reason).toMatch(/`vercel --prod` is a deploy command/);
    expect(run(r.work, cfg, { agent_type: 'track', tool_input: { command: 'npm test && fly deploy --remote-only' } })?.decision).toBe('ask');
    expect(run(r.work, cfg, { tool_input: { command: 'vercel dev' } })).toBeNull();
    expect(run(r.work, {}, { tool_input: { command: 'vercel --prod' } })).toBeNull();
  }, 30_000);
});

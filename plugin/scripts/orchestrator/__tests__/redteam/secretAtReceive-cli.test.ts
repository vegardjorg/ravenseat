// =============================================================
// redteam/secretAtReceive-cli.test.ts: a key a track commits is found at receive, and the merge stops on it.
//
// Why: the push check scans what leaves the machine, but by then a track's commits are already in the base branch, and
// its history keeps the key. Receive scans the track's own commits (<base>..<branch>, every commit, the same patterns
// and exceptions as the push check). A hit opens the block secret-found with file:line and the rule, never the value,
// and the merge refuses until a clean receive closes it; `merge --allow-secret` (owner and orchestrator only) goes past,
// logged. An incomplete scan warns and blocks nothing. The check is opt-in (lib/optInChecks.js): these tests turn
// secretScan.atReceive on, and the default (off) scans nothing.
// The fake keys are joined at run time, so this file holds none of them literally.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { project, task } from './project';

const GH = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
const GENERIC_VALUE = ['q8Zr2Lm9', 'Xw4Tb7Kd1Vn6'].join('');

type Block = { code: string; to?: string; note?: string };

/** Task A delivered by a local track that also commits `files` (path -> text) in its worktree; then receive. The scan is on unless `config.secretScan` says otherwise. */
function delivered(files: Record<string, string>, config: Record<string, unknown> = {}) {
  const p = project({ config: { ...config, secretScan: { atReceive: true, ...(config.secretScan as object) } }, tasks: [task('A')] });
  // The built-in patterns, whatever is on PATH: gitleaks has its own rules, and the test is about the wiring.
  (p.env as Record<string, string | undefined>).QUEUE_SECRET_SCANNER = 'builtin';
  const scratch = p.localDelivers('A');
  const wt = path.join(p.repo, '.claude', 'worktrees', 'agent-A');
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
    fs.writeFileSync(path.join(wt, f), text);
  }
  p.g(['add', '--', ...Object.keys(files)], wt);
  p.g(['commit', '-q', '-m', 'more'], wt);
  const r = p.run('receive', 'A', '--scratchpad', scratch);
  const task0 = () => JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8')).tasks.find((x: { id: string }) => x.id === 'A');
  const openBlock = () => ((task0().blocks ?? []) as Block[]).find((b) => !b.to) ?? null;
  return { p, r, scratch, wt, openBlock, task0 };
}

describe('a key in a track\'s commits is found at receive, and the merge stops on it', () => {
  it('receive names file:line and the rule, never the value, and opens secret-found; merge stops, nothing merged', () => {
    const d = delivered({ 'lib/client.ts': `export const token = '${GH}';\n` });
    expect(d.r.code, d.r.out).toBe(0);
    expect(d.r.out).toMatch(/SECRET: .*lib\/client\.ts:1 \(github-token\)/);
    expect(d.r.out).not.toContain(GH);
    const b = d.openBlock();
    expect(b?.code).toBe('secret-found');
    expect(b?.note).toContain('lib/client.ts:1 (github-token)');
    expect(JSON.stringify(d.task0())).not.toContain(GH);
    // The finding log: one H row with the path, the line and the rule, never the value.
    const log = fs.readFileSync(path.join(d.p.folder, 'findings.jsonl'), 'utf8');
    expect(log).not.toContain(GH);
    expect(log.split('\n').filter(Boolean).map((l) => JSON.parse(l))).toMatchObject([
      { caught_by: 'secret-scan', severity: 'H', task: 'A', where: { files: ['lib/client.ts'], line: 1 }, excerpt: '1 secret hit(s) at receive (rules: github-token)' },
    ]);
    const m = d.p.merge('A');
    expect(m.code).not.toBe(0);
    expect(m.out).toMatch(/STOP: A is not merged\. .*secret/);
    expect(m.out).toContain('lib/client.ts:1');
    expect(m.out).toContain('--allow-secret');
    expect(m.out).not.toContain(GH);
    expect(d.p.taskOf('A')?.status).toBe('review');
  }, 240_000);

  it('--allow-secret goes past the stop, logged as secret-overridden', () => {
    const d = delivered({ 'lib/client.ts': `export const token = '${GH}';\n` });
    const m = d.p.run('merge', 'A', '--scratchpad', path.join(d.p.folder, 'collect', 'A'), '--allow-secret');
    expect(m.out).not.toMatch(/STOP: A is not merged\. .*secret/);
    expect(m.out).toContain('secret-overridden');
    expect(fs.readFileSync(path.join(d.p.folder, 'times.jsonl'), 'utf8')).toContain('secret-overridden');
  }, 240_000);

  it('a fix round that takes the key out of the branch history closes the block at the next receive', () => {
    const d = delivered({ 'lib/client.ts': `export const token = '${GH}';\n` });
    expect(d.openBlock()?.code).toBe('secret-found');
    fs.writeFileSync(path.join(d.wt, 'lib', 'client.ts'), 'export const token = process.env.API_TOKEN;\n');
    d.p.g(['add', '--', 'lib/client.ts'], d.wt);
    d.p.g(['commit', '-q', '--amend', '-m', 'more'], d.wt);
    const again = d.p.run('receive', 'A', '--scratchpad', d.scratch);
    expect(again.code, again.out).toBe(0);
    expect(again.out).not.toMatch(/SECRET:/);
    expect(d.openBlock()?.code ?? null).not.toBe('secret-found');
    expect(d.task0().secret_found).toBeUndefined();
  }, 240_000);

  it('test and fixture files get the push check\'s exceptions: a generic name = value there blocks nothing', () => {
    const line = `const API_KEY = '${GENERIC_VALUE}';\n`;
    const quiet = delivered({ 'lib/__tests__/client.test.ts': line });
    expect(quiet.r.code, quiet.r.out).toBe(0);
    expect(quiet.r.out).not.toMatch(/SECRET:/);
    expect(quiet.openBlock()?.code ?? null).not.toBe('secret-found');
    const loud = delivered({ 'lib/config.ts': line });
    expect(loud.r.out).toMatch(/SECRET: .*lib\/config\.ts:1 \(generic-secret\)/);
    expect(loud.openBlock()?.code).toBe('secret-found');
  }, 240_000);

  it('an incomplete scan warns and blocks nothing; off (the default) scans nothing', () => {
    const big = delivered({ 'lib/client.ts': `export const token = '${GH}';\n` }, { secretScan: { maxBytes: 10 } });
    expect(big.r.code, big.r.out).toBe(0);
    expect(big.r.out).toMatch(/secret scan at receive did not finish/i);
    expect(big.openBlock()?.code ?? null).not.toBe('secret-found');
    const off = delivered({ 'lib/client.ts': `export const token = '${GH}';\n` }, { secretScan: { atReceive: undefined } });
    expect(off.r.code, off.r.out).toBe(0);
    expect(off.r.out).not.toMatch(/SECRET:|secret scan at receive/i);
    expect(off.openBlock()?.code ?? null).not.toBe('secret-found');
  }, 240_000);
});

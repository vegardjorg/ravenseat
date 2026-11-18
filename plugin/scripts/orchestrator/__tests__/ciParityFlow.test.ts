// =============================================================
// ciParityFlow.test.ts: CI parity for a built gate guard with the real queue.mjs (ROADMAP 0i step 9b,
// plans/feillogg-til-gater-2026-11-15.md section 3.7 point 4 and section 3.9).
//
// Locks: (1) `checks --json` has the card quick-gate-add with the guard's command from the registry while it is not in
// gates.quick; (2) `checks quick-add <G-n>` ADDS that command at the end of gates.quick and keeps every other key and
// command, a second add changes nothing, and nothing is run; (3) it is refused, with the file unchanged, for an unknown
// or retired guard, a deploy command, and from a track worktree; (4) a gate guard with 0 runs after 7 days gives one INFO
// line in `ravenseat guards` and `ravenseat doctor`; (5) the settings learning.quickGateCard and learning.idleGuardInfo
// off take the card and the line away.
// The pure rules are in lib/__tests__/quickGate.test.ts, the card and the lift in lib/__tests__/checksCiParity.test.ts.
// Plain strings only: the commands in the registry are never run here (a run would fail, `npm run` has no package).
// =============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try {
      fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      /* left for the OS */
    }
  }
});

const guard = (o: Record<string, unknown> = {}) => ({
  id: 'G-1',
  kind: 'gate',
  title: 'Lint for unchecked results',
  explain: 'Stops a result used without its error check.',
  against: { signature: null, lesson: null, class: 'unchecked-error', area: 'src/api' },
  command: 'npm run lint:api',
  task: 'GATE-1',
  built: '2026-01-05',
  status: 'active',
  measures: { runs: null, redRuns: null, caughtSince: null, lastRed: null },
  ...o,
});

function project({ guards = [guard()] as object[], config = {} as Record<string, unknown> } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-parity-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const data = path.join(folder, 'data');
  for (const d of [repo, data]) fs.mkdirSync(d);
  fs.mkdirSync(path.join(repo, '.ravenseat'));
  fs.writeFileSync(path.join(repo, '.ravenseat', 'guards.json'), `${JSON.stringify({ version: 1, guards }, null, 2)}\n`);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const configFile = path.join(folder, 'queue.config.json');
  const configText = `${JSON.stringify({ baseBranch: 'main', mode: 'lite', gates: { quick: ['npm test'], full: ['npm run build'] }, deployCommands: ['npm run release'], ...config }, null, 2)}\n`;
  fs.writeFileSync(configFile, configText);
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ limits: {}, resolved: [], projects: {}, tasks: [] }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: folder,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
  } as NodeJS.ProcessEnv;
  execFileSync('git', ['-C', repo, ...ID, 'init', '-q', '-b', 'main'], { env, stdio: 'ignore' });
  execFileSync('git', ['-C', repo, ...ID, 'commit', '-q', '--allow-empty', '-m', 'start'], { env, stdio: 'ignore' });
  const q = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: repo, timeout: 90_000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
  };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { env, stdio: 'ignore' });
  const configNow = () => fs.readFileSync(configFile, 'utf8');
  return { q, git, configFile, configText, configNow };
}

type Card = { key: string; action: string | null; quickGate?: { guard: string; command: string }[] };
const cards = (out: string) => (JSON.parse(out) as { suggestions: Card[] }).suggestions;

describe('the card and checks quick-add', () => {
  it('the card carries the guard\'s command from the registry, and quick-add only appends it', () => {
    const p = project();
    const card = cards(p.q('checks', '--json').stdout).find((s) => s.key === 'quick-gate-add');
    expect(card).toMatchObject({ action: 'quick-gate', quickGate: [{ guard: 'G-1', command: 'npm run lint:api' }] });
    // show names the command; plan adds no investigation task for a card that needs no agent.
    expect(p.q('checks', 'show', 'quick-gate-add').out).toContain('checks quick-add <G-n>');
    const plan = p.q('checks', 'plan', 'quick-gate-add');
    expect(plan.code).not.toBe(0);
    expect(plan.out).toContain('needs no agent');

    const r = p.q('checks', 'quick-add', 'G-1');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Nothing was run');
    const after = JSON.parse(p.configNow());
    expect(after).toEqual({ ...JSON.parse(p.configText), gates: { quick: ['npm test', 'npm run lint:api'], full: ['npm run build'] } });
    // The rest of the file is as written (it was written with two spaces, and stays so).
    expect(p.configNow()).toBe(`${JSON.stringify(after, null, 2)}\n`);

    const again = p.q('checks', 'quick-add', 'G-1');
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain('already in gates.quick');
    expect(JSON.parse(p.configNow()).gates.quick).toEqual(['npm test', 'npm run lint:api']);
    expect(cards(p.q('checks', '--json').stdout).find((s) => s.key === 'quick-gate-add')).toBeUndefined();
  });

  it('refuses an unknown or retired guard, a deploy command and a key that is not a guard id, and writes nothing', () => {
    const p = project({ guards: [guard({ status: 'retired' }), guard({ id: 'G-2', command: 'npm run release -- --prod' }), guard({ id: 'G-3', kind: 'review', command: null })] });
    for (const id of ['G-9', 'G-1', 'G-2', 'G-3', '--all', 'npm run x']) {
      const r = p.q('checks', 'quick-add', id);
      expect(r.code, `${id}: ${r.out}`).not.toBe(0);
      expect(p.configNow(), id).toBe(p.configText);
    }
    expect(p.q('checks', 'quick-add', 'G-2').out).toMatch(/deploy/);
    // A refused command is never offered on the card either.
    expect(cards(p.q('checks', '--json').stdout).find((s) => s.key === 'quick-gate-add')).toBeUndefined();
  });

  it('is refused from a track worktree (a queue/ branch)', () => {
    const p = project();
    p.git('checkout', '-q', '-b', 'queue/T-1');
    const r = p.q('checks', 'quick-add', 'G-1');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('track worktree');
    expect(p.configNow()).toBe(p.configText);
  });

  it('learning.quickGateCard off: no card, while quick-add still works for the owner', () => {
    const p = project({ config: { learning: { quickGateCard: false } } });
    expect(cards(p.q('checks', '--json').stdout).find((s) => s.key === 'quick-gate-add')).toBeUndefined();
    expect(p.q('checks', 'quick-add', 'G-1').code).toBe(0);
  });
});

describe('a gate guard that has not run (INFO)', () => {
  it('ravenseat guards and ravenseat doctor name a gate guard with 0 runs after 7 days', () => {
    const p = project();
    const g = p.q('guards');
    expect(g.code, g.out).toBe(0);
    expect(g.out).toMatch(/INFO: G-1 .*0 runs in \d+ days/);
    expect(g.out).toContain('checks quick-add G-1');
    const d = p.q('doctor');
    expect(d.out).toMatch(/G-1 \(Lint for unchecked results\) has 0 runs/);
  });

  it('a guard built today, or learning.idleGuardInfo off, gives no line', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(project({ guards: [guard({ built: today })] }).q('guards').out).not.toContain('0 runs in');
    const off = project({ config: { learning: { idleGuardInfo: false } } });
    expect(off.q('guards').out).not.toContain('0 runs in');
    expect(off.q('doctor').out).not.toMatch(/G-1 .* has 0 runs/);
  });

  it('learning.idleGuardDays 0 is off; set to a number, it turns an old idleGuardInfo false on with it (L2)', () => {
    const zero = project({ config: { learning: { idleGuardDays: 0 } } });
    expect(zero.q('guards').out).not.toContain('0 runs in');
    const old = project({ config: { learning: { idleGuardInfo: false } } });
    const r = old.q('settings', 'set', 'learning.idleGuardDays', '3');
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(old.configNow()).learning).toEqual({ idleGuardInfo: true, idleGuardDays: 3 });
    expect(old.q('guards').out).toMatch(/INFO: G-1 .*0 runs in \d+ days/);
  });
});

// =============================================================
// settingsCli.test.ts: `ravenseat settings` (read) and `ravenseat settings set` (cli/settings.mjs) against a temporary
// queue (plans/innstillinger-vurdering-2026-11-12.md, steps 4 and 5).
//
// Reading: lite hides the full-only rows behind one count line per category, --advanced marks the advanced rows, --all
// shows the full-only ones with the reason, --json gives the grouped rows.
// Writing, the weakening pattern (the plan's table, step 5):
//   (a) refused from a track worktree, whatever the flags say; and the push guard denies it to queue agents
//   (b) a weakening value without --i-understand --by owner prints the warning texts and exits 1; nothing is written
//   (c) a stronger value (and a value that is no guard) needs no flag
//   (d) a weakening that goes through writes a setting-weakened row in the time log
//   (e) queue.config.json keeps its form: order, indentation, one-line lists and _comment keys
// and the row's store decides the file: queue.config.json or queue.json.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PG = require('../lib/pushGuard.js');

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
let root = '';
let env: NodeJS.ProcessEnv = {};
const configFile = () => path.join(root, 'queue.config.json');
const timeLog = () => path.join(root, 'times.jsonl');
const queue = () => JSON.parse(fs.readFileSync(path.join(root, 'q', 'queue.json'), 'utf8'));
const logRows = () =>
  fs.existsSync(timeLog())
    ? fs
        .readFileSync(timeLog(), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** Runs queue.mjs async (spawnSync blocks the vitest worker on a loaded machine). */
const ravenseat = (args: string[], cwd = root) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const p = spawn(process.execPath, [QUEUE, ...args], { cwd, env });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    p.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out, err }));
  });

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-settings-'));
  env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: path.join(root, 'q'),
    QUEUE_CONFIG: configFile(),
    QUEUE_TIME_LOG: timeLog(),
    QUEUE_GIT: root,
    DISABLE_UPDATES: '1',
  };
  delete env.QUEUE_SESSION;
  fs.writeFileSync(configFile(), '{\n  "mode": "full"\n}\n');
  expect((await ravenseat(['init'])).code).toBe(0);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('ravenseat settings (read)', () => {
  it('lite: the full-only rows are left out with a count line, and advanced rows only with --advanced, marked', async () => {
    fs.writeFileSync(configFile(), '{\n  "mode": "lite"\n}\n');
    const r = await ravenseat(['settings']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Mode: lite. Weakened guards: none.');
    expect(r.out).toContain('Limits and cost');
    expect(r.out).toMatch(/limits\.maxConcurrent +5/);
    expect(r.out).not.toContain('limits.maxDPlus');
    expect(r.out).toMatch(/\+ \d+ advanced \(--advanced\), 2 full mode only \(--all\)/);
    expect(r.out).not.toContain('[advanced]');
    const adv = await ravenseat(['settings', '--advanced']);
    expect(adv.out).toMatch(/maxFixRounds +3 .*\[advanced\]/);
    expect(adv.out).not.toContain('limits.maxDPlus');
    const all = await ravenseat(['settings', '--all']);
    expect(all.out).toMatch(/limits\.maxDPlus .*\[full mode only: lite has one task type \(class K\)\]/);
  });

  it('a category, --changed and --json', async () => {
    fs.writeFileSync(configFile(), '{\n  "mode": "full",\n  "gitSurface": "off"\n}\n');
    const gates = await ravenseat(['settings', 'gates']);
    expect(gates.out).toContain('Gates and checks');
    expect(gates.out).not.toContain('Limits and cost');
    const changed = await ravenseat(['settings', '--changed']);
    expect(changed.out).toMatch(/gitSurface +off .*\[weakened\]/);
    expect(changed.out).not.toContain('limits.maxConcurrent');
    expect(changed.out.split('\n')[0]).toBe('Mode: full. Weakened guards: 1 (gitSurface off).');
    const json = JSON.parse((await ravenseat(['settings', '--json'])).out);
    expect(json.mode).toBe('full');
    expect(json.weakened.map((w: { key: string }) => w.key)).toEqual(['gitSurface']);
    expect(json.categories.map((c: { id: string }) => c.id)).toContain('guards');
  });
});

describe('ravenseat settings set: the weakening pattern', () => {
  it('(a) is refused from a track worktree, also with the owner flags', async () => {
    const tree = path.join(root, 'tree');
    fs.mkdirSync(tree);
    const g = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: tree, stdio: 'pipe' });
    g('init', '-q', '-b', 'queue/A-1');
    g('commit', '-q', '--allow-empty', '-m', 'start');
    const before = fs.readFileSync(configFile(), 'utf8');
    for (const args of [
      ['settings', 'set', 'maxFixRounds', '4'],
      ['settings', 'set', 'gitSurface', 'off', '--i-understand', '--by', 'owner'],
    ]) {
      const r = await ravenseat(args, tree);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toMatch(/track worktree/);
    }
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
    expect(logRows().filter((x) => x.event === 'setting-weakened')).toEqual([]);
  });

  it('(a) the push guard denies settings set to queue agents, whatever the flags', () => {
    for (const command of [
      'ravenseat settings set maxFixRounds 4',
      'ravenseat settings set gitSurface off --i-understand --by owner',
      'node scripts/orchestrator/queue.mjs settings set secretScan.enabled off --i-understand --by owner',
    ]) {
      expect(PG.assess(command, { agentType: 'track', branch: 'queue/A-1', environment: null })?.decision, command).toBe('deny');
    }
  });

  it('(b) a weakening value without --i-understand --by owner prints the warning and exits 1; nothing is written', async () => {
    const before = fs.readFileSync(configFile(), 'utf8');
    for (const extra of [[], ['--i-understand'], ['--by', 'owner'], ['--i-understand', '--by', 'agent']]) {
      const r = await ravenseat(['settings', 'set', 'gitSurface', 'warn', ...extra]);
      expect(r.code, extra.join(' ')).toBe(1);
      const text = r.out + r.err;
      expect(text).toContain('STOP: this weakens a guard (gitSurface warn).');
      expect(text).toContain('Protects against: A git hook or git setting added while a track ran');
      expect(text).toContain('Why not: Hooks and settings like core.hooksPath run code');
      expect(text).toContain('What changes: A changed hook or setting no longer stops receive');
      expect(text).toContain('Saved for the project (queue.config.json, remember to commit).');
      expect(text).toContain('settings set gitSurface warn --i-understand --by owner');
    }
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
    expect(logRows().filter((x) => x.event === 'setting-weakened')).toEqual([]);
  });

  it('(c) a stronger value needs no flag, and neither does a value that is no guard', async () => {
    fs.writeFileSync(configFile(), '{\n  "mode": "full",\n  "gitSurface": "off"\n}\n');
    const r = await ravenseat(['settings', 'set', 'gitSurface', 'warn']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).gitSurface).toBe('warn');
    const n = await ravenseat(['settings', 'set', 'maxFixRounds', '4']);
    expect(n.code, n.err).toBe(0);
    expect(n.out).toContain('maxFixRounds = 4');
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).maxFixRounds).toBe(4);
    expect(logRows().filter((x) => x.event === 'setting-weakened')).toEqual([]);
  });

  it('(d) a confirmed weakening is written and logged as setting-weakened, with who and the old and new value', async () => {
    const r = await ravenseat(['settings', 'set', 'secretScan.enabled', 'off', '--i-understand', '--by', 'owner']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).secretScan).toEqual({ enabled: false });
    const rows = logRows().filter((x) => x.event === 'setting-weakened');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'setting-weakened', key: 'secretScan.enabled', from: true, to: false, by: 'owner', store: 'config' });
    expect(Date.parse(rows[0].time)).toBeGreaterThan(0);
  });

  it('(e) queue.config.json keeps its order, indentation, one-line lists and _comment keys', async () => {
    const text = [
      '{',
      '    "_comment": "ours, see the team wiki",',
      '    "mode": "full",',
      '    "gates": { "quick": ["npm test"], "full": ["npm test", "npm run e2e"] },',
      '    "push": {',
      '        "mode": "owner",',
      '        "minTasks": 10',
      '    }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(configFile(), text);
    const r = await ravenseat(['settings', 'set', 'push.minTasks', '5']);
    expect(r.code, r.err).toBe(0);
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(text.replace('"minTasks": 10', '"minTasks": 5'));
    const w = await ravenseat(['settings', 'set', 'push.mode', 'threshold', '--i-understand', '--by', 'owner']);
    expect(w.code, w.err).toBe(0);
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(
      text.replace('"minTasks": 10', '"minTasks": 5').replace('"mode": "owner"', '"mode": "threshold"'),
    );
  });

  it('writes to the store the row names: limits and auto-accept go to queue.json, not queue.config.json', async () => {
    const before = fs.readFileSync(configFile(), 'utf8');
    const l = await ravenseat(['settings', 'set', 'limits.maxConcurrent', '3']);
    expect(l.code, l.err).toBe(0);
    expect(queue().limits.maxConcurrent).toBe(3);
    const refused = await ravenseat(['settings', 'set', 'proposals.autoAccept.enabled', 'on']);
    expect(refused.code).toBe(1);
    expect(refused.out + refused.err).toContain('Saved only for you (queue.json).');
    expect(queue().proposals?.autoAccept?.enabled).not.toBe(true);
    const ok = await ravenseat(['settings', 'set', 'proposals.autoAccept.enabled', 'on', '--i-understand', '--by', 'owner']);
    expect(ok.code, ok.err).toBe(0);
    expect(queue().proposals.autoAccept.enabled).toBe(true);
    expect(logRows().filter((x) => x.event === 'setting-weakened').map((x) => [x.key, x.store])).toEqual([
      ['proposals.autoAccept.enabled', 'queue'],
    ]);
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
  });

  it('refuses what it cannot set: an unknown key, a list, a read-only row and a bad value', async () => {
    for (const [args, message] of [
      [['settings', 'set', 'noSuchKey', '1'], /unknown setting noSuchKey/],
      [['settings', 'set', 'protectedPaths', '[]'], /edit it in queue\.config\.json/],
      [['settings', 'set', 'baseBranch', 'dev'], /read only/],
      [['settings', 'set', 'gitSurface', 'sometimes'], /stop, warn or off/],
      [['settings', 'set', 'limits.maxDPlus', '9'], /cannot be larger than maxConcurrent/],
      [['settings', 'set', 'gitSurface'], /settings set <key> <value>/],
    ] as [string[], RegExp][]) {
      const r = await ravenseat(args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err, args.join(' ')).toMatch(message);
    }
  });
});

// Step B of the settings work: the older commands that write a setting go through the same rule (one shared check in
// cli/settings.mjs), so `settings set` is not the only door that asks.
describe('the older commands follow the same weakening rule', () => {
  it('proposals auto on without --i-understand --by owner prints the warning and exits 1; nothing is written', async () => {
    for (const extra of [[], ['--i-understand'], ['--by', 'owner']]) {
      const r = await ravenseat(['proposals', 'auto', 'on', ...extra]);
      expect(r.code, extra.join(' ')).toBe(1);
      const text = r.out + r.err;
      expect(text).toContain('STOP: this weakens a guard (proposals.autoAccept.enabled on).');
      expect(text).toContain('Protects against: Tasks proposed by agents that start without you seeing them first.');
      expect(text).toContain('Saved only for you (queue.json).');
      expect(text).toContain('Confirm with: ravenseat proposals auto on --i-understand --by owner');
    }
    expect(queue().proposals?.autoAccept?.enabled).not.toBe(true);
    expect(logRows().filter((x) => x.event === 'setting-weakened')).toEqual([]);
  });

  it('proposals auto on with the owner flags writes it and logs setting-weakened; off and the other rules need no flag', async () => {
    const ok = await ravenseat(['proposals', 'auto', 'on', '--classes', 'K,U', '--i-understand', '--by', 'owner']);
    expect(ok.code, ok.err).toBe(0);
    expect(queue().proposals.autoAccept).toMatchObject({ enabled: true, classes: ['K', 'U'] });
    expect(logRows().filter((x) => x.event === 'setting-weakened')).toEqual([
      expect.objectContaining({ key: 'proposals.autoAccept.enabled', from: false, to: true, by: 'owner', store: 'queue' }),
    ]);
    // Already on: on again (with other rules) is no new weakening.
    expect((await ravenseat(['proposals', 'auto', 'on', '--max-estimate', '30'])).code).toBe(0);
    expect((await ravenseat(['proposals', 'auto', 'off'])).code).toBe(0);
    expect(queue().proposals.autoAccept.enabled).toBe(false);
    expect((await ravenseat(['proposals', 'auto', '--classes', 'K'])).code).toBe(0);
    expect(logRows().filter((x) => x.event === 'setting-weakened')).toHaveLength(1);
  });

  it('proposals auto on is refused from a track worktree, also with the owner flags', async () => {
    const tree = path.join(root, 'tree');
    fs.mkdirSync(tree);
    const g = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: tree, stdio: 'pipe' });
    g('init', '-q', '-b', 'queue/A-1');
    g('commit', '-q', '--allow-empty', '-m', 'start');
    const r = await ravenseat(['proposals', 'auto', 'on', '--i-understand', '--by', 'owner'], tree);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/track worktree/);
    expect(queue().proposals?.autoAccept?.enabled).not.toBe(true);
    expect(logRows().filter((x) => x.event === 'setting-weakened')).toEqual([]);
  });

  it('limit and cloud set need no flag for a value that weakens nothing', async () => {
    const l = await ravenseat(['limit', 'maxConcurrent', '2']);
    expect(l.code, l.err).toBe(0);
    expect(queue().limits.maxConcurrent).toBe(2);
    const c = await ravenseat(['cloud', 'set', 'maxSessions', '2']);
    expect(c.code, c.err).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).cloud.maxSessions).toBe(2);
    expect(logRows().filter((x) => x.event === 'setting-weakened')).toEqual([]);
  });
});

/** A git tree on a track branch, for the "refused from a track worktree" checks. */
function trackTree() {
  const tree = path.join(root, 'tree');
  fs.mkdirSync(tree);
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: tree, stdio: 'pipe' });
  g('init', '-q', '-b', 'queue/A-1');
  g('commit', '-q', '--allow-empty', '-m', 'start');
  return tree;
}

describe('mode lite is a confirmed weakening (owner decision 2026-11-12)', () => {
  const weakened = () => logRows().filter((x) => x.event === 'setting-weakened');
  const mode = () => JSON.parse(fs.readFileSync(configFile(), 'utf8')).mode;

  it('mode lite on a full project without --i-understand --by owner prints the warning and exits 1; nothing is written', async () => {
    const before = fs.readFileSync(configFile(), 'utf8');
    for (const extra of [[], ['--i-understand'], ['--by', 'owner'], ['--i-understand', '--by', 'agent']]) {
      const r = await ravenseat(['mode', 'lite', ...extra]);
      expect(r.code, extra.join(' ')).toBe(1);
      const text = r.out + r.err;
      expect(text).toContain('STOP: this weakens a guard (mode lite).');
      expect(text).toContain('Protects against:');
      expect(text).toMatch(/gitSurface and dependencyFiles/);
      expect(text).toContain('Confirm with: ravenseat mode lite --i-understand --by owner');
    }
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
    expect(weakened()).toEqual([]);
  });

  it('with the owner flags it is written and logged; back to full and lite again on lite need no flag', async () => {
    const r = await ravenseat(['mode', 'lite', '--i-understand', '--by', 'owner']);
    expect(r.code, r.err).toBe(0);
    expect(mode()).toBe('lite');
    expect(weakened()).toEqual([expect.objectContaining({ key: 'mode', from: 'full', to: 'lite', by: 'owner', store: 'config' })]);
    expect((await ravenseat(['mode', 'lite'])).code).toBe(0);
    expect((await ravenseat(['mode', 'full'])).code).toBe(0);
    expect(mode()).toBe('full');
    expect(weakened()).toHaveLength(1);
  });

  it('settings set mode lite follows the same rule, and an install without a mode key counts as full', async () => {
    fs.writeFileSync(configFile(), '{}\n');
    const r = await ravenseat(['settings', 'set', 'mode', 'lite']);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain('STOP: this weakens a guard (mode lite).');
    expect(fs.readFileSync(configFile(), 'utf8')).toBe('{}\n');
    expect((await ravenseat(['mode', 'lite'])).code).toBe(1);
    expect(weakened()).toEqual([]);
  });

  it('is refused from a track worktree, also with the owner flags', async () => {
    const before = fs.readFileSync(configFile(), 'utf8');
    const r = await ravenseat(['mode', 'lite', '--i-understand', '--by', 'owner'], trackTree());
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/track worktree/);
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
    expect(weakened()).toEqual([]);
  });

  it('the first run is not blocked: a fresh init writes lite with no flag; init --lite on an existing full project asks', async () => {
    // A new project: no queue yet and no mode of its own.
    fs.rmSync(path.join(root, 'q'), { recursive: true, force: true });
    fs.writeFileSync(configFile(), '{}\n');
    const first = await ravenseat(['init']);
    expect(first.code, first.err).toBe(0);
    expect(mode()).toBe('lite');
    // init --lite on a new project is the same first run.
    fs.rmSync(path.join(root, 'q'), { recursive: true, force: true });
    fs.writeFileSync(configFile(), '{}\n');
    expect((await ravenseat(['init', '--lite'])).code).toBe(0);
    expect(mode()).toBe('lite');
    expect(weakened()).toEqual([]);
    // An existing full project: init --lite is the switch, so it asks like mode lite.
    fs.writeFileSync(configFile(), '{\n  "mode": "full"\n}\n');
    const sw = await ravenseat(['init', '--lite']);
    expect(sw.code).toBe(1);
    expect(sw.out + sw.err).toContain('STOP: this weakens a guard (mode lite).');
    expect(sw.out + sw.err).toContain('Confirm with: ravenseat init --lite --i-understand --by owner');
    expect(mode()).toBe('full');
    const ok = await ravenseat(['init', '--lite', '--i-understand', '--by', 'owner']);
    expect(ok.code, ok.err).toBe(0);
    expect(mode()).toBe('lite');
    expect(weakened()).toEqual([expect.objectContaining({ key: 'mode', from: 'full', to: 'lite', by: 'owner' })]);
  });
});

describe('cloud.collect auto is a confirmed weakening (owner decision 2026-11-12)', () => {
  const weakened = () => logRows().filter((x) => x.event === 'setting-weakened');
  const collect = () => JSON.parse(fs.readFileSync(configFile(), 'utf8')).cloud?.collect;

  it('cloud set collect auto without the owner flags prints the warning and exits 1; nothing is written', async () => {
    const before = fs.readFileSync(configFile(), 'utf8');
    for (const args of [['cloud', 'set', 'collect', 'auto'], ['settings', 'set', 'cloud.collect', 'auto']]) {
      const r = await ravenseat(args);
      expect(r.code, args.join(' ')).toBe(1);
      const text = r.out + r.err;
      expect(text).toContain('STOP: this weakens a guard (cloud.collect auto).');
      expect(text).toContain('Protects against:');
    }
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(before);
    expect(weakened()).toEqual([]);
  });

  it('with the owner flags it is written and logged; off and ask need no flag', async () => {
    const r = await ravenseat(['cloud', 'set', 'collect', 'auto', '--i-understand', '--by', 'owner']);
    expect(r.code, r.err).toBe(0);
    expect(collect()).toBe('auto');
    expect(weakened()).toEqual([expect.objectContaining({ key: 'cloud.collect', from: 'ask', to: 'auto', by: 'owner' })]);
    expect((await ravenseat(['cloud', 'set', 'collect', 'off'])).code).toBe(0);
    expect((await ravenseat(['cloud', 'set', 'collect', 'ask'])).code).toBe(0);
    expect(collect()).toBe('ask');
    expect(weakened()).toHaveLength(1);
  });

  it('is refused from a track worktree, also with the owner flags', async () => {
    const r = await ravenseat(['cloud', 'set', 'collect', 'auto', '--i-understand', '--by', 'owner'], trackTree());
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/track worktree/);
    expect(collect()).toBeUndefined();
  });
});

describe('owner decision 2026-11-12: guidance quiet is no weakening', () => {
  it('guidance quiet needs no flag and logs nothing', async () => {
    const r = await ravenseat(['guidance', 'quiet']);
    expect(r.code, r.err).toBe(0);
    expect(queue().guidance).toBe('quiet');
    expect(logRows().filter((x) => x.event === 'setting-weakened')).toEqual([]);
  });
});

describe('one shared weakening rule, no copy', () => {
  // The older writers of a registry value call cli/settings.mjs guardWeakening; none has its own --i-understand check.
  const cli = (name: string) => fs.readFileSync(path.resolve(__dirname, '..', 'cli', name), 'utf8');
  it.each([
    ['owner.mjs', 'proposals.autoAccept.enabled'],
    ['cost.mjs', 'limits.'],
    ['cloud.mjs', 'cloud.'],
  ])('%s uses guardWeakening and logWeakened from settings.mjs for %s', (file, key) => {
    const src = cli(file);
    expect(src).toMatch(/import \{ guardWeakening, logWeakened \} from '\.\/settings\.mjs';/);
    expect(src).toContain('guardWeakening(');
    expect(src).toContain(key);
    expect(src).not.toContain("'--i-understand'");
  });
  it('settings.mjs itself checks the flags in one place', () => {
    expect(cli('settings.mjs').match(/'--i-understand'/g)).toHaveLength(1);
  });
});

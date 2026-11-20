// =============================================================
// catalogFlow.test.ts: `ravenseat catalog init|show|check|accept` through the real CLI, in a temporary project
// (lib/catalog.js, cli/catalog.mjs, bolk B3 of the scope drift plan).
//
// Locks: (1) init writes stack.md with the generated block from the manifests, reuse.md and decisions/README.md, never
// over a file that is there, and refreshes only the block; (2) show lists the parts and one choice in full, with the
// plan entries that link to it; (3) check exits 1 on an error, 0 on warnings only, and a project without a catalog is
// fine; (4) the owner lock: accept needs --by owner, is refused from a track worktree whatever --by says, records the
// owner's accept in the data folder, and a status set to accepted by hand is unconfirmed until the owner accepts it;
// the push guard lets a queue agent read the catalog and nothing else, and the write guard keeps it off the record;
// (5) the Checks tab offers the catalog card for a known stack until the folder exists; (6) doctor names a catalog
// error as WARN while catalog.doctor is on, and not when it is off; (7) plan new warns about a link to a choice the
// catalog does not have while catalog.planLinks is on.
// Runs queue.mjs against a temporary repo and queue folder. Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const CAT = 'docs/queue/catalog';

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

const DECISION = [
  '---',
  'id: D-0001',
  'title: Dates through one library',
  'status: proposed',
  'paths: ["lib/**"]',
  'invariant: Code under lib/ handles dates with dayjs only.',
  'plan: PL-DATES',
  '---',
  'Why: one library for one job.',
  '',
].join('\n');

function project(config: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-catalog-flow-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt-A');
  fs.mkdirSync(repo);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const configFile = path.join(folder, 'queue.config.json');
  const setConfig = (c: Record<string, unknown>) =>
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite', ...c }));
  setConfig(config);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: folder,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    RAVENSEAT_CLAUDE_DIR: path.join(folder, 'claude'),
    RAVENSEAT_MANAGED_CLAUDE_MD: '',
    RAVENSEAT_INSTRUCTIONS_TOP: repo,
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const write = (f: string, text: string, root = repo) => {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  };
  const g = (args: string[], cwd = repo) => execFileSync('git', ['-C', cwd, ...ID, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  write('package.json', JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: { dayjs: '1.11.0' } }));
  write('lib/a.js', 'function norm(p) { return p; }\nmodule.exports = { norm };\n');
  g(['init', '-q', '-b', 'main']);
  g(['add', '--', 'package.json', 'lib/a.js']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ limits: {}, resolved: [], projects: { p: { title: 'P' } }, tasks: [] }),
  );
  const run = (args: string[], cwd = repo) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const read = (f: string) => fs.readFileSync(path.join(repo, f), 'utf8');
  const ledger = path.join(folder, 'catalog-accepted.json');
  return { folder, repo, worktree, run, write, read, ledger, setConfig };
}

describe('ravenseat catalog init, show and check', () => {
  it('init writes the three parts with the generated block, never over a file, and refreshes only the block', () => {
    const p = project();
    const r = p.run(['catalog', 'init']);
    expect(r.code, r.all).toBe(0);
    const stack = p.read(`${CAT}/stack.md`);
    expect(stack).toMatch(/ravenseat:generated begin/);
    expect(stack).toMatch(/Node/);
    expect(stack).toMatch(/dates and times: dayjs/);
    expect(stack).toMatch(/test: `npm test`/);
    expect(stack).toMatch(/## Prefer/);
    expect(p.read(`${CAT}/reuse.md`)).toMatch(/\| Purpose \| Symbol \| File \|/);
    expect(p.read(`${CAT}/decisions/README.md`)).toMatch(/D-0001-<slug>\.md/);
    expect(stack).not.toMatch(/\r/);
    // The owner's own lines stay; only the block follows the manifests.
    p.write(`${CAT}/stack.md`, `${stack}- dates: use dayjs, not moment\n`);
    p.write(`${CAT}/reuse.md`, 'my own reuse file\n');
    p.write('pyproject.toml', '[project]\nname = "x"\n');
    const again = p.run(['catalog', 'init']);
    expect(again.code, again.all).toBe(0);
    expect(p.read(`${CAT}/reuse.md`)).toBe('my own reuse file\n');
    expect(p.read(`${CAT}/stack.md`)).toMatch(/Python/);
    expect(p.read(`${CAT}/stack.md`)).toMatch(/- dates: use dayjs, not moment/);
    expect(again.out).toMatch(/kept reuse\.md/);
  });

  it('check is fine without a catalog, exits 1 on an error and 0 on warnings only', () => {
    const p = project();
    const none = p.run(['catalog', 'check']);
    expect(none.code).toBe(0);
    expect(none.out).toMatch(/no catalog/i);
    p.run(['catalog', 'init']);
    p.write(`${CAT}/decisions/D-0001-dates.md`, DECISION.replace('status: proposed', 'status: maybe'));
    const bad = p.run(['catalog', 'check']);
    expect(bad.code).toBe(1);
    expect(bad.all).toMatch(/status must be one of/);
    p.write(`${CAT}/decisions/D-0001-dates.md`, DECISION.replace('["lib/**"]', '["nowhere/**"]'));
    const warnOnly = p.run(['catalog', 'check']);
    expect(warnOnly.code, warnOnly.all).toBe(0);
    expect(warnOnly.all).toMatch(/match no tracked file/);
    expect(JSON.parse(p.run(['catalog', 'check', '--json']).out)).toMatchObject({ ok: true, exists: true });
  });

  it('show lists the parts and one choice in full, with the plan entries that link to it', () => {
    const p = project();
    p.run(['catalog', 'init']);
    p.write(`${CAT}/decisions/D-0001-dates.md`, DECISION);
    fs.writeFileSync(
      path.join(p.folder, 'plans.json'),
      JSON.stringify({ entries: [{ id: 'PL-DATES', title: 'Dates', project: 'p', priority: 'later', priority_set_by: 'owner', maturity: 'idea', decisions: ['D-0001'] }] }),
    );
    const list = p.run(['catalog', 'show']);
    expect(list.code, list.all).toBe(0);
    expect(list.out).toMatch(/D-0001\s+proposed\s+Dates through one library/);
    const one = p.run(['catalog', 'show', 'D-0001']);
    expect(one.out).toMatch(/invariant: Code under lib\/ handles dates with dayjs only\./);
    expect(one.out).toMatch(/linked from plan entries: PL-DATES/);
    expect(p.run(['catalog', 'show', 'D-0099']).code).toBe(1);
  });
});

describe('the owner lock on accepted', () => {
  it('accept needs --by owner, is refused from a track worktree, and records the owner accept', () => {
    const p = project();
    p.run(['catalog', 'init']);
    p.write(`${CAT}/decisions/D-0001-dates.md`, DECISION);
    for (const args of [['accept', 'D-0001'], ['accept', 'D-0001', '--by', 'agent'], ['accept', 'D-0001', '--by']]) {
      const r = p.run(['catalog', ...args]);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toMatch(/--by owner/);
    }
    // From the track's own worktree, with the same file there: refused whatever --by says.
    p.write(`${CAT}/decisions/D-0001-dates.md`, DECISION, p.worktree);
    const inTrack = p.run(['catalog', 'accept', 'D-0001', '--by', 'owner'], p.worktree);
    expect(inTrack.code).toBe(1);
    expect(inTrack.err).toMatch(/track worktree/);
    expect(fs.readFileSync(path.join(p.worktree, CAT, 'decisions', 'D-0001-dates.md'), 'utf8')).toBe(DECISION);
    expect(fs.existsSync(p.ledger)).toBe(false);
    expect(p.read(`${CAT}/decisions/D-0001-dates.md`)).toBe(DECISION);

    const ok = p.run(['catalog', 'accept', 'D-0001', '--by', 'owner']);
    expect(ok.code, ok.all).toBe(0);
    expect(p.read(`${CAT}/decisions/D-0001-dates.md`)).toMatch(/status: accepted\naccepted_by: owner\naccepted: \d{4}-\d{2}-\d{2}\n/);
    expect(JSON.parse(fs.readFileSync(p.ledger, 'utf8')).decisions['D-0001']).toMatchObject({ by: 'owner' });
    expect(p.run(['catalog', 'check']).code).toBe(0);
    expect(p.run(['catalog', 'show']).out).toMatch(/D-0001\s+accepted/);
  });

  it('a status set to accepted by hand, or an invariant changed after the accept, is unconfirmed until the owner accepts it', () => {
    const p = project();
    p.run(['catalog', 'init']);
    p.write(`${CAT}/decisions/D-0001-dates.md`, DECISION.replace('status: proposed', 'status: accepted'));
    const forged = p.run(['catalog', 'check']);
    expect(forged.code).toBe(1);
    expect(forged.all).toMatch(/D-0001 says accepted, but the owner did not accept this version/);
    expect(p.run(['catalog', 'show']).out).toMatch(/D-0001\s+unconfirmed/);
    expect(p.run(['catalog', 'accept', 'D-0001', '--by', 'owner']).code).toBe(0);
    expect(p.run(['catalog', 'check']).code).toBe(0);
    const text = p.read(`${CAT}/decisions/D-0001-dates.md`);
    p.write(`${CAT}/decisions/D-0001-dates.md`, text.replace('dayjs only', 'dayjs or moment'));
    expect(p.run(['catalog', 'check']).code).toBe(1);
  });

  it('the push guard lets a queue agent read the catalog, never accept; the write guard keeps it off the record', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const PG = require('../lib/pushGuard.js');
    const WG = require('../lib/writeGuard.js');
    const GE = require('../lib/gateEvidence.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const ctx = { agentType: 'track', branch: 'queue/A', environment: null };
    for (const command of ['ravenseat catalog show', 'ravenseat catalog check', 'ravenseat catalog show D-0001'])
      expect(PG.assess(command, ctx)?.decision ?? 'allow', command).not.toBe('deny');
    for (const command of ['ravenseat catalog accept D-0001 --by owner', 'ravenseat catalog init', 'ravenseat catalog accept D-0001'])
      expect(PG.assess(command, ctx)?.decision, command).toBe('deny');
    expect(WG.assessWrite({ agentType: 'track', filePath: path.join('C:\\data', 'catalog-accepted.json'), folder: 'C:\\data', guardedTypes: [] })).not.toBeNull();
    expect(GE.tamperReason('rm .queue/catalog-accepted.json')).toBeTruthy();
  });
});

// Roadmap 0z Z-B: `catalog propose` writes the next free id as proposed and runs check, from the main tree only.
describe('ravenseat catalog propose', () => {
  it('writes the next free id as proposed, runs check, and is refused from a track worktree', () => {
    const p = project();
    p.run(['catalog', 'init']);
    p.write(`${CAT}/decisions/D-0001-dates.md`, DECISION);
    const args = ['catalog', 'propose', '--title', 'Paths with forward slashes', '--invariant', 'Code under lib/ joins paths with path.posix.', '--paths', 'lib/**'];
    const inTrack = p.run(args, p.worktree);
    expect(inTrack.code).toBe(1);
    expect(inTrack.err).toMatch(/track worktree/);
    expect(fs.existsSync(path.join(p.worktree, CAT, 'decisions', 'D-0002-paths-with-forward-slashes.md'))).toBe(false);

    const r = p.run([...args, '--plan', 'PL-DATES', '--why', 'One join for every platform.']);
    expect(r.code, r.all).toBe(0);
    const file = `${CAT}/decisions/D-0002-paths-with-forward-slashes.md`;
    const text = p.read(file);
    expect(text).toMatch(/^---\nid: D-0002\n/);
    expect(text).toMatch(/\nstatus: proposed\n/);
    expect(text).toMatch(/\npaths: \["lib\/\*\*"\]\n/);
    expect(text).toMatch(/One join for every platform\./);
    expect(r.out).toMatch(/Proposed D-0002/);
    expect(r.out).toMatch(/catalog check: 0 error\(s\)/);
    expect(r.out).toMatch(/catalog accept D-0002 --by owner/);
    expect(p.run(['catalog', 'show']).out).toMatch(/D-0002\s+proposed\s+Paths with forward slashes/);

    // A bad proposal writes nothing; the push guard denies it to a queue agent.
    const bad = p.run(['catalog', 'propose', '--title', 'X', '--invariant', 'Y.', '--paths', '../up']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/Nothing was written/);
    expect(fs.readdirSync(path.join(p.repo, CAT, 'decisions')).filter((n) => n.startsWith('D-0003'))).toEqual([]);
    expect(p.run(['catalog', 'propose', '--title', 'X']).code).toBe(1);
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const PG = require('../lib/pushGuard.js');
    expect(PG.assess('ravenseat catalog propose --title X --invariant Y --paths a', { agentType: 'track', branch: 'queue/A', environment: null })?.decision).toBe('deny');
  });

  const withQuestion = (p: ReturnType<typeof project>) =>
    fs.writeFileSync(
      path.join(p.folder, 'queue.json'),
      JSON.stringify({
        limits: {},
        resolved: [],
        projects: { p: { title: 'P' } },
        question: { 'Q-1': { type: 'question', text: 'Which date library?' }, 'Q-2': { type: 'question', text: 'Which vendor this time?' } },
        tasks: [{ id: 'A-1', title: 'Dates', status: 'waiting', waiting_on: ['Q-1'], owned_files: ['lib/'], plan: 'PL-DATES', project: 'p' }],
      }),
    );
  const queueFile = (p: ReturnType<typeof project>) => JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8'));

  it('Z-A: resolve --keep stores the answer and writes a proposed draft; never accepted', () => {
    const p = project();
    withQuestion(p);
    const r = p.run(['resolve', 'Q-1', '--answer', 'Always dayjs, never moment.', '--keep', '--by', 'owner']);
    expect(r.code, r.all).toBe(0);
    expect(queueFile(p).resolutions['Q-1']).toMatchObject({ answer: 'Always dayjs, never moment.' });
    expect(r.out).toMatch(/KEEP: proposed D-0001 from the answer to Q-1/);
    const text = p.read(`${CAT}/decisions/D-0001-which-date-library.md`);
    expect(text).toMatch(/\nstatus: proposed\n/);
    expect(text).toMatch(/\npaths: \["lib\/\*\*"\]\n/);
    expect(text).toMatch(/\ninvariant: Always dayjs, never moment\.\n/);
    expect(text).toMatch(/\nplan: PL-DATES\n/);
    expect(fs.existsSync(p.ledger)).toBe(false);
    expect(p.run(['catalog', 'show']).out).toMatch(/D-0001\s+proposed/);
    // Without --keep, explicit says nothing; a resolve without an answer has nothing to keep.
    const plain = p.run(['resolve', 'Q-2', '--answer', 'Vendor B', '--by', 'owner']);
    expect(plain.out).not.toMatch(/KEEP/);
  });

  it('Z-A: captureAnswers off refuses resolve --keep and propose before anything changes; suggest prints the line', () => {
    const p = project({ catalog: { captureAnswers: 'off' } });
    withQuestion(p);
    const off = p.run(['resolve', 'Q-1', '--answer', 'Always dayjs.', '--keep']);
    expect(off.code).toBe(1);
    expect(off.err).toMatch(/catalog\.captureAnswers is off/);
    expect(queueFile(p).resolutions ?? {}).toEqual({});
    expect(p.run(['catalog', 'propose', '--title', 'X', '--invariant', 'Y.', '--paths', 'lib/**']).err).toMatch(/captureAnswers is off/);
    expect(p.run(['resolve', 'Q-1', '--answer', 'Always dayjs.', '--keep'], p.worktree).code).toBe(1);

    p.setConfig({ catalog: { captureAnswers: 'suggest' } });
    const hint = p.run(['resolve', 'Q-1', '--answer', 'Always dayjs, never moment.']);
    expect(hint.code, hint.all).toBe(0);
    expect(hint.out).toMatch(/KEEP\?: the answer to Q-1 reads like a lasting rule\. .*catalog propose --from-answer Q-1/);
    expect(p.run(['resolve', 'Q-2', '--answer', 'Vendor B']).out).not.toMatch(/KEEP/);
    const kept = p.run(['catalog', 'propose', '--from-answer', 'Q-1', '--paths', 'lib/dates/**']);
    expect(kept.code, kept.all).toBe(0);
    expect(p.read(`${CAT}/decisions/D-0001-which-date-library.md`)).toMatch(/\npaths: \["lib\/dates\/\*\*"\]\n/);
    expect(p.run(['catalog', 'propose', '--from-answer', 'Q-9']).err).toMatch(/no stored answer/);
  });

  it('Z-C: propose --supersedes takes the old paths and plan, and its accept marks the old one superseded', () => {
    const p = project();
    p.run(['catalog', 'init']);
    p.write(`${CAT}/decisions/D-0001-dates.md`, DECISION);
    expect(p.run(['catalog', 'accept', 'D-0001', '--by', 'owner']).code).toBe(0);
    const nowhere = p.run(['catalog', 'propose', '--title', 'X', '--invariant', 'Y.', '--supersedes', 'D-0042']);
    expect(nowhere.code).toBe(1);
    expect(nowhere.err).toMatch(/D-0042 is not in/);
    const r = p.run(['catalog', 'propose', '--title', 'Dates with the platform', '--invariant', 'Code under lib/ handles dates with Temporal.', '--supersedes', 'D-0001']);
    expect(r.code, r.all).toBe(0);
    const text = p.read(`${CAT}/decisions/D-0002-dates-with-the-platform.md`);
    expect(text).toMatch(/\npaths: \["lib\/\*\*"\]\n/);
    expect(text).toMatch(/\nsupersedes: D-0001\nplan: PL-DATES\n/);
    // Until the accept, the old one holds; the accept of the new one sets it to superseded in the same step.
    expect(p.run(['catalog', 'show']).out).toMatch(/D-0001\s+accepted/);
    const ok = p.run(['catalog', 'accept', 'D-0002', '--by', 'owner']);
    expect(ok.code, ok.all).toBe(0);
    expect(ok.out).toMatch(/D-0001 is now superseded/);
    expect(p.read(`${CAT}/decisions/D-0001-dates.md`)).toMatch(/\nstatus: superseded\n/);
    const check = p.run(['catalog', 'check']);
    expect(check.code, check.all).toBe(0);
    expect(check.all).not.toMatch(/is not marked status: superseded/);
    expect(p.run(['catalog', 'show']).out).toMatch(/D-0001\s+superseded/);
  });

  it('works before catalog init: it makes the decisions folder', () => {
    const p = project();
    const r = p.run(['catalog', 'propose', '--title', 'One', '--invariant', 'Code under lib/ stays small.', '--paths', 'lib/**', '--json']);
    expect(r.code, r.all).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, id: 'D-0001', file: `${CAT}/decisions/D-0001-one.md`, errors: [] });
    expect(fs.existsSync(path.join(p.repo, CAT, 'decisions', 'README.md'))).toBe(true);
  });
});

// Bolk B5: the generated index (lib/catalogIndex.js) and `catalog find`.
describe('ravenseat catalog index and find', () => {
  const TAGGED = [
    '/**',
    ' * Turn text into a dayjs date.',
    ' * @shared parse a date from user input',
    ' */',
    'function parseDate(s) { return s; }',
    'function norm(p) { return p; }',
    'module.exports = { parseDate, norm };',
    '',
  ].join('\n');

  it('index builds the cache once and reads only changed files after that', () => {
    const p = project();
    p.write('lib/dates.js', TAGGED);
    const first = p.run(['catalog', 'index']);
    expect(first.code, first.all).toBe(0);
    expect(first.out).toMatch(/2 files, 2 read, 0 from the cache; 1 tagged @shared/);
    expect(fs.existsSync(path.join(p.folder, 'catalog-index.json'))).toBe(true);
    const again = p.run(['catalog', 'index', '--json']);
    expect(JSON.parse(again.out).stats).toMatchObject({ files: 2, scanned: 0, reused: 2 });
    p.write('lib/dates.js', `${TAGGED}// changed\n`);
    expect(JSON.parse(p.run(['catalog', 'index', '--json']).out).stats).toMatchObject({ scanned: 1, reused: 1 });
  });

  it('a @shared tag on a name that is not exported is named by index', () => {
    const p = project();
    p.write('lib/x.js', '/** @shared hidden helper */\nfunction hidden() {}\nmodule.exports = {};\n');
    expect(p.run(['catalog', 'index']).out).toMatch(/lib\/x\.js: @shared on hidden \(line 2\), but hidden is not exported/);
  });

  it('find searches the code index and the catalog, in short lines, and says when nothing matches', () => {
    const p = project();
    p.write('lib/dates.js', TAGGED);
    p.run(['catalog', 'init']);
    p.write(`${CAT}/decisions/D-0001-dates.md`, DECISION);
    const r = p.run(['catalog', 'find', 'date']);
    expect(r.code, r.all).toBe(0);
    const lines = r.out.trim().split('\n');
    expect(lines[1]).toMatch(/^ {2}shared +parseDate +lib\/dates\.js:5 +parse a date from user input$/);
    expect(r.out).toMatch(/D-0001/);
    expect(r.out).toMatch(/prefer|dates and times|dayjs/);
    expect(lines.length).toBeLessThanOrEqual(12);
    const none = p.run(['catalog', 'find', 'zzzqqq']);
    expect(none.code).toBe(0);
    expect(none.out).toMatch(/nothing matches zzzqqq/i);
    expect(p.run(['catalog', 'find']).code).not.toBe(0);
    const j = JSON.parse(p.run(['catalog', 'find', 'parse', '--json']).out);
    expect(j.rows[0]).toMatchObject({ kind: 'shared', name: 'parseDate', file: 'lib/dates.js' });
  });

  it('a queue agent may run find, never index; the cache is kept off its writes', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const PG = require('../lib/pushGuard.js');
    const WG = require('../lib/writeGuard.js');
    const GE = require('../lib/gateEvidence.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const ctx = { agentType: 'track', branch: 'queue/A', environment: null };
    expect(PG.assess('ravenseat catalog find date', ctx)?.decision ?? 'allow').not.toBe('deny');
    expect(PG.assess('ravenseat catalog index', ctx)?.decision).toBe('deny');
    expect(WG.assessWrite({ agentType: 'track', filePath: path.join('C:\\data', 'catalog-index.json'), folder: 'C:\\data', guardedTypes: [] })).not.toBeNull();
    expect(GE.tamperReason('rm .queue/catalog-index.json')).toBeTruthy();
  });
});

describe('the Checks card, doctor and plan links', () => {
  it('the Checks tab offers the catalog card for a known stack until the folder exists', () => {
    const p = project();
    const keys = () => JSON.parse(p.run(['checks', '--json']).out).suggestions.map((s: { key: string }) => s.key);
    expect(keys()).toContain('project-catalog');
    p.run(['catalog', 'init']);
    expect(keys()).not.toContain('project-catalog');
  });

  it('doctor names a catalog error as WARN while catalog.doctor is on, and not when it is off', () => {
    const p = project();
    p.run(['catalog', 'init']);
    p.write(`${CAT}/decisions/D-0001-dates.md`, DECISION.replace('status: proposed', 'status: accepted'));
    const rows = () => JSON.parse(p.run(['doctor', '--json', '--all']).out).checks.filter((c: { name: string }) => c.name === 'catalog');
    expect(rows()).toEqual([expect.objectContaining({ status: 'WARN', message: expect.stringMatching(/D-0001 says accepted/) })]);
    p.setConfig({ catalog: { doctor: false } });
    expect(rows()).toEqual([]);
  });

  it('plan new warns about a link to a choice the catalog does not have while catalog.planLinks is on', () => {
    const p = project();
    p.run(['catalog', 'init']);
    p.write(`${CAT}/decisions/D-0001-dates.md`, DECISION);
    const entry = (id: string, decisions: string[]) => {
      const f = path.join(p.folder, `${id}.json`);
      fs.writeFileSync(f, JSON.stringify({ id, title: id, project: 'p', priority: 'later', priority_reason: 'Later: no deadline.', maturity: 'idea', decisions }));
      return p.run(['plan', 'new', '--file', f]);
    };
    const known = entry('PL-ONE', ['D-0001']);
    expect(known.code, known.all).toBe(0);
    expect(known.all).not.toMatch(/is not in docs\/queue\/catalog/);
    const unknown = entry('PL-TWO', ['D-0042']);
    expect(unknown.code, unknown.all).toBe(0);
    expect(unknown.all).toMatch(/decision D-0042 is not in docs\/queue\/catalog/);
    p.setConfig({ catalog: { planLinks: false } });
    expect(entry('PL-THREE', ['D-0043']).all).not.toMatch(/is not in docs\/queue\/catalog/);
  });
});

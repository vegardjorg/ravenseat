// =============================================================
// checksFlow.test.ts: `ravenseat checks` through the real CLI, in a temporary project.
//
// Locks: (1) it reads and writes nothing before ravenseat init, and saves the report after; (2) the opt-out stops the overview and
// comes back; (3) plan gives an investigation task, proposed without --approved, once; (4) a suggestion set aside stays aside;
// (5) a project's own files in docs/queue/checks change the suggestions; (6) a file with a mistake is reported.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function project({ queue = true, config = {} as object, files = {} as Record<string, string> } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-checks-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const write = (f: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  };
  for (const [f, text] of Object.entries(files)) write(f, text);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite', ...config }));
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
    // The instruction size reads the user's Claude folder and the folders above the project: keep both inside the test.
    RAVENSEAT_CLAUDE_DIR: path.join(folder, 'claude'),
    RAVENSEAT_MANAGED_CLAUDE_MD: '',
    RAVENSEAT_INSTRUCTIONS_TOP: repo,
  } as NodeJS.ProcessEnv;
  const g = (args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { env, stdio: 'ignore' });
  g(['init', '-q', '-b', 'main']);
  g(['commit', '-q', '--allow-empty', '-m', 'start']);
  g(['remote', 'add', 'origin', 'https://github.com/x/y.git']);
  if (queue) fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ limits: {}, resolved: [], projects: {}, tasks: [] }));
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: repo });
    return { code: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}`, out: r.stdout ?? '' };
  };
  const json = () => JSON.parse(run('checks', '--json').out);
  const task = (id: string) => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks.find((o: { id: string }) => o.id === id);
  const keys = () => json().suggestions.map((s: { key: string }) => s.key);
  return { repo, folder, run, json, task, keys, write };
}

const OWN = 'docs/queue/checks';
const TEMPLATE = (head: string) => `---\n${head}\n---\n\n## Investigate\n\nFind out.\n\n## Plan and build\n\nDo it.\n`;
const NODE = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) };

describe('ravenseat checks: the overview', () => {
  it('works before ravenseat init and writes nothing', () => {
    const p = project({ queue: false, files: NODE });
    const before = fs.readdirSync(p.folder).sort();
    const r = p.run('checks');
    expect(r.code).toBe(0);
    expect(r.all).toContain('Tests: script');
    expect(r.all).toContain('did not run any of it');
    expect(fs.readdirSync(p.folder).sort()).toEqual(before);
  });
  it('saves the same picture as the --json answer, with a CI file and its jobs', () => {
    const p = project({ files: { ...NODE, '.github/workflows/ci.yml': 'on: push\njobs:\n  test:\n    steps:\n      - run: npm test\n' } });
    const seen = p.json();
    expect(seen.found.ci[0]).toMatchObject({ host: 'GitHub Actions', jobs: ['test'], triggers: ['push'] });
    const saved = JSON.parse(fs.readFileSync(path.join(p.folder, 'checks-report.json'), 'utf8'));
    expect(saved.suggestions).toEqual(seen.suggestions);
    expect(saved.version).toBe(1);
  });
  it('show gives the template; an unknown key says what to do', () => {
    const p = project();
    expect(p.run('checks', 'show', 'first-test').all).toContain('Plan and build');
    const bad = p.run('checks', 'show', 'nope');
    expect(bad.code).toBe(1);
    expect(bad.all).toContain('ravenseat checks lists');
  });
});

describe('ravenseat checks off and on', () => {
  it('stops the overview, and comes back; quiet guidance also stops it unless its own switch says on', () => {
    const p = project();
    expect(p.run('checks', 'off').all).toContain('Checks: off');
    expect(p.run('checks').all).toContain('is off');
    expect(p.json()).toEqual({ off: true });
    expect(p.run('checks', 'on').code).toBe(0);
    expect(p.json().suggestions.length).toBeGreaterThan(0);
    p.run('guidance', 'quiet');
    expect(p.json().suggestions.length).toBeGreaterThan(0); // its own "on" wins
  });
  it('before ravenseat init there is nothing to save the choice in, and it says so', () => {
    const r = project({ queue: false }).run('checks', 'off');
    expect(r.code).toBe(1);
    expect(r.all).toContain('ravenseat init');
  });
});

describe('ravenseat checks plan', () => {
  it('adds a proposed investigation, and not twice', () => {
    const p = project();
    const r = p.run('checks', 'plan', 'first-test');
    expect(r.code).toBe(0);
    expect(p.task('KS-PLAN-FIRST-TEST')).toMatchObject({ class: 'U', status: 'proposed' });
    expect(p.task('KS-PLAN-FIRST-TEST').mission).toContain('Do not build it');
    expect(p.run('checks', 'plan', 'first-test').all).toContain('already there');
    const s = p.json().suggestions.find((x: { key: string }) => x.key === 'first-test');
    expect(s).toMatchObject({ state: 'queued', taskId: 'KS-PLAN-FIRST-TEST' });
  });
  it('--approved is ready to run, also in full mode with its project', () => {
    const p = project({ config: { mode: 'full' } });
    expect(p.run('checks', 'plan', 'first-test', '--approved').code).toBe(0);
    expect(p.task('KS-PLAN-FIRST-TEST')).toMatchObject({ status: 'waiting', project: 'cicd' });
  });
  it('a suggestion with its own action needs no agent', () => {
    const p = project({ files: NODE });
    const r = p.run('checks', 'plan', 'use-gates');
    expect(r.code).toBe(1);
    expect(r.all).toContain('kickstart gates --apply');
  });

  it('an opt-in check that is off has a card; turn-on writes its setting, and the card goes (lib/optInChecks.js)', () => {
    const p = project();
    expect(p.keys()).toEqual(expect.arrayContaining(['allowlist-scan', 'gitignore-own-rules', 'secret-scan-receive']));
    expect(p.run('checks', 'plan', 'secret-scan-receive').all).toContain('checks turn-on secret-scan-receive');
    // Only a card with action setting turns anything on.
    expect(p.run('checks', 'turn-on', 'first-test').code).toBe(1);
    const r = p.run('checks', 'turn-on', 'secret-scan-receive');
    expect(r.code, r.all).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.config.json'), 'utf8'));
    expect(config.secretScan).toEqual({ atReceive: true });
    expect(config.baseBranch).toBe('main');
    expect(p.keys()).not.toContain('secret-scan-receive');
    expect(p.keys()).toContain('allowlist-scan');
  });
});

describe('ravenseat checks dismiss and restore', () => {
  it('sets aside, keeps it aside after a new scan, and brings it back', () => {
    const p = project();
    p.run('checks', 'dismiss', 'first-test');
    const state = () => p.json().suggestions.find((x: { key: string }) => x.key === 'first-test').state;
    expect(state()).toBe('dismissed');
    expect(p.run('checks').all).toContain('1 set aside');
    p.run('checks', 'restore', 'first-test');
    expect(state()).toBe('open');
  });

  it('a card set aside that no longer applies is still listed and can be brought back, but not planned', () => {
    const p = project();
    p.run('checks', 'dismiss', 'first-test');
    // A test appears: the card's condition no longer holds, and it stays in the report as set aside.
    p.write('package.json', NODE['package.json']);
    const card = () => p.json().suggestions.find((x: { key: string }) => x.key === 'first-test');
    expect(card()).toMatchObject({ state: 'dismissed', applies: false });
    expect(p.json().important).toBe(p.json().suggestions.filter((s: { applies: boolean; state: string; priority: string }) => s.applies && s.state === 'open' && s.priority === 'high').length);
    const plan = p.run('checks', 'plan', 'first-test');
    expect(plan.code).not.toBe(0);
    expect(plan.all).toMatch(/does not apply to this project now/);
    const back = p.run('checks', 'restore', 'first-test');
    expect(back.code).toBe(0);
    expect(back.all).toMatch(/no longer set aside/);
    // Restored and not applying: gone from the report, as any card that does not apply.
    expect(card()).toBeUndefined();
  });

  it('a no to a setup tip runs the tip\'s own "No:" command, which sets the card aside for good (also the tips of the earlier checks)', () => {
    const p = project();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const OI = require('../lib/optInChecks.js');
    for (const key of ['allowlist-scan', 'gitignore-own-rules', 'secret-scan-receive']) {
      const tip = OI.tipLine(OI.bySuggestion(key));
      const no = /No: ravenseat (.+)$/.exec(tip)?.[1].split(' ') ?? [];
      expect(no, tip).toEqual(['checks', 'dismiss', key]);
      expect(p.run(...no).code).toBe(0);
    }
    const s = p.json().suggestions.filter((x: { key: string }) => ['allowlist-scan', 'gitignore-own-rules', 'secret-scan-receive'].includes(x.key));
    expect(s.map((x: { state: string }) => x.state)).toEqual(['dismissed', 'dismissed', 'dismissed']);
  });

  it('share-backup: a card only in a repo known to be private; Turn on is the owner\'s click and writes share and the .gitignore', () => {
    const p = project();
    expect(p.keys()).not.toContain('share-backup');
    fs.writeFileSync(path.join(p.folder, 'repo-visibility.json'), JSON.stringify({ visibility: 'private', remote: 'https://github.com/x/y.git', checkedAt: new Date().toISOString() }));
    expect(p.keys()).toContain('share-backup');
    expect(p.json().suggestions.find((x: { key: string }) => x.key === 'share-backup').priority).not.toBe('high');
    const r = p.run('checks', 'turn-on', 'share-backup');
    expect(r.code, r.all).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.config.json'), 'utf8'));
    expect(config.share).toMatchObject({ queueData: true, include: ['queue.json', 'plans.json'] });
    expect(fs.readFileSync(path.join(p.repo, '.gitignore'), 'utf8')).toContain('!scripts/.queue/queue.json');
    expect(p.keys()).not.toContain('share-backup');
  });
});

describe('the project changes the suggestions in docs/queue/checks', () => {
  it('adds, replaces and removes a suggestion', () => {
    const p = project({
      files: {
        [`${OWN}/suggestions/backups.md`]: TEMPLATE('title: Check the backups\ncategory: ops\npriority: high\nwhy: W'),
        [`${OWN}/suggestions/first-test.md`]: TEMPLATE('title: My own first test\ncategory: tests\npriority: low\nwhy: W'),
        [`${OWN}/suggestions/ci-on-push.md`]: '---\noff: true\n---\n',
        [`${OWN}/categories.json`]: JSON.stringify([{ key: 'ops', title: 'Operations' }]),
      },
    });
    const r = p.json();
    const keys = r.suggestions.map((s: { key: string }) => s.key);
    expect(keys).toContain('backups');
    expect(keys).not.toContain('ci-on-push');
    expect(r.suggestions.find((s: { key: string }) => s.key === 'first-test').title).toBe('My own first test');
    expect(r.categories.map((c: { title: string }) => c.title)).toContain('Operations');
    // A project's own suggestion goes to the queue like any other.
    expect(p.run('checks', 'plan', 'backups').code).toBe(0);
    expect(p.task('KS-PLAN-BACKUPS').mission).toContain('Find out.');
  });
  it('removes a whole category', () => {
    const p = project({ files: { [`${OWN}/categories.json`]: JSON.stringify([{ key: 'security', off: true }, { key: 'dependencies', off: true }]) } });
    const r = p.json();
    expect(r.suggestions.filter((s: { category: string }) => ['security', 'dependencies'].includes(s.category))).toEqual([]);
  });
  it('a file with a mistake is left out and named, and the rest still shows', () => {
    const p = project({ files: { [`${OWN}/suggestions/broken.md`]: 'no header', [`${OWN}/categories.json`]: '{not json' } });
    const r = p.run('checks');
    expect(r.code).toBe(0);
    expect(r.all).toContain('Catalog problem: broken: no header');
    expect(r.all).toContain('categories.json');
    expect(r.all).toContain('first-test');
  });
});

describe('ravenseat checks: the instruction size suggestion', () => {
  const long = Array.from({ length: 201 }, (_, i) => `- rule ${i}`).join('\n') + '\n';
  it('a CLAUDE.md over the limit gets slim-instructions; a short one does not', () => {
    expect(project({ files: { 'CLAUDE.md': long } }).keys()).toContain('slim-instructions');
    expect(project({ files: { 'CLAUDE.md': 'Short.\n' } }).keys()).not.toContain('slim-instructions');
  });
  it('the suggestion is not shown in quiet, nor with instructionSize.mode off', () => {
    const p = project({ files: { 'CLAUDE.md': long } });
    p.run('guidance', 'quiet');
    expect(p.json()).toEqual({ off: true });
    expect(project({ config: { instructionSize: { mode: 'off' } }, files: { 'CLAUDE.md': long } }).keys()).not.toContain('slim-instructions');
  });
  it('show gives the text for Claude, and plan refuses: a queue agent may not change CLAUDE.md', () => {
    const p = project({ files: { 'CLAUDE.md': long } });
    expect(p.run('checks', 'show', 'slim-instructions').all).toContain('Ask Claude in your session');
    const r = p.run('checks', 'plan', 'slim-instructions');
    expect(r.code).toBe(1);
    expect(r.all).toContain('a queue agent cannot do it');
  });
});

describe('ravenseat checks: stack packs for the review signals', () => {
  const NEXT = { 'package.json': JSON.stringify({ dependencies: { next: '16', fastify: '5' } }) };
  const config = (p: { folder: string }) => JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.config.json'), 'utf8'));
  const find = (p: { json: () => any }, key: string) => p.json().suggestions.find((s: { key: string }) => s.key === key);

  it('finds the stack from the manifests and suggests the packs, without an agent', () => {
    const p = project({ files: NEXT });
    const s = find(p, 'stack-review-signals');
    expect(s).toMatchObject({ action: 'packs', priority: 'high', state: 'open' });
    expect(s.detail).toMatch(/Next\.js/);
    expect(p.json().packs).toMatchObject({ detected: ['nextjs'], missing: ['core', 'nextjs'], unpacked: ['fastify'] });
    expect(find(p, 'stack-pack-research').detail).toMatch(/fastify/);
    const plan = p.run('checks', 'plan', 'stack-review-signals');
    expect(plan.code).toBe(1);
    expect(plan.all).toContain('checks packs --apply');
  });

  it('checks packs shows what they add and writes nothing; --apply writes review.packs and the suggestion goes', () => {
    const p = project({ files: NEXT });
    const show = p.run('checks', 'packs');
    expect(show.code).toBe(0);
    expect(show.all).toContain('nextjs');
    expect(show.all).toContain('Nothing written');
    expect(config(p).review).toBeUndefined();
    const r = p.run('checks', 'packs', '--apply');
    expect(r.code).toBe(0);
    expect(config(p).review.packs).toEqual(['core', 'nextjs']);
    expect(config(p).baseBranch).toBe('main');
    expect(find(p, 'stack-review-signals')).toBeUndefined();
    expect(p.run('checks', 'packs', '--apply').all).toContain('already on');
  });

  it('a project pack in docs/queue/review-packs is offered and its signals are written to review.signals', () => {
    const WORD = String.raw`\breply\.setCookie\s*\(`;
    const own = {
      id: 'fastify',
      title: 'Fastify',
      detect: { npm: ['fastify'] },
      signals: { auth: { words: [WORD] } },
      examples: {
        hit: [
          { file: 'src/a.ts', line: "reply.setCookie('sid', v)", signal: 'auth' },
          { file: 'src/b.ts', line: 'reply.setCookie (name, v)', signal: 'auth' },
        ],
        miss: [
          { file: 'src/a.ts', line: 'reply.send(x)' },
          { file: 'src/b.ts', line: 'const setCookieName = 1' },
        ],
      },
    };
    const p = project({ files: { ...NEXT, 'docs/queue/review-packs/fastify.json': JSON.stringify(own) } });
    expect(p.json().catalogErrors).toEqual([]);
    expect(p.json().packs.missing).toContain('fastify');
    expect(find(p, 'stack-pack-research')).toBeUndefined();
    expect(p.run('checks', 'packs', '--apply').code).toBe(0);
    expect(config(p).review.packs).toContain('fastify');
    expect(config(p).review.signals.auth.words).toContain(WORD);
  });

  it('the red marker can be switched off and on, and the report says how many important ones are open', () => {
    const p = project({ files: NEXT });
    expect(p.json().important).toBeGreaterThan(0);
    expect(p.json().marker).toBe(true);
    expect(p.run('checks', 'marker', 'off').all).toContain('marker: off');
    expect(p.json().marker).toBe(false);
    expect(p.run('checks', 'marker', 'on').code).toBe(0);
    expect(p.json().marker).toBe(true);
  });
});

describe('ravenseat checks: the client format canary (0w W4)', () => {
  const SECRET = 'PRIVATE-CONTENT-do-not-leak';
  /** A main session transcript in the test's transcripts folder (QUEUE_TRANSCRIPTS). */
  const transcript = (p: { folder: string }, rows: object[]) => {
    const dir = path.join(p.folder, 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's1.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  };
  const turn = { type: 'assistant', version: '2.1.400', message: { id: 'm1', model: 'x', content: [], usage: { input_tokens: 1 } } };
  const busy = { type: 'system', subtype: 'api_error', version: '2.1.400', error: { status: 500, message: SECRET } };
  const card = (p: { json: () => { suggestions: { key: string }[] } }) => p.json().suggestions.find((s) => s.key === 'client-format');

  it('a new row type gives one medium card naming the version and the type, never content; no shape log by default', () => {
    const p = project({ files: NODE });
    transcript(p, [turn, { type: 'brand-new-row', version: '2.1.400', text: SECRET }, busy]);
    const r = p.run('checks', '--json');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(SECRET);
    const c = card(p) as unknown as { priority: string; detail: string };
    expect(c.priority).toBe('medium');
    expect(c.detail).toContain('Claude Code 2.1.400');
    expect(c.detail).toContain('brand-new-row (1)');
    expect(fs.existsSync(path.join(p.folder, 'client-shapes.jsonl'))).toBe(false);
  });

  it('no card while the rows read as expected, and none with client.canary off', () => {
    const p = project({ files: NODE });
    transcript(p, [turn]);
    expect(card(p)).toBeUndefined();
    const off = project({ files: NODE, config: { client: { canary: false } } });
    transcript(off, [turn, { type: 'brand-new-row', version: '2.1.400' }]);
    expect(card(off)).toBeUndefined();
  });

  it('client.shapeLog on writes the API error form without values', () => {
    const p = project({ files: NODE, config: { client: { shapeLog: true } } });
    transcript(p, [turn, busy]);
    p.run('checks', '--json');
    const text = fs.readFileSync(path.join(p.folder, 'client-shapes.jsonl'), 'utf8');
    expect(JSON.parse(text.trim()).shape.error).toEqual({ message: 'string', status: 'number' });
    expect(text).not.toContain(SECRET);
  });
});

// =============================================================
// decisionSignals.test.ts: the decision signals receive reads from a track's diff (lib/decisionSignals.js).
//
// Locks: (1) a new npm package is named precisely, from the diff alone and from both sides of the file, and a version
// bump or a script is no new package; (2) other manifests say the file changed, or name the package when both sides can
// be read; (3) migrations and schema files are spotted, deleted ones are not; (4) deleted non-test files count only at
// the threshold; (5) a big change without Assumptions and owner question text with ownerQuestions=0 are unstated;
// (6) a signal without a matching owner question is "not asked"; (7) the stored record and the time log row are
// truncated and hold no diff text; (8) receive prints one SIGNALS line, stores the record, writes one time log row per
// tip and never stops, and the switch turns it off. The receive block runs queue.mjs against a temporary queue and git
// repo (as testWeakening.test.ts), never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const DS = require('../decisionSignals') as any;

/** A small git diff: one file per entry, `lines` with their +/-/space prefix. */
function diffOf(files: { path: string; lines: string[]; status?: 'new' | 'deleted' }[]) {
  return files
    .flatMap((f) => [
      `diff --git a/${f.path} b/${f.path}`,
      ...(f.status === 'new' ? ['new file mode 100644', 'index 0000000..1111111'] : []),
      ...(f.status === 'deleted' ? ['deleted file mode 100644', 'index 1111111..0000000'] : []),
      ...(f.status === 'new' ? ['--- /dev/null'] : [`--- a/${f.path}`]),
      ...(f.status === 'deleted' ? ['+++ /dev/null'] : [`+++ b/${f.path}`]),
      '@@ -1,3 +1,4 @@',
      ...f.lines,
    ])
    .join('\n');
}

const pkgDiff = diffOf([
  {
    path: 'package.json',
    lines: [
      '   "scripts": {',
      '-    "build": "tsc"',
      '+    "build": "tsc -p ."',
      '+    "lint": "eslint ."',
      '   },',
      '   "dependencies": {',
      '-    "react": "^18.2.0",',
      '+    "react": "^18.3.1",',
      '+    "date-fns": "^3.6.0",',
      '     "zod": "^3.0.0"',
      '   },',
      '   "devDependencies": {',
      '+    "vitest": "3.2.4"',
      '   }',
    ],
  },
]);

const kinds = (r: any) => r.signals.map((s: any) => s.category);

describe('new package', () => {
  it('npm from the diff alone: added names in a dependency section, not a bump, not a script', () => {
    const r = DS.detect({ diff: pkgDiff });
    const dep = r.signals.find((s: any) => s.category === 'dependency');
    expect(dep.items).toEqual(['date-fns', 'vitest']);
    expect(dep.what).toBe('2 new packages: date-fns, vitest');
  });

  it('npm from both sides of the file when they can be read', () => {
    const read = (side: string) =>
      side === 'base'
        ? JSON.stringify({ dependencies: { react: '18', zod: '3' } })
        : JSON.stringify({ dependencies: { react: '18', zod: '3', 'date-fns': '3' }, devDependencies: { vitest: '3' } });
    const dep = DS.detect({ diff: pkgDiff, read }).signals.find((s: any) => s.category === 'dependency');
    expect(dep.items).toEqual(['date-fns', 'vitest']);
  });

  it('a new package.json: every name is new; node_modules is never read', () => {
    const d = diffOf([
      { path: 'web/package.json', status: 'new', lines: ['+{', '+  "dependencies": {', '+    "left-pad": "1"', '+  }', '+}'] },
      { path: 'node_modules/x/package.json', status: 'new', lines: ['+{', '+  "dependencies": {', '+    "y": "1"', '+  }', '+}'] },
    ]);
    expect(DS.detect({ diff: d }).signals.find((s: any) => s.category === 'dependency').items).toEqual(['left-pad']);
  });

  it('only a version bump: no signal', () => {
    const d = diffOf([{ path: 'package.json', lines: ['   "dependencies": {', '-    "react": "^18.2.0"', '+    "react": "^18.3.1"', '   }'] }]);
    expect(kinds(DS.detect({ diff: d }))).toEqual([]);
  });

  it('other manifests: the file changed; with both sides read, the new name', () => {
    const d = diffOf([
      { path: 'Gemfile', lines: ['+gem "rails"'] },
      { path: 'requirements.txt', lines: [' flask==3.0', '+requests>=2'] },
    ]);
    const dep = DS.detect({ diff: d }).signals.find((s: any) => s.category === 'dependency');
    expect(dep.items).toEqual(['Gemfile changed', 'requirements.txt changed']);
    const read = (side: string, p: string) => (p === 'requirements.txt' ? (side === 'base' ? 'flask==3.0\n' : 'flask==3.0\nrequests>=2\n') : null);
    expect(DS.detect({ diff: d, read }).signals.find((s: any) => s.category === 'dependency').items).toEqual(['Gemfile changed', 'requests']);
  });
});

describe('migration or schema', () => {
  it('a migration folder, the configured folder, schema files and .sql elsewhere; not a deleted one', () => {
    const d = diffOf([
      { path: 'db/migrate/001_users.rb', status: 'new', lines: ['+class X; end'] },
      { path: 'sql/up/002.sql', status: 'new', lines: ['+create table t (id int);'] },
      { path: 'prisma/schema.prisma', lines: ['+model A {}'] },
      { path: 'src/report.sql', lines: ['+select 1;'] },
      { path: 'migrations/old.sql', status: 'deleted', lines: ['-drop table t;'] },
      { path: 'src/app.ts', lines: ['+x'] },
    ]);
    const m = DS.detect({ diff: d, migrations: { folder: 'sql/up' } }).signals.find((s: any) => s.category === 'migration');
    expect(m.items).toEqual(['db/migrate/001_users.rb', 'sql/up/002.sql', 'prisma/schema.prisma', 'src/report.sql']);
    expect(m.what).toBe('4 migration or schema files');
  });
});

describe('deletion', () => {
  const del = (n: number, test = false) =>
    Array.from({ length: n }, (_, i) => ({ path: test ? `src/a${i}.test.ts` : `src/a${i}.ts`, status: 'deleted' as const, lines: ['-x'] }));

  it('non-test files at the threshold (3 by default), test files never count', () => {
    expect(kinds(DS.detect({ diff: diffOf(del(2)) }))).toEqual([]);
    expect(kinds(DS.detect({ diff: diffOf([...del(2), ...del(5, true)]) }))).toEqual([]);
    const s = DS.detect({ diff: diffOf(del(3)) }).signals.find((x: any) => x.category === 'deletion');
    expect(s.what).toBe('3 files deleted');
    expect(DS.detect({ diff: diffOf(del(2)), setup: { deleteMin: 2 } }).signals.map((x: any) => x.category)).toEqual(['deletion']);
  });
});

describe('unstated choices', () => {
  const big = diffOf([{ path: 'src/big.ts', status: 'new', lines: Array.from({ length: 320 }, (_, i) => `+line ${i}`) }]);

  it('a big change without Assumptions; with them, or under the size, none', () => {
    expect(DS.detect({ diff: big }).signals.find((s: any) => s.category === 'unstated').what).toBe(
      'a big change (320 lines) with no Assumptions',
    );
    expect(kinds(DS.detect({ diff: big, report: { assumptions: 'Used X.' } }))).toEqual([]);
    expect(kinds(DS.detect({ diff: big, setup: { bigDiffLines: 400 } }))).toEqual([]);
  });

  it('test lines do not make a change big', () => {
    const t = diffOf([{ path: 'src/big.test.ts', status: 'new', lines: Array.from({ length: 400 }, () => '+x') }]);
    expect(kinds(DS.detect({ diff: t }))).toEqual([]);
  });

  it('owner question text with ownerQuestions=0', () => {
    const r = DS.detect({ diff: '', report: { questionText: 'Which library?', ownerQuestions: 0 } });
    expect(r.signals.map((s: any) => [s.category, s.what])).toEqual([['unstated', 'owner questions written, but ownerQuestions=0']]);
    expect(kinds(DS.detect({ diff: '', report: { questionText: 'Which library?', ownerQuestions: 1 } }))).toEqual([]);
  });
});

describe('asked, told, not asked', () => {
  it('a signal is asked when an owner question names its kind, told when the Assumptions do; unstated is never counted', () => {
    const d = diffOf([
      { path: 'package.json', lines: ['   "dependencies": {', '+    "date-fns": "3"', '   }'] },
      { path: 'supabase/migrations/1.sql', status: 'new', lines: ['+create table a (id int);'] },
      ...Array.from({ length: 3 }, (_, i) => ({ path: `src/o${i}.ts`, status: 'deleted' as const, lines: ['-x'] })),
    ]);
    const r = DS.detect({
      diff: d,
      report: { questionText: 'May I add the date-fns library?', ownerQuestions: 1, assumptions: 'Removed the old exporter.' },
    });
    const by = Object.fromEntries(r.signals.map((s: any) => [s.category, s]));
    expect(by.dependency.asked).toBe(true);
    expect(by.migration.asked).toBe(false);
    expect(by.deletion.asked).toBe(false);
    expect(by.deletion.told).toBe(true);
    expect(r.notAsked).toEqual(['migration', 'deletion']);
    const u = DS.detect({ diff: '', report: { questionText: 'x', ownerQuestions: 0 } });
    expect(u.signals[0].asked).toBeNull();
    expect(u.notAsked).toEqual([]);
  });

  it('nothing in the diff: no signals', () => {
    expect(DS.detect({ diff: '' })).toEqual({ signals: [], notAsked: [], lines: 0 });
    expect(DS.detect({})).toEqual({ signals: [], notAsked: [], lines: 0 });
  });
});

describe('record, row and line', () => {
  const many = diffOf([
    { path: 'package.json', lines: ['   "dependencies": {', ...Array.from({ length: 9 }, (_, i) => `+    "pkg-${'x'.repeat(200)}-${i}": "1",`), '   }'] },
  ]);

  it('the record keeps at most five items, each cut, and the tip and time', () => {
    const rec = DS.record(DS.detect({ diff: many }), { tip: 'abc123', at: '2026-11-22T10:00:00.000Z' });
    expect(rec.tip).toBe('abc123');
    expect(rec.at).toBe('2026-11-22T10:00:00.000Z');
    expect(rec.signals[0].items).toHaveLength(5);
    expect(rec.signals[0].more).toBe(4);
    expect(rec.signals[0].items.every((x: string) => x.length <= DS.ITEM_MAX)).toBe(true);
    expect(rec.signals[0].what.length).toBeLessThanOrEqual(DS.WHAT_MAX);
    expect(DS.record({ signals: [], notAsked: [] }, { tip: 'a', at: 'b' })).toBeNull();
  });

  it('the time log row: categories and not asked, no item text', () => {
    const rec = DS.record(DS.detect({ diff: many }), { tip: 'abc', at: '2026-11-22T10:00:00.000Z' });
    const row = DS.row('T-1', rec);
    expect(row).toEqual({ time: '2026-11-22T10:00:00.000Z', event: 'signal', task: 'T-1', tip: 'abc', categories: ['dependency'], not_asked: ['dependency'] });
    expect(JSON.stringify(row)).not.toContain('pkg-');
  });

  it('a new row only for a new delivery (another tip)', () => {
    expect(DS.isNewDelivery(null, { tip: 'a' })).toBe(true);
    expect(DS.isNewDelivery({ tip: 'a' }, { tip: 'a' })).toBe(false);
    expect(DS.isNewDelivery({ tip: 'a' }, { tip: 'b' })).toBe(true);
  });

  it('one receive line, which says it never stops', () => {
    const rec = DS.record(DS.detect({ diff: pkgDiff }), { tip: 'a', at: 'b' });
    expect(DS.receiveLine('T-1', rec)).toBe(
      'SIGNALS: T-1: 2 new packages: date-fns, vitest. Not asked: new package. Shown in Decided for you; never a stop.',
    );
    expect(DS.receiveLine('T-1', null)).toBeNull();
  });
});

// ---- receive: the SIGNALS line, the record on the task and the time log row ------------------------------------------

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

describe('queue.mjs receive with decision signals', () => {
  /** A queue with task A on queue/A, which adds a package and a migration; `config` is queue.config.json. */
  const setup = (config: object) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-dsig-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    const scratch = path.join(folder, 'scratch');
    fs.mkdirSync(repo);
    fs.mkdirSync(scratch);
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const put = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
      g(['add', '--', file]);
    };
    g(['init', '-q', '-b', 'main']);
    put('package.json', JSON.stringify({ name: 'x', dependencies: { zod: '3' } }, null, 2) + '\n');
    g(['commit', '-q', '-m', 'start']);
    g(['switch', '-q', '-c', 'queue/A']);
    put('package.json', JSON.stringify({ name: 'x', dependencies: { zod: '3', 'date-fns': '3' } }, null, 2) + '\n');
    put('db/migrations/001.sql', 'create table a (id int);\n');
    g(['commit', '-q', '-m', 'track A']);
    g(['switch', '-q', 'main']);
    const task = {
      id: 'A',
      title: 'Task A',
      domain: 'dom-A',
      class: 'K',
      status: 'running',
      mission: 'The mission for A.',
      value: 5,
      content_min: 60,
      depends_on: [],
      waiting_on: [],
      owned_files: ['package.json', 'db/migrations/001.sql'],
      started: '2026-01-01T00:00:00.000Z',
      branch: 'queue/A',
      migr_block: null,
      scratchpad: scratch,
    };
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ created: task.started, limits: {}, next_migr: 3600, resolved: [], tasks: [task] }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, 'A', 'track-result.md'),
      'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=1 edge=-\n\n' +
        '## Owner questions\n1. Is date-fns the library you want?\n',
    );
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    } as NodeJS.ProcessEnv;
    delete env.QUEUE_SCRATCHPAD;
    delete env.QUEUE_SESSION;
    const receive = () =>
      spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), 'receive', 'A'], { encoding: 'utf8', env, cwd: folder });
    const rows = () => {
      const f = path.join(folder, 'times.jsonl');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.event === 'signal') : [];
    };
    const task0 = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks[0];
    return { receive, rows, task0 };
  };

  it('prints the line, stores the record, one row per tip, and the delivery goes to review', () => {
    const m = setup({});
    const r = m.receive();
    expect(r.stderr ?? '').toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SIGNALS: A: 1 new package: date-fns; 1 migration or schema file. Not asked: migration or schema.');
    const t = m.task0();
    expect(t.status).toBe('review');
    expect(t.decision_signals.signals.map((s: any) => [s.category, s.asked])).toEqual([
      ['dependency', true],
      ['migration', false],
    ]);
    expect(m.rows()).toEqual([expect.objectContaining({ event: 'signal', task: 'A', categories: ['dependency', 'migration'], not_asked: ['migration'] })]);
    // The same delivery again: no second row.
    expect(m.receive().status).toBe(0);
    expect(m.rows()).toHaveLength(1);
  });

  it('decisionSignals.enabled false: no line, no record, no row', () => {
    const m = setup({ decisionSignals: { enabled: false } });
    const r = m.receive();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('SIGNALS');
    expect(m.task0().decision_signals).toBeUndefined();
    expect(m.rows()).toEqual([]);
  });
});

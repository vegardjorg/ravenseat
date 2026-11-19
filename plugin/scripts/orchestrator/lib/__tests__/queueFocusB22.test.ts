/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueFocusB22.test.ts: the default for tasks outside a new focus (board step B22, the focus review of 2026-11-18,
// owner question 3 answered 2026-11-19: fill is the default, as recommended).
//
// What the tests prove:
//   - the new setting focus.restDefault (queue.config.json, choices fill and wait, default fill) has its row in the
//     settings registry under Plans and focus, with fill as the default the Settings panel shows,
//   - `ravenseat focus set` without --rest and `focus save` (the board's Save focus) without a rest give a NEW focus the
//     setting's value; an explicit --rest (or the board's explicit choice) wins over the setting,
//   - an existing focus keeps its stored rest: nothing is migrated, and a save without a rest keeps it,
//   - the board preselects the effective value for a new focus (focusNow.how.rest without a focus is the setting), and
//     "How focus works" and the Focus settings summary are built from it,
//   - with rest wait, "What happens now" always says how many tasks outside the focus wait, also when none do.
// The board runs in jsdom with a small synthetic queue (no network), as in queueFocusB21.test.ts.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as any;
const L = require('../queueLogic.js') as any;
const KK = require('../queueConfig.js') as any;
const R = require('../settingsRegistry.js') as any;
const SV = require('../settingsView.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const ORCH = join(__dirname, '..', '..');
const CLIENT = join(ORCH, 'queue-board');
const QUEUE_MJS = join(ORCH, 'queue.mjs');
const iso = new Date(Date.now() - 86_400_000).toISOString();

// The config this file reads in process: a temp queue.config.json (or none), read fresh so cfg() sees it.
const configFolder = mkdtempSync(join(tmpdir(), 'ravenseat-focus-b22-config-'));
const before = process.env.QUEUE_CONFIG;
function useConfig(own: object | null) {
  const file = join(configFolder, own ? 'queue.config.json' : 'none.json');
  if (own) writeFileSync(file, JSON.stringify(own));
  process.env.QUEUE_CONFIG = file;
  KK.config({ fresh: true });
  L.resetConfig();
}
useConfig(null);
afterAll(() => {
  if (before == null) delete process.env.QUEUE_CONFIG;
  else process.env.QUEUE_CONFIG = before;
  KK.config({ fresh: true });
  L.resetConfig();
  rmSync(configFolder, { recursive: true, force: true });
});

function task(id: string, project: string, status: string, extra: object = {}) {
  return {
    id,
    title: `Task ${id}`,
    project,
    domain: `${project}-${id}`,
    class: 'K',
    value: 5,
    content_min: 60,
    status,
    depends_on: [],
    waiting_on: [],
    owned_files: [`file/${id}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/${id}.md`,
    added_by: 'test',
    added_at: iso,
    ...(status === 'done' ? { done: iso } : {}),
    ...extra,
  };
}

const PROJECTS = {
  billing: { title: 'Subscriptions', prefixes: ['BILL-'] },
  misc: { title: 'Odds and ends', prefixes: ['MISC-'] },
};

/** BILL-1 in the focus step project:billing; MISC-1 and MISC-2 outside it. `focus` null = no focus. */
function makeQueue(focus: object | null = null, tasks: any[] | null = null): any {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: tasks ?? [task('BILL-1', 'billing', 'waiting'), task('MISC-1', 'misc', 'waiting'), task('MISC-2', 'misc', 'waiting')],
    projects: PROJECTS,
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
    ...(focus ? { focus: { from: iso, order: ['project:billing'], drag_with_dependencies: true, ...focus } } : {}),
  };
}

describe('the setting focus.restDefault', () => {
  afterEach(() => useConfig(null));

  it('has its row under Plans and focus: a choice of fill and wait, full mode only, with the label "Outside focus"', () => {
    const row = R.rowFor('focus.restDefault');
    expect(row).toBeTruthy();
    expect(row.category).toBe('plans');
    expect(row.type).toBe('choice');
    expect(row.choices).toEqual(['fill', 'wait']);
    expect(row.title).toBe('Outside focus');
    expect(row.modes).toEqual(['full']);
    expect(row.explanation).toMatch(/fill \(default\)/);
  });

  it('defaults to fill in STANDARD and in the Settings view', () => {
    expect(KK.STANDARD.focus.restDefault).toBe('fill');
    const v = SV.settingsView({ config: KK.merge(KK.STANDARD, { mode: 'full' }), queue: { tasks: [] } });
    const r = v.categories.find((c: any) => c.id === 'plans').rows.find((x: any) => x.key === 'focus.restDefault');
    expect(r.standard).toBe('fill');
    expect(r.value).toBe('fill');
    expect(r.options).toEqual(['fill', 'wait']);
  });

  it('focusRestDefault reads the config: fill without one, wait when set, fill for anything else', () => {
    expect(L.focusRestDefault()).toBe('fill');
    useConfig({ focus: { restDefault: 'wait' } });
    expect(L.focusRestDefault()).toBe('wait');
    useConfig({ focus: { restDefault: 'nonsense' } });
    expect(L.focusRestDefault()).toBe('fill');
  });
});

describe('setFocus and saveFocusPlan: the default applies only to a new focus without a rest', () => {
  afterEach(() => useConfig(null));

  it('no rest given: the setting decides (fill by default, wait when the setting says so)', () => {
    let queue = makeQueue();
    expect(L.setFocus(queue, { order: ['project:billing'] }).error).toEqual([]);
    expect(queue.focus.rest).toBe('fill');
    useConfig({ focus: { restDefault: 'wait' } });
    queue = makeQueue();
    L.setFocus(queue, { order: ['project:billing'] });
    expect(queue.focus.rest).toBe('wait');
  });

  it('an explicit rest wins over the setting, both ways', () => {
    let queue = makeQueue();
    L.setFocus(queue, { order: ['project:billing'], rest: 'wait' });
    expect(queue.focus.rest).toBe('wait');
    useConfig({ focus: { restDefault: 'wait' } });
    queue = makeQueue();
    L.setFocus(queue, { order: ['project:billing'], rest: 'fill' });
    expect(queue.focus.rest).toBe('fill');
  });

  it('an existing focus keeps its stored rest: the ranking and the status still read wait under a fill default', () => {
    const queue = makeQueue({ rest: 'wait' });
    expect(L.focusStatus(queue)?.rest).toBe('wait');
    expect(T.focusNow(queue).how.rest).toBe('wait');
    // A focus without a stored rest (written by hand) is read as before: wait. Nothing is migrated.
    const bare = makeQueue({});
    expect(L.focusStatus(bare)?.rest).toBe('wait');
    expect(bare.focus.rest).toBeUndefined();
  });

  it('a board save without a rest keeps the rest of the focus it replaces, and takes the setting when there is none', () => {
    const queue = makeQueue({ rest: 'wait' });
    expect(L.saveFocusPlan(queue, { order: ['project:billing', 'project:misc'] }).error).toEqual([]);
    expect(queue.focus.rest).toBe('wait');
    const fresh = makeQueue();
    L.saveFocusPlan(fresh, { order: ['project:billing'] });
    expect(fresh.focus.rest).toBe('fill');
    // The board's explicit choice wins.
    const chosen = makeQueue({ rest: 'fill' });
    L.saveFocusPlan(chosen, { order: ['project:billing'], rest: 'wait' });
    expect(chosen.focus.rest).toBe('wait');
  });

  it('the Save focus preview (focusPreview) without a rest shows the setting for a new focus', () => {
    const r = T.focusPreview(makeQueue(), { order: ['project:billing'] });
    expect(r.error).toEqual([]);
    expect(r.lines.join('\n')).toMatch(/fill/);
  });
});

describe('queue.mjs focus set: --rest left out takes the setting, an explicit --rest wins', () => {
  let folder = '';
  let configFile: string | null = null;
  const run = (args: string[]) =>
    execFileSync(process.execPath, [QUEUE_MJS, ...args], {
      env: {
        ...process.env,
        QUEUE_FOLDER: folder,
        QUEUE_GIT: folder,
        QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
        QUEUE_CONFIG: configFile ?? join(folder, 'no-config.json'),
        DISABLE_UPDATES: '1',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const rest = () => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8')).focus.rest;

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'ravenseat-focus-b22-'));
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  afterEach(() => {
    configFile = null;
  });
  const fresh = () => writeFileSync(join(folder, 'queue.json'), JSON.stringify({ ...makeQueue(), next_migr: 1000 }, null, 2));

  it('without --rest and without a setting: fill', () => {
    fresh();
    run(['focus', 'set', 'project:billing']);
    expect(rest()).toBe('fill');
  });

  it('without --rest and the setting wait: wait', () => {
    fresh();
    configFile = join(folder, 'queue.config.json');
    writeFileSync(configFile, JSON.stringify({ focus: { restDefault: 'wait' } }));
    run(['focus', 'set', 'project:billing']);
    expect(rest()).toBe('wait');
  });

  it('--rest wait wins over the fill default, and --rest fill over the wait setting', () => {
    fresh();
    run(['focus', 'set', 'project:billing', '--rest', 'wait']);
    expect(rest()).toBe('wait');
    configFile = join(folder, 'queue.config.json');
    writeFileSync(configFile, JSON.stringify({ focus: { restDefault: 'wait' } }));
    run(['focus', 'set', 'project:billing', '--rest', 'fill']);
    expect(rest()).toBe('fill');
  });

  it('a change that is not a new focus (focus add) keeps the stored rest', () => {
    fresh();
    run(['focus', 'set', 'project:billing', '--rest', 'wait']);
    run(['focus', 'add', 'project:misc']);
    expect(rest()).toBe('wait');
  });
});

describe('"What happens now" with rest wait always says how many tasks outside the focus wait', () => {
  it('without a focus, "How focus works" describes the default a new focus gets', () => {
    expect(T.focusNow(makeQueue()).how.rest).toBe('fill');
    useConfig({ focus: { restDefault: 'wait' } });
    try {
      expect(T.focusNow(makeQueue()).how.rest).toBe('wait');
    } finally {
      useConfig(null);
    }
  });

  it('active, with tasks outside: the count', () => {
    const n = T.focusNow(makeQueue({ rest: 'wait' }));
    expect(n.state).toBe('active');
    expect(n.text).toMatch(/2 tasks outside the focus wait\./);
  });

  it('active, with nothing outside: says 0', () => {
    const n = T.focusNow(makeQueue({ rest: 'wait' }, [task('BILL-1', 'billing', 'waiting')]));
    expect(n.state).toBe('active');
    expect(n.text).toMatch(/0 tasks outside the focus wait\./);
  });

  it('nothing in the focus can start: the count and that free slots stay empty', () => {
    const tasks = [
      task('BILL-2', 'billing', 'running'),
      task('BILL-1', 'billing', 'waiting', { depends_on: ['BILL-2'] }),
      task('MISC-1', 'misc', 'waiting'),
    ];
    const n = T.focusNow(makeQueue({ rest: 'wait' }, tasks));
    expect(n.state).toBe('waiting');
    expect(n.text).toMatch(/1 task outside the focus waits, so free slots stay empty\./);
    const none = T.focusNow(makeQueue({ rest: 'wait' }, tasks.slice(0, 2)));
    expect(none.text).toMatch(/0 tasks outside the focus wait\./);
  });

  it('rest fill keeps its own wording and says nothing when nothing is outside', () => {
    expect(T.focusNow(makeQueue({ rest: 'fill' })).text).toMatch(/2 tasks outside the focus fill free slots\./);
    const n = T.focusNow(makeQueue({ rest: 'fill' }, [task('BILL-1', 'billing', 'waiting')]));
    expect(n.text).not.toMatch(/outside the focus/);
  });
});

// ---- The board in jsdom: a new focus preselects the setting ----
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;

describe('the board: the Focus tab preselects the default for a new focus', () => {
  const state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false } };
  beforeAll(async () => {
    const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
    document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
    sessionStorage.setItem('queue-board-key', 'testKey');
    localStorage.clear();
    const w = window as any;
    w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.HTMLElement.prototype.scrollIntoView = function () {};
    w.setInterval = () => 0;
    w.fetch = async (filePath: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        filePath.startsWith('/api/state')
          ? filePath.includes(`version=${state.version}`)
            ? { version: state.version, unchanged: true }
            : state
          : {},
    });
    for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
      (0, eval)(clientSource(f));
    await flush();
  }, 60_000);

  it('without a focus the Rest select shows fill, the summary and "How focus works" say the rest fills free slots', async () => {
    expect(state.data.focusNow.how.rest).toBe('fill');
    $('show-plan').click();
    await flush();
    const select = document.querySelector('select[aria-label="Rest of the queue"]') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('fill');
    expect(document.querySelector('.plan-settings-summary')?.textContent).toMatch(/the rest fills free slots/);
    expect(document.querySelector('#focus-how-body')?.textContent).toMatch(/The rest fills free slots/);
    // The help on the field names the setting, so the owner can find where the default comes from.
    expect((select.closest('label') as HTMLElement).title).toMatch(/Outside focus/);
  });
});

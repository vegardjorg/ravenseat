/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueFocusB21.test.ts: focus on the cards (board step B21, the focus review of 2026-11-18).
//
// What the tests prove:
//   - addFocusStep takes several steps at once: they go in together at one place, in the given order, as ONE
//     changelog entry (one undo), and a step already in the list is skipped and named,
//   - focusChangePreview (queueBoard.js) tries one add or remove on a copy with the B20 logic and says what changes,
//     in board words (no CLI command): a duplicate is a no-op, the last step and a missing focus are refused,
//   - `ravenseat focus add` / `focus remove` answer with one JSON line (--json) and refuse a stale --expect-changed
//     with exit 6, so the board can save a card action the same way it saves the Focus tab,
//   - POST /api/focus { change, dry } previews and POST /api/focus { change, expect } saves through the CLI; a bad step
//     or a remove of more than one step is refused with 400, and a stale preview with 409,
//   - the board: "Add to focus" in the detail panel of a task outside the focus, "Remove from focus" for a task that
//     is its own step, only a note (no button) for a task a broader step covers, "Add to focus" on an outside-focus
//     card (without the CLI hint) and in the Selection menu, all through the dry preview first,
//   - the Focus tab has an "Add to focus …" picker (kind, what, position) that puts the step into the draft, and a task
//     step taken out of In focus in the draft stands in Not in focus, so it can be brought back.
// The board runs in jsdom with a small synthetic queue (no network), as in queueFocusB20.test.ts.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import net from 'node:net';
import { tmpdir } from 'os';
import { join } from 'path';
import { clientSource } from './boardClient';
import { boardOpen, keyFileArgs } from './boardKey';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as {
  board: (queue: unknown, option?: unknown) => any;
  focusChangePreview: (queue: unknown, change: unknown, option?: unknown) => any;
};
const L = require('../queueLogic.js') as {
  addFocusStep: (queue: unknown, raw: string | string[], option?: unknown) => any;
  undoEntry: (queue: unknown, option?: unknown) => any;
  cloneJson: <X>(x: X) => X;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const ORCH = join(__dirname, '..', '..');
const CLIENT = join(ORCH, 'queue-board');
const QUEUE_MJS = join(ORCH, 'queue.mjs');
const iso = new Date(Date.now() - 86_400_000).toISOString();

function task(id: string, project: string, feature: string | null, status: string, extra: object = {}) {
  return {
    id,
    title: `Task ${id}`,
    project,
    ...(feature ? { feature } : {}),
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
  ui: { title: 'Habit screens', prefixes: ['UI-'] },
  billing: { title: 'Subscriptions', prefixes: ['BILL-'] },
  misc: { title: 'Odds and ends', prefixes: ['MISC-'] },
};

/**
 * Step 1 the Today feature, step 2 the billing project, step 3 the one task MISC-3. MISC-1 sits outside the focus,
 * BILL-1 is covered by the broader project step.
 */
function makeQueue(order: string[] | null = ['feature:ui/Today', 'project:billing', 'task:MISC-3']): any {
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('UI-3', 'ui', 'Today', 'waiting'),
      task('UI-4', 'ui', 'Today', 'waiting'),
      task('BILL-1', 'billing', null, 'waiting'),
      task('MISC-1', 'misc', null, 'waiting'),
      task('MISC-3', 'misc', null, 'waiting'),
      task('MISC-2', 'misc', null, 'done'),
    ],
    projects: PROJECTS,
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
    ...(order ? { focus: { from: iso, rest: 'wait', order, drag_with_dependencies: true } } : {}),
  };
}

describe('addFocusStep with several steps', () => {
  it('puts them in together at one place, in order, as one changelog entry that one undo takes back', () => {
    const queue = makeQueue();
    const before = [...queue.focus.order];
    const r = L.addFocusStep(queue, ['task:MISC-1', 'task:UI-4'], { at: 2, by: 'owner' });
    expect(r.error).toEqual([]);
    expect(r.stages).toEqual(['task:MISC-1', 'task:UI-4']);
    expect(r.index).toBe(1);
    expect(queue.focus.order).toEqual([
      'feature:ui/Today',
      'task:MISC-1',
      'task:UI-4',
      'project:billing',
      'task:MISC-3',
    ]);
    expect(queue.changelog.length).toBe(1);
    expect(queue.changelog[0].action).toBe('focus add');
    expect(L.undoEntry(queue, { by: 'owner' }).error).toEqual([]);
    expect(queue.focus.order).toEqual(before);
  });

  it('skips a step already in the list and names it; all of them already there is a no-op', () => {
    const queue = makeQueue();
    const r = L.addFocusStep(queue, ['task:MISC-3', 'task:MISC-1']);
    expect(r.error).toEqual([]);
    expect(r.stages).toEqual(['task:MISC-1']);
    expect(r.skipped).toEqual(['task:MISC-3']);
    expect(queue.focus.order.at(-1)).toBe('task:MISC-1');
    const n = queue.changelog.length;
    const again = L.addFocusStep(queue, ['task:MISC-3', 'task:MISC-1']);
    expect(again.noop).toBe(true);
    expect(queue.changelog.length).toBe(n);
  });

  it('one unknown id refuses the whole add, with nothing changed', () => {
    const queue = makeQueue();
    const r = L.addFocusStep(queue, ['task:MISC-1', 'task:NOPE-9']);
    expect(r.error.join(' ')).toMatch(/unknown task/);
    expect(queue.focus.order).toEqual(['feature:ui/Today', 'project:billing', 'task:MISC-3']);
    expect(queue.changelog.length).toBe(0);
  });
});

describe('focusChangePreview: one change tried on a copy', () => {
  it('an add says before and after and the step lines, and leaves the queue as it was', () => {
    const queue = makeQueue();
    const f = T.focusChangePreview(queue, { action: 'add', steps: ['task:MISC-1'] });
    expect(f.error).toEqual([]);
    expect(f.noop).toBe(false);
    expect(f.before_text).not.toMatch(/MISC-1/);
    expect(f.after_text).toMatch(/MISC-1/);
    expect(f.lines.join('\n')).toMatch(/step 4: .*MISC-1.*\(task\)/);
    expect(queue.focus.order).toEqual(['feature:ui/Today', 'project:billing', 'task:MISC-3']);
    expect(queue.changelog.length).toBe(0);
  });

  it('a remove takes the one task step out', () => {
    const f = T.focusChangePreview(makeQueue(), { action: 'remove', steps: ['task:MISC-3'] });
    expect(f.error).toEqual([]);
    expect(f.after_text).not.toMatch(/MISC-3/);
  });

  it('a step already in the focus is a no-op with a message', () => {
    const f = T.focusChangePreview(makeQueue(), { action: 'add', steps: ['task:MISC-3'] });
    expect(f.error).toEqual([]);
    expect(f.noop).toBe(true);
    expect(f.message).toMatch(/already/);
  });

  it('the last step and a missing focus are refused in board words, without a CLI command', () => {
    const last = T.focusChangePreview(makeQueue(['task:MISC-3']), { action: 'remove', steps: ['task:MISC-3'] });
    expect(last.error.join(' ')).toMatch(/only step/);
    expect(last.error.join(' ')).toMatch(/Clear focus/);
    const none = T.focusChangePreview(makeQueue(null), { action: 'add', steps: ['task:MISC-1'] });
    expect(none.error.join(' ')).toMatch(/No focus is set/);
    for (const f of [last, none]) expect(f.error.join(' ')).not.toMatch(/ravenseat/);
    expect(T.focusChangePreview(makeQueue(), { action: 'add', steps: ['task:NOPE-9'] }).error.join(' ')).toMatch(
      /unknown task/,
    );
  });
});

describe('queue.mjs focus add / remove --json and --expect-changed', () => {
  let folder: string;
  function run(args: string[]): { code: number; out: string; error: string } {
    try {
      const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], {
        env: { ...process.env, QUEUE_FOLDER: folder, QUEUE_GIT: folder, QUEUE_TIME_LOG: join(folder, 'times.jsonl') },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, error: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout ?? '', error: x.stderr ?? '' };
    }
  }
  const readQueue = () => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));
  const lastJson = (s: string) => JSON.parse(s.trim().split('\n').pop() ?? '');
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'queue-focus-b21-'));
    writeFileSync(join(folder, 'queue.json'), JSON.stringify({ ...makeQueue(), next_migr: 1000 }, null, 2));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('add takes several steps in one change and answers with JSON; one undo takes all of them back', () => {
    const r = run(['focus', 'add', 'MISC-1', 'UI-4', '--at', '1', '--json', '--by', 'theBoard']);
    expect(r.code, r.error).toBe(0);
    const j = lastJson(r.out);
    expect(j.ok).toBe(true);
    expect(j.stages).toEqual(['task:MISC-1', 'task:UI-4']);
    expect(readQueue().focus.order.slice(0, 2)).toEqual(['task:MISC-1', 'task:UI-4']);
    expect(run(['undo']).code).toBe(0);
    expect(readQueue().focus.order).toEqual(['feature:ui/Today', 'project:billing', 'task:MISC-3']);
  });

  it('remove answers with JSON; an error with --json is one JSON line and exit 1', () => {
    const r = run(['focus', 'remove', 'task:MISC-3', '--json']);
    expect(r.code, r.error).toBe(0);
    expect(lastJson(r.out)).toMatchObject({ ok: true, stage: 'task:MISC-3' });
    const bad = run(['focus', 'remove', 'task:MISC-1', '--json']);
    expect(bad.code).toBe(1);
    expect(lastJson(bad.out).ok).toBe(false);
    expect(lastJson(bad.out).error.join(' ')).toMatch(/not in the focus/);
  });

  it('a stale --expect-changed is refused with exit 6 and nothing changed', () => {
    const q = readQueue();
    q.changed = new Date().toISOString();
    writeFileSync(join(folder, 'queue.json'), JSON.stringify(q, null, 2));
    const r = run(['focus', 'add', 'MISC-1', '--json', '--expect-changed', '2000-01-01T00:00:00.000Z']);
    expect(r.code).toBe(6);
    expect(lastJson(r.out)).toMatchObject({ ok: false, outdated: true });
    expect(readQueue().focus.order).not.toContain('task:MISC-1');
  });
});

describe('POST /api/focus { change }', () => {
  let root = '';
  let board: ChildProcess | null = null;
  let base = '';
  let key = '';
  const KF = keyFileArgs();
  const queueFile = () => join(root, 'q', 'queue.json');
  const post = async (body: object) => {
    const r = await fetch(`${base}/api/focus`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-queue-key': key },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ravenseat-focus-b21-'));
    const folder = join(root, 'q');
    mkdirSync(folder);
    const env = {
      ...process.env,
      QUEUE_ROOT: root,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: join(root, 'no-config.json'),
      QUEUE_TIME_LOG: join(root, 'times.jsonl'),
      QUEUE_GIT: root,
      DISABLE_UPDATES: '1',
    };
    execFileSync(process.execPath, [QUEUE_MJS, 'init'], { cwd: root, env, stdio: 'ignore' });
    const start = JSON.parse(readFileSync(queueFile(), 'utf8'));
    writeFileSync(queueFile(), JSON.stringify({ ...start, ...makeQueue() }, null, 2));
    const port = await new Promise<number>((done) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => done(p));
      });
    });
    board = spawn(process.execPath, [join(ORCH, 'queue-board.mjs'), '--port', String(port), ...KF.args], {
      cwd: root,
      env,
    });
    await new Promise<void>((done, fail) => {
      let out = '';
      const t = setTimeout(() => fail(new Error(`no start line: ${out}`)), 60_000);
      board!.stdout!.on('data', (d) => {
        out += String(d);
        const m = boardOpen(out, KF.file);
        if (m) {
          clearTimeout(t);
          base = m[1];
          key = m[2];
          done();
        }
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (board && board.exitCode == null) {
      const gone = new Promise((done) => board!.once('exit', done));
      board.kill();
      await gone;
    }
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('dry previews the add, and the save goes in with one "focus add" entry', async () => {
    const change = { action: 'add', steps: ['task:MISC-1'] };
    const dry = await post({ change, dry: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ ok: true, dry: true, can: true });
    expect(dry.body.after_text).toMatch(/MISC-1/);
    expect(JSON.parse(readFileSync(queueFile(), 'utf8')).focus.order).not.toContain('task:MISC-1');
    const saved = await post({ change, expect: dry.body.changed });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.ok).toBe(true);
    const q = JSON.parse(readFileSync(queueFile(), 'utf8'));
    expect(q.focus.order.at(-1)).toBe('task:MISC-1');
    expect(q.changelog.at(-1).action).toBe('focus add');
  }, 60_000);

  it('a no-op preview cannot be saved; a stale preview gives 409', async () => {
    const dup = await post({ change: { action: 'add', steps: ['task:MISC-3'] }, dry: true });
    expect(dup.status).toBe(200);
    expect(dup.body.can).toBe(false);
    expect(dup.body.noop).toBe(true);
    const stale = await post({
      change: { action: 'remove', steps: ['task:MISC-3'] },
      expect: '2000-01-01T00:00:00.000Z',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.outdated).toBe(true);
  }, 60_000);

  it('refuses a bad step, an unknown action, a bad position and a remove of more than one step with 400', async () => {
    for (const change of [
      { action: 'add', steps: ['task:a b'] },
      { action: 'add', steps: [] },
      { action: 'swap', steps: ['task:MISC-1'] },
      { action: 'add', steps: ['task:MISC-1'], at: 0 },
      { action: 'remove', steps: ['task:MISC-3', 'project:billing'] },
    ]) {
      const r = await post({ change, dry: true });
      expect(r.status, JSON.stringify(change)).toBe(400);
    }
  }, 60_000);
});

// ---- The board in jsdom ----
const queue = makeQueue();
const state = { version: 'v1', data: { ...T.board(queue), gitError: null, logo: false } };
const posted: any[] = [];
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const card = (id: string) => document.querySelector(`.summary[data-id="${id}"]`) as HTMLElement;
const panelButtons = () => [...$('panel').querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
const dialog = () => $('plan-dialog');
const closeDialog = async () => {
  const cancel = [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
  cancel?.click();
  await flush();
};
const openCard = async (id: string) => {
  (card(id).querySelector('.summary-button') as HTMLButtonElement).click();
  await flush();
};

describe('the board: focus on the cards', () => {
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
    w.fetch = async (filePath: string, init?: { body?: string }) => {
      if (filePath.startsWith('/api/focus')) posted.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () =>
          filePath.startsWith('/api/state')
            ? filePath.includes(`version=${state.version}`)
              ? { version: state.version, unchanged: true }
              : state
            : filePath.startsWith('/api/focus')
              ? { ok: true, can: true, before_text: 'before', after_text: 'after', lines: ['a line'], changed: 'c1' }
              : {},
      };
    };
    for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
      (0, eval)(clientSource(f));
    await flush();
  }, 60_000);

  beforeEach(() => {
    posted.length = 0;
  });

  it('the panel of a task outside the focus has "Add to focus", which previews first and saves on confirm', async () => {
    await openCard('MISC-1');
    expect(panelButtons()).toContain('Add to focus');
    expect(panelButtons()).not.toContain('Remove from focus');
    const add = [...$('panel').querySelectorAll('button')].find((b) => b.textContent === 'Add to focus')!;
    add.click();
    await flush();
    expect(posted[0]).toEqual({ change: { action: 'add', steps: ['task:MISC-1'] }, dry: true });
    expect(dialog().textContent).toMatch(/before/);
    expect(dialog().textContent).toMatch(/a line/);
    const save = dialog().querySelector('.button-filled') as HTMLButtonElement;
    expect(save.textContent).toBe('Add to focus');
    save.click();
    await flush();
    expect(posted[1]).toEqual({ change: { action: 'add', steps: ['task:MISC-1'] }, expect: 'c1' });
  });

  it('the panel of a task that is its own step has "Remove from focus" and no add', async () => {
    await openCard('MISC-3');
    expect(panelButtons()).toContain('Remove from focus');
    expect(panelButtons()).not.toContain('Add to focus');
    [...$('panel').querySelectorAll('button')].find((b) => b.textContent === 'Remove from focus')!.click();
    await flush();
    expect(posted[0]).toEqual({ change: { action: 'remove', steps: ['task:MISC-3'] }, dry: true });
    await closeDialog();
  });

  it('a task covered by a broader step gets a note on what covers it, and no add or remove', async () => {
    await openCard('BILL-1');
    expect(panelButtons()).not.toContain('Add to focus');
    expect(panelButtons()).not.toContain('Remove from focus');
    expect(($('panel').textContent ?? '').replace(/\s+/g, ' ')).toMatch(/In focus through step T2/);
  });

  it('an outside-focus card has "Add to focus" under its reason, without the CLI hint, and it does not open the panel', async () => {
    (document.querySelector('#panel .button-icon') as HTMLButtonElement | null)?.click();
    await flush();
    const footer = card('MISC-1').querySelector('.summary-footer') as HTMLElement;
    expect(footer.textContent).not.toMatch(/ravenseat focus/);
    const button = footer.querySelector('button.focus-add') as HTMLButtonElement;
    expect(button?.textContent).toBe('Add to focus');
    expect(card('BILL-1').querySelector('button.focus-add')).toBeNull();
    expect($('panel').hidden).toBe(true);
    button.click();
    await flush();
    expect(posted[0]).toEqual({ change: { action: 'add', steps: ['task:MISC-1'] }, dry: true });
    // The click on the card's button opens the preview, not the detail panel.
    expect($('panel').hidden).toBe(true);
    await closeDialog();
  });

  it('Selection has "Add to focus" for the selected outside the focus, in one change', async () => {
    for (const id of ['MISC-1', 'BILL-1']) {
      const i = card(id).querySelector('.mark-box input') as HTMLInputElement;
      i.click();
      await flush();
    }
    const row = [...$('optionLine').querySelectorAll('[data-action]')].find(
      (b) => (b as HTMLElement).dataset.action === 'focus-add',
    ) as HTMLButtonElement;
    expect(row?.textContent).toBe('Add to focus');
    row.click();
    await flush();
    expect(posted[0]).toEqual({ change: { action: 'add', steps: ['task:MISC-1'] }, dry: true });
    await closeDialog();
  });

  it('the Focus tab picker puts the chosen step into the draft at the chosen position', async () => {
    $('show-plan').click();
    await flush();
    const open = [...document.querySelectorAll('.plan-tool button')].find(
      (b) => (b.textContent ?? '').trim() === 'Add to focus …',
    ) as HTMLButtonElement;
    expect(open).toBeTruthy();
    open.click();
    await flush();
    const kind = dialog().querySelector('select[aria-label="Kind"]') as HTMLSelectElement;
    // QA-1b: What is a searchable combobox over a listbox, and Position is First / After a step / Last
    // (queueBoardQa1b.test.ts covers both in depth).
    const what = () => dialog().querySelector('#plan-pick-what[role="combobox"]') as HTMLInputElement;
    const first = dialog().querySelector('input[name="plan-pick-where"][value="first"]') as HTMLInputElement;
    expect(kind && what() && first).toBeTruthy();
    expect([...kind.options].map((o) => o.value)).toEqual(['task', 'feature', 'project', 'area']);
    kind.value = 'task';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    const values = [...$(what().getAttribute('aria-controls')!).querySelectorAll('[role="option"]')].map(
      (o) => (o as HTMLElement).dataset.value,
    );
    expect(values).toContain('task:MISC-1');
    // What is already a step is not offered again.
    expect(values).not.toContain('task:MISC-3');
    what().value = 'MISC-1';
    what().dispatchEvent(new Event('input', { bubbles: true }));
    first.checked = true;
    first.dispatchEvent(new Event('change', { bubbles: true }));
    [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Add')!.click();
    await flush();
    const keys = [...document.querySelectorAll('.plan-list[data-col="focus"] > .plan-element')].map(
      (x) => (x as HTMLElement).dataset.key,
    );
    expect(keys[0]).toBe('task:MISC-1');
    expect(document.querySelector('.plan-draft')?.textContent).toMatch(/Draft, not saved/);
    // Nothing was saved: the picker only edits the draft.
    expect(posted.filter((b) => !b.dry)).toEqual([]);
  });

  it('a task step taken out in the draft stands in Not in focus with its title, and can go back', async () => {
    const row = (k: string) =>
      document.querySelector(`.plan-list > .plan-element[data-key="${k}"]`) as HTMLElement;
    const press = (target: HTMLElement, k: string) =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    press(row('task:MISC-3'), ' ');
    await flush();
    press(row('task:MISC-3'), 'ArrowRight');
    await flush();
    press(row('task:MISC-3'), ' ');
    await flush();
    expect(row('task:MISC-3')?.closest('.plan-list')?.getAttribute('data-col')).toBe('later');
    const header = (row('task:MISC-3').querySelector('.plan-header')?.textContent ?? '').replace(/\s+/g, ' ');
    expect(header).toMatch(/Task MISC-3/);
    expect(header).not.toMatch(/does not exist/);
    press(row('task:MISC-3'), ' ');
    await flush();
    press(row('task:MISC-3'), 'ArrowLeft');
    await flush();
    press(row('task:MISC-3'), ' ');
    await flush();
    expect(row('task:MISC-3')?.closest('.plan-list')?.getAttribute('data-col')).toBe('focus');
    // The task added by the picker and then taken out stands in Not in focus too.
    press(row('task:MISC-1'), ' ');
    await flush();
    press(row('task:MISC-1'), 'ArrowRight');
    await flush();
    press(row('task:MISC-1'), ' ');
    await flush();
    expect(row('task:MISC-1')?.closest('.plan-list')?.getAttribute('data-col')).toBe('later');
  });
});

/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPlansTriage.test.ts: confirming Claude's proposals in the Inbox (P7 of plans/plans-tab-ux-review-2026-11-19.md).
//
// What the tests prove:
//   - an Inbox row with a proposal reads "Claude suggests: ..." (with the reason, the summary and the plan it looks
//     like) before its buttons Accept, Edit, Decline and, with a duplicate, Merge into PL-X; keys 1 to 4 are named,
//   - a row without a proposal offers only Edit and Drop, and says how to get a proposal,
//   - Accept saves at once (POST /api/plan-proposal, action accept, the register version as expect) with Undo
//     (POST /api/plan-undo with the changelog number); a 409 (changed since) is said in words and nothing is assumed,
//   - Edit opens a form with the proposal's values; Accept from the form sends the owner's edits,
//   - Decline opens a panel with a reason and Drop it, and Merge into any other plan; Escape closes it,
//   - the keys: 1 Accept, 2 Edit, 3 Decline, 4 Merge (only with a candidate), nothing on a sorted plan,
//   - nothing shows with features.plans.inbox off, or for a plan outside the Inbox,
//   - the wiring: triage.js loads before plans.js, the server serves it and routes /api/plan-proposal through
//     queue.mjs plan accept|decline|merge with --set-by owner, --expect-changed and the edits in a file; plans.js
//     stays read only; no innerHTML; tokens only in the CSS.
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const V = require('../queuePlanView.js') as any;
const R = require('../planProposal.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const triageJs = readFileSync(join(CLIENT, 'plans', 'triage.js'), 'utf8');
const roadmapJs = readFileSync(join(CLIENT, 'plans', 'roadmap.js'), 'utf8');
const css = readFileSync(join(CLIENT, 'plans', 'plans.css'), 'utf8');
const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
const server = readFileSync(join(CLIENT, '..', 'queue-board.mjs'), 'utf8');
const plansJs = readFileSync(join(CLIENT, 'plans', 'plans.js'), 'utf8');
const workJs = readFileSync(join(CLIENT, 'plans', 'work.js'), 'utf8');

type Post = Record<string, unknown>;

function el(tag: string, attr: Record<string, unknown> | null, ...children: unknown[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attr ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v as EventListener);
    else if (k.startsWith('--')) e.style.setProperty(k, String(v));
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const b of (children as unknown[]).flat()) if (b != null && b !== false) e.append(typeof b === 'string' ? document.createTextNode(b) : (b as Node));
  return e;
}

const PROPOSAL = {
  at: '2026-11-20T08:00:00.000Z',
  by: 'claude',
  fields: {
    project: 'app',
    priority: 'now',
    now_category: ['important'],
    priority_reason: 'Rule 4: many readers ask for it.',
    maturity: 'investigated',
    size: 'M',
    summary: 'A dark theme for night reading.',
  },
  merge: ['PL-THEME'],
  outline: 'Problem: the white page at night.',
};
const plan = (o: Post = {}) => ({
  id: 'PL-DARK-MODE-1',
  title: 'Dark mode',
  summary: 'People read at night.',
  project: 'general',
  priority: 'later',
  maturity: 'idea',
  maturity_plan: 'idea',
  size: null,
  now_category: [],
  priority_reason: null,
  inbox: { by: 'owner', at: '2026-11-20T07:00:00.000Z' },
  proposal: PROPOSAL,
  ...o,
});
const DATA = {
  changed: '2026-11-20T08:30:00.000Z',
  projects: { general: { title: 'General' }, app: { title: 'App' } },
  entries: [plan(), { id: 'PL-THEME', title: 'Themes', priority: 'later', maturity: 'planned', inbox: null }],
};

/** triage.js in jsdom with the helpers plans.js gives it; `answer` is what the fake server says. */
function setup({ on = true, p = plan() as any, answer = { ok: true, log: 9, message: 'Accepted.' } as any, fail = null as string | null } = {}) {
  const w: any = { QueuePlanView: V };
  new Function('window', triageJs)(w);
  const calls: { post: [string, Post][]; message: [string, boolean][]; undo: [string, () => void][]; refresh: number } = {
    post: [],
    message: [],
    undo: [],
    refresh: 0,
  };
  const st: any = {};
  const h: any = {
    el,
    featureOn: () => on,
    data: () => ({ ...DATA, entries: [p, DATA.entries[1]] }),
    triage: () => st,
    setTriage: (change: Post) => {
      Object.assign(st, change);
      redraw();
    },
    post: async (path: string, body: Post) => {
      calls.post.push([path, body]);
      if (fail) {
        const e: any = new Error(fail);
        e.status = 409;
        throw e;
      }
      return path === '/api/plan-undo' ? { ok: true, message: 'Undone (one change).' } : answer;
    },
    message: (t: string, error = false) => calls.message.push([t, error]),
    undoToast: (t: string, fn: () => void) => calls.undo.push([t, fn]),
    refresh: async () => {
      calls.refresh += 1;
    },
  };
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  function redraw() {
    const b = w.QueuePlanTriage.block(h, p);
    root.replaceChildren(...(b ? [b] : []));
  }
  redraw();
  return { w, h, calls, root, st, redraw };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const button = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('button')].find((b) => (b.textContent ?? '').startsWith(text)) as HTMLButtonElement;

describe('an Inbox row with a proposal', () => {
  it('reads "Claude suggests: ..." with the reason, the summary and the duplicate, before the buttons', () => {
    const { root } = setup();
    const g = root.querySelector('.plans-triage') as HTMLElement;
    expect(g.getAttribute('role')).toBe('group');
    const says = root.querySelector('.plans-triage-says') as HTMLElement;
    expect(says.textContent).toBe('Claude suggests: App · Now (important) · Investigated · size M');
    expect(g.getAttribute('aria-labelledby')).toBe(says.id);
    expect(root.querySelector('.plans-triage-because')?.textContent).toBe('Because: Rule 4: many readers ask for it.');
    expect(root.querySelector('.plans-triage-summary')?.textContent).toBe('New summary: A dark theme for night reading.');
    expect(root.querySelector('.plans-triage-merge')?.textContent).toBe('Looks like PL-THEME, Themes');
    expect(root.querySelector('details.plans-triage-outline summary')?.textContent).toBe('Suggested outline');
    // the words come before the buttons in reading order
    const all = [...g.querySelectorAll('.plans-triage-says, button')];
    expect(all[0]).toBe(says);
  });
  it('the buttons: Accept, Edit, Decline and Merge into PL-THEME, each with its key', () => {
    const { root } = setup();
    const b = [...root.querySelectorAll('.plans-triage-actions button')];
    expect(b.map((x) => x.getAttribute('data-action'))).toEqual(['accept', 'edit', 'decline', 'merge']);
    expect(b.map((x) => x.getAttribute('aria-keyshortcuts'))).toEqual(['1', '2', '3', '4']);
    expect(b[3].textContent).toMatch(/^Merge into PL-THEME/);
  });
  it('no Merge button without a duplicate', () => {
    const { root } = setup({ p: plan({ proposal: { ...PROPOSAL, merge: undefined } }) });
    expect(root.querySelector('[data-action="merge"]')).toBe(null);
  });
});

describe('a row without a proposal', () => {
  it('only Edit and Drop, and how to get a proposal', () => {
    const { root } = setup({ p: plan({ proposal: null }) });
    expect(root.querySelector('.plans-triage-says')?.textContent).toMatch(/No suggestion yet.*\/plans inbox/);
    const b = [...root.querySelectorAll('.plans-triage-actions button')];
    expect(b.map((x) => x.getAttribute('data-action'))).toEqual(['edit', 'decline']);
    expect(b.map((x) => (x.textContent ?? '').replace(/\d$/, ''))).toEqual(['Edit', 'Drop']);
    expect(b.map((x) => x.getAttribute('aria-keyshortcuts'))).toEqual(['2', '3']);
  });
  it('nothing outside the Inbox, and nothing with features.plans.inbox off', () => {
    expect(setup({ p: plan({ inbox: null }) }).root.querySelector('.plans-triage')).toBe(null);
    expect(setup({ on: false }).root.querySelector('.plans-triage')).toBe(null);
  });
});

describe('Accept', () => {
  it('saves at once with the register version, offers Undo, and Undo sends the changelog number', async () => {
    const { root, calls } = setup({ answer: { ok: true, log: 9, message: 'Accepted: PL-DARK-MODE-1 has left the inbox.' } });
    button(root, 'Accept').click();
    await flush();
    expect(calls.post[0]).toEqual(['/api/plan-proposal', { action: 'accept', id: 'PL-DARK-MODE-1', edits: {}, expect: DATA.changed }]);
    expect(calls.undo[0][0]).toBe('Accepted: PL-DARK-MODE-1 has left the inbox.');
    expect(calls.refresh).toBe(1);
    calls.undo[0][1]();
    await flush();
    expect(calls.post[1]).toEqual(['/api/plan-undo', { nr: [9] }]);
  });
  it('a refusal (for example 409, changed since) is said in words on the row', async () => {
    const { root, calls } = setup({ fail: 'The plan register has changed since. Look again.' });
    button(root, 'Accept').click();
    await flush();
    expect(calls.undo).toHaveLength(0);
    const err = root.querySelector('.plans-triage-error') as HTMLElement;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toBe('Not saved: The plan register has changed since. Look again.');
  });
});

describe('Edit then accept', () => {
  it('opens a form with the proposal\'s values; Accept sends the owner\'s edits', async () => {
    const { root, calls } = setup();
    button(root, 'Edit').click();
    const form = root.querySelector('form.plans-triage-form') as HTMLFormElement;
    expect(form).toBeTruthy();
    const project = form.querySelector('select[name="project"]') as HTMLSelectElement;
    expect(project.value).toBe('app');
    expect((form.querySelector('select[name="priority"]') as HTMLSelectElement).value).toBe('now');
    expect((form.querySelector('select[name="maturity"]') as HTMLSelectElement).value).toBe('investigated');
    expect((form.querySelector('select[name="size"]') as HTMLSelectElement).value).toBe('M');
    expect((form.querySelector('textarea[name="summary"]') as HTMLTextAreaElement).value).toBe('A dark theme for night reading.');
    expect((form.querySelector('input[name="now_category"][value="important"]') as HTMLInputElement).checked).toBe(true);
    // every control has a label
    for (const c of form.querySelectorAll('select, textarea, input[type="text"]'))
      expect(form.querySelector(`label[for="${c.id}"]`)).toBeTruthy();
    const size = form.querySelector('select[name="size"]') as HTMLSelectElement;
    size.value = 'L';
    size.dispatchEvent(new Event('change'));
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const [path, body] = calls.post[0];
    expect(path).toBe('/api/plan-proposal');
    expect(body).toMatchObject({ action: 'accept', id: 'PL-DARK-MODE-1', expect: DATA.changed });
    expect(body.edits).toMatchObject({ project: 'app', priority: 'now', now_category: ['important'], maturity: 'investigated', size: 'L', summary: 'A dark theme for night reading.' });
  });
  it('without a proposal the form starts from the plan as it is; Cancel and Escape close it', () => {
    const { root, st } = setup({ p: plan({ proposal: null }) });
    button(root, 'Edit').click();
    const form = root.querySelector('form.plans-triage-form') as HTMLFormElement;
    expect((form.querySelector('select[name="project"]') as HTMLSelectElement).value).toBe('general');
    expect((form.querySelector('select[name="priority"]') as HTMLSelectElement).value).toBe('later');
    // the categories only show for Now
    expect(form.querySelector('input[name="now_category"]')).toBe(null);
    form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(st.edit).toBe(null);
  });
});

describe('Decline and Merge', () => {
  it('Decline opens a reason and Drop it; it sends the reason', async () => {
    const { root, calls } = setup({ answer: { ok: true, log: 10, message: 'Declined: dropped.' } });
    button(root, 'Decline').click();
    const panel = root.querySelector('.plans-triage-decline') as HTMLElement;
    const reason = panel.querySelector('input[name="reason"]') as HTMLInputElement;
    expect(panel.querySelector(`label[for="${reason.id}"]`)).toBeTruthy();
    reason.value = 'Not for this product.';
    reason.dispatchEvent(new Event('input'));
    button(panel, 'Drop it').click();
    await flush();
    expect(calls.post[0]).toEqual(['/api/plan-proposal', { action: 'decline', id: 'PL-DARK-MODE-1', reason: 'Not for this product.', expect: DATA.changed }]);
    expect(calls.undo).toHaveLength(1);
  });
  it('the panel can merge into any other plan, the duplicate first', async () => {
    const { root, calls } = setup();
    button(root, 'Decline').click();
    const sel = root.querySelector('select[name="merge-to"]') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['PL-THEME']);
    button(root.querySelector('.plans-triage-decline') as HTMLElement, 'Merge').click();
    await flush();
    expect(calls.post[0]).toEqual(['/api/plan-proposal', { action: 'merge', id: 'PL-DARK-MODE-1', to: 'PL-THEME', expect: DATA.changed }]);
  });
  it('Merge into PL-THEME on the row merges at once, with Undo', async () => {
    const { root, calls } = setup({ answer: { ok: true, log: 11, message: 'Merged.' } });
    button(root, 'Merge into PL-THEME').click();
    await flush();
    expect(calls.post[0][1]).toMatchObject({ action: 'merge', to: 'PL-THEME' });
    expect(calls.undo).toHaveLength(1);
  });
  it('Escape closes the panel', () => {
    const { root, st } = setup();
    button(root, 'Decline').click();
    (root.querySelector('.plans-triage-decline') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(st.decline).toBe(null);
  });
});

describe('the keys', () => {
  it('1 Accept, 2 Edit, 3 Decline, 4 Merge; 1 and 4 do nothing without a proposal or a duplicate', async () => {
    let s = setup();
    expect(s.w.QueuePlanTriage.key(s.h, s.h.data().entries[0], '2')).toBe(true);
    expect(s.st.edit?.id).toBe('PL-DARK-MODE-1');
    expect(s.w.QueuePlanTriage.key(s.h, s.h.data().entries[0], '3')).toBe(true);
    expect(s.st.decline?.id).toBe('PL-DARK-MODE-1');
    expect(s.w.QueuePlanTriage.key(s.h, s.h.data().entries[0], '1')).toBe(true);
    await flush();
    expect(s.calls.post[0][1]).toMatchObject({ action: 'accept' });
    s = setup({ p: plan({ proposal: null }) });
    expect(s.w.QueuePlanTriage.key(s.h, s.h.data().entries[0], '1')).toBe(false);
    expect(s.w.QueuePlanTriage.key(s.h, s.h.data().entries[0], '4')).toBe(false);
    s = setup({ p: plan({ inbox: null }) });
    expect(s.w.QueuePlanTriage.key(s.h, s.h.data().entries[0], '2')).toBe(false);
  });
  it('work.js sends the number keys on the Roadmap to the triage of the row with focus', () => {
    expect(workJs).toMatch(/h\.triageKey\?\.\(/);
  });
});

describe('the server call', () => {
  it('boardCall checks the body and builds the queue.mjs call with --set-by owner and --expect-changed', () => {
    const ok = R.boardCall({ action: 'accept', id: 'PL-DARK-MODE-1', edits: { size: 'L' }, expect: DATA.changed });
    expect(ok.error).toEqual([]);
    expect(ok.file).toEqual({ size: 'L' });
    expect(ok.args('/tmp/x.json')).toEqual([
      'plan', 'accept', 'PL-DARK-MODE-1', '--file', '/tmp/x.json', '--set-by', 'owner', '--by', 'theBoard', '--json',
      '--expect-changed', DATA.changed,
    ]);
    const d = R.boardCall({ action: 'decline', id: 'PL-DARK-MODE-1', reason: 'No.' });
    expect(d.file).toEqual({ reason: 'No.' });
    expect(d.args('/f')).toEqual(['plan', 'decline', 'PL-DARK-MODE-1', '--file', '/f', '--set-by', 'owner', '--by', 'theBoard', '--json']);
    const m = R.boardCall({ action: 'merge', id: 'PL-DARK-MODE-1', to: 'PL-THEME' });
    expect(m.file).toBe(null);
    expect(m.args(null)).toEqual(['plan', 'merge', 'PL-DARK-MODE-1', '--into', 'PL-THEME', '--set-by', 'owner', '--by', 'theBoard', '--json']);
    for (const bad of [
      { action: 'apply', id: 'PL-A' },
      { action: 'accept', id: '--all' },
      { action: 'accept', id: 'PL-A', edits: 'x' },
      { action: 'accept', id: 'PL-A', edits: { title: 'x' } },
      { action: 'merge', id: 'PL-A' },
      { action: 'merge', id: 'PL-A', to: 'PL-A' },
      { action: 'decline', id: 'PL-A', reason: 7 },
      { action: 'accept', id: 'PL-A', expect: 'yesterday' },
    ])
      expect(R.boardCall(bad).error.length).toBeGreaterThan(0);
  });
});

describe('the wiring', () => {
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('triage.js loads before plans.js and is served; plans.js and roadmap.js wire it in; plans.js stays read only', () => {
    expect(html.indexOf('/plans/triage.js')).toBeGreaterThan(0);
    expect(html.indexOf('/plans/plans.js')).toBeGreaterThan(html.indexOf('/plans/triage.js'));
    expect(server).toMatch(/'\/plans\/triage\.js': \[path\.join\('plans', 'triage\.js'\)/);
    expect(plansJs).toMatch(/window\.QueuePlanTriage/);
    expect(roadmapJs).toMatch(/h\.triageBlock\?\.\(/);
    expect(plansJs).not.toMatch(/method:\s*'POST'/);
    const urls = [...code(triageJs).matchAll(/'(\/api\/[a-z-]+)'/g)].map((m) => m[1]);
    expect([...new Set(urls)].sort()).toEqual(['/api/plan-proposal', '/api/plan-undo']);
  });
  it('the server: the route through the write guard, the module switch, the edits in a file, queue.mjs', () => {
    expect(server).toMatch(/filePath === '\/api\/plan-proposal'\) return planProposal\(b\)/);
    const fn = server.slice(server.indexOf('async function planProposal'), server.indexOf('// ---- Multi select'));
    expect(fn).toMatch(/FEATURES\['plans\.inbox'\]/);
    expect(fn).toMatch(/PROPOSALS\.boardCall\(b\)/);
    expect(fn).toMatch(/fs\.rmSync\(tmp/);
    expect(fn).toMatch(/planWriteAnswer\(/);
    expect(fn).not.toMatch(/renameSync|PLAN_FILE|writeFileSync\(PLAN/);
  });
  it('no innerHTML in triage.js; tokens only in its CSS', () => {
    expect(code(triageJs)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
    const start = css.indexOf('/* ---- Inbox proposals');
    expect(start).toBeGreaterThan(0);
    expect(css.slice(start)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

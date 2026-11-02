// =============================================================
// queueDecide.test.ts: `cq decide` (cli/decide.mjs), `approve` / `qa ok` with --by, and `cq board-setting cloud on|off`
// (cli/board.mjs), run as processes against a temporary queue (QUEUE_FOLDER, QUEUE_GIT, QUEUE_TIME_LOG), never the
// real one.
//
// Why: /cq:decide only runs the commands `cq decide --json` gives it, so the list, its order and the exact command
// per option are the contract. The owner's answers must be recorded as the owner's (--by owner), and the board's own
// switches must be settable from Claude Code (the Cloud tab is hidden by default).
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const KK = require('../queueConfig') as any;

const QUEUE = resolve(__dirname, '..', '..', 'queue.mjs');

let folder: string;
const env = () => ({
  ...process.env,
  QUEUE_FOLDER: folder,
  QUEUE_GIT: folder,
  QUEUE_TIME_LOG: join(folder, 'times.jsonl'),
});
const run = (...args: string[]) => execFileSync(process.execPath, [QUEUE, ...args], { env: env(), encoding: 'utf8' });
const queue = () => JSON.parse(readFileSync(join(folder, 'queue.json'), 'utf8'));

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cq-decide-'));
  writeFileSync(
    join(folder, 'queue.json'),
    JSON.stringify({
      tasks: [
        { id: 'T-1', title: 'Needs vendor', status: 'waiting', class: 'K', value: 3, waiting_on: ['Q-1'] },
        { id: 'T-2', title: 'After vendor', status: 'waiting', class: 'K', value: 3, depends_on: ['T-1'] },
        { id: 'T-5', title: 'Add export', status: 'proposed', class: 'K', value: 3 },
        { id: 'T-9', title: 'Login form', status: 'done', class: 'K', value: 2, qa_status: 'waiting' },
      ],
      question: {
        'Q-1': { type: 'question', text: 'Which vendor?', recommendation: 'Vendor B', choices: ['Vendor A', 'Vendor B'] },
      },
      resolved: [],
    }),
  );
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe('cq decide', () => {
  it('--json: every item with its impact line and the exact command per option, the question first', () => {
    const j = JSON.parse(run('decide', '--json'));
    expect(j.count).toBe(3);
    expect(j.listening).toBe(false);
    expect(j.items.map((x: any) => x.key)).toEqual(['decide:Q-1', 'approve:T-5', 'check:T-9']);
    const q = j.items[0];
    expect(q.nr).toBe(1);
    expect(q.impact_line).toMatch(/^unlocks 2 tasks/);
    expect(q.options.map((o: any) => [o.label, o.recommended, o.cli])).toEqual([
      ['Vendor B', true, 'cq resolve Q-1 --choice 2 --by owner'],
      ['Vendor A', false, 'cq resolve Q-1 --choice 1 --by owner'],
    ]);
    expect(q.free.cli).toBe('cq resolve Q-1 --answer "<text>" --by owner');
    expect(j.items[1].options.map((o: any) => o.cli)).toEqual([
      'cq approve T-5 --by owner',
      'cq cancel T-5 --remark declined --by owner',
    ]);
    expect(j.items[2].options.map((o: any) => o.cli)).toEqual(['cq qa ok T-9 --by owner', 'cq qa deviation T-9 "<text>"']);
    expect(j.decided).toEqual([]);
  });

  it('prints the list for a human, and never writes', () => {
    const before = readFileSync(join(folder, 'queue.json'), 'utf8');
    const out = run('decide');
    expect(out).toContain('Waiting on you: 3 decisions, most impact first');
    expect(out).toContain('1. DECIDE  Q-1  Which vendor?');
    expect(out).toContain('Vendor B (recommended)');
    expect(out).toContain('cq approve T-5 --by owner');
    expect(run('decide', '--max', '1')).toContain('... and 2 more');
    expect(readFileSync(join(folder, 'queue.json'), 'utf8')).toBe(before);
  });

  it('the commands it lists record the owner, and the answers show under --today', () => {
    run('resolve', 'Q-1', '--choice', '2', '--by', 'owner');
    run('approve', 'T-5', '--by', 'owner');
    run('qa', 'ok', 'T-9', '--by', 'owner');
    const q = queue();
    expect(q.tasks.find((o: any) => o.id === 'T-5').approved_by).toBe('owner');
    expect(q.tasks.find((o: any) => o.id === 'T-9').qa_ok_by).toBe('owner');
    const j = JSON.parse(run('decide', '--json'));
    expect(j.count).toBe(0);
    expect(j.decided.map((d: any) => [d.verb, d.id]).sort()).toEqual([
      ['approve', 'T-5'],
      ['check', 'T-9'],
      ['decide', 'Q-1'],
    ]);
    expect(run('decide')).toContain('Nothing waiting on you.');
    expect(run('decide', '--today')).toContain('Decided today: 3');
  });
});

describe('the board switches (Cloud tab hidden by default)', () => {
  it('board.showCloud is false by default; queue.json board wins over the config', () => {
    expect(KK.STANDARD.board.showCloud).toBe(false);
    expect(KK.boardSwitches({ board: {} }, null)).toEqual({ showCloud: false });
    expect(KK.boardSwitches({ board: { showCloud: true } }, null)).toEqual({ showCloud: true });
    expect(KK.boardSwitches({ board: { showCloud: true } }, { board: { showCloud: false } })).toEqual({ showCloud: false });
    expect(KK.boardSwitches({ board: { showCloud: 'yes' } }, { board: { showCloud: 1 } })).toEqual({ showCloud: false });
  });

  it('cq board-setting cloud on|off writes queue.json board.showCloud', () => {
    expect(run('board-setting')).toContain('Cloud tab: hidden');
    run('board-setting', 'cloud', 'on');
    expect(queue().board).toEqual({ showCloud: true });
    expect(run('board-setting')).toContain('Cloud tab: shown');
    run('board-setting', 'cloud', 'off');
    expect(queue().board.showCloud).toBe(false);
    expect(() => run('board-setting', 'cloud', 'maybe')).toThrow();
  });
});

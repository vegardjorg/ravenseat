// =============================================================
// doorShow.test.ts: the switch for door and blast radius (mergeDanger.show, friction review 22.11 Top 4).
//
// Locks: on (the default) changes nothing; off leaves the template sentence and the reviewer sentence out (with one
// short line so the agent files' standing ask is not followed), receive prints no DOOR line and stores no record, and
// a record stored before the switch is hidden from the board, decide and the PR body (lib/doorShow.js hideStored).
// The receive part runs queue.mjs against a temporary queue and git repo (as mergeDangerReceive.test.ts).
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
type Task = Record<string, unknown> & { id: string };
const DS = require('../doorShow.js') as {
  on: (cfg: unknown) => boolean;
  hideStored: <Q extends { tasks?: Task[] }>(queue: Q, cfg: unknown) => Q;
  trimTemplate: (text: string) => string;
  OFF_TRACK: string;
  OFF_REVIEWER: string;
};
const O = require('../../missionText.js') as { makeQueueCommon: (t: string, s: string, k?: unknown) => string };
const RES = require('../logic/results.js') as {
  reviewerPrompt: (o: { o: Task; type: string; folder: string; door?: boolean; classes?: string[] }) => string;
};
const R = require('../settingsRegistry.js') as { SETTINGS: { key: string; modes: string[]; type: string }[] };
const KK = require('../queueConfig.js') as { STANDARD: { mergeDanger?: { show?: unknown } } };
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'docs', 'mission-template.md'), 'utf8');
const OFF = { mergeDanger: { show: false } };

describe('the setting', () => {
  it('is a row in both modes, on in STANDARD, and only false turns it off', () => {
    const row = R.SETTINGS.find((r) => r.key === 'mergeDanger.show');
    expect(row?.type).toBe('onoff');
    expect(row?.modes).toEqual(['lite', 'full']);
    expect(KK.STANDARD.mergeDanger?.show).toBe(true);
    expect(DS.on({})).toBe(true);
    expect(DS.on({ mergeDanger: { show: 'no' } })).toBe(true);
    expect(DS.on(OFF)).toBe(false);
  });
});

describe('the mission and the reviewer prompt', () => {
  it('on: the shared protocol keeps the template sentence and has no off line', () => {
    const s = O.makeQueueCommon(TEMPLATE, '/scratch', {});
    expect(s).toMatch(/Also `Door: one-way` or `Door: two-way`/);
    expect(s).not.toContain(DS.OFF_TRACK);
  });

  it('off: the sentence is left out and one short line says so', () => {
    const s = O.makeQueueCommon(TEMPLATE, '/scratch', OFF);
    expect(s).not.toMatch(/`Door: one-way`/);
    expect(s).toContain(DS.OFF_TRACK);
    // The paragraph around it is intact.
    expect(s).toMatch(/each becomes an open item that `done` waits for\)\.\n\*\*Known bugs:\*\*/);
  });

  it('trimTemplate leaves a template without the sentence as it is', () => {
    expect(DS.trimTemplate('a\nb\n')).toBe('a\nb\n');
  });

  it('off: the reviewer prompt has no door sentence, only the off line', () => {
    const o = { id: 'A', class: 'D', branch: 'queue/A' };
    const on = RES.reviewerPrompt({ o, type: 'reviewer', folder: '/p', classes: ['other'] });
    expect(on).toMatch(/your own call on two lines/);
    const off = RES.reviewerPrompt({ o, type: 'reviewer', folder: '/p', classes: ['other'], door: false });
    expect(off).not.toMatch(/your own call on two lines/);
    expect(off).toContain(DS.OFF_REVIEWER);
  });
});

describe('a record stored before the switch', () => {
  const queue = { tasks: [{ id: 'A', merge_danger: { door: 'one-way', blast: 'data' } }, { id: 'B' }] };

  it('is kept as it is while on (the same object)', () => {
    expect(DS.hideStored(queue, {})).toBe(queue);
  });

  it('is hidden while off, and the queue itself is not changed', () => {
    const shown = DS.hideStored(queue, OFF);
    expect(shown.tasks?.map((t) => 'merge_danger' in t)).toEqual([false, false]);
    expect(queue.tasks[0].merge_danger).toEqual({ door: 'one-way', blast: 'data' });
  });
});

// ---- receive against a temporary queue ----------------------------------------------------------------------------
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

const setup = (report: string, config: unknown) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-door-'));
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
  put('src/a.js', 'module.exports = 1;\n');
  g(['commit', '-q', '-m', 'start']);
  g(['switch', '-q', '-c', 'queue/A']);
  put('src/a.js', 'module.exports = 2;\n');
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
    owned_files: ['src/a.js'],
    started: '2026-01-01T00:00:00.000Z',
    branch: 'queue/A',
    migr_block: null,
    scratchpad: scratch,
    // A record from a receive while the switch was on.
    merge_danger: { door: 'two-way', blast: 'local', at: '2026-01-01T00:00:00.000Z' },
  };
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: task.started, limits: {}, next_migr: 3600, resolved: [], tasks: [task] }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'A', 'track-result.md'), report);
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
  const task0 = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks[0];
  return { receive, task0 };
};

const RESULT = 'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-\n\n';

describe('ravenseat decide with mergeDanger.show off', () => {
  it('a delivery stored with a door and blast radius shows neither, and the delivery itself is still listed', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-door-decide-'));
    temporary.push(folder);
    const task = { id: 'T-9', title: 'Login form', status: 'done', class: 'K', value: 2, qa_status: 'waiting' };
    const md = { door: 'one-way', blast: 'users' };
    fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ tasks: [{ ...task, merge_danger: md }], resolved: [] }));
    const decide = (config: unknown) => {
      const configFile = path.join(folder, 'queue.config.json');
      fs.writeFileSync(configFile, JSON.stringify(config));
      const env = { ...process.env, QUEUE_FOLDER: folder, QUEUE_GIT: folder, QUEUE_CONFIG: configFile, QUEUE_TIME_LOG: path.join(folder, 'times.jsonl') };
      return execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), 'decide'], { env, encoding: 'utf8' });
    };
    expect(decide({})).toContain('Blast radius: users');
    const off = decide(OFF);
    expect(off).toContain('T-9');
    expect(off).not.toMatch(/Blast radius|One-way door/);
  });
});

describe('queue.mjs receive with mergeDanger.show off', () => {
  it('prints no DOOR line, stores no record, writes no package section, and the delivery goes to review', () => {
    const m = setup(`${RESULT}## Assumptions\nnone\n\nDoor: one-way\nBlast radius: data\n`, OFF);
    const r = m.receive();
    expect(r.stderr ?? '').toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/^DOOR:/m);
    const t = m.task0();
    expect(t.status).toBe('review');
    expect(t.merge_danger).toBeUndefined();
    expect(fs.readFileSync(path.join(t.review_package, '00-package.md'), 'utf8')).not.toMatch(/## Door and blast radius/);
  });
});

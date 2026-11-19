// =============================================================
// missionInlineMax.test.ts: a long inline mission moves to <dataFolder>/mission/<id>.md (roadmap 2c3 MISSION-INLINE-MAX).
//
// Why: a task without documents keeps its whole text in queue.json, and queue.json is read and written by every CLI
// command and every board refresh. A mission longer than queue.missionInlineMax characters (default 16000, 0 = off)
// is written to the mission folder by add and edit, in the same form the board and batch pack use, and the
// task stores the path. The agent's mission build reads the file as it always read a mission file.
//
// Proven where it is enforced: the pure rules in lib/missionInline.js, and queue.mjs (add, edit, trackFile)
// plus cli/context.mjs readMission against temporary folders, never the real queue.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MI = require('../missionInline.js') as {
  DEFAULT_MAX: number;
  inlineMax: (config: unknown) => number;
  needsMove: (mission: unknown, max: number) => boolean;
  sizeKb: (text: string) => number;
  chooseFile: (
    dir: string,
    id: string,
    text: string,
    o?: { fsLike?: unknown },
  ) => { file?: string; reused?: boolean; renamed?: boolean; error?: string };
  noteLine: (m: { id: string; path: string; kb: number; renamed?: boolean; reused?: boolean; taken?: string }) => string;
};

const ORCH = path.resolve(__dirname, '..', '..');
const QUEUE = path.join(ORCH, 'queue.mjs');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

type Task = Record<string, unknown> & { id: string; mission?: string };

/** A text of `n` characters with line breaks, so it is never mistaken for a path. */
const longText = (n: number, seed = 'x') => {
  const line = `${seed} The mission says what to build and how to check it. `;
  let s = '## Mission\n\n';
  while (s.length < n) s += `${line}\n`;
  return s.slice(0, n);
};

// ---- Pure ----------------------------------------------------------------------------------------------------------

describe('missionInline (pure)', () => {
  it('the limit: 16000 by default, 0 turns it off, a broken value reads as the default', () => {
    expect(MI.DEFAULT_MAX).toBe(16000);
    expect(MI.inlineMax({})).toBe(16000);
    expect(MI.inlineMax({ queue: { missionInlineMax: 0 } })).toBe(0);
    expect(MI.inlineMax({ queue: { missionInlineMax: 500 } })).toBe(500);
    for (const bad of [-1, 1.5, '200', null, true]) expect(MI.inlineMax({ queue: { missionInlineMax: bad } })).toBe(16000);
  });

  it('only a string longer than the limit moves, and never with the limit at 0', () => {
    expect(MI.needsMove('a'.repeat(101), 100)).toBe(true);
    expect(MI.needsMove('a'.repeat(100), 100)).toBe(false);
    expect(MI.needsMove('a'.repeat(5000), 0)).toBe(false);
    expect(MI.needsMove(undefined, 100)).toBe(false);
    expect(MI.needsMove({ text: 'x' }, 1)).toBe(false);
  });

  it('the size in KB is rounded and never 0', () => {
    expect(MI.sizeKb('a')).toBe(1);
    expect(MI.sizeKb('a'.repeat(20 * 1024))).toBe(20);
  });

  it('chooseFile: a free <id>.md, the same text reused, other text never overwritten (<id>+2.md)', () => {
    const files: Record<string, string> = {};
    const fsLike = {
      statSync: (f: string) => {
        if (!(f in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isFile: () => true };
      },
      readFileSync: (f: string) => files[f],
    };
    const dir = path.join('d', 'mission');
    const at = (n: string) => path.join(dir, n);
    expect(MI.chooseFile(dir, 'A', 'text', { fsLike })).toEqual({ file: at('A.md'), reused: false, renamed: false });
    files[at('A.md')] = 'text';
    expect(MI.chooseFile(dir, 'A', 'text', { fsLike })).toEqual({ file: at('A.md'), reused: true, renamed: false });
    files[at('A.md')] = 'other';
    expect(MI.chooseFile(dir, 'A', 'text', { fsLike })).toEqual({ file: at('A+2.md'), reused: false, renamed: true });
    files[at('A+2.md')] = 'other too';
    expect(MI.chooseFile(dir, 'A', 'text', { fsLike })).toEqual({ file: at('A+3.md'), reused: false, renamed: true });
  });

  it('chooseFile refuses when no free name is left, and a folder in the way is skipped', () => {
    const fsLike = {
      statSync: (f: string) => ({ isFile: () => !f.endsWith('B.md') }),
      readFileSync: () => 'taken',
    };
    const r = MI.chooseFile('m', 'B', 'text', { fsLike });
    expect(r.file).toBeUndefined();
    expect(r.error).toMatch(/no free file name/);
  });

  it('the NOTE line', () => {
    expect(MI.noteLine({ id: 'T1', path: 'scripts/.queue/mission/T1.md', kb: 18 })).toBe(
      'NOTE: T1: the mission (18 KB) was moved to scripts/.queue/mission/T1.md to keep queue.json small; the agent reads it as before.',
    );
    expect(MI.noteLine({ id: 'T1', path: 'm/T1+2.md', kb: 18, renamed: true, taken: 'm/T1.md' })).toBe(
      'NOTE: T1: the mission (18 KB) was moved to m/T1+2.md to keep queue.json small; the agent reads it as before. ' +
        'm/T1.md already holds other text, so it was left as it is.',
    );
    expect(MI.noteLine({ id: 'T1', path: 'm/T1.md', kb: 18, reused: true })).toBe(
      'NOTE: T1: the mission (18 KB) was moved to m/T1.md to keep queue.json small; the agent reads it as before. ' +
        'The file already held this text.',
    );
  });
});

// ---- queue.mjs against a temporary folder -------------------------------------------------------------------------

/** A temporary queue (data folder = QUEUE_ROOT, so a mission path is "mission/<id>.md") with an optional limit. */
function project(config: object = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-mission-max-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { stdio: 'ignore' });
  fs.writeFileSync(
    path.join(folder, 'queue.json'),
    JSON.stringify({ created: '2026-11-01T00:00:00.000Z', limits: {}, resolved: [], tasks: [] }),
  );
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  const tasks = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks as Task[];
  const get = (id: string) => tasks().find((t) => t.id === id)!;
  const task = (id: string, mission: string) => ({
    id,
    title: `Task ${id}`,
    domain: 'dom',
    class: 'K',
    mission,
    value: 5,
    content_min: 120,
  });
  const add = (id: string, mission: string, ...flags: string[]) => {
    const file = path.join(folder, `add-${id}.json`);
    fs.writeFileSync(file, JSON.stringify(task(id, mission)));
    return run('add', '--file', file, ...flags);
  };
  return { folder, env, run, tasks, get, task, add, missionDir: path.join(folder, 'mission') };
}

const NOTE = (id: string, p: string, kb: number) =>
  `NOTE: ${id}: the mission (${kb} KB) was moved to ${p} to keep queue.json small; the agent reads it as before.`;

describe('queue.mjs add and edit move a long inline mission', () => {
  it('under the limit nothing changes: the text stays inline and no file is written', () => {
    const p = project();
    const text = longText(16000);
    const r = p.add('U1', text);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(p.get('U1').mission).toBe(text);
    expect(fs.existsSync(p.missionDir)).toBe(false);
    expect(r.out).not.toContain('NOTE:');
  }, 60_000);

  it('over the limit (default 16000) the text moves to mission/<id>.md, the path is stored, the text is intact', () => {
    const p = project();
    const text = longText(20000);
    const r = p.add('O1', text);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(p.get('O1').mission).toBe('mission/O1.md');
    expect(fs.readFileSync(path.join(p.missionDir, 'O1.md'), 'utf8')).toBe(text);
    expect(r.out.split('\n')).toContain(NOTE('O1', 'mission/O1.md', MI.sizeKb(text)));
    // queue.json no longer carries the text.
    expect(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8')).not.toContain(text.slice(0, 200));
  }, 60_000);

  it('an existing file with other text is never overwritten: the mission goes to <id>+2.md and the line says so', () => {
    const p = project({ queue: { missionInlineMax: 100 } });
    fs.mkdirSync(p.missionDir);
    fs.writeFileSync(path.join(p.missionDir, 'C1.md'), 'the board wrote this');
    const text = longText(300);
    const r = p.add('C1', text);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(p.missionDir, 'C1.md'), 'utf8')).toBe('the board wrote this');
    expect(fs.readFileSync(path.join(p.missionDir, 'C1+2.md'), 'utf8')).toBe(text);
    expect(p.get('C1').mission).toBe('mission/C1+2.md');
    expect(r.out).toContain(
      `${NOTE('C1', 'mission/C1+2.md', 1)} mission/C1.md already holds other text, so it was left as it is.`,
    );
  }, 60_000);

  it('an existing file with the same text is reused, not written again', () => {
    const p = project({ queue: { missionInlineMax: 100 } });
    const text = longText(300);
    fs.mkdirSync(p.missionDir);
    fs.writeFileSync(path.join(p.missionDir, 'S1.md'), text);
    const r = p.add('S1', text);
    expect(r.code).toBe(0);
    expect(p.get('S1').mission).toBe('mission/S1.md');
    expect(fs.readdirSync(p.missionDir)).toEqual(['S1.md']);
    expect(r.out).toContain('The file already held this text.');
  }, 60_000);

  it('edit moves a long mission as well, and the changelog holds the path, not the text', () => {
    const p = project({ queue: { missionInlineMax: 100 } });
    expect(p.add('E1', 'Short.').code).toBe(0);
    const text = longText(400);
    const r = p.run('edit', 'E1', '--json', JSON.stringify({ mission: text }));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(p.get('E1').mission).toBe('mission/E1.md');
    expect(fs.readFileSync(path.join(p.missionDir, 'E1.md'), 'utf8')).toBe(text);
    expect(r.out).toContain(NOTE('E1', 'mission/E1.md', 1));
    const queue = JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.json'), 'utf8'));
    expect(JSON.stringify(queue.changelog)).not.toContain(text.slice(0, 200));
    // An edit of another field leaves an inline mission alone.
    expect(p.add('E2', 'Short too.').code).toBe(0);
    expect(p.run('edit', 'E2', '--json', JSON.stringify({ title: 'Renamed' })).out).not.toContain('NOTE:');
    expect(p.get('E2').mission).toBe('Short too.');
  }, 60_000);

  it('--answer-json (add, edit, also with --json input) carries the moved path and prints no NOTE line', () => {
    const p = project({ queue: { missionInlineMax: 100 } });
    const text = longText(300);
    const a = p.add('J1', text, '--answer-json');
    expect(a.code).toBe(0);
    expect(a.out.trim().split('\n')).toHaveLength(1);
    const aj = JSON.parse(a.out);
    expect(aj.ok).toBe(true);
    expect(aj.missionMoved).toEqual([{ id: 'J1', path: 'mission/J1.md', kb: 1, chars: 300, renamed: false, reused: false }]);

    expect(p.add('J2', 'Short.').code).toBe(0);
    const e = p.run('edit', 'J2', '--json', JSON.stringify({ mission: longText(300, 'y') }), '--answer-json');
    expect(e.code).toBe(0);
    expect(e.out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(e.out).missionMoved).toEqual([
      { id: 'J2', path: 'mission/J2.md', kb: 1, chars: 300, renamed: false, reused: false },
    ]);

    // add --json '{...}' (the task as JSON input) with --answer-json: the same one JSON line.
    const text3 = longText(300, 'z');
    const j = p.run('add', '--json', JSON.stringify(p.task('J3', text3)), '--answer-json');
    expect(j.err).toBe('');
    expect(j.code).toBe(0);
    expect(j.out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(j.out).missionMoved).toEqual([
      { id: 'J3', path: 'mission/J3.md', kb: 1, chars: 300, renamed: false, reused: false },
    ]);
    expect(p.get('J3').mission).toBe('mission/J3.md');
    expect(fs.readFileSync(path.join(p.missionDir, 'J3.md'), 'utf8')).toBe(text3);
    // The same --json input without --answer-json prints the NOTE line with the text answer.
    const k = p.run('add', '--json', JSON.stringify(p.task('J5', longText(300, 'w'))));
    expect(k.out).toContain(NOTE('J5', 'mission/J5.md', 1));

    // Without a move the answers are as before (no missionMoved field).
    expect(JSON.parse(p.add('J4', 'Short.', '--answer-json').out)).not.toHaveProperty('missionMoved');
    expect(JSON.parse(p.run('edit', 'J4', '--json', '{"title":"T"}', '--answer-json').out)).not.toHaveProperty(
      'missionMoved',
    );
  }, 60_000);

  it('queue.missionInlineMax 0 turns it off: a long mission stays inline', () => {
    const p = project({ queue: { missionInlineMax: 0 } });
    const text = longText(30000);
    const r = p.add('Z1', text);
    expect(r.code).toBe(0);
    expect(p.get('Z1').mission).toBe(text);
    expect(fs.existsSync(p.missionDir)).toBe(false);
    expect(r.out).not.toContain('NOTE:');
  }, 60_000);
});

// ---- The agent's mission build reads the moved file exactly as before ---------------------------------------------

describe('the agent reads a moved mission exactly as an inline one', () => {
  /** Adds T with `text`, marks it picked (as pick would) and returns the track file trackFile writes for it. */
  const trackFor = (config: object, text: string) => {
    const p = project(config);
    expect(p.add('T', text).code).toBe(0);
    const file = path.join(p.folder, 'queue.json');
    const q = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(q.tasks[0], { status: 'picked', picked_by: 'tester', branch: 'queue/T' });
    fs.writeFileSync(file, JSON.stringify(q));
    const out = path.join(p.folder, 'track.md');
    const r = p.run('trackFile', 'T', '--out', out);
    expect(r.code, r.err + r.out).toBe(0);
    return { p, track: fs.readFileSync(out, 'utf8') };
  };

  it('trackFile gives the same track block for the moved mission as for the same text inline', () => {
    const text = longText(500);
    const moved = trackFor({ queue: { missionInlineMax: 100 } }, text);
    const inline = trackFor({ queue: { missionInlineMax: 0 } }, text);
    expect(moved.p.get('T').mission).toBe('mission/T.md');
    expect(inline.p.get('T').mission).toBe(text);
    expect(moved.track).toContain(text);
    expect(moved.track).toBe(inline.track);
  }, 60_000);

  it('readMission (cli/context.mjs) returns the moved text and its path', () => {
    const p = project({ queue: { missionInlineMax: 100 } });
    const text = longText(500);
    expect(p.add('R1', text).code).toBe(0);
    // A small script in the temporary folder imports context.mjs with the same environment as the CLI.
    const script = path.join(p.folder, 'read-mission.mjs');
    fs.writeFileSync(
      script,
      `import { readMission, read } from ${JSON.stringify(pathToFileURL(path.join(ORCH, 'cli', 'context.mjs')).href)};\n` +
        "const o = read().tasks.find((x) => x.id === 'R1');\n" +
        'process.stdout.write(JSON.stringify(readMission(o)));\n',
    );
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: p.env });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ text, path: 'mission/R1.md' });
  }, 60_000);
});

// =============================================================
// queueFindings.test.ts: `ravenseat finding`, what a track reports outside its scope (lib/queueFindings.js, cli/finding.mjs).
//
// Locks: a finding lands as an idea in the plan register (PL-FINDING-<n>, priority later, set by agent), linked to the
// reporting task and its project; the same title (case, punctuation and spacing ignored) is deduplicated onto the
// existing entry; a finding counts as new until it is triaged; `orchestrator pulse`, `show` and `state` show the count.
// The CLI runs against a temporary queue folder, never the real queue.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Entry = Record<string, unknown> & {
  id: string;
  title: string;
  finding?: { tasks: string[]; files: string[]; count: number; reported: string; last: string };
};
type Reg = { entries: Entry[]; archive: Record<string, Entry>; changelog: unknown[] };

const FI = require('../queueFindings') as {
  findingKey: (t: string) => string;
  nextFindingId: (reg: Reg) => string;
  parseFiles: (raw: string | undefined) => { files: string[]; error: string[] };
  recordFinding: (
    reg: Reg,
    input: { title: string; detail?: string | null; task?: string | null; files?: string[]; project: string },
    ctx?: { projects?: object; now?: string },
  ) => { error: string[]; warnings: string[]; entry?: Entry; created?: boolean; duplicate?: string; finding?: boolean };
  isNewFinding: (e: Entry, tasks?: object[]) => boolean;
  findingsSummary: (reg: Reg, tasks?: object[]) => { new: number; ids: string[] };
  findingsLine: (s: { new: number; ids: string[] }, ravenseat?: string) => string | null;
};
const P = require('../queuePlan') as {
  emptyRegister: () => Reg;
  validateEntry: (e: object, ctx: object) => { error: string[] };
  editEntry: (reg: Reg, id: string, field: object, ctx?: object) => { error: string[] };
};

const PROJECTS = { app: { title: 'App', prefixes: ['A-'] }, web: { title: 'Web', prefixes: ['W-'] } };

describe('queueFindings (pure)', () => {
  it('normalizes titles for the duplicate check', () => {
    expect(FI.findingKey('  The Login  form: leaks the e-mail!! ')).toBe('the login form leaks the e mail');
    expect(FI.findingKey('Café crash')).toBe(FI.findingKey('cafe CRASH'));
  });

  it('a new finding is an idea, priority later as an agent, with the task, the files and the next id', () => {
    const reg = P.emptyRegister();
    reg.archive['PL-FINDING-4'] = { id: 'PL-FINDING-4', title: 'old' }; // ids are never reused
    const r = FI.recordFinding(
      reg,
      { title: 'Date parsing ignores the time zone', detail: 'utils/date.js line 40', task: 'A-1', files: ['utils/date.js'], project: 'app' },
      { projects: PROJECTS, now: '2026-11-02T10:00:00.000Z' },
    );
    expect(r.error).toEqual([]);
    expect(r.created).toBe(true);
    expect(r.entry).toMatchObject({
      id: 'PL-FINDING-5',
      title: 'Date parsing ignores the time zone',
      summary: 'utils/date.js line 40',
      project: 'app',
      priority: 'later',
      priority_set_by: 'agent',
      maturity: 'idea',
      finding: { tasks: ['A-1'], files: ['utils/date.js'], count: 1, reported: '2026-11-02T10:00:00.000Z' },
    });
    expect(P.validateEntry(r.entry!, { projects: PROJECTS }).error).toEqual([]);
    expect(FI.findingsSummary(reg)).toEqual({ new: 1, ids: ['PL-FINDING-5'] });
    expect(FI.findingsLine(FI.findingsSummary(reg))).toBe(
      'FINDINGS: 1 new from the tracks, not triaged (PL-FINDING-5): ravenseat finding list',
    );
    expect(FI.findingsLine({ new: 0, ids: [] })).toBeNull();
  });

  it('the same title again adds the task and files to the entry instead of a new one', () => {
    const reg = P.emptyRegister();
    FI.recordFinding(reg, { title: 'Flaky test in cart', task: 'A-1', files: ['a.ts'], project: 'app' }, { projects: PROJECTS });
    const again = FI.recordFinding(
      reg,
      { title: 'flaky TEST in cart.', task: 'W-2', files: ['a.ts', 'b.ts'], project: 'web' },
      { projects: PROJECTS, now: '2026-11-02T12:00:00.000Z' },
    );
    expect(again).toMatchObject({ duplicate: 'PL-FINDING-1', finding: true });
    expect(reg.entries).toHaveLength(1);
    expect(reg.entries[0].finding).toMatchObject({ tasks: ['A-1', 'W-2'], files: ['a.ts', 'b.ts'], count: 2, last: '2026-11-02T12:00:00.000Z' });
    // A plan entry that is not a finding with the same title: matched, and left alone.
    reg.entries.push({ id: 'PL-X-1', title: 'Export to CSV', project: 'app', priority: 'now', maturity: 'planned' });
    const known = FI.recordFinding(reg, { title: 'export to csv', task: 'A-1', project: 'app' }, { projects: PROJECTS });
    expect(known).toMatchObject({ duplicate: 'PL-X-1', finding: false });
    expect(reg.entries.find((p) => p.id === 'PL-X-1')).not.toHaveProperty('finding');
  });

  it('causes: the merged task(s) a finding is a defect of, kept apart from the reporting task and merged on a duplicate', () => {
    const reg = P.emptyRegister();
    const first = FI.recordFinding(reg, { title: 'Off by one', task: 'W-2', causes: ['A-1', 'A-1'], project: 'app' }, { projects: PROJECTS });
    expect(first.entry.finding).toMatchObject({ tasks: ['W-2'], causes: ['A-1'] });
    FI.recordFinding(reg, { title: 'off by ONE', task: 'W-3', causes: ['B-1'], project: 'app' }, { projects: PROJECTS });
    expect(reg.entries[0].finding.causes).toEqual(['A-1', 'B-1']);
    // Without --cause no field is written (older findings look the same), and the list row has an empty list.
    const plain = FI.recordFinding(reg, { title: 'Another', task: 'W-2', project: 'app' }, { projects: PROJECTS });
    expect(plain.entry.finding).not.toHaveProperty('causes');
    expect(FI.findingRows(reg, [], { all: true }).map((r: { causes: string[] }) => r.causes)).toEqual([['A-1', 'B-1'], []]);
  });

  it('stops being new when triaged: prioritized, matured, dropped or turned into queue tasks', () => {
    const fresh = () => {
      const reg = P.emptyRegister();
      FI.recordFinding(reg, { title: 'Slow query', task: 'A-1', project: 'app' }, { projects: PROJECTS });
      return reg;
    };
    let reg = fresh();
    expect(FI.isNewFinding(reg.entries[0])).toBe(true);
    expect(FI.isNewFinding(reg.entries[0], [{ id: 'A-9', plan: 'PL-FINDING-1' }])).toBe(false);
    expect(P.editEntry(reg, 'PL-FINDING-1', { maturity: 'investigated' }, { projects: PROJECTS }).error).toEqual([]);
    expect(FI.findingsSummary(reg).new).toBe(0);
    reg = fresh();
    const drop = { priority: 'drop', drop_reason: 'Not a problem.', priority_reason: 'Checked: works as intended.' };
    expect(P.editEntry(reg, 'PL-FINDING-1', drop, { projects: PROJECTS }).error).toEqual([]);
    expect(FI.findingsSummary(reg).new).toBe(0);
    // The tool owns the field: plan edit cannot set it.
    expect(P.editEntry(fresh(), 'PL-FINDING-1', { finding: null }, { projects: PROJECTS }).error.join()).toMatch(/finding is set by the tool/);
  });

  it('--files takes relative paths only, deduplicated', () => {
    expect(FI.parseFiles('src/a.ts, ./src/b.ts,src/a.ts,')).toEqual({ files: ['src/a.ts', 'src/b.ts'], error: [] });
    expect(FI.parseFiles('src\\c.ts').files).toEqual(['src/c.ts']);
    expect(FI.parseFiles('/etc/passwd,../x').error).toHaveLength(2);
    expect(FI.parseFiles(undefined)).toEqual({ files: [], error: [] });
    expect(FI.recordFinding(P.emptyRegister(), { title: '  !! ', project: 'app' }).error[0]).toMatch(/title is empty/);
  });
});

// ---- The CLI against a temporary queue folder ----
const QUEUE_MJS = path.resolve(__dirname, '..', '..', 'queue.mjs');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

describe('ravenseat finding (against a temporary queue)', () => {
  it('works in a fresh project with no projects registered, without asking an agent for anything it may not run', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-finding-'));
    temporary.push(folder);
    const queueFile = path.join(folder, 'queue.json');
    fs.writeFileSync(queueFile, JSON.stringify({ projects: {}, resolved: [], tasks: [] }));
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, '{}');
    const env = { ...process.env, QUEUE_FOLDER: folder, QUEUE_CONFIG: configFile, QUEUE_ROOT: folder, QUEUE_GIT: folder, QUEUE_TIME_LOG: path.join(folder, 'times.jsonl') };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [QUEUE_MJS, ...args], { encoding: 'utf8', env, cwd: folder });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    const projects = () => JSON.parse(fs.readFileSync(queueFile, 'utf8')).projects;
    // A preview writes nothing.
    expect(run('finding', 'Only a look', '--dry').code).toBe(0);
    expect(projects()).toEqual({});
    const first = run('finding', 'No linter in this project', '--detail', 'Why');
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/FINDING PL-FINDING-1: .* \(project general\)/);
    expect(first.out).not.toMatch(/WARNING/);
    expect(Object.keys(projects())).toEqual(['general']);
    // The next one lands in the same project, and it can be triaged.
    expect(run('finding', 'No tests either').out).toMatch(/PL-FINDING-2/);
    expect(run('plan', 'prioritize', 'PL-FINDING-1', 'owner', '--reason', 'Looked at it', '--set-by', 'owner').code).toBe(0);
  });
  it('records, deduplicates, lists, and shows the count in pulse, show and state', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-finding-'));
    temporary.push(folder);
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({
        projects: PROJECTS,
        resolved: [],
        tasks: [
          { id: 'A-1', title: 'a', domain: 'x', class: 'K', status: 'running', mission: 'm' },
          { id: 'Z-1', title: 'z', domain: 'x', class: 'K', status: 'waiting', mission: 'm' },
        ],
      }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, '{}');
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: folder,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [QUEUE_MJS, ...args], { encoding: 'utf8', env, cwd: folder });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    const reg = () => JSON.parse(fs.readFileSync(path.join(folder, 'plans.json'), 'utf8')) as Reg;

    const first = run('finding', 'Retry loop has no backoff', '--detail', 'net/retry.js', '--task', 'A-1', '--files', 'net/retry.js');
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/^FINDING PL-FINDING-1: "Retry loop has no backoff" from A-1, an idea in the plan register \(project app\)\./m);
    expect(reg().entries[0]).toMatchObject({ project: 'app', finding: { tasks: ['A-1'], files: ['net/retry.js'] } });

    const dup = run('finding', 'retry loop has NO backoff', '--task', 'Z-1', '--project', 'web');
    expect(dup.out).toMatch(/^Already reported as PL-FINDING-1: now 2 report\(s\) from A-1, Z-1\. Nothing new created\.$/m);
    expect(reg().entries).toHaveLength(1);

    // Z-1 has no registered project and there are two: the command asks for --project.
    const which = run('finding', 'Another thing', '--task', 'Z-1');
    expect(which.code).toBe(1);
    expect(which.error).toMatch(/Which project\? Z-1 has no registered project\. Give --project <pid> \(app, web\)/);
    expect(run('finding', 'x', '--task', 'NOPE').error).toMatch(/Unknown task NOPE/);
    expect(run('finding', 'x', '--cause', 'A-1,NOPE').error).toMatch(/Unknown task NOPE \(--cause/);
    expect(run('finding').error).toMatch(/Use: ravenseat finding "<title>"/);

    expect(run('finding', 'Second issue', '--task', 'A-1', '--dry').out).toMatch(/^Preview \(nothing written\): FINDING PL-FINDING-2/m);
    expect(reg().entries).toHaveLength(1);

    const line = /^FINDINGS: 1 new from the tracks, not triaged \(PL-FINDING-1\): ravenseat finding list$/m;
    expect(run('orchestrator', 'pulse', '--session', 'test').out).toMatch(line);
    expect(run('show').out).toMatch(line);
    expect(JSON.parse(run('state').out).findings).toEqual({ new: 1, ids: ['PL-FINDING-1'] });
    expect(run('finding', 'list').out).toMatch(/^NEW PL-FINDING-1\s+later\s+Retry loop has no backoff from A-1, Z-1 x2$/m);

    // Triage (drop) through the plan register: no longer new, still listed with --all.
    expect(run('plan', 'prioritize', 'PL-FINDING-1', 'drop', '--reason', 'Backoff is in the client.').code).toBe(0);
    expect(run('show').out).not.toMatch(/^FINDINGS:/m);
    expect(JSON.parse(run('state').out).findings).toEqual({ new: 0, ids: [] });
    expect(run('finding', 'list').out).toMatch(/^No new findings/m);
    expect(run('finding', 'list', '--all').out).toMatch(/^ {4}PL-FINDING-1\s+drop/m);
    // The write is in the plan changelog, so plan undo rolls the drop back.
    expect(run('plan', 'undo').code).toBe(0);
    expect(JSON.parse(run('state').out).findings.new).toBe(1);
    // --cause: the merged task(s) the finding is a defect of, saved as finding.causes and shown in the list.
    expect(run('finding', 'Totals are off by one', '--task', 'Z-1', '--cause', 'A-1', '--project', 'app').code).toBe(0);
    expect(reg().entries.find((p) => p.title === 'Totals are off by one')?.finding).toMatchObject({ tasks: ['Z-1'], causes: ['A-1'] });
    expect(run('finding', 'list').out).toMatch(/Totals are off by one from Z-1, caused by A-1$/m);
  }, 120_000);
});

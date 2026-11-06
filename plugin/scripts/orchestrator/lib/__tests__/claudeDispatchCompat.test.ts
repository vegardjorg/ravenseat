// =============================================================
// claudeDispatchCompat.test.ts: what the Claude flow prints and writes when tracks start, locked before the client
// adapter refactor (plans: client adapters, phase 0). fill, start and resume run against a copy of a queue in a
// temporary folder; their stdout, queue-fill.json and the mission files are compared with stored snapshots.
//
// Only what users and skills rely on is compared, normalized so a harmless difference in the test machine is not a
// regression: the temporary folder becomes <ROOT>, backslashes become slashes, shas become <SHA>, times become <TIME>.
// A change here is a change in what the orchestrator session reads: update the snapshot (vitest -u) only on purpose.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid', '-c', 'core.autocrlf=false'];
const temporary: string[] = [];
afterAll(() => temporary.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

type Task = Record<string, unknown> & { id: string; status: string };

const task = (id: string, cls: string, over: Record<string, unknown> = {}): Task => ({
  id,
  title: `Task ${id}`,
  domain: `domain-${id}`,
  class: cls,
  status: 'waiting',
  mission: `Mission text for ${id}: change the module and add a test.`,
  value: 5,
  owned_files: [`src/${id}.ts`],
  ...over,
});

function setup() {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-compat-')));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const g = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q', '-b', 'main']);
  // fill warns about an identity ravenseat merge would refuse; this locked output is for a project that has a working one.
  g(['config', 'user.name', 'queue-test']);
  g(['config', 'user.email', 'queue-test@queue-test.test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  const queue = {
    tasks: [task('K1', 'K'), task('D1', 'D'), task('U1', 'U'), task('P1', 'D+'), task('S1', 'K')],
    limits: { maxConcurrent: 5, maxDPlus: 1, maxPerDomain: 7, maxDb: 6, minFreeMemoryPct: 10 },
    next_migr: 100,
    resolved: [],
  };
  fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify(queue));
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ loadGuard: { minFreeMemoryPct: 10, allSlotsFreeMemoryPct: 40 } }));
  fs.mkdirSync(path.join(folder, 'docs'));
  fs.copyFileSync(path.join(ROOT, 'docs', 'mission-template.md'), path.join(folder, 'docs', 'mission-template.md'));
  const scratch = path.join(folder, 'scratch');
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        QUEUE_FOLDER: folder,
        QUEUE_CONFIG: configFile,
        QUEUE_ROOT: folder,
        QUEUE_GIT: repo,
        QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
        QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
        QUEUE_SCRATCHPAD: scratch,
        QUEUE_LOAD: 'free=100',
        TZ: 'UTC',
      },
    });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const head = g(['rev-parse', 'HEAD']).trim();
  /** A branch for the task, one commit ahead (what a track leaves before a fix round). */
  const branch = (id: string) => {
    g(['branch', `queue/${id}`]);
    g(['checkout', '-q', `queue/${id}`]);
    fs.writeFileSync(path.join(repo, `${id}.txt`), 'work\n');
    g(['add', '--', `${id}.txt`]);
    g(['commit', '-q', '-m', `work on ${id}`]);
    g(['checkout', '-q', 'main']);
  };
  const norm = (text: string) => normalize(text, folder, head);
  return { folder, scratch, run, norm, branch };
}

/** The temporary folder, path separators, the head sha and times out of a text, so it is the same on every machine. */
function normalize(text: string, folder: string, head: string): string {
  const forms = new Set([folder, folder.split(path.sep).join('/'), folder.split(path.sep).join('\\\\')]);
  let s = text.replace(/\r\n/g, '\n');
  for (const f of [...forms].sort((a, b) => b.length - a.length)) s = s.split(f).join('<ROOT>');
  // The head in full and every abbreviation of it (git and the queue print 7 to 12 characters).
  s = s.replace(/\b[0-9a-f]{7,40}\b/g, (m) => (head.startsWith(m) ? '<HEAD>' : m));
  return s
    .replace(/\\\\/g, '/')
    .replace(/\\/g, '/')
    .replace(/\b[0-9a-f]{40}\b/g, '<SHA>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<TIME>');
}

/** The stable fields of queue-fill.json (no time). */
function fillJson(scratch: string, norm: (s: string) => string) {
  const file = path.join(scratch, 'queue-fill.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { head?: string; track: Record<string, unknown>[] };
  // Normalize each string value, not the JSON text (a backslash there may be an escape).
  const deep = (v: unknown): unknown =>
    typeof v === 'string'
      ? norm(v)
      : Array.isArray(v)
        ? v.map(deep)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
          : v;
  return { head: j.head ? norm(j.head) : j.head, track: j.track.map(deep) };
}

const snap = (name: string) => path.join(__dirname, '__snapshots__', 'claudeDispatch', name);

describe('Claude dispatch output (locked before the adapter refactor)', () => {
  it('fill: stdout, queue-fill.json and the mission files for each class (K, D, D+, U)', async () => {
    const { scratch, run, norm } = setup();
    const r = run(['fill', '--scratchpad', scratch]);
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    await expect(norm(r.out)).toMatchFileSnapshot(snap('fill.stdout.txt'));
    const j = fillJson(scratch, norm);
    await expect(JSON.stringify(j, null, 2) + '\n').toMatchFileSnapshot(snap('fill.json'));
    const started = j.track.map((t) => String(t.id)).sort();
    expect(started).toEqual(['D1', 'K1', 'P1', 'S1', 'U1']);
    for (const id of started) {
      const prompt = fs.readFileSync(path.join(scratch, `prompt-${id}.md`), 'utf8');
      await expect(norm(prompt)).toMatchFileSnapshot(snap(`prompt-${id}.md`));
    }
    for (const f of ['queue-common.md', 'queue-track-fill.md']) {
      await expect(norm(fs.readFileSync(path.join(scratch, f), 'utf8'))).toMatchFileSnapshot(snap(f));
    }
  }, 120_000);

  it('start: the agent line for a waiting task', async () => {
    const { run, norm } = setup();
    const r = run(['start', 'S1']);
    expect(r.code).toBe(0);
    await expect(norm(r.out)).toMatchFileSnapshot(snap('start.stdout.txt'));
  }, 60_000);

  it('resume: a fix round writes a round prompt and prints the agent line', async () => {
    const { scratch, run, norm, branch } = setup();
    expect(run(['fill', '--scratchpad', scratch]).code).toBe(0);
    branch('K1');
    const r = run(['resume', 'K1', '--reason', 'fix', '--scratchpad', scratch]);
    expect(r.error).toBe('');
    expect(r.code).toBe(0);
    await expect(norm(r.out)).toMatchFileSnapshot(snap('resume.stdout.txt'));
    const round = fs.readdirSync(scratch).filter((f) => /^prompt-K1-r\d+\.md$/.test(f));
    expect(round.length).toBe(1);
    await expect(norm(fs.readFileSync(path.join(scratch, round[0]), 'utf8'))).toMatchFileSnapshot(
      snap('resume-prompt.md'),
    );
  }, 120_000);
});

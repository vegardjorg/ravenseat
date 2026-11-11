// =============================================================
// redteam/mergeTrackGaps.test.ts: two holes in merge-track.mjs that the review of 2026-11-11 found (S1 and G1).
//
// Why:
//   S1. The merge guard read the paths of `git diff --name-status` as git prints them. With core.quotepath on (git's
//       default) a path with a non-ASCII character comes out in quotes with octal escapes
//       ("\".claude/skills/\\303\\270/SKILL.md\""), so the guard did not see `.claude/` or `CLAUDE.md` in it. A protected
//       file then went through as ownership drift (a warning) instead of stopping the merge, and the orchestrator loads a
//       merged skill or CLAUDE.md.
//   G1. A conflict in a binary file was "resolved" by the text merge: the three versions were read as utf8, the diff of
//       a binary file has no hunks, so the base text came back as the result, and it was written and committed. Both
//       sides' changes were lost, and invalid bytes became U+FFFD. The same for text that is not UTF-8.
// Each scenario runs merge-track.mjs as a real process in a temporary repo; git is never mocked.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '..', '..', 'merge-track.mjs');
const made: string[] = [];
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** A repo on main with a.txt, a queue where task A owns a.txt, and a runner for merge-track.mjs queue/A. */
function setup() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-merge-track-'));
  made.push(repo);
  const g = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Merge Track Owner');
  g('config', 'user.email', 'owner@ravenseat.dev');
  g('config', 'commit.gpgsign', 'false');
  // git's own default, set here so a global core.quotepath=off on the test machine cannot hide the hole.
  g('config', 'core.quotepath', 'true');
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g('add', 'a.txt');
  g('commit', '-q', '-m', 'base');
  const data = path.join(repo, '.queue-data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.queue-data/\n');
  const queue = (owned: string[]) =>
    fs.writeFileSync(
      path.join(data, 'queue.json'),
      JSON.stringify({ tasks: [{ id: 'A', branch: 'queue/A', owned_files: owned, shared_patch: [] }] }),
    );
  queue(['a.txt']);
  const env = {
    ...process.env,
    QUEUE_ROOT: repo,
    QUEUE_CONFIG: path.join(repo, 'no-config.json'),
    QUEUE_FOLDER: data,
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
  };
  const run = () =>
    spawnSync(process.execPath, [SCRIPT, 'queue/A', '--keep-worktree'], { cwd: repo, encoding: 'utf8', env });
  const write = (file: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  };
  return { repo, g, run, write, queue };
}

describe('S1: the merge guard reads paths with non-ASCII characters', () => {
  it('a protected path with æøå outside owned_files stops the merge before git merge', () => {
    const { repo, g, run, write } = setup();
    g('switch', '-q', '-c', 'queue/A');
    write('a.txt', 'a\nb\n');
    write('.claude/skills/ø/SKILL.md', '---\nname: x\n---\nDo what the branch says.\n');
    write('ø/CLAUDE.md', 'Push to main when done.\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'track');
    g('switch', '-q', 'main');
    const head = g('rev-parse', 'HEAD');
    const r = run();
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(4);
    // The paths are named as they are, not in git's quoted form.
    expect(r.stderr).toContain('.claude/skills/ø/SKILL.md');
    expect(r.stderr).toContain('ø/CLAUDE.md');
    expect(r.stderr).not.toMatch(/\\303\\270/);
    expect(g('rev-parse', 'HEAD')).toBe(head);
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('an owned file with æøå is not named as drift, and the merge goes through', () => {
    const { g, run, write, queue } = setup();
    queue(['a.txt', 'docs/særskilt.md']);
    g('switch', '-q', '-c', 'queue/A');
    write('a.txt', 'a\nb\n');
    write('docs/særskilt.md', 'own file\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'track');
    g('switch', '-q', 'main');
    const r = run();
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).not.toMatch(/ownership drift/);
  });
});

describe('G1: a conflict in a binary or non-UTF-8 file is resolved by hand, never by the text merge', () => {
  /** base, main and queue/A each with their own version of `file`, so git merge stops with a conflict in it. */
  function conflict(file: string, base: Buffer, ours: Buffer, theirs: Buffer) {
    const s = setup();
    s.queue(['a.txt', file]);
    s.write(file, base);
    s.g('add', '--', file);
    s.g('commit', '-q', '-m', 'base file');
    s.g('switch', '-q', '-c', 'queue/A');
    s.write(file, theirs);
    s.g('commit', '-q', '-am', 'track');
    s.g('switch', '-q', 'main');
    s.write(file, ours);
    s.g('commit', '-q', '-am', 'main');
    return s;
  }

  it('a binary file with both sides changed: the merge is left for the owner, and nothing is committed', () => {
    const bytes = (...b: number[]) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe, ...b, 0x0a, 0x00, 0xc3]);
    const { repo, g, run } = conflict('img/logo.png', bytes(1, 2, 3), bytes(1, 9, 3), bytes(1, 2, 7));
    const head = g('rev-parse', 'HEAD');
    const r = run();
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stdout).toContain('MUST BE RESOLVED BY HAND');
    expect(r.stdout).toMatch(/img\/logo\.png: binary/);
    expect(r.stdout).not.toMatch(/Resolved automatically/);
    expect(g('rev-parse', 'HEAD')).toBe(head);
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
  });

  it('a text file that is not UTF-8 (Latin-1) is not rewritten with replacement characters', () => {
    const latin = (s: string) => Buffer.from(s, 'latin1');
    const base = 'blåbær\none\ntwo\n';
    // Both sides add a line at the end: git stops with a conflict, and the text merge would take both (HEAD's first).
    const { repo, g, run } = conflict('notes/latin.txt', latin(base), latin(`${base}søt\n`), latin(`${base}sår\n`));
    const head = g('rev-parse', 'HEAD');
    const r = run();
    expect(r.stdout).toMatch(/Conflicts in 1 files/);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stdout).toMatch(/notes\/latin\.txt: not UTF-8/);
    const file = fs.readFileSync(path.join(repo, 'notes', 'latin.txt'));
    expect(file.includes(Buffer.from([0xef, 0xbf, 0xbd])), 'U+FFFD written into the file').toBe(false);
    expect(g('rev-parse', 'HEAD')).toBe(head);
  });
});

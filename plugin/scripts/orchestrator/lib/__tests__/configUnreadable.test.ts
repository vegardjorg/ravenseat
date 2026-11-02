// =============================================================
// configUnreadable.test.ts: queue.config.json exists but does not parse (H3 in plans/review-2026-11-02.md).
//
// Why: a parse error used to give the default values in silence. With the defaults the base branch is "main", the
// migration guard and the deploy commands are gone and the gate lists are empty, so a push to production or a merge
// with zero gates could go through. Locks that config() reports the error (file, line, column) while still giving the
// defaults to `cq doctor`, that the CLI entry points stop with a clear message (doctor and help still run), and that
// the push guard's answer for an unreadable config asks (main session) or denies (queue agents) only the push,
// migration and deploy shaped commands. Temporary folders only.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { answerForHook, assessUnreadableConfig, commandsFromText, dangerousKind } from '../configGuard';
import { config, parseErrorPosition, readConfigFile } from '../queueConfig';

const ORCH = path.resolve(__dirname, '..', '..');
const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

/** A temporary project folder with a queue.config.json holding `text`. */
function project(text: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-badconfig-'));
  temporary.push(root);
  const file = path.join(root, 'queue.config.json');
  fs.writeFileSync(file, text);
  const data = path.join(root, 'q');
  fs.mkdirSync(data);
  const env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_CONFIG: file,
    QUEUE_FOLDER: data,
    QUEUE_GIT: root,
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
    QUEUE_HOOKS: path.join(root, 'no-hooks.json'),
    DISABLE_UPDATES: '1',
  };
  const run = (script: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ORCH, script), ...args], { encoding: 'utf8', env, cwd: root, timeout: 60_000 });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  return { root, file, data, run };
}

const BROKEN = '{\n  "baseBranch": "staging",\n  "deployCommands": ["npm run release"],\n}\n';

describe('config() on an unreadable queue.config.json', () => {
  it('gives the defaults plus configError with the file, line and column; a missing file is no error', () => {
    const p = project(BROKEN);
    const k = config({ root: p.root, fresh: true });
    expect(k.baseBranch).toBe('main');
    expect(k.configError).toMatchObject({ file: p.file, line: 4, column: 1 });
    expect(k.configError.message).toMatch(/JSON/);
    // Not enumerable: a JSON copy of the config does not carry it.
    expect(Object.keys(k)).not.toContain('configError');
    expect(readConfigFile(path.join(p.root, 'missing.json'))).toEqual({ own: {}, error: null });
  });

  it('a byte order mark is not an error; a file that is not one object is', () => {
    const p = project('﻿{ "baseBranch": "staging" }');
    expect(readConfigFile(p.file)).toEqual({ own: { baseBranch: 'staging' }, error: null });
    fs.writeFileSync(p.file, '[1, 2]');
    expect(readConfigFile(p.file).error?.message).toMatch(/one JSON object/);
  });

  it('parseErrorPosition reads line and column from the message, or counts them from the position', () => {
    expect(parseErrorPosition('Unexpected token } in JSON at position 30 (line 4 column 1)')).toEqual({ line: 4, column: 1 });
    expect(parseErrorPosition('Unexpected token } in JSON at position 6', '{\n "a",}')).toEqual({ line: 2, column: 5 });
    expect(parseErrorPosition('something else', '{}')).toBeNull();
  });
});

describe('the CLI stops instead of running on the defaults', () => {
  it('queue.mjs show and cq gates stop with the file, the position and a hint; nothing is written', () => {
    const p = project(BROKEN);
    const show = p.run('queue.mjs', 'show');
    expect(show.code).toBe(1);
    expect(show.error).toContain(`${p.file}:4:1`);
    expect(show.error).toMatch(/cannot be read/);
    expect(show.error).toMatch(/cq doctor/);
    const init = p.run('queue.mjs', 'init');
    expect(init.code).toBe(1);
    expect(fs.existsSync(path.join(p.data, 'queue.json'))).toBe(false);
    expect(fs.readFileSync(p.file, 'utf8')).toBe(BROKEN);
    const gates = p.run('cq.mjs', 'gates', '--quick');
    expect(gates.code).toBe(1);
    expect(gates.error).toMatch(/cannot be read/);
    const direct = p.run('gates.mjs', '--quick');
    expect(direct.code).toBe(1);
    expect(direct.error).toMatch(/cannot be read/);
  }, 60_000);

  it('cq doctor still runs and FAILs the config with the line and column; cq help still works', () => {
    const p = project(BROKEN);
    const d = p.run('queue.mjs', 'doctor');
    expect(d.code).toBe(1);
    expect(d.out).toMatch(/^FAIL {2}config {5}.*queue\.config\.json does not parse \(line 4, column 1\)/m);
    expect(d.out).toMatch(/the queue commands stop/);
    expect(p.run('cq.mjs', 'help').code).toBe(0);
  }, 60_000);
});

describe('the push guard answer while the config is unreadable (lib/configGuard.js)', () => {
  const error = { file: '/p/queue.config.json', message: 'x', line: 4, column: 1 };

  it('push, migration and deploy shaped commands: ask in the main session, deny for a queue agent', () => {
    for (const c of [
      'git push origin main',
      'git -C ../x push',
      'bash -c "git push --force origin main"',
      'npx supabase db push',
      'npm run db:migrate',
      'npx prisma migrate deploy',
      'vercel --prod',
      'fly deploy --remote-only',
      'npm test && firebase deploy',
      'terraform apply -auto-approve',
      'npm publish',
    ]) {
      expect(assessUnreadableConfig(c, { error })?.decision, c).toBe('ask');
      expect(assessUnreadableConfig(c, { error, guarded: true })?.decision, c).toBe('deny');
    }
    const a = assessUnreadableConfig('git push', { error });
    expect(a?.reason).toMatch(/^config unreadable: /);
    expect(a?.reason).toContain('/p/queue.config.json:4:1');
  });

  it('everything else gets no answer, and a readable config never does', () => {
    for (const c of ['git status', 'git commit -m "push the button"', 'npm test', 'npx tsc --noEmit', 'cat migrations.md']) {
      expect(dangerousKind(c), c).toBeNull();
      expect(assessUnreadableConfig(c, { error }), c).toBeNull();
    }
    expect(assessUnreadableConfig('git push', { error: null })).toBeNull();
  });

  it('the project commands named in the broken file are caught too (best effort)', () => {
    expect(commandsFromText(BROKEN)).toEqual(['npm run release']);
    expect(commandsFromText('{ "migrations": { "pushCommand": "node tools/apply.js" }, }')).toEqual(['node tools/apply.js']);
    const p = project(BROKEN);
    expect(answerForHook('npm run release', { file: p.file }, false)?.decision).toBe('ask');
    expect(answerForHook('npm run build', { file: p.file }, false)).toBeNull();
  });
});

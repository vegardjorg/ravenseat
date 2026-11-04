// =============================================================
// setup.test.ts: setup.mjs merges settings.queue.json into a project's .claude/settings.json.
//
// The hooks in settings.queue.json are the vendored install's copy of plugin/hooks/hooks.json. The test proves that a
// project set up before a hook was added gets the new hook next to the old ones (never twice), and that the two hook
// files list the same scripts.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'path';
// @ts-expect-error: plain ESM script without types
import { fillConfigFromProject, mergeSettings, PLUGIN_ROOT, setupProject } from '../setup.mjs';
import * as PB from '../lib/pushBatch';

type Hook = { type?: string; command: string; args?: string[]; timeout?: number };
type Settings = { hooks: Record<string, { matcher?: string; hooks: Hook[] }[]> } & Record<string, unknown>;

/** The command line of a hook: shell form has it all in `command`, exec form has the script in `args`. */
const line = (h: Hook) => [h.command, ...(h.args ?? [])].join(' ');

/** The hook scripts per event in a settings or hooks.json file. */
function scriptsPerEvent(s: Settings) {
  const out: Record<string, string[]> = {};
  for (const [event, groups] of Object.entries(s.hooks ?? {}))
    out[event] = groups.flatMap((g) => g.hooks.map((h) => /(hook-[\w-]+\.mjs)/.exec(line(h))?.[1] ?? line(h))).sort();
  return out;
}

describe('setup.mjs mergeSettings', () => {
  let target: string;
  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), 'queue-setup-'));
  });
  afterEach(() => rmSync(target, { recursive: true, force: true }));

  it('hooks.json and settings.queue.json list the same hook scripts per event', () => {
    const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const vendored = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'settings.queue.json'), 'utf8'));
    expect(scriptsPerEvent(vendored)).toEqual(scriptsPerEvent(plugin));
    expect(scriptsPerEvent(plugin).SubagentStop).toEqual(['hook-time.mjs', 'hook-track-end.mjs']);
  });

  it('every node hook in both files is exec form (command node, the script in args, no shell)', () => {
    const files: [string, string][] = [
      [join(PLUGIN_ROOT, 'hooks', 'hooks.json'), '${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator/'],
      [join(PLUGIN_ROOT, 'settings.queue.json'), '${CLAUDE_PROJECT_DIR}/scripts/orchestrator/'],
    ];
    for (const [file, prefix] of files) {
      const s: Settings = JSON.parse(readFileSync(file, 'utf8'));
      const hooks = Object.values(s.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
      expect(hooks.length).toBeGreaterThan(0);
      for (const h of hooks) {
        expect(h.command).toBe('node');
        expect(h.args).toHaveLength(1);
        const arg = h.args?.[0] ?? '';
        expect(arg.startsWith(prefix)).toBe(true);
        expect(arg.slice(prefix.length)).toMatch(/^hook-[\w-]+\.mjs$/);
        expect(typeof h.timeout).toBe('number');
      }
    }
  });

  it('shell-form queue hooks of an older install are rewritten to exec form, never added twice', () => {
    mkdirSync(join(target, '.claude'));
    const file = join(target, '.claude', 'settings.json');
    const own = { type: 'command', command: 'node tools/my-hook.mjs', timeout: 5 };
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: 'node "$CLAUDE_PROJECT_DIR/scripts/orchestrator/hook-track-context.mjs"',
                  timeout: 10,
                },
                own,
              ],
            },
          ],
          SubagentStop: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'node scripts/orchestrator/hook-time.mjs', timeout: 30 }],
            },
          ],
        },
      }),
    );
    const notes = mergeSettings(target, { hooks: true }).join('\n');
    expect(notes).toContain('hook made exec form: hook-track-context.mjs');
    expect(notes).toContain('hook made exec form: hook-time.mjs');
    const after: Settings = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.hooks.PostToolUse[0].hooks[0]).toEqual({
      type: 'command',
      command: 'node',
      args: ['${CLAUDE_PROJECT_DIR}/scripts/orchestrator/hook-track-context.mjs'],
      timeout: 10,
    });
    // The project's own hook is left as it is, and hook-track-context.mjs is not added a second time.
    expect(after.hooks.PostToolUse[0].hooks[1]).toEqual(own);
    expect(after.hooks.PostToolUse).toHaveLength(1);
    expect(scriptsPerEvent(after).SubagentStop).toEqual(['hook-time.mjs', 'hook-track-end.mjs']);
    // A second run changes nothing.
    const before = readFileSync(file, 'utf8');
    expect(mergeSettings(target, { hooks: true }).join('\n')).not.toMatch(/hook (made|\w+:)/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('an older install gets hook-track-end.mjs on SubagentStop, once', () => {
    mkdirSync(join(target, '.claude'));
    const file = join(target, '.claude', 'settings.json');
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          SubagentStop: [
            { matcher: '*', hooks: [{ type: 'command', command: 'node scripts/orchestrator/hook-time.mjs' }] },
          ],
        },
      }),
    );
    const notes = mergeSettings(target, { hooks: true }).join('\n');
    expect(notes).toContain('hook SubagentStop: hook-track-end.mjs');
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(scriptsPerEvent(after).SubagentStop).toEqual(['hook-time.mjs', 'hook-track-end.mjs']);
    // A second run adds nothing.
    mergeSettings(target, { hooks: true });
    expect(scriptsPerEvent(JSON.parse(readFileSync(file, 'utf8'))).SubagentStop).toEqual([
      'hook-time.mjs',
      'hook-track-end.mjs',
    ]);
  });

  const settingsFile = () => join(target, '.claude', 'settings.json');
  const read = () => JSON.parse(readFileSync(settingsFile(), 'utf8'));
  const pluginCommand = `node "${join(PLUGIN_ROOT, 'scripts', 'orchestrator', 'statusline.mjs').split('\\').join('/')}"`;

  it('statusLine: a plugin install writes the absolute plugin path, a vendored one the $CLAUDE_PROJECT_DIR form', () => {
    mergeSettings(target, { keys: true });
    expect(read().statusLine).toMatchObject({ type: 'command', command: pluginCommand, padding: 0 });
    rmSync(settingsFile());
    mergeSettings(target, { keys: true, hooks: true });
    expect(read().statusLine.command).toBe('node "$CLAUDE_PROJECT_DIR/scripts/orchestrator/statusline.mjs"');
  });

  it('statusLine: without --settings it is only recommended', () => {
    const notes = mergeSettings(target, {}).join('\n');
    expect(notes).toContain('recommended, not set');
    expect(notes).toContain('statusLine=');
  });

  it('statusLine: an old plugin path is refreshed, someone else`s status line is kept', () => {
    mkdirSync(join(target, '.claude'));
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        statusLine: { type: 'command', command: 'node "/old/cq/1.0.0/scripts/orchestrator/statusline.mjs"', padding: 1 },
      }),
    );
    mergeSettings(target, { keys: true });
    expect(read().statusLine).toEqual({ type: 'command', command: pluginCommand, padding: 1 });

    writeFileSync(settingsFile(), JSON.stringify({ statusLine: { type: 'command', command: 'my-line.sh' } }));
    const notes = mergeSettings(target, { keys: true }).join('\n');
    expect(notes).toContain('statusLine: kept your own');
    expect(read().statusLine).toEqual({ type: 'command', command: 'my-line.sh' });
  });
});

describe('setup.mjs records the plugin version it set up (for the setup notice on the board)', () => {
  let target: string;
  const before = process.env.QUEUE_FOLDER;
  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), 'queue-setup-rec-'));
    delete process.env.QUEUE_FOLDER;
  });
  afterEach(() => {
    rmSync(target, { recursive: true, force: true });
    if (before === undefined) delete process.env.QUEUE_FOLDER;
    else process.env.QUEUE_FOLDER = before;
  });
  const version = () => JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const recordFile = () => join(target, 'scripts', '.queue', 'setup.json');

  it('--settings in a plugin install writes <dataFolder>/setup.json with the plugin version', () => {
    const log = setupProject({ target, settings: true });
    expect(JSON.parse(readFileSync(recordFile(), 'utf8')).pluginVersion).toBe(version());
    expect(log.notes.join(' | ')).toContain(`setup record: plugin ${version()} (scripts/.queue/setup.json)`);
  });

  it('nothing without --settings, with --dry, or in a vendored install (hooks)', () => {
    setupProject({ target });
    setupProject({ target, settings: true, dry: true });
    setupProject({ target, settings: true, hooks: true });
    expect(existsSync(recordFile())).toBe(false);
  });
});

describe('setup.mjs --ci: the GitHub Actions template (opt-in, never over an existing workflow)', () => {
  let target: string;
  const before = process.env.QUEUE_CONFIG;
  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), 'queue-setup-ci-'));
    delete process.env.QUEUE_CONFIG;
  });
  afterEach(() => {
    rmSync(target, { recursive: true, force: true });
    if (before === undefined) delete process.env.QUEUE_CONFIG;
    else process.env.QUEUE_CONFIG = before;
  });
  const workflow = () => join(target, '.github', 'workflows', 'cq-gates.yml');

  it('writes nothing without --ci or with --dry', () => {
    setupProject({ target });
    setupProject({ target, ci: true, dry: true });
    expect(existsSync(workflow())).toBe(false);
  });

  it('writes the template with baseBranch filled in; it runs gates.quick, cancels old runs and has a path filter', () => {
    writeFileSync(join(target, 'queue.config.json'), JSON.stringify({ baseBranch: 'develop', gates: { quick: ['npm test'] } }));
    const log = setupProject({ target, ci: true });
    const text = readFileSync(workflow(), 'utf8');
    expect(log.notes.join(' | ')).toMatch(/\.github\/workflows\/cq-gates\.yml: written \(runs gates\.quick on push to develop/);
    expect(text).toMatch(/branches: \[develop\]/);
    expect(text).not.toContain('__BASE_BRANCH__');
    expect(text).toMatch(/jq -r '\(\.gates\.quick \/\/ \[\]\)\[\]' queue\.config\.json/);
    expect(text).toMatch(/# - uses: actions\/setup-node@v4/);
    expect(text).toMatch(/# - uses: gitleaks\/gitleaks-action@v2/);
    expect(PB.workflowCost(text)).toEqual({ push: true, concurrency: true, pathFilter: true });
  });

  it('never replaces an existing workflow, also not with --overwrite, and names other workflows', () => {
    mkdirSync(join(target, '.github', 'workflows'), { recursive: true });
    writeFileSync(workflow(), 'mine\n');
    const log = setupProject({ target, ci: true, overwrite: true });
    expect(readFileSync(workflow(), 'utf8')).toBe('mine\n');
    expect(log.notes.join(' | ')).toMatch(/cq-gates\.yml: kept \(already there; setup never overwrites a workflow\)/);
    rmSync(workflow());
    writeFileSync(join(target, '.github', 'workflows', 'build.yml'), 'on: push\n');
    const again = setupProject({ target, ci: true });
    expect(readFileSync(join(target, '.github', 'workflows', 'build.yml'), 'utf8')).toBe('on: push\n');
    expect(again.notes.join(' | ')).toMatch(/you already have build\.yml: check that they do not run the same checks twice/);
  });
});

describe('setup.mjs fillConfigFromProject', () => {
  const example = readFileSync(join(PLUGIN_ROOT, 'queue.config.example.json'), 'utf8');
  const fresh = (branch: string, pkg?: object) => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-setup-fill-'));
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', branch]);
    if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    return dir;
  };

  it('takes the current branch and the checks the project has, and keeps the comments', () => {
    const dir = fresh('master', { scripts: { test: 'node --test' } });
    const { text, notes } = fillConfigFromProject(example, dir);
    const c = JSON.parse(text);
    expect(c.baseBranch).toBe('master');
    expect(c.gates.quick).toEqual(['npm test']);
    expect(c.gates.full).toEqual(['npm test']);
    expect(c._baseGate).toBeTruthy();
    expect(notes.join('\n')).toContain('baseBranch master');
    rmSync(dir, { recursive: true, force: true });
  });

  it('no checks found: empty gates and a note, never a command the project does not have', () => {
    const dir = fresh('trunk');
    const { text, notes } = fillConfigFromProject(example, dir);
    const c = JSON.parse(text);
    expect(c.gates.quick).toEqual([]);
    expect(c.gates.full).toEqual([]);
    expect(notes.join('\n')).toContain('no check commands found');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('kickstart missingScripts', () => {
  const K = createRequire(import.meta.url)(join(PLUGIN_ROOT, 'scripts', 'orchestrator', 'lib', 'kickstart.js'));
  it('names scripts package.json does not have, and leaves other commands alone', () => {
    const pkg = JSON.stringify({ scripts: { test: 'x', lint: 'y' } });
    expect(K.missingScripts(['npm test', 'npm run lint', 'npm run build', 'npx tsc', 'pytest', 'yarn lint'], pkg)).toEqual(['npm run build']);
    expect(K.missingScripts(['npm test'], null)).toEqual(['npm test']);
  });
});

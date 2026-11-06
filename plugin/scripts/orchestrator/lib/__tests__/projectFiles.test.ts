// =============================================================
// projectFiles.test.ts: after a plugin update the project still has its own copies of the docs and the mission template,
// and a status line path with the old version in it. Locks what ravenseat doctor, ravenseat setup and the pure rules say about them.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const PF = require('../projectFiles.js');
const SCRIPTS = path.resolve(__dirname, '..', '..');
const PLUGIN = path.resolve(SCRIPTS, '..', '..');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const tmp = () => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-pf-')));
  temporary.push(d);
  return d;
};
const put = (root: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
/** A small plugin folder, and a project set up from it. */
function pair() {
  const plugin = tmp();
  const project = tmp();
  put(plugin, '.claude-plugin/plugin.json', JSON.stringify({ version: '1.2.3' }));
  put(plugin, 'docs/mission-template.md', 'new template\nline two\n');
  put(plugin, 'docs/guide.md', 'new guide\n');
  put(plugin, 'CLAUDE.queue.md', 'rules\n');
  put(project, 'docs/queue/mission-template.md', 'new template\nline two\n');
  put(project, 'docs/queue/guide.md', 'new guide\n');
  put(project, 'CLAUDE.queue.md', 'rules\n');
  return { plugin, project };
}

describe('staleFiles', () => {
  it('nothing to say when the copies match, also with other line endings', () => {
    const { plugin, project } = pair();
    put(project, 'docs/queue/mission-template.md', 'new template\r\nline two\r\n');
    expect(PF.staleFiles(plugin, project)).toMatchObject({ version: '1.2.3', changed: [], missing: [], mission: false });
    expect(PF.staleMessage(PF.staleFiles(plugin, project))).toBeNull();
  });
  it('names a mission template that differs, and says what it means and how to replace it', () => {
    const { plugin, project } = pair();
    put(project, 'docs/queue/mission-template.md', 'old template\n');
    const s = PF.staleFiles(plugin, project);
    expect(s.mission).toBe(true);
    expect(s.changed).toEqual(['docs/queue/mission-template.md']);
    expect(PF.staleMessage(s)).toMatch(/mission-template\.md differs from plugin 1\.2\.3/);
    expect(PF.staleMessage(s)).toMatch(/old instructions/);
    expect(PF.STALE_FIX).toContain('ravenseat setup --overwrite');
    expect(PF.STALE_FIX).toMatch(/edits .* lost/);
    expect(PF.STALE_FIX).toMatch(/commit/);
  });
  it('other files differing and new files missing are named too', () => {
    const { plugin, project } = pair();
    put(project, 'docs/queue/guide.md', 'old guide\n');
    put(plugin, 'docs/new.md', 'x\n');
    const s = PF.staleFiles(plugin, project);
    expect(s).toMatchObject({ mission: false, changed: ['docs/queue/guide.md'], missing: ['docs/queue/new.md'] });
    expect(PF.staleMessage(s)).toContain('docs/queue/guide.md');
    expect(PF.staleMessage(s)).toContain('docs/queue/new.md');
  });
  it('says nothing for a project that is not set up, or an install without a plugin manifest', () => {
    const { plugin, project } = pair();
    expect(PF.staleFiles(plugin, tmp())).toBeNull();
    fs.rmSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    expect(PF.staleFiles(plugin, project)).toBeNull();
  });
});

describe('staleStatusLines', () => {
  const line = (v: string) => JSON.stringify({ statusLine: { type: 'command', command: `node "C:/x/plugins/cache/ravenseat/ravenseat/${v}/scripts/orchestrator/statusline.mjs"` } });
  it('finds an old version in the shared and in the local settings', () => {
    const { plugin, project } = pair();
    put(project, '.claude/settings.json', line('0.8.14'));
    put(project, '.claude/settings.local.json', line('1.2.3'));
    expect(PF.staleStatusLines(plugin, project)).toEqual([{ file: '.claude/settings.json', version: '0.8.14' }]);
  });
  it('is quiet on the current version, a status line of your own and broken or missing files', () => {
    const { plugin, project } = pair();
    expect(PF.staleStatusLines(plugin, project)).toEqual([]);
    put(project, '.claude/settings.json', line('1.2.3'));
    put(project, '.claude/settings.local.json', '{ not json');
    expect(PF.staleStatusLines(plugin, project)).toEqual([]);
    put(project, '.claude/settings.json', JSON.stringify({ statusLine: { command: 'my-own.sh' } }));
    expect(PF.staleStatusLines(plugin, project)).toEqual([]);
  });
});

describe('through the commands', () => {
  function project() {
    const root = tmp();
    const g = (...a: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    put(root, 'README.md', 'x\n');
    g('add', 'README.md');
    g('commit', '-qm', 'start');
    return root;
  }
  it('ravenseat doctor warns about an old mission template and an old status line', () => {
    const root = project();
    put(root, 'docs/queue/mission-template.md', 'old template\n');
    put(root, '.claude/settings.json', JSON.stringify({ statusLine: { command: 'node "C:/x/ravenseat/0.0.1/scripts/orchestrator/statusline.mjs"' } }));
    const data = path.join(root, 'data');
    put(data, 'queue.json', JSON.stringify({ tasks: [], projects: {} }));
    put(root, 'queue.config.json', JSON.stringify({ baseBranch: 'main' }));
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'queue.mjs'), 'doctor', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, QUEUE_ROOT: root, QUEUE_FOLDER: data, QUEUE_CONFIG: path.join(root, 'queue.config.json'), QUEUE_GIT: root },
    });
    const checks = JSON.parse(r.stdout).checks as { name: string; status: string; message: string; fix?: string }[];
    const files = checks.find((c) => c.name === 'project files' && /mission-template/.test(c.message));
    expect(files?.status).toBe('WARN');
    expect(files?.fix).toContain('ravenseat setup --overwrite');
    const status = checks.find((c) => c.name === 'project files' && /status line/.test(c.message));
    expect(status?.status).toBe('WARN');
    expect(status?.message).toContain('0.0.1');
    expect(status?.fix).toContain('ravenseat setup --settings');
  });
  it('ravenseat setup names a kept file that differs, and says nothing about it after --overwrite', () => {
    const root = project();
    const setup = (...a: string[]) =>
      spawnSync(process.execPath, [path.join(SCRIPTS, 'setup.mjs'), '--target', root, ...a], { encoding: 'utf8', env: { ...process.env } });
    expect(setup().status).toBe(0);
    put(root, 'docs/queue/mission-template.md', 'old template\n');
    const again = setup();
    expect(again.stdout).toMatch(/mission-template\.md differs from plugin/);
    expect(again.stdout).toContain('ravenseat setup --overwrite');
    expect(setup('--overwrite').stdout).not.toMatch(/differs from plugin/);
    expect(fs.readFileSync(path.join(root, 'docs/queue/mission-template.md'), 'utf8')).toBe(fs.readFileSync(path.join(PLUGIN, 'docs/mission-template.md'), 'utf8'));
  });
});

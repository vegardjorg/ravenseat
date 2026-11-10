// =============================================================
// approvalLive.test.ts: the NEEDS APPROVAL card against a REAL Claude Code session (opt-in, never in CI).
//
// Why: the unit tests (queueApprovalWait.test.ts) feed the hook the input shape we saw once. Only a real session shows
// whether Claude Code still sends the Notification for a background agent's permission prompt, whether the agent's
// transcript is on disk by then, and whether the board ties the agent to its task. The first live run (2026-11-10) found
// two faults the unit tests could not: the board tied the agent to no task (the time log's start row had the agent id),
// and a claude started from inside another Claude Code session writes no transcripts (inherited CLAUDE_* variables).
//
// What it does: a temporary queue project with one running task, an interactive claude in its OWN console window
// (a permission prompt needs a terminal; `claude -p` refuses the call at once and sends no Notification) with a clean
// environment and a --settings file that wires the plugin's Notification and SubagentStart hooks. The prompt makes the
// main session start one background agent whose only job is a Write, which waits on the prompt. The test waits for
// approval-waits.json, then asks the real board (/api/state) and expects the task in "Waiting on you" with the tool.
// Nobody answers the prompt: the window is closed at the end, so the file is never written.
//
// Run (Windows, a logged-in claude on PATH, run from the repo root, which claude must already trust):
//   RAVENSEAT_LIVE_APPROVAL=1 npx vitest run plugin/scripts/orchestrator/__tests__/approvalLive.test.ts
// It costs a few cents of usage and takes about a minute. Skipped otherwise.
// =============================================================
import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const LIVE = process.env.RAVENSEAT_LIVE_APPROVAL === '1' && process.platform === 'win32';
const SCRIPTS = path.resolve(__dirname, '..');
const REPO = path.resolve(SCRIPTS, '..', '..', '..');
const slash = (p: string) => p.replace(/\\/g, '/');

/** Waits until `check` gives a value, or fails after `ms`. */
async function until<T>(what: string, ms: number, check: () => T | null | undefined | false): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** A clean environment: none of the host session's CLAUDE_* variables (they stop the child writing transcripts). */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC_BASE_URL$)/.test(k)) env[k] = v;
  return { ...env, ...extra };
}

describe.skipIf(!LIVE)('live: a background agent on a permission prompt shows as NEEDS APPROVAL', () => {
  it('the hook saves the wait and the board ties it to the running task', async () => {
    const id = `LIVE-${Date.now().toString(36).toUpperCase()}`;
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-live-approval-'));
    const target = path.join(folder, 'never-written.txt');
    const env = {
      QUEUE_ROOT: folder,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: path.join(folder, 'queue.config.json'),
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    };
    fs.writeFileSync(env.QUEUE_CONFIG, JSON.stringify({ baseBranch: 'main' }));
    const task = { id, title: 'live', status: 'running', class: 'K', domain: 'd', value: 5, content_min: 30, depends_on: [], waiting_on: [],
      owned_files: ['x.txt'], started: new Date().toISOString(), branch: `queue/${id}`, mission: 'x' };
    fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, resolved: [], tasks: [task] }));
    const hook = (file: string, timeout: number) => ({ type: 'command', command: 'node', args: [slash(path.join(SCRIPTS, file))], timeout });
    const settings = path.join(folder, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ hooks: {
      Notification: [{ matcher: 'permission_prompt', hooks: [hook('hook-approval-wait.mjs', 10)] }],
      SubagentStart: [{ matcher: '*', hooks: [hook('hook-time.mjs', 30)] }],
    } }));
    // No double quotes inside the prompt: it goes through PowerShell to claude as one argument.
    const prompt = `You are the orchestrator for track ${id}. Start exactly one background subagent with the Agent tool, run_in_background true, `
      + `subagent_type general-purpose. Its prompt is: You are track ${id}. Use the Write tool to create ${slash(target)} with the content x, then stop. `
      + 'After starting it, wait.';
    const starter = path.join(folder, 'start.ps1');
    fs.writeFileSync(starter, [
      `$p = Start-Process -FilePath 'claude' -WorkingDirectory '${REPO}' -PassThru -ArgumentList @('--permission-mode', 'default', '--settings', '${slash(settings)}', '"${prompt}"')`,
      '$p.Id',
    ].join('\r\n'));
    const started = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', starter], { encoding: 'utf8', env: cleanEnv(env) });
    const pid = Number(started.stdout.trim().split(/\s+/).at(-1));
    expect(pid, started.stderr).toBeGreaterThan(0);

    let board: ReturnType<typeof spawn> | null = null;
    try {
      const waitsFile = path.join(folder, 'approval-waits.json');
      const waits = await until('approval-waits.json', 240_000, () => fs.existsSync(waitsFile) && JSON.parse(fs.readFileSync(waitsFile, 'utf8')));
      const [agent] = Object.keys(waits);
      expect(waits[agent].tool).toBe('Write');
      // Nothing in the file but the agent id, the tool and the time.
      expect(JSON.stringify(waits)).not.toContain('never-written');

      const port = await new Promise<number>((done) => {
        const s = net.createServer().listen(0, '127.0.0.1', () => {
          const free = (s.address() as net.AddressInfo).port;
          s.close(() => done(free));
        });
      });
      const transcripts = path.join(os.homedir(), '.claude', 'projects', REPO.replace(/[^A-Za-z0-9]/g, '-'));
      board = spawn(process.execPath, [path.join(SCRIPTS, 'queue-board.mjs'), '--port', String(port)], {
        cwd: folder,
        env: { ...process.env, ...env, QUEUE_TRANSCRIPTS: transcripts },
      });
      let out = '';
      board.stdout!.on('data', (d: Buffer) => (out += String(d)));
      const open = await until('the board', 60_000, () => /Open: (http:\/\/[^/\s]+)\/#key=(\S+)/.exec(out));
      const state = await (await fetch(`${open[1]}/api/state`, { headers: { 'x-queue-key': open[2] } })).json();
      const stuck = state.data.inbox.stuck.find((x: { id: string }) => x.id === id);
      expect(stuck?.awaiting_approval?.tool, JSON.stringify(state.data.inbox.stuck)).toBe('Write');
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      board?.kill();
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)]);
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }, 360_000);
});

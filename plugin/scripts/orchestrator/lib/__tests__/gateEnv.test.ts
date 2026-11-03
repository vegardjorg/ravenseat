// =============================================================
// gateEnv.test.ts: the scrubbed environment for the gate commands (lib/gateEnv.js).
//
// Locks: (1) what node, npm, git and the shell need stays (PATH, HOME, USERPROFILE, TEMP, SystemRoot, ...), on Windows
// and Linux names; (2) the queue's location variables go (QUEUE_*, CLAUDE_PROJECT_DIR), the role marker stays;
// (3) a variable whose value points to the evidence store or the data folder goes (no case and "/" vs "\" on Windows);
// (4) tokens and cloud keys go (GITHUB_TOKEN, GH_TOKEN, *_TOKEN, *_SECRET, *_API_KEY, AWS_*, ANTHROPIC_API_KEY,
// OPENAI_API_KEY, SSH_AUTH_SOCK, npm's _authToken), a plain *_KEY of an unknown provider stays; (5) dropped lists names
// only, and FORCE_COLOR is 0.
// =============================================================
import { describe, expect, it } from 'vitest';

import * as GV from '../gateEnv';

const base = {
  PATH: '/usr/bin:/bin',
  Path: 'C:\\Windows\\system32',
  HOME: '/home/u',
  USERPROFILE: 'C:\\Users\\u',
  TEMP: 'C:\\Temp',
  TMPDIR: '/tmp',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  PATHEXT: '.COM;.EXE;.BAT',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  NODE_ENV: 'test',
  npm_config_cache: '/home/u/.npm',
  MY_FEATURE_KEY: 'on',
};

describe('gateEnv', () => {
  it('keeps what node, npm, git and the shell need, and sets FORCE_COLOR=0', () => {
    const { env, dropped } = GV.gateEnv(base, { platform: 'linux' });
    expect(env).toMatchObject(base);
    expect(env.FORCE_COLOR).toBe('0');
    expect(dropped).toEqual([]);
  });

  it('drops the queue location variables and CLAUDE_PROJECT_DIR, keeps the role marker', () => {
    const { env, dropped } = GV.gateEnv(
      {
        ...base,
        QUEUE_FOLDER: '/p/.queue',
        QUEUE_ROOT: '/p',
        QUEUE_CONFIG: '/p/queue.config.json',
        QUEUE_TIME_LOG: '/p/.queue/t.jsonl',
        CLAUDE_PROJECT_DIR: '/p',
        QUEUE_AGENT_ROLE: 'track',
        QUEUE_ATTEMPT: 'A-a1',
      },
      { platform: 'linux' },
    );
    expect(dropped).toEqual(['CLAUDE_PROJECT_DIR', 'QUEUE_CONFIG', 'QUEUE_FOLDER', 'QUEUE_ROOT', 'QUEUE_TIME_LOG']);
    expect(env.QUEUE_AGENT_ROLE).toBe('track');
    expect(env.QUEUE_ATTEMPT).toBe('A-a1');
  });

  it('drops a variable whose value points to the evidence store or the data folder', () => {
    const storePaths = ['C:\\p\\.queue\\gate-evidence.json', 'C:\\p\\.queue'];
    const { dropped } = GV.gateEnv(
      { ...base, MY_STORE: 'c:/P/.queue/gate-evidence.json', OTHER: 'x;C:\\p\\.queue;y', ROOT_ONLY: 'C:\\p' },
      { platform: 'win32', storePaths },
    );
    expect(dropped).toEqual(['MY_STORE', 'OTHER']);
    // On Linux the comparison keeps the case.
    expect(GV.gateEnv({ A: '/P/.queue' }, { platform: 'linux', storePaths: ['/p/.queue'] }).dropped).toEqual([]);
    expect(GV.gateEnv({ A: '/p/.queue/x' }, { platform: 'linux', storePaths: ['/p/.queue'] }).dropped).toEqual(['A']);
  });

  it('drops tokens and cloud keys, keeps a plain *_KEY of an unknown provider', () => {
    const secrets = {
      GITHUB_TOKEN: 'x',
      GH_TOKEN: 'x',
      NPM_TOKEN: 'x',
      CLAUDE_CODE_OAUTH_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'x',
      OPENAI_API_KEY: 'x',
      AWS_ACCESS_KEY_ID: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      AWS_REGION: 'eu-north-1',
      AZURE_CLIENT_SECRET: 'x',
      GOOGLE_APPLICATION_CREDENTIALS: '/k.json',
      SUPABASE_SERVICE_ROLE_KEY: 'x',
      MY_SERVICE_SECRET: 'x',
      DB_PASSWORD: 'x',
      SOME_API_KEY: 'x',
      SSH_AUTH_SOCK: '/tmp/agent',
      GIT_ASKPASS: '/askpass',
      'npm_config_//registry.npmjs.org/:_authToken': 'x',
      github_token: 'x',
    };
    const { env, dropped } = GV.gateEnv({ ...base, ...secrets }, { platform: 'linux' });
    expect(dropped).toEqual(Object.keys(secrets).sort());
    expect(env.MY_FEATURE_KEY).toBe('on');
    expect(env.NODE_ENV).toBe('test');
    for (const k of Object.keys(secrets)) expect(env).not.toHaveProperty(k);
  });

  it('the keep list wins over every other rule', () => {
    const { env } = GV.gateEnv({ PATH: '/p/.queue/bin:/usr/bin', TEMP: '/p/.queue' }, { platform: 'linux', storePaths: ['/p/.queue'] });
    expect(env.PATH).toBe('/p/.queue/bin:/usr/bin');
    expect(env.TEMP).toBe('/p/.queue');
    expect(GV.dropReason('Path', 'x', { windows: true })).toBeNull();
    expect(GV.dropReason('GITHUB_TOKEN', 'x')).toBe('secret');
    expect(GV.dropReason('QUEUE_FOLDER', 'x')).toBe('queue location');
  });

  it('skips undefined values and never lists a value', () => {
    const { env, dropped } = GV.gateEnv({ A: undefined, GH_TOKEN: 'secret-value' } as never, { platform: 'linux' });
    expect(env).not.toHaveProperty('A');
    expect(dropped).toEqual(['GH_TOKEN']);
    expect(JSON.stringify(dropped)).not.toContain('secret-value');
  });
});

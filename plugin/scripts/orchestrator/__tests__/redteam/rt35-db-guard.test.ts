// =============================================================
// redteam/rt35-db-guard.test.ts: RT-35 "a database probe gate runs against a shared database".
//
// Why: probes write rows and test refusals. With DATABASE_URL still pointing at a shared database (staging from an
// earlier session), the same gate run changes data other people rely on. With dbGuard.localOnly on, gates.mjs refuses
// a probe gate whose database is not local before it runs: red, one REFUSED line with the host, never the URL. A local
// database runs as before, and the guard is off by default. The gate here is a node command that writes a marker file
// (so the test sees whether it ran) and carries the word pgtap, which makes it a probe gate (lib/checksScan.js kind db):
// no database tool is needed. The fake password is joined at run time; the host is a reserved example domain.
// =============================================================
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { project, SCRIPTS, task } from './project';

const PW = ['rt', 'Pw', '35x', 'Qz'].join('');
const PROBE = `node -e "require('fs').writeFileSync('probe-ran.txt', 'pgtap')"`;

function probeProject(config: Record<string, unknown>, databaseUrl: string) {
  const p = project({ gates: [PROBE], config, tasks: [task('A')] });
  (p.env as Record<string, string | undefined>).DATABASE_URL = databaseUrl;
  const gates = () => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'gates.mjs'), '--quick'], { cwd: p.repo, env: p.env, encoding: 'utf8', timeout: 120_000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ran: fs.existsSync(path.join(p.repo, 'probe-ran.txt')) };
  };
  return { p, gates };
}

const SHARED = `postgresql://postgres:${PW}@db.shared.example.com:5432/postgres`;
const LOCAL = `postgresql://postgres:${PW}@127.0.0.1:54322/postgres`;

describe('RT-35: a probe gate and a shared database', () => {
  it('guard on, DATABASE_URL on a shared host: the probe is refused before it runs, and the URL is never shown', () => {
    const { gates } = probeProject({ dbGuard: { localOnly: true } }, SHARED);
    const r = gates();
    expect(r.code).toBe(1);
    expect(r.ran).toBe(false);
    expect(r.out).toContain('REFUSED (dbGuard.localOnly)');
    expect(r.out).toContain('db.shared.example.com');
    expect(r.out).not.toContain(PW);
  }, 150_000);

  it('guard on, a local database: the probe runs as before', () => {
    const { gates } = probeProject({ dbGuard: { localOnly: true } }, LOCAL);
    const r = gates();
    expect(r.code).toBe(0);
    expect(r.ran).toBe(true);
  }, 150_000);

  it('off by default: the probe runs whatever the database is (the setting is the owner\'s choice)', () => {
    const { gates } = probeProject({}, SHARED);
    const r = gates();
    expect(r.code).toBe(0);
    expect(r.ran).toBe(true);
  }, 150_000);
});

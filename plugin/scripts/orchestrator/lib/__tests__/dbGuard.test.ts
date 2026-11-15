// =============================================================
// dbGuard.test.ts: database probe gates only against a local database (lib/dbGuard.js, dbGuard.localOnly).
//
// Why: probes write and test refusals. Against a shared database the same run changes data other people rely on. The
// guard must refuse a probe gate whose URL, host or environment points elsewhere (a DATABASE_URL left on staging,
// `--linked`), let local ones through (localhost, 127.0.0.1, ::1, a Docker service name), never touch other gates, and
// never show the URL (it may hold a password). The fake password is joined at run time.
// =============================================================
import { describe, expect, it } from 'vitest';

import { hostsOf, isLocalHost, refusal } from '../dbGuard';

const PW = ['pw', 'Zq81', 'xLm'].join('');

describe('isLocalHost', () => {
  it('local: localhost, 127.x, ::1, a socket and a Docker service name without a dot', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '', '/var/run/postgresql', 'db', 'postgres', 'supabase_db_app'])
      expect(isLocalHost(h), h).toBe(true);
  });

  it('not local: a name with a dot, another IP address, another IPv6 address', () => {
    for (const h of ['db.example.com', 'staging.internal', '10.0.0.5', '192.168.1.20', 'fe80::1', '2001:db8::1', '1234'])
      expect(isLocalHost(h), h).toBe(false);
  });
});

describe('hostsOf', () => {
  it('reads the command first: a URL, --host, a PGHOST prefix and --linked', () => {
    expect(hostsOf(`pg_prove -d postgres://app:${PW}@db.example.com:5432/app supabase/tests`)).toEqual([{ host: 'db.example.com', from: 'the command' }]);
    expect(hostsOf('pg_prove --host 127.0.0.1 -d app tests/sql')).toEqual([{ host: '127.0.0.1', from: 'the command' }]);
    expect(hostsOf('PGHOST=staging.example.com pg_prove tests/sql')).toEqual([{ host: 'staging.example.com', from: 'the command' }]);
    expect(hostsOf('supabase test db --linked')[0]).toMatchObject({ remote: true });
    expect(hostsOf('pg_prove -d postgresql://[::1]:54322/postgres x')).toEqual([{ host: '::1', from: 'the command' }]);
  });

  it('falls back to DATABASE_URL, TEST_DATABASE_URL and PGHOST only when the command names none', () => {
    const env = { DATABASE_URL: `postgres://u:${PW}@staging.example.com/app`, PGHOST: 'other.example.com' };
    expect(hostsOf('supabase test db', env)).toEqual([
      { host: 'staging.example.com', from: 'DATABASE_URL' },
      { host: 'other.example.com', from: 'PGHOST' },
    ]);
    expect(hostsOf('pg_prove -h localhost tests/sql', env)).toEqual([{ host: 'localhost', from: 'the command' }]);
    expect(hostsOf('supabase test db', {})).toEqual([]);
  });
});

describe('refusal', () => {
  it('refuses a probe gate against a shared database and names the host, never the URL', () => {
    const line = refusal('supabase test db', { env: { DATABASE_URL: `postgresql://postgres:${PW}@db.abcdefgh.supabase.co:5432/postgres` } });
    expect(line).toMatch(/^REFUSED \(dbGuard\.localOnly\)/);
    expect(line).toContain('host db.abcdefgh.supabase.co (from DATABASE_URL)');
    expect(line).not.toContain(PW);
    expect(line).not.toContain('postgresql://');
    expect(refusal('supabase test db --linked')).toContain('the linked remote project');
    expect(refusal('pg_prove -d "postgres://%%bad" tests')).toMatch(/REFUSED/);
  });

  it('lets a local probe gate through, and one that names no database (the tools default to local)', () => {
    expect(refusal('supabase test db')).toBeNull();
    expect(refusal('pg_prove -h localhost -p 54322 -d postgres supabase/tests/*.sql')).toBeNull();
    expect(refusal('sqlx test', { env: { DATABASE_URL: 'postgres://postgres:postgres@db:5432/test' } })).toBeNull();
    expect(refusal('pg_prove tests/sql', { env: { DATABASE_URL: 'postgres://u@127.0.0.1/app' } })).toBeNull();
  });

  it('a package.json script counts as its body; other gates are never checked', () => {
    const scripts = { 'test:db': `pg_prove -d postgres://u:${PW}@staging.example.com/app tests/sql`, test: 'vitest run' };
    expect(refusal('npm run test:db', { scripts })).toMatch(/host staging\.example\.com/);
    const env = { DATABASE_URL: 'postgres://u@staging.example.com/app' };
    expect(refusal('npm test', { scripts, env })).toBeNull();
    expect(refusal('npx vitest run', { env })).toBeNull();
  });
});

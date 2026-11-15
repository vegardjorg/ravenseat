// =============================================================
// dbGuard.js: a database probe gate may only run against a local database (opt-in: dbGuard.localOnly).
//
// WHY: database probes (pgTAP via pg_prove, `supabase test db`, `sqlx test`) write rows, create roles and call
// functions that are meant to refuse. Against a local database that is the point, and a probe that writes runs in a
// transaction that is rolled back. Against a shared one (staging, a teammate's database, production by mistake) the same
// run changes data other people rely on, and a probe that does not roll back leaves it changed. The usual way it
// happens is quiet: DATABASE_URL in the shell still points at staging from an earlier session, or a command says
// --linked. With dbGuard.localOnly on, gates.mjs and the base gate check each probe gate command before it runs and
// refuse it (red, with one line) when its database is not local.
//
// Where a probe gate gets its database, in this order:
//   1. the command itself (or the package.json script it runs): a database URL (postgres://, postgresql://, mysql://,
//      mariadb://, mongodb://, mongodb+srv://, redis://, sqlserver://), `--host`/`-h <host>` (pg_prove, psql), a
//      `PGHOST=<host>` prefix, or `--linked` (`supabase test db --linked` runs against the linked remote project);
//   2. when the command names none: the gate environment's DATABASE_URL, TEST_DATABASE_URL and PGHOST.
//   Nothing named anywhere: the tool's own default, which is local for all of these tools, so the gate runs.
// Local: localhost (and *.localhost), 127.0.0.0/8, ::1, an empty host (a Unix socket), or a Docker service name without
// a dot (`db`, `postgres`, `supabase_db_app`). Anything else, and a URL that cannot be read, is refused. Only the host is
// ever shown, never the URL (it may hold a password).
// Which commands are probe gates: what lib/checksScan.js classifies as kind `db` (pg_prove, pgtap, supabase test db,
// sqlx test), also through a package.json script. Other gates are never checked, so a unit test with a remote
// DATABASE_URL in the environment is not refused by this.
//
//   isLocalHost(host)              is this host local?
//   hostsOf(command, env)          [{ host, from }] where the command's database is, or [] when nothing names one
//   refusal(command, { env, scripts })   null (fine, or not a probe gate) or the one line that refuses it
//
// Pure. Used by: gates.mjs, cli/baseHealth.mjs (through lib/baseHealth.js runBaseGate's guard). Tested in:
// lib/__tests__/dbGuard.test.ts, red team RT-35.
// =============================================================
'use strict';

const { classify, withScriptBody } = require('./checksScan.js');

const URL_RE = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|sqlserver):\/\/[^\s'"`]*/gi;
const HOST_FLAG = /(?:^|\s)(?:-h|--host)(?:=|\s+)(['"]?)([^\s'"]+)\1/g;
const PGHOST_PREFIX = /(?:^|\s)PGHOST=(['"]?)([^\s'"]*)\1/g;
const ENV_URLS = ['DATABASE_URL', 'TEST_DATABASE_URL'];

/** Is `host` local? See the header for the list. */
function isLocalHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true; // a Unix socket
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.startsWith('/')) return true; // PGHOST as a socket folder
  // A Docker (compose) service name: letters, digits, _ and -, no dot, and not a bare number.
  return /^[a-z][a-z0-9_-]*$/.test(h);
}

/** The host of a database URL, or undefined when it cannot be read (refused). Multi-host URLs: every host. */
function urlHosts(url) {
  const m = /^[a-z+]+:\/\/(?:[^@/?#]*@)?([^/?#]*)/i.exec(url);
  if (!m) return undefined;
  const list = m[1].split(',').map((x) => x.trim());
  // host:port, [v6]:port; percent-encoded socket paths are local.
  return list.map((hp) => {
    if (/^%2f/i.test(hp)) return '';
    const v6 = /^\[([^\]]*)\]/.exec(hp);
    if (v6) return v6[1];
    return hp.replace(/:\d*$/, '');
  });
}

/**
 * Where the command's database is: [{ host, from }] (`from`: the command, or the variable's name). A URL that cannot be
 * read gives { host: null }, which is never local. `--linked` gives { host: 'the linked remote project' }.
 * @param {string} command
 * @param {Record<string, string|undefined>} [env]
 */
function hostsOf(command, env = {}) {
  const c = String(command ?? '');
  const out = [];
  for (const m of c.matchAll(URL_RE)) {
    const hosts = urlHosts(m[0]);
    if (!hosts) out.push({ host: null, from: 'the command' });
    else for (const host of hosts) out.push({ host, from: 'the command' });
  }
  for (const m of c.matchAll(HOST_FLAG)) out.push({ host: m[2], from: 'the command' });
  for (const m of c.matchAll(PGHOST_PREFIX)) out.push({ host: m[2], from: 'the command' });
  if (/\bsupabase\b[^;&|]*\s--linked\b/.test(c)) out.push({ host: 'the linked remote project', from: 'the command', remote: true });
  if (out.length) return out;
  for (const name of ENV_URLS) {
    const v = env[name];
    if (typeof v !== 'string' || !v.trim()) continue;
    const hosts = urlHosts(v.trim());
    if (!hosts) out.push({ host: null, from: name });
    else for (const host of hosts) out.push({ host, from: name });
  }
  if (typeof env.PGHOST === 'string' && env.PGHOST.trim()) out.push({ host: env.PGHOST.trim(), from: 'PGHOST' });
  return out;
}

/**
 * The line that refuses a probe gate command whose database is not local, or null.
 * @param {string} command  the gate command as written in queue.config.json
 * @param {{ env?: Record<string, string|undefined>, scripts?: Record<string, string>, cli?: string }} [o]
 *   `env` the environment the gate gets, `scripts` package.json's scripts (a gate that runs one counts as its body).
 */
function refusal(command, { env = {}, scripts = {}, cli = 'ravenseat' } = {}) {
  const full = withScriptBody(String(command ?? ''), scripts ?? {});
  if (!classify(full).includes('db')) return null;
  const bad = hostsOf(full, env).filter((h) => h.remote || h.host === null || !isLocalHost(h.host));
  if (!bad.length) return null;
  const b = bad[0];
  const what = b.host === null ? 'a database URL that cannot be read' : b.remote ? b.host : `host ${b.host}`;
  return (
    `REFUSED (dbGuard.localOnly): this probe gate would run against ${what} (from ${b.from}), not a local database. ` +
    'Probes write and expect refusals, so they run only against localhost, 127.0.0.1, ::1 or a Docker service name. ' +
    `Start the local database and point the gate at it, or turn the guard off: ${cli} settings set dbGuard.localOnly off`
  );
}

module.exports = { isLocalHost, hostsOf, refusal };

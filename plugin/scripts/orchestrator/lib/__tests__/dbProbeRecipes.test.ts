// =============================================================
// dbProbeRecipes.test.ts: the database probe recipes (0i step 8, plans/feillogg-til-gater-2026-11-15.md sections 3.7,
// 3.8 and 3.9): recipes for the classes access-control and migration-schema, a local database told apart from a remote
// one, the setting learning.dbProbes (off by default), and the shared database guard in the "Build as gate" mission.
//
// Locks: (1) the plugin ships database recipes for both classes, for Supabase, Postgres and any other local database,
// each marked db, each naming the host check and the rollback in its own text, each pointing to the database cards that
// exist; (2) a database recipe is shown only with learning.dbProbes on AND a local database found, so off is the default
// and a remote-only database never gets one; a project recipe marked db without those conditions is left out and named;
// (3) the scan finds a local database in supabase/config.toml, a compose file with a database image, or testcontainers in
// the manifests, and not in a compose file without one; (4) the build task for a database class or recipe demands the
// host check before anything writes, the stop on any other host, the rollback, and says what dbGuard.localOnly does;
// a gate for any other class is unchanged; (5) the setting is in the registry and the defaults, off; (6) with the
// setting off the card says how to turn the recipes on, only where a local database is found.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const C = require('../checksCatalog.js');
const S = require('../checksScan.js');
const R = require('../findingRepeats.js');
const QC = require('../queueConfig.js');
const REG = require('../settingsRegistry.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const BUILTIN = path.resolve(__dirname, '..', '..', 'checks-catalog');
const NONE = path.join(BUILTIN, 'does-not-exist');
const DB_CLASSES = ['access-control', 'migration-schema'];
type Recipe = { id: string; class: string; when: string; title: string; text: string; cards: string[]; db?: boolean };

const fsLike = (files: Record<string, string>) => ({
  exists: (f: string) => f in files,
  read: (f: string) => files[f] ?? null,
  list: (dir: string) => Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)),
});

/** Facts for a project with a local database of one engine, the setting on or off. */
const local = (engine: string, from: string, o: object = {}) => ({ localDatabase: { engines: [engine], from: [from] }, hasDatabase: true, ...o });
const SUPABASE = { stacks: ['Node/TypeScript'], packs: { detected: ['supabase'] }, ...local('postgres', 'supabase/config.toml') };
const COMPOSE_PG = { stacks: ['Python'], ...local('postgres', 'docker-compose.yml') };
const COMPOSE_MYSQL = { stacks: ['Node'], ...local('mysql', 'compose.yaml') };
const on = (f: object) => ({ ...f, dbProbesOn: true });

describe('the database recipes the plugin ships', () => {
  const catalog = C.loadCatalog({ builtin: BUILTIN, own: NONE });
  const recipes: Recipe[] = catalog.recipes;
  const db = recipes.filter((r) => DB_CLASSES.includes(r.class));

  it('cover both database classes for Supabase, Postgres and any other local database, all marked db', () => {
    expect(catalog.errors).toEqual([]);
    for (const cls of DB_CLASSES) expect(db.filter((r) => r.class === cls).length, cls).toBeGreaterThanOrEqual(3);
    for (const r of db) expect(r.db, r.id).toBe(true);
    // Only the database classes carry the mark.
    for (const r of recipes.filter((x) => !DB_CLASSES.includes(x.class))) expect(r.db, r.id).not.toBe(true);
  });

  it('each one asks for the setting and a local database in its when, so off is the default', () => {
    for (const r of db) {
      expect(r.when, r.id).toMatch(/\bdb-probes-on\b/);
      expect(r.when, r.id).toMatch(/\bhas-local-database\b|\blocal-db:/);
    }
  });

  it('each text names the host check and the rollback, and points to the database cards that exist', () => {
    const keys = new Set(catalog.templates.map((t: { key: string }) => t.key));
    for (const r of db) {
      expect(r.text, r.id).toMatch(/localhost/);
      expect(r.text, r.id).toMatch(/roll(?:ed)? ?back|ROLLBACK/i);
      expect(r.text.length, r.id).toBeLessThanOrEqual(400);
      expect(r.cards.length, r.id).toBeGreaterThan(0);
      for (const k of r.cards) expect(keys.has(k), `${r.id} -> ${k}`).toBe(true);
    }
    const all = new Set(db.flatMap((r) => r.cards));
    for (const k of ['db-rules-probes', 'db-migrations-ci', 'db-shared-guard']) expect(all.has(k), k).toBe(true);
  });

  it('follow the stack: supabase test db for Supabase, pg_prove for Postgres, the own test runner for the rest', () => {
    expect(C.recipeFor('access-control', on(SUPABASE), recipes).text).toMatch(/supabase test db/);
    expect(C.recipeFor('migration-schema', on(SUPABASE), recipes).text).toMatch(/supabase db reset/);
    expect(C.recipeFor('access-control', on(COMPOSE_PG), recipes).text).toMatch(/pg_prove/);
    expect(C.recipeFor('migration-schema', on(COMPOSE_PG), recipes).cards).toContain('db-migrations-ci');
    const other = C.recipeFor('access-control', on(COMPOSE_MYSQL), recipes);
    expect(other.text).toMatch(/testcontainers|test runner/i);
    expect(other.text).not.toMatch(/pg_prove|supabase/);
  });

  it('are not shown with the setting off, without a local database, or for a remote one only', () => {
    for (const cls of DB_CLASSES) {
      expect(C.recipeFor(cls, SUPABASE, recipes), `${cls} off`).toBeNull();
      expect(C.recipeFor(cls, { ...SUPABASE, dbProbesOn: false }, recipes), `${cls} false`).toBeNull();
      expect(C.recipeFor(cls, on({ stacks: ['Node/TypeScript'], packs: { detected: ['supabase'] }, hasDatabase: true }), recipes), `${cls} remote`).toBeNull();
      expect(C.recipeFor(cls, on({ stacks: ['Node/TypeScript'], localDatabase: null }), recipes), `${cls} none`).toBeNull();
    }
  });
});

describe('a project database recipe', () => {
  const ownFolder = (recipes: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-dbrecipes-'));
    fs.writeFileSync(path.join(dir, 'recipes.json'), JSON.stringify(recipes));
    return dir;
  };
  const base = { class: 'access-control', title: 'Own probes', text: 'Our probes, only against localhost, rolled back.', cards: [] };

  it('marked db without the setting and a local database in its when is left out and named', () => {
    const own = ownFolder({
      recipes: [
        { ...base, id: 'own-db-loose', db: true, when: 'stack:supabase', examples: { hit: [{ packs: { detected: ['supabase'] } }], miss: [{}] } },
        {
          ...base,
          id: 'own-db-ok',
          db: true,
          when: 'db-probes-on, has-local-database',
          examples: { hit: [{ dbProbesOn: true, localDatabase: { engines: ['postgres'], from: ['x'] } }], miss: [{ dbProbesOn: true }] },
        },
      ],
    });
    const catalog = C.loadCatalog({ builtin: BUILTIN, own });
    expect(catalog.errors.join('\n')).toMatch(/own-db-loose: .*db-probes-on/);
    const ids = catalog.recipes.map((r: Recipe) => r.id);
    expect(ids).not.toContain('own-db-loose');
    expect(ids[0]).toBe('own-db-ok');
    expect(catalog.recipes[0].db).toBe(true);
  });

  it('db must be true or false', () => {
    const own = ownFolder({ recipes: [{ ...base, id: 'own-db-word', db: 'yes', when: '', examples: { hit: [{}], miss: [] } }] });
    expect(C.loadCatalog({ builtin: BUILTIN, own }).errors.join('\n')).toMatch(/own-db-word: "db" must be true or false/);
  });
});

describe('the conditions for a local database and the setting', () => {
  it('has-local-database, local-db:<engine> and db-probes-on read their facts, and unknown is no', () => {
    expect(C.holds('has-local-database', COMPOSE_PG)).toBe(true);
    expect(C.holds('has-local-database', { hasDatabase: true })).toBe(false);
    expect(C.holds('local-db:postgres', COMPOSE_PG)).toBe(true);
    expect(C.holds('local-db:postgres', COMPOSE_MYSQL)).toBe(false);
    expect(C.holds('local-db:mysql|postgres', COMPOSE_MYSQL)).toBe(true);
    expect(C.holds('db-probes-on', { dbProbesOn: true })).toBe(true);
    expect(C.holds('db-probes-on', {})).toBe(false);
  });
});

describe('the scan tells a local database from a remote one', () => {
  const ld = (files: Record<string, string>) => S.scan(fsLike(files)).localDatabase;

  it('supabase/config.toml is the local Supabase stack (Postgres)', () => {
    expect(ld({ 'supabase/config.toml': 'project_id = "app"' })).toEqual({ engines: ['postgres'], from: ['supabase/config.toml'] });
  });

  it('a compose file with a database image, with or without a registry and a tag', () => {
    const compose = 'services:\n  db:\n    image: "docker.io/library/postgres:16-alpine"\n  cache:\n    image: redis:7\n';
    expect(ld({ 'docker-compose.yml': compose })).toEqual({ engines: ['postgres'], from: ['docker-compose.yml'] });
    expect(ld({ 'compose.yaml': 'services:\n  db:\n    image: bitnami/mariadb:11\n' })).toEqual({ engines: ['mysql'], from: ['compose.yaml'] });
    expect(ld({ 'docker-compose.yaml': 'services:\n  m:\n    image: mongo\n' })).toEqual({ engines: ['mongo'], from: ['docker-compose.yaml'] });
    expect(ld({ 'compose.yml': 'services:\n  db:\n    image: supabase/postgres:15.1\n' })?.engines).toEqual(['postgres']);
  });

  it('a compose file with no database image, or one that only names a remote URL, is not a local database', () => {
    expect(ld({ 'docker-compose.yml': 'services:\n  web:\n    image: node:22\n    environment:\n      DATABASE_URL: postgres://u@db.example.com/app\n' })).toBeNull();
    // A commented line is not a service.
    expect(ld({ 'docker-compose.yml': 'services:\n  web:\n    # image: postgres:16\n    image: node:22\n' })).toBeNull();
    expect(ld({ 'src/index.ts': '' })).toBeNull();
  });

  it('testcontainers in package.json or the Python manifests is a throwaway database', () => {
    const pkg = (deps: object) => JSON.stringify({ devDependencies: deps });
    expect(ld({ 'package.json': pkg({ '@testcontainers/postgresql': '^10.0.0' }) })).toEqual({ engines: ['postgres'], from: ['package.json'] });
    expect(ld({ 'package.json': pkg({ testcontainers: '^10.0.0' }) })).toEqual({ engines: [], from: ['package.json'] });
    expect(ld({ 'pyproject.toml': '[project]\ndependencies = ["testcontainers[postgres]>=4"]\n' })).toEqual({ engines: ['postgres'], from: ['pyproject.toml'] });
    expect(ld({ 'requirements-dev.txt': 'pytest\ntestcontainers[mysql]==4.8\n' })).toEqual({ engines: ['mysql'], from: ['requirements-dev.txt'] });
  });

  it('a local database counts as a database for the database cards, and the sources are listed once each', () => {
    const r = S.scan(fsLike({ 'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n  db2:\n    image: postgis/postgis\n' }));
    expect(r.hasDatabase).toBe(true);
    expect(r.localDatabase).toEqual({ engines: ['postgres'], from: ['docker-compose.yml'] });
    const both = S.scan(fsLike({ 'supabase/config.toml': '', 'package.json': JSON.stringify({ devDependencies: { '@testcontainers/mysql': '1' } }) }));
    expect(both.localDatabase).toEqual({ engines: ['postgres', 'mysql'], from: ['supabase/config.toml', 'package.json'] });
  });
});

describe('the build task for a database class carries the shared database guard', () => {
  const entry = (o: object = {}) => ({
    key: 'access-control@supabase/migrations',
    class: 'access-control',
    area: 'supabase/migrations',
    scope: 'area',
    incidents: 2,
    weight: 2,
    severity: 'H',
    tasks: ['A-1', 'B-2'],
    files: ['supabase/migrations/0007_rls.sql'],
    places: ['supabase/migrations/0007_rls.sql'],
    firstSeen: '2026-10-01T10:00:00.000Z',
    lastSeen: '2026-11-15T10:00:00.000Z',
    due: true,
    guardFailed: null,
    ...o,
  });
  const PROJECT = { quick: ['npm test'], full: [], ci: ['.github/workflows/ci.yml'], testRunner: 'npx vitest run' };
  const DB_RECIPE = { id: 'access-control-supabase', title: 'Probes', text: 'supabase test db', db: true };
  const mission = (o: object, e: object = {}) => R.buildTask(entry(e), { id: 'GATE-9', ...o }).mission as string;

  it('with a database recipe: the host check before anything writes, the stop elsewhere, the rollback', () => {
    const t = R.buildTask(entry(), { id: 'GATE-9', project: { ...PROJECT, database: { has: true, guardOn: false } }, recipe: DB_RECIPE });
    expect(t.mission).toMatch(/localhost, 127\.0\.0\.1, ::1/);
    expect(t.mission).toMatch(/before anything (?:that )?writes/i);
    expect(t.mission).toMatch(/stops? with one line/i);
    expect(t.mission).toMatch(/never the URL/i);
    expect(t.mission).toMatch(/ROLLBACK/);
    expect(t.mission).toMatch(/no real database is contacted/i);
    expect(t.acceptance.join('\n')).toMatch(/checks its host before it writes/i);
  });

  it('says what dbGuard.localOnly does, on and off, and never asks the agent to change it', () => {
    const off = mission({ project: { ...PROJECT, database: { has: true, guardOn: false } }, recipe: DB_RECIPE });
    expect(off).toMatch(/dbGuard\.localOnly is off/);
    expect(off).toMatch(/recommend/i);
    expect(off).toMatch(/do not change it yourself/i);
    const onm = mission({ project: { ...PROJECT, database: { has: true, guardOn: true } }, recipe: DB_RECIPE });
    expect(onm).toMatch(/dbGuard\.localOnly is on/);
    expect(onm).toMatch(/URL inside a file/);
  });

  it('a database class in a project with a database gets the guard even with no recipe (the setting off)', () => {
    expect(mission({ project: { ...PROJECT, database: { has: true, guardOn: false } }, recipe: null })).toMatch(/127\.0\.0\.1/);
    expect(mission({ project: { ...PROJECT, database: { has: true } } }, { class: 'migration-schema', key: 'migration-schema@x' })).toMatch(/ROLLBACK/);
  });

  it('any other class, or a database class with no database, is unchanged', () => {
    const plain = { project: PROJECT, recipe: null };
    const before = mission(plain, { class: 'unchecked-error', key: 'unchecked-error@src' });
    expect(before).not.toMatch(/127\.0\.0\.1|ROLLBACK|dbGuard/);
    expect(mission({ project: { ...PROJECT, database: { has: true } }, recipe: null }, { class: 'unchecked-error', key: 'unchecked-error@src' })).toBe(before);
    expect(mission({ project: { ...PROJECT, database: { has: false } }, recipe: null })).not.toMatch(/127\.0\.0\.1/);
    expect(mission({ project: PROJECT, recipe: null })).not.toMatch(/127\.0\.0\.1/);
  });
});

describe('the setting learning.dbProbes', () => {
  it('is off in the defaults, the standard config and setupOf, and checked by setupProblems', () => {
    expect(R.DEFAULTS.dbProbes).toBe(false);
    expect(QC.STANDARD.learning.dbProbes).toBe(false);
    expect(R.setupOf({}).dbProbes).toBe(false);
    expect(R.setupOf({ learning: { dbProbes: true } }).dbProbes).toBe(true);
    expect(R.setupProblems({ dbProbes: 'on' })).toEqual(['learning.dbProbes must be true or false']);
  });

  it('is in the settings registry, an on/off with its reason', () => {
    const row = REG.rowFor('learning.dbProbes');
    expect(row).toBeTruthy();
    expect(row.type).toBe('onoff');
    expect(row.explanation).toMatch(/Off by default/);
    expect(row.explanation).toMatch(/local/);
  });
});

describe('the card ledger-recipes for a database class', () => {
  const catalog = C.loadCatalog({ builtin: BUILTIN, own: NONE });
  const card = (facts: object) =>
    C.buildReport({ facts: { git: true, inspectionOn: true, ...facts }, catalog, now: 'x' }).suggestions.find((s: { key: string }) => s.key === 'ledger-recipes') as Record<string, any> | undefined;
  const ledger = {
    ledger: {
      due: [{ key: 'access-control@supabase', class: 'access-control', title: 'access control and authorization', area: 'supabase', scope: 'area', incidents: 2, tasks: ['A-1', 'B-2'], files: ['supabase/x.sql'], proposal: { state: 'add', task: null } }],
      guardFailed: [],
      marker: true,
      recent: {},
      cap: { open: 0, max: 3, full: false },
    },
  };

  it('with the setting off and a local database: no recipe, and one line on how to turn them on', () => {
    const c = card({ ...SUPABASE, ...ledger });
    expect(c?.ledger.items[0].recipe).toBeNull();
    expect(c?.ledger.items[0].hint).toMatch(/learning\.dbProbes/);
    expect(c?.detail).toMatch(/settings set learning\.dbProbes on/);
  });

  it('with the setting on: the recipe, marked db; with no local database: no hint', () => {
    const c = card({ ...on(SUPABASE), ...ledger });
    expect(c?.ledger.items[0].recipe).toMatchObject({ id: 'access-control-supabase', db: true });
    expect(c?.ledger.items[0].hint ?? null).toBeNull();
    const remote = card({ stacks: ['Node/TypeScript'], hasDatabase: true, ...ledger });
    expect(remote?.ledger.items[0].hint ?? null).toBeNull();
    expect(remote?.detail).not.toMatch(/learning\.dbProbes/);
  });
});

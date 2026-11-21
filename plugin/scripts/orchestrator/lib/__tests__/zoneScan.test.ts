// =============================================================
// zoneScan.test.ts: the starter scan that PROPOSES sensitive zones (PG-5, plans/plan-gate-vurdering-2026-11-21.md
// section 6; lib/zoneScan.js) and the proposed zone file it writes (lib/catalog.js proposalFile, kind zone).
//
// Locks: (1) the scan finds four kinds of candidate from what the tree shows: the configured migrations folder (or a
// folder named migrations), files that look like a public contract (OpenAPI, GraphQL, protobuf, JSON schema, a published
// package's entry points), auth or permission folders by name, and encryption or key handling by name; (2) test,
// fixture, vendor and build folders never count; (3) a tree with none of that gives no candidate (the set starts empty);
// (4) a candidate whose files an existing zone already covers, or whose title an existing zone has (any status, so a
// declined or edited one is not proposed again), is left out; (5) proposalFile writes a zone as status proposed with a
// reason, paths and keywords and no invariant, and it parses without errors.
// Pure.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const ZS = require('../zoneScan.js') as any;
const C = require('../catalog.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const keys = (list: any[]) => list.map((c) => c.key).sort();
const byKey = (list: any[], key: string) => list.find((c) => c.key === key);

describe('the zone scan finds candidates', () => {
  it('an empty or plain tree gives none', () => {
    expect(ZS.zoneCandidates({ files: [] })).toEqual([]);
    expect(ZS.zoneCandidates({ files: ['src/app.ts', 'src/ui/button.tsx', 'README.md'] })).toEqual([]);
  });

  it('the configured migrations folder, or a folder named migrations', () => {
    const conf = ZS.zoneCandidates({ files: ['db/migrations/001_init.sql', 'src/a.ts'], migrationsFolder: 'db/migrations' });
    expect(byKey(conf, 'data-model').paths).toEqual(['db/migrations/**']);
    const found = ZS.zoneCandidates({ files: ['server/migrations/0001.py', 'server/app.py'] });
    expect(byKey(found, 'data-model').paths).toEqual(['server/migrations/**']);
    expect(byKey(found, 'data-model').reason).toMatch(/expensive to undo|outlives/);
  });

  it('public contracts: OpenAPI, GraphQL, protobuf, JSON schema and a published package entry point', () => {
    const files = ['api/openapi.yaml', 'schema/app.graphql', 'proto/user.proto', 'formats/export.schema.json', 'package.json', 'dist/index.js', 'src/index.ts'];
    const pkg = JSON.stringify({ name: 'my-lib', main: 'src/index.ts', bin: { tool: 'bin/tool.js' } });
    const c = byKey(ZS.zoneCandidates({ files: [...files, 'bin/tool.js'], readFile: (f: string) => (f === 'package.json' ? pkg : null) }), 'contracts');
    expect(c.paths).toEqual(expect.arrayContaining(['api/openapi.yaml', 'schema/app.graphql', 'proto/user.proto', 'formats/export.schema.json', 'src/index.ts', 'bin/tool.js']));
    // A private package publishes nothing, so its entry points are no contract.
    const priv = JSON.stringify({ name: 'app', private: true, main: 'src/index.ts' });
    expect(ZS.zoneCandidates({ files: ['package.json', 'src/index.ts'], readFile: () => priv })).toEqual([]);
  });

  it('auth or permission folders and encryption or key handling by name', () => {
    const list = ZS.zoneCandidates({ files: ['src/auth/session.ts', 'src/auth/login.ts', 'app/permissions/roles.ts', 'lib/crypto/seal.ts', 'lib/util/encrypt.ts'] });
    expect(keys(list)).toEqual(['auth', 'crypto']);
    expect(byKey(list, 'auth').paths).toEqual(['app/permissions/**', 'src/auth/**']);
    expect(byKey(list, 'crypto').paths).toEqual(['lib/crypto/**', 'lib/util/encrypt.ts']);
    for (const c of list) {
      expect(c.title).toBeTruthy();
      expect(c.reason.length).toBeLessThanOrEqual(200);
      expect(c.keywords.length).toBeGreaterThan(0);
      expect(c.found.length).toBeGreaterThan(0);
    }
  });

  it('test, fixture, vendor and build folders never count', () => {
    const files = ['tests/auth/a.test.ts', 'src/__tests__/crypto/x.ts', 'vendor/auth/lib.js', 'dist/auth/x.js', 'node_modules/x/migrations/1.sql', 'fixtures/openapi.yaml'];
    expect(ZS.zoneCandidates({ files })).toEqual([]);
  });

  it('a nested folder of the same kind is covered by the outer one', () => {
    const c = byKey(ZS.zoneCandidates({ files: ['src/auth/a.ts', 'src/auth/oauth/b.ts'] }), 'auth');
    expect(c.paths).toEqual(['src/auth/**']);
  });
});

describe('what the owner already has is not proposed again', () => {
  const files = ['src/auth/session.ts', 'db/migrations/1.sql'];
  it('files an existing zone covers are left out, whatever its status', () => {
    const existing = [{ title: 'Sessions', status: 'proposed', paths: ['src/auth/**'] }];
    expect(keys(ZS.zoneCandidates({ files, existing }))).toEqual(['data-model']);
  });

  it('a zone with the same title is left out (a declined or edited one stays declined)', () => {
    const t = ZS.zoneCandidates({ files })[0].title;
    const existing = [{ title: t.toUpperCase(), status: 'superseded', paths: ['elsewhere/**'] }];
    expect(ZS.zoneCandidates({ files, existing }).map((c: any) => c.title)).not.toContain(t);
  });
});

describe('the proposed zone file', () => {
  it('status proposed, kind zone, paths, keywords and a reason, no invariant, parses clean', () => {
    const c = ZS.zoneCandidates({ files: ['src/auth/session.ts'] })[0];
    const r = C.proposalFile({ id: 'D-0003', ...ZS.proposalOf(c) });
    expect(r.errors).toEqual([]);
    expect(r.text).toMatch(/^status: proposed$/m);
    expect(r.text).toMatch(/^kind: zone$/m);
    expect(r.text).not.toMatch(/^invariant:/m);
    const d = C.parseDecision(r.name, r.text).decision;
    expect(d.kind).toBe('zone');
    expect(d.paths).toEqual(['src/auth/**']);
    expect(d.keywords).toEqual(c.keywords);
    expect(d.reason).toBe(c.reason);
    expect(d.body).toMatch(/src\/auth\/session\.ts/);
  });
});

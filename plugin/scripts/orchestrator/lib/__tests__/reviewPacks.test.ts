// =============================================================
// reviewPacks.test.ts: stack packs for the review signals (lib/reviewPacks.js, review-packs/packs.json).
//
// Why: the built-in signals are generic. A pack per stack adds the risky APIs of that stack (sign-in, raw SQL, rules
// that open access, CORS and CSRF, unsafe deserializing, shell from data, uploads, TLS off), and is turned on per
// project with review.packs after the owner says yes on the Checks tab. Packs are data, so the examples in each pack
// are the tests: a hit line must hit its signal, a miss line must hit nothing.
//
// Locks: (1) every shipped pack is valid and every example behaves (with core, as the Checks tab turns them on);
// (2) the lookahead trap `\s*(?!...)` is refused; (3) the stack is found from the manifests only (package.json,
// requirements, pyproject, Gemfile, composer, pom, gradle, go.mod, mix.exs, pubspec, csproj), with prefixes for Go
// modules and NuGet; (4) a known stack without a pack is reported as such; (5) review.packs turns the pack's signals on
// in signalSetup and signalHits, including its extra code files (.sql); an unknown id is ignored; (6) without
// review.packs nothing changes.
// =============================================================
import { describe, it, expect } from 'vitest';

const RP = require('../reviewPacks.js');
const RS = require('../reviewSignals.js');

/** A unified diff that adds `lines` to `file`. */
function diffAdding(file: string, lines: string[]) {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
}

/** A fake project for detectStacks: a map of file -> text. */
function fsOf(files: Record<string, string>) {
  const norm = (f: string) => f.replace(/\\/g, '/').replace(/\/$/, '');
  return {
    exists: (f: string) => Object.keys(files).some((k) => k === norm(f) || k.startsWith(`${norm(f)}/`)),
    read: (f: string) => files[norm(f)] ?? null,
    list: (dir: string) => {
      const d = norm(dir);
      const prefix = d === '' || d === '.' ? '' : `${d}/`;
      return [...new Set(Object.keys(files).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0]))];
    },
  };
}

describe('the shipped packs', () => {
  const data = RP.builtinData();
  const ids = Object.keys(data.packs);

  it('are many, have core, and every one is valid', () => {
    expect(ids.length).toBeGreaterThanOrEqual(30);
    expect(ids).toContain('core');
    const problems = ids.flatMap((id) => RP.validatePack(data.packs[id], data));
    expect(problems).toEqual([]);
  });

  it('every example behaves: hits hit their signal, misses hit nothing (pack with core)', () => {
    const problems = ids.flatMap((id) => RP.exampleProblems(data.packs[id], data));
    expect(problems).toEqual([]);
  });

  it('a miss line of one pack hits nothing with every pack on (a project with many stacks)', () => {
    const config = { review: { packs: ids } };
    const wrong: string[] = [];
    for (const id of ids)
      for (const m of data.packs[id].examples?.miss ?? []) {
        const hits = RS.signalHits({ config, changedPaths: [], diff: diffAdding(m.file, [m.line]) });
        if (hits.length) wrong.push(`${id}: ${m.line} -> ${hits.map((h: { name: string }) => h.name).join(',')}`);
      }
    expect(wrong).toEqual([]);
  });
});

describe('validatePack', () => {
  const data = RP.builtinData();
  const good = () => ({
    id: 'own-thing',
    title: 'Own thing',
    detect: { npm: ['own-thing'] },
    signals: { auth: { words: ['\\bownLogin\\s*\\('] } },
    examples: {
      hit: [
        { file: 'src/a.ts', line: 'ownLogin(user)', signal: 'auth' },
        { file: 'src/b.ts', line: 'await ownLogin (x)', signal: 'auth' },
      ],
      miss: [
        { file: 'src/a.ts', line: 'const ownLoginText = 1' },
        { file: 'src/b.ts', line: 'readUser()' },
      ],
    },
  });

  it('a good pack has no problems', () => {
    expect(RP.validatePack(good(), data)).toEqual([]);
    expect(RP.exampleProblems(good(), data)).toEqual([]);
  });

  it('refuses the lookahead trap \\s*(?!...) and accepts \\s*(?!\\s*...)', () => {
    const trap = good();
    trap.signals.auth.words = ["\\bownLogin\\s*\\(\\s*(?!['\"])"];
    expect(RP.validatePack(trap, data).join(' ')).toMatch(/lookahead/);
    const fixed = good();
    fixed.signals.auth.words = ["\\bownLogin\\s*\\(\\s*(?!\\s*['\"])"];
    expect(RP.validatePack(fixed, data)).toEqual([]);
  });

  it('names a word that does not compile, an unknown signal, a missing title and too few examples', () => {
    const bad = good() as any;
    bad.title = '';
    bad.signals = { auth: { words: ['(unclosed'] }, 'not-a-signal': { words: ['x'] } };
    bad.examples = { hit: [], miss: [] };
    const text = RP.validatePack(bad, data).join(' | ');
    expect(text).toMatch(/title/);
    expect(text).toMatch(/does not compile/);
    expect(text).toMatch(/not-a-signal/);
    expect(text).toMatch(/examples/);
  });

  it('exampleProblems names a hit that does not hit and a miss that does', () => {
    const p = good();
    p.examples.hit.push({ file: 'src/c.ts', line: 'nothing here', signal: 'auth' });
    p.examples.miss.push({ file: 'src/c.ts', line: 'ownLogin(y)' });
    const text = RP.exampleProblems(p, data).join(' | ');
    expect(text).toMatch(/nothing here/);
    expect(text).toMatch(/ownLogin\(y\)/);
  });
});

describe('detectStacks: from the manifests only', () => {
  it('finds npm packages in package.json (dependencies and devDependencies) and workspace folders', () => {
    const r = RP.detectStacks(
      fsOf({
        'package.json': JSON.stringify({ dependencies: { next: '16', '@supabase/supabase-js': '2' } }),
        'packages/api/package.json': JSON.stringify({ devDependencies: { express: '5' } }),
      }),
    );
    expect(r.packs).toEqual(expect.arrayContaining(['nextjs', 'supabase', 'express']));
    expect(r.packs).not.toContain('core');
  });

  it('finds Python from requirements and pyproject, with case and _ against - not mattering', () => {
    expect(RP.detectStacks(fsOf({ 'requirements.txt': 'Django>=5\nfastapi==0.1 ; python_version>"3"\n' })).packs).toEqual(
      expect.arrayContaining(['django', 'fastapi']),
    );
    expect(RP.detectStacks(fsOf({ 'pyproject.toml': '[project]\ndependencies = [\n  "SQLAlchemy>=2",\n]\n' })).packs).toContain('sqlalchemy');
    expect(RP.detectStacks(fsOf({ 'pyproject.toml': '[tool.poetry.dependencies]\nflask = "^3"\n' })).packs).toContain('flask');
  });

  it('finds Ruby, PHP, Java, Go, Elixir, Dart and .NET', () => {
    expect(RP.detectStacks(fsOf({ Gemfile: "source 'x'\ngem 'rails', '~> 8'\n" })).packs).toContain('rails');
    expect(RP.detectStacks(fsOf({ 'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11' } }) })).packs).toContain('laravel');
    const pom = '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>';
    expect(RP.detectStacks(fsOf({ 'pom.xml': pom })).packs).toContain('spring');
    expect(RP.detectStacks(fsOf({ 'build.gradle.kts': 'implementation("org.springframework.boot:spring-boot-starter-security")' })).packs).toContain('spring');
    expect(RP.detectStacks(fsOf({ 'go.mod': 'module x\n\nrequire (\n\tgithub.com/labstack/echo/v4 v4.12.0\n)\n' })).packs).toContain('go');
    expect(RP.detectStacks(fsOf({ 'mix.exs': 'defp deps do\n  [{:phoenix, "~> 1.7"}]\nend' })).packs).toContain('phoenix');
    expect(RP.detectStacks(fsOf({ 'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n' })).packs).toContain('flutter');
    expect(RP.detectStacks(fsOf({ 'Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' })).packs).toContain('aspnetcore');
    expect(
      RP.detectStacks(fsOf({ 'src/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.AspNetCore.Authentication.JwtBearer" /></ItemGroup></Project>' })).packs,
    ).toContain('aspnetcore');
  });

  it('finds a stack by a marker file, and never by a name in a comment or a lockfile alone', () => {
    expect(RP.detectStacks(fsOf({ 'firestore.rules': 'rules_version = "2";' })).packs).toContain('firebase');
    expect(RP.detectStacks(fsOf({ 'README.md': 'we do not use django', 'package-lock.json': '"django"' })).packs).toEqual([]);
  });

  it('reports a known stack without a pack, and an empty project finds nothing', () => {
    const r = RP.detectStacks(fsOf({ 'package.json': JSON.stringify({ dependencies: { fastify: '5', express: '5' } }) }));
    expect(r.packs).toContain('express');
    expect(r.unpacked).toContain('fastify');
    expect(RP.detectStacks(fsOf({}))).toEqual({ packs: [], unpacked: [] });
  });

  it('a package.json that does not parse is skipped, not thrown', () => {
    expect(RP.detectStacks(fsOf({ 'package.json': '{ not json' })).packs).toEqual([]);
  });

  it('a project pack (docs/queue/review-packs) is detected, and a known stack it covers is no longer unpacked', () => {
    const own = { id: 'fastify', title: 'Fastify', detect: { npm: ['fastify'] }, signals: { auth: { words: ['\\breply\\.setCookie\\s*\\('] } } };
    const data = RP.mergePacks(RP.builtinData(), [own]);
    const r = RP.detectStacks(fsOf({ 'package.json': JSON.stringify({ dependencies: { fastify: '5' } }) }), data);
    expect(r.packs).toContain('fastify');
    expect(r.unpacked).not.toContain('fastify');
  });
});

describe('review.packs in the signals', () => {
  it('without review.packs, a pack-only word does not hit (nothing changes for existing projects)', () => {
    const hits = RS.signalHits({ config: {}, diff: diffAdding('src/repo.ts', ['await prisma.$queryRawUnsafe(q)']) });
    expect(hits.map((h: { name: string }) => h.name)).not.toContain('raw-sql');
  });

  it('with the pack on, its new signal hits and lifts reviewer-security', () => {
    const config = { review: { packs: ['core', 'prisma'] } };
    const hits = RS.signalHits({ config, diff: diffAdding('src/repo.ts', ['await prisma.$queryRawUnsafe(q)']) });
    expect(hits).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'raw-sql', reviewer: 'reviewer-security' })]));
  });

  it('a pack can read files that are not code by default (supabase: .sql)', () => {
    const line = 'alter table notes disable row level security;';
    const off = RS.signalHits({ config: {}, diff: diffAdding('supabase/migrations/1_x.sql', [line]) });
    expect(off).toEqual([]);
    const on = RS.signalHits({ config: { review: { packs: ['core', 'supabase'] } }, diff: diffAdding('supabase/migrations/1_x.sql', [line]) });
    expect(on.map((h: { name: string }) => h.name)).toContain('access-rule');
  });

  it('an unknown pack id is ignored, and the own review.signals still switch a signal off', () => {
    const setup = RS.signalSetup({ review: { packs: ['no-such-pack', 'prisma'], signals: { 'raw-sql': { enabled: false } } } });
    expect(setup['raw-sql'].enabled).toBe(false);
    expect(Object.values(setup).every((s: any) => !s.broken)).toBe(true);
  });
});

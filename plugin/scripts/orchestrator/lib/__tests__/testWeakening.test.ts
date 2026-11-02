// =============================================================
// testWeakening.test.ts: the test-weakening warning (lib/testWeakening.js) and its place in `receive`.
//
// Locks: (1) every marker family is found on an ADDED line in a test file, never on a removed line, a moved line or
// a non-test file; (2) a deleted test file and a test file moved out of the test paths are counted; (3) the config
// adds test paths and markers, and doctor's setupProblems names an invalid expression; (4) `receive` prints one WARN
// line and writes a "Test weakening" section in 00-package.md, and the switch turns both off. The receive block runs
// queue.mjs against a temporary queue and git repo, as queueDoneCheck.test.ts. Never the main repo or the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const TW = require('../testWeakening') as {
  isTestFile: (p: string, extra?: string[]) => boolean;
  assess: (
    diff: string,
    setup?: { testPaths?: string[]; markers?: string[] },
  ) => {
    deleted: { path: string; movedTo: string | null }[];
    markers: { path: string; family: string; kind: string; line: string }[];
    testsRemoved: number;
    testsAdded: number;
  };
  summaryLine: (r: ReturnType<typeof TW.assess>) => string | null;
  packageSection: (r: ReturnType<typeof TW.assess>) => string[];
  setupProblems: (s: unknown) => string[];
};

/** A one-file diff that adds `added` (and removes `removed`) in `file`. */
const patch = (file: string, added: string[], removed: string[] = []) =>
  [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length + 1} +1,${added.length + 1} @@`,
    ' context line',
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join('\n');

describe('isTestFile', () => {
  it('knows the test names and folders of each ecosystem', () => {
    for (const p of [
      'src/a.test.ts',
      'src/a.spec.mjs',
      'lib/__tests__/x.ts',
      'tests/test_a.py',
      'pkg/a_test.py',
      'pkg/a_test.go',
      'spec/models/user_spec.rb',
      'src/test/java/a/FooTest.java',
      'app/FooTests.cs',
      'tests/Unit/FooTest.php',
      'tests/integration.rs',
      'e2e/login.ts',
    ])
      expect(TW.isTestFile(p), p).toBe(true);
  });
  it('leaves code, fixtures and look-alikes alone', () => {
    for (const p of ['src/a.ts', 'src/testing.ts', 'tests/fixtures/data.json', 'src/latest.py', 'node_modules/x/a.test.js'])
      expect(TW.isTestFile(p), p).toBe(false);
  });
  it('the config adds globs', () => {
    expect(TW.isTestFile('checks/a.check.ts')).toBe(false);
    expect(TW.isTestFile('checks/a.check.ts', ['*.check.ts'])).toBe(true);
  });
});

describe('markers on added lines', () => {
  const cases: [string, string, string][] = [
    ['src/a.test.ts', "it.skip('works', () => {});", 'skip'],
    ['src/a.test.ts', "describe.skip('group', () => {});", 'skip'],
    ['src/a.test.ts', "it.skipIf(process.env.CI)('x', () => {});", 'skip'],
    ['src/a.test.ts', "test.only('works', () => {});", 'focus'],
    ['src/a.test.ts', "it.only.each([1])('x %s', () => {});", 'focus'],
    ['src/a.spec.js', "xit('works', () => {});", 'skip'],
    ['src/a.spec.js', "xdescribe('group', () => {});", 'skip'],
    ['src/a.spec.js', "fit('works', () => {});", 'focus'],
    ['src/a.test.ts', "it.todo('later');", 'todo'],
    ['src/a.spec.js', "  pending('flaky');", 'skip'],
    ['spec/a_spec.rb', '    pending "not yet"', 'skip'],
    ['tests/test_a.py', '@pytest.mark.skip(reason="flaky")', 'skip'],
    ['tests/test_a.py', '@pytest.mark.skipif(sys.platform == "win32", reason="x")', 'skip'],
    ['tests/test_a.py', '@pytest.mark.xfail', 'skip'],
    ['tests/test_a.py', '    pytest.skip("not now")', 'skip'],
    ['tests/test_a.py', '@unittest.skip("x")', 'skip'],
    ['tests/test_a.py', '        self.skipTest("x")', 'skip'],
    ['src/lib.rs', '    #[ignore]', 'skip'],
    ['pkg/a_test.go', '\tt.Skip("flaky")', 'skip'],
    ['pkg/a_test.go', '\tt.Skipf("on %s", runtime.GOOS)', 'skip'],
    ['src/test/java/FooTest.java', '    @Disabled("x")', 'skip'],
    ['src/test/java/FooTest.java', '    @Ignore', 'skip'],
    ['app/FooTests.cs', '    [Fact(Skip = "x")]', 'skip'],
    ['app/FooTests.cs', '    [Ignore("x")]', 'skip'],
    ['tests/FooTest.php', '        $this->markTestSkipped("x");', 'skip'],
  ];
  for (const [file, line, kind] of cases)
    it(`${kind}: ${line.trim()}`, () => {
      const r = TW.assess(patch(file, [line]));
      expect(r.markers).toHaveLength(1);
      expect(r.markers[0]).toMatchObject({ path: file, kind });
    });

  it('no hit on a removed line, a non-test file or a moved line', () => {
    expect(TW.assess(patch('src/a.test.ts', [], ["it.skip('x', () => {});"])).markers).toEqual([]);
    expect(TW.assess(patch('src/stream.ts', ['reader.skip(4);', "it.only('x')"])).markers).toEqual([]);
    // Re-indented (removed and added with the same trimmed text): not a new marker.
    expect(
      TW.assess(patch('src/a.test.ts', ["    it.skip('x', () => {});"], ["  it.skip('x', () => {});"])).markers,
    ).toEqual([]);
    // Moved from one test file to another: not new either.
    const moved = [patch('a.test.ts', [], ["it.skip('x', () => {});"]), patch('b.test.ts', ["it.skip('x', () => {});"])];
    expect(TW.assess(moved.join('\n')).markers).toEqual([]);
  });
  it('no hit on ordinary test code that only looks close', () => {
    const lines = [
      "expect(status).toBe('pending');",
      "const benefit = fit(data);",
      "it('skips empty rows', () => {});",
      'const t = x.Skip;',
    ];
    expect(TW.assess(patch('src/a.test.ts', lines)).markers).toEqual([]);
  });
  it('a removed line starting with "--" is a hunk line, not a file header', () => {
    const d = patch('src/a.test.ts', ["it.only('x', () => {});"], ['-- old comment']);
    expect(TW.assess(d).markers).toHaveLength(1);
  });
  it('extra markers from the config; an invalid one is left out and named by setupProblems', () => {
    const r = TW.assess(patch('src/a.test.ts', ['skipUnlessDb();']), { markers: ['\\bskipUnlessDb\\(', '(['] });
    expect(r.markers).toHaveLength(1);
    expect(TW.setupProblems({ markers: ['(['] })[0]).toMatch(/invalid regular expression/);
    expect(TW.setupProblems({ enabled: true, testPaths: [], markers: [] })).toEqual([]);
    expect(TW.setupProblems({ testPaths: 'x' })[0]).toMatch(/list of strings/);
  });
});

describe('deleted and moved test files, the count and the texts', () => {
  const deleted = [
    'diff --git a/src/a.test.ts b/src/a.test.ts',
    'deleted file mode 100644',
    'index 1111111..0000000',
    '--- a/src/a.test.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    "-it('a', () => {});",
    "-it('b', () => {});",
  ].join('\n');
  const movedOut = [
    'diff --git a/tests/test_b.py b/old/b.py',
    'similarity index 100%',
    'rename from tests/test_b.py',
    'rename to old/b.py',
  ].join('\n');
  const added = [
    'diff --git a/src/c.test.ts b/src/c.test.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/c.test.ts',
    '@@ -0,0 +1 @@',
    "+it('c', () => {});",
  ].join('\n');
  const deletedCode = [
    'diff --git a/src/a.ts b/src/a.ts',
    'deleted file mode 100644',
    '--- a/src/a.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-export const a = 1;',
  ].join('\n');

  it('counts a deleted test file and one moved out of the test paths, not a deleted code file', () => {
    const r = TW.assess([deleted, movedOut, added, deletedCode].join('\n'));
    expect(r.deleted).toEqual([
      { path: 'src/a.test.ts', movedTo: null },
      { path: 'tests/test_b.py', movedTo: 'old/b.py' },
    ]);
    expect(r.testsRemoved).toBe(2);
    expect(r.testsAdded).toBe(1);
    expect(TW.summaryLine(r)).toBe(
      'WARN test weakening: 1 deleted test file, 1 test file moved out of the test paths (see 00-package.md)',
    );
  });
  it('the summary and the section, and nothing to say when nothing was found', () => {
    const r = TW.assess([deleted, patch('src/b.test.ts', ["it.skip('x')", "it.skip('y')", "it.only('z')"])].join('\n'));
    expect(TW.summaryLine(r)).toBe(
      'WARN test weakening: 2 skip markers, 1 focus marker, 1 deleted test file (see 00-package.md)',
    );
    const s = TW.packageSection(r).join('\n');
    expect(s).toContain('## Test weakening');
    expect(s).toContain('- deleted: `src/a.test.ts`');
    expect(s).toContain("- focus (js .skip/.only) in `src/b.test.ts`: `it.only('z')`");
    expect(s).toContain('Test files removed 1, added 0');
    const none = TW.assess(added);
    expect(TW.summaryLine(none)).toBeNull();
    expect(TW.packageSection(none).join('\n')).toContain('None found');
  });
});

// ---- receive: the WARN line and the package section ----------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

describe('queue.mjs receive with test weakening', () => {
  /** A queue with task A on queue/A, which skips one test and deletes another; `config` is queue.config.json. */
  const setup = (config: object) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-weak-'));
    temporary.push(folder);
    const repo = path.join(folder, 'repo');
    const scratch = path.join(folder, 'scratch');
    fs.mkdirSync(repo);
    fs.mkdirSync(scratch);
    const g = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const put = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
      g(['add', '--', file]);
    };
    g(['init', '-q', '-b', 'main']);
    put('src/a.test.ts', "it('a', () => {});\n");
    put('src/b.test.ts', "it('b', () => {});\n");
    g(['commit', '-q', '-m', 'start']);
    g(['switch', '-q', '-c', 'queue/A']);
    put('src/a.test.ts', "it.skip('a', () => {});\n");
    g(['rm', '-q', '--', 'src/b.test.ts']);
    g(['commit', '-q', '-m', 'track A']);
    g(['switch', '-q', 'main']);
    const task = {
      id: 'A',
      title: 'Task A',
      domain: 'dom-A',
      class: 'K',
      status: 'running',
      mission: 'The mission for A.',
      value: 5,
      content_min: 60,
      depends_on: [],
      waiting_on: [],
      owned_files: ['src/a.test.ts', 'src/b.test.ts'],
      started: '2026-01-01T00:00:00.000Z',
      branch: 'queue/A',
      migr_block: null,
      scratchpad: scratch,
    };
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ created: task.started, limits: {}, next_migr: 3600, resolved: [], tasks: [task] }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    fs.mkdirSync(path.join(scratch, 'A'), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, 'A', 'report.md'),
      'RESULT status=DONE branch=queue/A commits=1 migr=- gates=OK probe=- ownerQuestions=0 edge=-\n',
    );
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    } as NodeJS.ProcessEnv;
    delete env.QUEUE_SCRATCHPAD;
    delete env.QUEUE_SESSION;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), 'receive', 'A'], {
      encoding: 'utf8',
      env,
      cwd: folder,
    });
    const pkg = path.join(scratch, 'rev-A', '00-package.md');
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '', pkg: fs.existsSync(pkg) ? fs.readFileSync(pkg, 'utf8') : '' };
  };

  it('prints one WARN line and writes the section', () => {
    const m = setup({});
    expect(m.error).toBe('');
    expect(m.code).toBe(0);
    expect(m.out).toContain('WARN test weakening: 1 skip marker, 1 deleted test file (see 00-package.md)');
    expect(m.pkg).toContain('## Test weakening');
    expect(m.pkg).toContain('- deleted: `src/b.test.ts`');
    expect(m.pkg).toContain("in `src/a.test.ts`: `it.skip('a', () => {});`");
  });
  it('enabled false turns the line and the section off', () => {
    const m = setup({ testWeakening: { enabled: false } });
    expect(m.code).toBe(0);
    expect(m.out).not.toContain('test weakening');
    expect(m.pkg).not.toContain('## Test weakening');
    expect(m.pkg).toContain('# Review package A');
  });
});

// =============================================================
// heavyCommand.test.ts: which shell lines are heavy test runs that should go through the machine queue
// (lib/heavyCommand.js, roadmap 0s V10), and that `ravenseat heavy -- <command>` hides nothing from the guards.
//
// Locks: npm/pnpm/yarn test, npm run test:*, redteam, vitest, jest and playwright (direct, npx, a node_modules path)
// and scripts/test-changed.mjs are heavy; a lint, a build, a single `node -e`, `vitest --version` and the redteam report
// are not; a line already wrapped in `ravenseat heavy --` is never flagged again. The setting processGuard.heavyQueue is
// warn by default, off and deny are taken, anything else is warn. The answers: warn is context for the agent (the
// command runs), deny names the exact command to run instead. The shell reader reads the inner command of the
// wrapper, so a push or an unknown package inside it is judged as if run bare; queue agents may run `heavy`.
// =============================================================
import { describe, expect, it } from 'vitest';

const H = require('../heavyCommand.js');
const SC = require('../shellCommands.js');
const PG = require('../pushGuard.js');

describe('heavyMatch', () => {
  const heavy = [
    'npm test',
    'npm t',
    'npm run test',
    'npm run test:changed -- main',
    'npm run redteam',
    'pnpm test',
    'yarn test',
    'npx vitest run lib/__tests__/x.test.ts',
    'vitest run',
    'node node_modules/vitest/vitest.mjs run',
    'npx jest',
    'npx playwright test',
    'node scripts/test-changed.mjs main',
    'cd plugin && npm test',
    'FOO=1 npm test 2>&1 | tail -20',
  ];
  for (const c of heavy) it(`flags ${c}`, () => expect(H.heavyMatch(c)).toBeTruthy());

  const light = [
    'npm run lint',
    'npm install',
    'npm run redteam:report',
    'node -e "1+1"',
    'npx vitest --version',
    'git status',
    'echo npm test',
    'ravenseat gates --quick',
  ];
  for (const c of light) it(`leaves ${c}`, () => expect(H.heavyMatch(c)).toBe(null));

  it('never flags a line that is already wrapped', () => {
    expect(H.heavyMatch('ravenseat heavy -- npm test')).toBe(null);
    expect(H.heavyMatch('node plugin/scripts/orchestrator/queue.mjs heavy -- npx vitest run')).toBe(null);
  });

  it('names what it found', () => {
    expect(H.heavyMatch('npx vitest run a.test.ts')).toMatchObject({ label: 'vitest' });
    expect(H.heavyMatch('npm run redteam')).toMatchObject({ label: 'npm run redteam' });
  });
});

describe('the setting processGuard.heavyQueue', () => {
  it('is warn by default; off and deny are taken, anything else is warn', () => {
    expect(H.modeOf({})).toBe('warn');
    expect(H.modeOf({ processGuard: { heavyQueue: 'off' } })).toBe('off');
    expect(H.modeOf({ processGuard: { heavyQueue: 'deny' } })).toBe('deny');
    expect(H.modeOf({ processGuard: { heavyQueue: 'nonsense' } })).toBe('warn');
  });
});

describe('the answer', () => {
  it('warn: context for the agent with the wrapped command; the command runs', () => {
    const a = H.answer({ command: 'npm test', match: { label: 'npm test' }, mode: 'warn', cli: 'ravenseat' });
    expect(a.decision).toBe('context');
    expect(a.text).toMatch(/ravenseat heavy -- npm test/);
  });

  it('deny: the reason names the exact command to run instead and the setting', () => {
    const a = H.answer({ command: 'npx vitest run', match: { label: 'vitest' }, mode: 'deny', cli: 'ravenseat' });
    expect(a.decision).toBe('deny');
    expect(a.text).toMatch(/ravenseat heavy -- npx vitest run/);
    expect(a.text).toMatch(/processGuard\.heavyQueue/);
  });

  it('off: no answer', () => {
    expect(H.answer({ command: 'npm test', match: { label: 'npm test' }, mode: 'off', cli: 'ravenseat' })).toBe(null);
  });

  it('quotes a line with a double quote safely in the suggestion', () => {
    const a = H.answer({ command: 'npx vitest run -t "a b"', match: { label: 'vitest' }, mode: 'deny', cli: 'ravenseat' });
    expect(a.text).toContain('ravenseat heavy -- npx vitest run -t "a b"');
  });
});

describe('the wrapper hides nothing from the guards', () => {
  it('the shell reader reads the inner command', () => {
    const words = SC.commandList('ravenseat heavy -- git push --force origin main').commands.map((c: { word: string }) => c.word);
    expect(words).toContain('git');
  });

  it('a queue agent may run heavy, and a push inside it is still denied', () => {
    const ctx = { branch: 'queue/A-1', baseBranch: 'main', branchPrefix: 'queue/', agentType: 'track', guardedTypes: new Set(), migrations: {}, deployCommands: [] };
    expect(PG.assess('ravenseat heavy -- npm test', ctx)).toBe(null);
    const push = PG.assess('ravenseat heavy -- git push origin queue/A-1', ctx);
    expect(push?.decision).toBe('deny');
    expect(push?.rule).toBe('agent-push');
  });
});

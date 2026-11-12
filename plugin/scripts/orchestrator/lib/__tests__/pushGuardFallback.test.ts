// pushGuardFallback.test.ts: the coarse rule the push guard falls back to when it has an internal error
// (lib/pushGuardFallback.js). It must stop a forced push or a branch delete, and stay silent on everything else.
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fallbackAnswer } = require('../pushGuardFallback.js');

describe('fallbackAnswer: deny on the irreversible pushes', () => {
  it.each([
    'git push --force origin main',
    'git push -f origin main',
    'git push --force-with-lease origin main',
    'git push --force-with-lease=main:abc origin main',
    'git push -uf origin feature',
    'git push origin +main',
    'git push origin +HEAD:main',
    'git push --delete origin feature',
    'git push -d origin feature',
    'git push origin :feature',
    'git push --mirror origin',
    'git -C ../repo push -f origin main',
    'git -c core.quotepath=off push --force',
    'cd repo && git push --force origin main',
    'git status; git push -f',
    'git.exe push --force origin main',
    '"C:\\Program Files\\Git\\cmd\\git.exe" push --force origin main',
    'GIT_TRACE=1 git push --force',
  ])('%s', (command) => {
    const a = fallbackAnswer(command, new Error('boom'));
    expect(a?.decision).toBe('deny');
    expect(a?.reason).toMatch(/internal error/);
    expect(a?.reason).toMatch(/boom/);
  });
});

describe('fallbackAnswer: no decision otherwise (the guard still fails open)', () => {
  it.each([
    'git push origin main',
    'git push',
    'git push -u origin feature',
    'git status',
    'git commit -m "push -f later"',
    'echo git push --force',
    'npm test -- -f',
    'git fetch --force origin',
    'ls -f',
    '',
  ])('%s', (command) => {
    expect(fallbackAnswer(command, new Error('boom'))).toBeNull();
  });

  it('a non-string command gives no decision', () => {
    expect(fallbackAnswer(undefined, new Error('x'))).toBeNull();
  });
});

// =============================================================
// sinkRegister.test.ts: the guard test for agent text on disk (lib/sinkRegister.js, lib/storeText.js; roadmap 0æ N2).
//
// Fails when a module writes files and reads agent text but has no row in the register, when a row's module is gone,
// when a row's route is unknown or its redacting call is not in the module, and when a metadata row says nothing.
// Also locks the shared route: redact first, cut after, and "withheld" (never the raw text) when the redaction throws
// or runs over its budget; the done and gate tail goes through it.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type Sink = { file: string; route: string; token: string | null; what: string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SR = require('../sinkRegister.js') as { ROUTES: Record<string, string>; AGENT_TEXT: RegExp; WRITES: RegExp; SINKS: Sink[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ST = require('../storeText.js') as {
  WITHHELD: string;
  forStore: (t: unknown, o?: Record<string, unknown>) => { text: string; withheld: boolean; count: number };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DC = require('../doneCheck.js') as { tailOf: (t: string, n?: number) => string[] };

const ORCH = path.resolve(__dirname, '..', '..');
// A made-up value in a provider's key format, built at run time so no key-shaped text sits in the repo.
const FAKE_KEY = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

/** Every source module under scripts/orchestrator/ (no tests, no vendored or generated folders). */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (['__tests__', 'node_modules', 'vendor', 'review-packs', 'checks-catalog'].includes(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (/\.(c?js|mjs)$/.test(e.name)) out.push(path.relative(ORCH, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  };
  walk(ORCH);
  return out;
}

describe('the register of agent text write sites', () => {
  it('lists every module that writes files and reads agent text', () => {
    const listed = new Set(SR.SINKS.map((s) => s.file));
    const missing = sources().filter((f) => {
      const text = fs.readFileSync(path.join(ORCH, f), 'utf8');
      return SR.WRITES.test(text) && SR.AGENT_TEXT.test(text) && !listed.has(f) && f !== 'lib/sinkRegister.js';
    });
    // A new module here stores agent text: route it through lib/storeText.js and add its row to lib/sinkRegister.js.
    expect(missing).toEqual([]);
  });

  it('every row names a module that exists, a known route and the call that redacts', () => {
    for (const s of SR.SINKS) {
      const file = path.join(ORCH, s.file);
      expect(fs.existsSync(file), `${s.file} is in the register but gone`).toBe(true);
      expect(Object.keys(SR.ROUTES), `${s.file}: route ${s.route}`).toContain(s.route);
      expect(s.what.trim().length, `${s.file}: say what it stores`).toBeGreaterThan(10);
      if (s.route === 'metadata') continue;
      expect(s.token, `${s.file}: a redacting route needs its call`).toBeTruthy();
      expect(fs.readFileSync(file, 'utf8').includes(String(s.token)), `${s.file} no longer calls ${s.token}`).toBe(true);
    }
  });
});

describe('storeText: redact first, cut after, withheld on failure', () => {
  it('redacts, then cuts, so a cut never keeps a prefix of the key', () => {
    const r = ST.forStore(`token here ${FAKE_KEY} end`, { maxChars: 20 });
    expect(r.withheld).toBe(false);
    expect(r.count).toBe(1);
    expect(r.text).not.toContain('ghp_A1b2');
    expect(r.text.length).toBeLessThanOrEqual(20);
  });

  it('a redaction that throws, or runs over its budget, stores withheld and never the text', () => {
    const thrown = ST.forStore(`x ${FAKE_KEY}`, {
      redact: () => {
        throw new Error('boom');
      },
    });
    expect(thrown).toEqual({ text: ST.WITHHELD, withheld: true, count: 0 });
    let t = 0;
    const slow = ST.forStore(`x ${FAKE_KEY}`, { budgetMs: 100, clock: () => (t += 1000), redact: (s: string) => ({ text: s }) });
    expect(slow.withheld).toBe(true);
    expect(slow.text).not.toContain(FAKE_KEY);
  });

  it('the done and gate tail is redacted', () => {
    const tail = DC.tailOf(['line 1', `auth failed for ${FAKE_KEY}`, 'line 3'].join('\n'), 2);
    expect(tail).toHaveLength(2);
    expect(tail.join('\n')).not.toContain(FAKE_KEY);
    expect(tail[0]).toContain('[REDACTED:');
  });
});

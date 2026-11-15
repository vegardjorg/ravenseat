// =============================================================
// setupLimits.test.ts: /ravenseat:setup asks about parallel tracks and a daily budget, after the queue exists.
//
// Why: the default maxConcurrent is 5, while the machine rule (lib/machineAdvice.js) can suggest fewer on a small machine, and the daily
// budget is off by default. `ravenseat setup` printed the machine line but nothing asked, so a small machine started
// five tracks and an API user had no spending limit unless they found `limit` themselves. The limits live in
// queue.json, which `ravenseat init` creates, so the question must come after init.
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
// A Windows checkout may have CRLF line endings (core.autocrlf), so the text is read with LF.
const SKILL = fs.readFileSync(path.join(PLUGIN, 'skills', 'setup', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');

/** The text of the section that starts with this heading, up to the next heading of level 2 or 3. */
function section(heading: string): string {
  const start = SKILL.indexOf(heading);
  if (start < 0) return '';
  const rest = SKILL.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('/ravenseat:setup: parallel tracks and the daily budget', () => {
  const text = section('### Parallel tracks and spending (one question)');

  it('has the question as its own section', () => {
    expect(text).not.toBe('');
  });

  it('comes after ravenseat init, since the limits live in queue.json', () => {
    expect(SKILL.indexOf('### Parallel tracks and spending')).toBeGreaterThan(SKILL.indexOf('ravenseat init --lite\n'));
    expect(SKILL.indexOf('### Parallel tracks and spending')).toBeLessThan(SKILL.indexOf('## 4. Bring in the user'));
  });

  it('shows the machine suggestion and sets maxConcurrent only on a yes', () => {
    expect(text).toContain('ravenseat machine');
    expect(text).toContain('ravenseat limit maxConcurrent');
    expect(text).toMatch(/ASK/);
  });

  it('asks for a daily budget, which a subscription user may skip', () => {
    expect(text).toContain('ravenseat limit dailyBudget');
    expect(text).toMatch(/subscription/i);
  });

  it('is not skipped by quiet guidance: limits are not advice', () => {
    expect(text).not.toMatch(/Skip this if the user chose "my own setup"/);
  });
});

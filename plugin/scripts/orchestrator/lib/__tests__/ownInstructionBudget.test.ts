// =============================================================
// ownInstructionBudget.test.ts: Ravenseat's own share of what Claude loads stays small.
//
// Why: Ravenseat tells the owner when the project's instructions grow too large (doctor's instructions row, the chat
// notice), so its own part of them must not be the cause. CLAUDE.queue.md is imported into the project's CLAUDE.md and loads
// in every session, track and subagent; each skill's description loads at start (the body only when it is used); the
// common track text goes into every track's prompt. Each budget has headroom over the size on 2026-11-12, so a normal edit
// passes and a quiet doubling fails. Raise a budget only with a reason in the commit.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const letters = (f: string) => [...fs.readFileSync(f, 'utf8')].length;

/** The description in a SKILL.md front matter (a folded or indented value counts with its continuation lines). */
function description(file: string): string {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  return /^description:\s*(.*(?:\n[ \t]+.*)*)/m.exec(front)?.[1] ?? '';
}

const skills = fs
  .readdirSync(path.join(PLUGIN, 'skills'))
  .map((d) => path.join(PLUGIN, 'skills', d, 'SKILL.md'))
  .filter((f) => fs.existsSync(f));

describe("Ravenseat's own instructions stay within a budget", () => {
  it('CLAUDE.queue.md (loads in every session, track and subagent) is under 6,000 chars', () => {
    expect(letters(path.join(PLUGIN, 'CLAUDE.queue.md'))).toBeLessThan(6000);
  });

  it('each SKILL.md is under 500 lines (the limit in the Claude Code docs)', () => {
    expect(skills.length).toBeGreaterThan(5);
    for (const f of skills) expect(fs.readFileSync(f, 'utf8').split('\n').length, f).toBeLessThan(500);
  });

  it('the skill descriptions (loaded at start) are under 6,500 chars together', () => {
    const sum = skills.reduce((s, f) => s + description(f).length, 0);
    expect(sum).toBeGreaterThan(1000);
    expect(sum).toBeLessThan(6500);
  });

  it("the common track text (in every track's prompt) is under 15,000 chars", () => {
    expect(letters(path.join(__dirname, '__snapshots__', 'claudeDispatch', 'queue-common.md'))).toBeLessThan(15000);
  });
});

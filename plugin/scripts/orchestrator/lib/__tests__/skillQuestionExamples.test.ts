// =============================================================
// skillQuestionExamples.test.ts: the owner-question examples in the skills pass the card check.
//
// Why: `add` and `question` refuse a new plain question without the card fields (category, context, if_yes, if_no,
// recommendation among the choices), in lite and full mode alike. An agent copies the skill's example, so an example
// that lacks a field teaches a command that is refused. Each example is taken from the skill text as written and run
// through setQuestion with strict on, the same call `add` and `question` make.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const L = require('../queueLogic') as {
  setQuestion: (queue: object, input: object, now?: string, o?: { strict?: boolean }) => { set: string[]; error: string[] };
};
/* eslint-enable @typescript-eslint/no-require-imports */

const SKILLS = path.resolve(__dirname, '..', '..', '..', '..', 'skills');
const skill = (name: string) => fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
const strict = (input: object) => L.setQuestion({ tasks: [] }, input, undefined, { strict: true }).error;

/** The flags of one `ravenseat question <id> …` example: `--x "…"` pairs, each --choice kept, the type as question. */
function questionFlags(line: string) {
  const id = /ravenseat question (\S+)/.exec(line)![1];
  const field: Record<string, unknown> = { type: 'question' };
  const choices: string[] = [];
  for (const m of line.matchAll(/--([a-z-]+) "([^"]*)"/g)) {
    if (m[1] === 'choice') choices.push(m[2]);
    else field[m[1].replace('-', '_')] = m[2];
  }
  // --category takes a bare key.
  const cat = /--category ([a-z-]+)/.exec(line);
  if (cat) field.category = cat[1];
  if (choices.length) field.choices = choices;
  return { [id]: field };
}

describe('the owner-question examples in the skills', () => {
  it('add-to-queue, the lite one-liner: add --json with a question', () => {
    const json = /ravenseat add --json '(\{"tasks".*?\}\}\})'/s.exec(skill('add-to-queue'))![1];
    expect(strict(JSON.parse(json).question)).toEqual([]);
  });

  it('add-to-queue, the full JSON file in step 5', () => {
    const block = /```json\r?\n(\s*\{ "tasks"[\s\S]*?)```/.exec(skill('add-to-queue'))![1];
    expect(strict(JSON.parse(block).question)).toEqual([]);
  });

  it('review: the architecture decision', () => {
    const line = /`(ravenseat question Q-REV-[^`]+)`/.exec(skill('review'))![1];
    expect(strict(questionFlags(line.replace('<n>', '1')))).toEqual([]);
  });

  it('plans: the owner question', () => {
    const line = /`(ravenseat question <id>[^`]+)`/.exec(skill('plans'))![1].replace('<id>', 'Q-PL-1');
    expect(strict(questionFlags(line))).toEqual([]);
  });
});

// =============================================================
// cli/instructions.mjs: `ravenseat instructions [--json] [--plan]`: what Claude Code loads as instructions in this project, and
// a proposed split.
//
//   ravenseat instructions          the files loaded at the start of every session, track and subagent (with the share of the
//                                   project, the user's ~/.claude, Ravenseat and the organization), the files loaded on
//                                   demand, the auto memory line, a suggestion per section and the duplicate lines
//   ravenseat instructions --json   the same as data
//   ravenseat instructions --plan   the same as a Markdown plan with a ready text for Claude, saved as instructions-plan.md
//                                   in the queue's data folder (ignored by git); before ravenseat init it is printed instead
//
// Read-only: it never writes CLAUDE.md, CLAUDE.local.md, .claude/ or any other project file. The split is done by the owner's
// own Claude session, because those are protected paths a queue agent may not change. Works with instructionSize.mode off
// too: it was asked for. The measurement is lib/instructionSize.js, the rules of thumb lib/instructionAdvice.js.
// Tested in: lib/__tests__/instructionsCli.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import { a, CLI, CONFIG, FILE, KK, MAIN_TREE, require } from './context.mjs';

const IS = require('./lib/instructionSize.js');
const AD = require('./lib/instructionAdvice.js');
const PLAN_FILE = 'instructions-plan.md';

/** Everything the three outputs show, from one measurement (each file is read once). */
function picture() {
  const m = IS.measureDisk(MAIN_TREE, { nested: true, keepText: true });
  const limits = IS.limitsOf(CONFIG);
  const assessment = IS.assess(m, limits);
  const memory = IS.memoryOf(MAIN_TREE, require('./lib/claudeFingerprint.js').claudeDir());
  // Suggestions for the project's own always-loaded files; Ravenseat's file, the user's and the organization's are not
  // the project's to split.
  const sections = m.always
    .filter((f) => f.scope === 'project')
    .flatMap((f) => AD.sectionsOf(f.raw).map((s) => ({ source: f.rel, line: s.line, heading: s.heading, chars: s.chars, ...AD.adviseSection(s) })));
  const texts = [...m.always, ...m.onDemand.flatMap((f) => f.parts)].filter((f) => f.scope !== 'organization');
  const dups = AD.duplicates([...new Map(texts.map((f) => [f.rel, f])).values()]);
  return { m, limits, assessment, memory, sections, duplicates: dups };
}

const pad = (s, w) => String(s).padStart(w);
const SCOPE_NAMES = [
  ['project', 'project'],
  ['user', 'your ~/.claude'],
  ['ravenseat', 'Ravenseat'],
  ['organization', 'organization'],
];

function note(f) {
  const bits = [];
  if (f.scope === 'ravenseat') bits.push('Ravenseat');
  else if (f.scope === 'user') bits.push('yours, every project');
  else if (f.scope === 'organization') bits.push('organization');
  if (f.via) bits.push(`imported by ${f.via}`);
  if (f.kind === 'agents-md') bits.push('read because there is no CLAUDE.md');
  return bits.length ? `  (${bits.join(', ')})` : '';
}

function printText(p) {
  const { m, limits, assessment: x, memory } = p;
  console.log(`Claude's instructions for ${MAIN_TREE}\n`);
  console.log('Loaded at the start of every session, track and subagent:');
  if (!m.always.length) console.log('  none');
  else {
    console.log(`  ${pad('chars', 8)}  ${pad('lines', 5)}  file`);
    for (const f of m.always) console.log(`  ${pad(IS.n(f.chars), 8)}  ${pad(f.lines, 5)}  ${f.rel}${note(f)}`);
  }
  console.log(`  Total: ${IS.n(m.total.chars)} chars in ${m.total.files} files, about ${IS.n(m.total.tokens)} tokens`);
  for (const [k, name] of SCOPE_NAMES) if (k !== 'organization' || m.byScope[k]) console.log(`    ${name.padEnd(16)} ${pad(IS.n(m.byScope[k]), 8)}`);
  const over = [];
  if (x.overTotal) over.push(`the total is over ${IS.n(limits.maxChars)}`);
  for (const f of x.overLines) over.push(`${f.rel} has ${f.lines} lines`);
  console.log(
    `  Limits: ${limits.maxLines} lines per file, ${IS.n(limits.maxChars)} chars in all (instructionSize.maxLines, instructionSize.maxChars)` +
      `${limits.mode === 'off' ? '; the advice is off (instructionSize.mode off)' : ''}. ${over.length ? `Over: ${over.join('; ')}.` : 'Within them.'}`,
  );
  console.log(`\nLoaded when Claude works on matching files (Claude sees only the first ${IS.n(IS.CUT_CHARS)} chars of each):`);
  if (!m.onDemand.length) console.log('  none');
  for (const f of m.onDemand) {
    const what = f.kind === 'rule' ? ` (paths: ${f.paths.join(', ')})` : ' (when Claude works in that folder)';
    const cut = f.chars > IS.CUT_CHARS ? '  CUT' : '';
    console.log(`  ${pad(IS.n(f.chars), 8)}  ${f.rel}${what}${f.files > 1 ? `, with ${f.files - 1} import(s)` : ''}${cut}`);
  }
  if (memory) console.log(`\nAuto memory (the main session only, not tracks): ${IS.n(memory.chars)} chars of MEMORY.md`);
  console.log('\nSuggestions per section (rules of thumb; nothing is changed):');
  if (!p.sections.length) console.log('  none: the project has no instruction file of its own');
  let last = null;
  for (const s of p.sections) {
    if (s.source !== last) console.log(`  ${(last = s.source)}`);
    console.log(`    line ${s.line}  ${s.heading} (${IS.n(s.chars)} chars): ${AD.adviceText(s)}`);
  }
  if (p.duplicates.length) {
    console.log('\nThe same line in more than one file (keep one copy, point to it from the others):');
    for (const d of p.duplicates.slice(0, 20)) console.log(`  "${d.line}" in ${d.at.join(', ')}`);
    if (p.duplicates.length > 20) console.log(`  and ${p.duplicates.length - 20} more (--json lists them)`);
  }
  console.log(
    `\nAn @ import saves nothing: it is loaded with the file that names it. ${CLI} instructions --plan writes this as a plan with a ` +
      'text to give Claude in your own session. Nothing was changed.',
  );
}

const cell = (s) => String(s).replace(/\|/g, '\\|');

/** The plan as Markdown: the numbers, the suggestions, the duplicates and the text for Claude. */
function planText(p, where) {
  const { m, limits, assessment: x } = p;
  const parts = SCOPE_NAMES.filter(([k]) => k !== 'organization' || m.byScope[k]).map(([k, name]) => `${name} ${IS.n(m.byScope[k])}`);
  const out = [
    `# Plan: Claude's instructions (${new Date().toISOString().slice(0, 10)})`,
    '',
    `Made by \`${CLI} instructions --plan\`. Rules of thumb, not a decision: read it, change what you disagree with, then give the`,
    'text at the end to Claude in your own session. Ravenseat changes none of your files.',
    '',
    '## Now',
    '',
    `- Loaded at the start of every session, track and subagent: ${IS.n(m.total.chars)} chars in ${m.total.files} files, about ` +
      `${IS.n(m.total.tokens)} tokens (${parts.join(', ')}).`,
    `- Limits: ${limits.maxLines} lines per file, ${IS.n(limits.maxChars)} chars in all.` +
      (x.overTotal || x.overLines.length
        ? ` Over: ${[x.overTotal ? 'the total' : null, ...x.overLines.map((f) => `${f.rel} (${f.lines} lines)`)].filter(Boolean).join(', ')}.`
        : ' Within them.'),
  ];
  if (x.cut.length) out.push(`- Cut when loaded on demand (only the first ${IS.n(IS.CUT_CHARS)} chars reach Claude): ${x.cut.map((f) => f.rel).join(', ')}.`);
  out.push('', '## Suggestions per section', '');
  if (!p.sections.length) out.push('None: the project has no instruction file of its own.');
  else {
    out.push('| File | Line | Section | Chars | Suggestion |', '|---|---|---|---|---|');
    for (const s of p.sections) out.push(`| ${cell(s.source)} | ${s.line} | ${cell(s.heading)} | ${IS.n(s.chars)} | ${cell(AD.adviceText(s))} |`);
  }
  if (p.duplicates.length) {
    out.push('', '## The same line in more than one file', '');
    for (const d of p.duplicates) out.push(`- "${d.line}": ${d.at.join(', ')}`);
  }
  out.push(
    '',
    '## After the split',
    '',
    '- A rule with paths: loads when Claude reads, edits or writes a matching file, also a new one, and in tracks too.',
    '- In each rule file, point to the one place a shared rule lives instead of copying it.',
    `- Run \`${CLI} instructions\` again and compare the numbers.`,
    '',
    '## Text to give Claude in your own session',
    '',
    `> Read the plan in ${where}. Split my instructions as it suggests, with my changes to it: keep the rules that apply`,
    '> everywhere in the root CLAUDE.md, move each area rule to the .claude/rules/ file it names with the paths: it names,',
    '> move each procedure to a skill, and remove what you can read from the code. Keep the wording of every rule you move.',
    '> Keep one copy of each duplicate line and point to it from the others. Show me the diff before you write anything,',
    `> and change nothing until I say yes. Then run ${CLI} instructions again and show me the numbers before and after.`,
    '',
  );
  return out.join('\n');
}

/** `ravenseat instructions [--json] [--plan]` (the usage is at the top of queue.mjs). */
export function cmdInstructions() {
  const p = picture();
  if (a.includes('--json')) {
    const { m, limits, assessment: x, memory, sections, duplicates } = p;
    const strip = ({ raw, parts, path: _p, ...rest }) => rest;
    console.log(
      JSON.stringify(
        {
          root: m.root,
          total: m.total,
          byScope: m.byScope,
          always: m.always.map(strip),
          onDemand: m.onDemand.map(strip),
          memory: memory && { chars: memory.chars, lines: memory.lines },
          limits,
          assessment: { overLines: x.overLines.map((f) => f.rel), overTotal: x.overTotal, cut: x.cut.map((f) => f.rel) },
          sections,
          duplicates,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (a.includes('--plan')) {
    // Only into the queue's data folder, and only when it exists: this command never creates a folder in the project.
    if (!fs.existsSync(FILE)) {
      console.log(planText(p, 'this plan'));
      console.log(`(not saved: there is no queue data folder yet; ${CLI} init makes one. Nothing was changed.)`);
      return;
    }
    const target = path.join(KK.dataFolder(), PLAN_FILE);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, planText(p, target));
    fs.renameSync(tmp, target);
    console.log(`Plan saved: ${target} (in the queue's data folder, ignored by git). Your instruction files were not changed.`);
    console.log('Read it, change it as you like, and give its last section to Claude in your own session.');
    return;
  }
  printText(p);
}

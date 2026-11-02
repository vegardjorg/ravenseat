// =============================================================
// cli/triage.mjs: the intake triage on the command line: `cq triage` and the triage part of `fill`, `next` and `start`.
//
//   cq triage                                   the tasks that need a verdict before they start, and why
//   cq triage <id> --verdict ready|done|stale|adjust [--note "..."] [--by "..."]
//                                               records the triage helper's answer (lib/queueTriage.js recordVerdict)
//   cq triage <id> --prompt [--scratchpad <dir>]
//                                               writes the triage prompt again and prints the agent line
//
// The rule, the verdicts and the owner question live in lib/queueTriage.js; this module only reads files (the mission
// file and its mtime) and prints. `fill` calls triageState under its lock and writeTriageSteps after it.
//
// Used by: queue.mjs (dispatch), cli/run.mjs (fill, next, start), cli/owner.mjs (resolve).
// Tested in: lib/__tests__/queueTriage.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import { a, BASE, CONFIG, CQ, die, edit, git, L, missionFile, positional, pulseCursor, read, readMission, require, val } from './context.mjs';

export const T = require('./lib/queueTriage.js');

/** The mission file's mtime (ms) when the mission is a file, otherwise null (an edit of the file counts as an edit). */
function missionMtimeMs(o) {
  try {
    const f = missionFile(o);
    return f ? fs.statSync(f).mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * The triage state of the queue now: the setup, the candidates (lib/queueTriage.js triageCandidates) and the ids that
 * must not start yet (`skip`, for selectNext). Called under the lock by fill, and without it by next and start.
 */
export function triageState(queue, { now = Date.now(), uncommitted = [] } = {}) {
  const setup = T.triageSetup(CONFIG, queue);
  const list = T.triageCandidates(queue, { now, setup, uncommitted, missionMtimeMs });
  return { setup, list, skip: new Set(list.map((x) => x.id)) };
}

/** Does this one task need a verdict now (start, fill --ids)? The reason, or null. */
export function triageReason(queue, o, { now = Date.now() } = {}) {
  const setup = T.triageSetup(CONFIG, queue);
  const t = T.needsTriage(o, queue, { now, setup, missionMtimeMs: missionMtimeMs(o) });
  return t.need ? t.reason : null;
}

/**
 * Writes `triage-<id>.md` in the scratchpad for each task and returns the agents to start (for the same-turn block)
 * and the lines to print.
 * @returns {{ agents: { id: string, subagent_type: string, prompt: string, message: string }[], lines: string[] }}
 */
export function writeTriageSteps(queue, steps, { scratch, head }) {
  const agents = [];
  const lines = [];
  if (!steps.length) return { agents, lines };
  fs.mkdirSync(scratch, { recursive: true });
  for (const s of steps) {
    const o = queue.tasks.find((x) => x.id === s.id);
    const m = readMission(o);
    const prompt = path.join(scratch, `triage-${o.id}.md`);
    fs.writeFileSync(
      prompt,
      T.triagePrompt(o, {
        reason: s.reason,
        base: BASE,
        head,
        missionText: m.error ? `(${m.error})` : m.text,
        missionPath: m.path,
        cq: CQ,
      }) + '\n',
    );
    agents.push({ id: o.id, subagent_type: T.TRIAGE, prompt, message: T.triageMessage(o.id, prompt) });
    lines.push(`  ${o.id}: ${s.reason}. Prompt ${prompt}`);
  }
  return {
    agents,
    lines: [
      `TRIAGE ${steps.length} task(s) first (they do not start until they have a verdict; read-only helper ` +
        `${require('./lib/projectRoot.js').agentRef(T.TRIAGE)}, small budget):`,
      ...lines,
      `  When each answers: ${CQ} triage <id> --verdict <ready|done|stale|adjust> --note "<its note>" (the TRIAGE line).`,
    ],
  };
}

/** The line about tasks whose triage step was printed recently (an agent may still run), or null. */
export function askedLine(list) {
  const asked = list.filter((x) => x.asked).map((x) => x.id);
  return asked.length ? `Waiting on a triage verdict (step already given): ${asked.join(', ')}.` : null;
}

/** `cq triage` (the usage is at the top of queue.mjs). */
export function cmdTriage() {
  const [id] = positional(1, ['--verdict', '--note', '--by', '--scratchpad']);
  if (!id) {
    const queue = read();
    const s = triageState(queue);
    if (!s.setup.on) {
      console.log(`Intake triage is off: ${s.setup.why}.`);
      return;
    }
    console.log(T.whenText(s.setup));
    if (!s.list.length) console.log('No task needs a triage verdict now.');
    for (const x of s.list) console.log(`  ${x.id.padEnd(12)} ${x.reason}${x.asked ? '  (step given, waiting on the verdict)' : ''}`);
    return;
  }
  if (a.includes('--prompt')) {
    const scratch = val('--scratchpad') ?? process.env.QUEUE_SCRATCHPAD;
    if (!scratch) die('triage <id> --prompt --scratchpad <folder> (or QUEUE_SCRATCHPAD)');
    const queue = read();
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    const reason = triageReason(queue, o) ?? 'asked for by hand';
    const w = writeTriageSteps(queue, [{ id, reason }], { scratch: path.resolve(scratch), head: git(['rev-parse', BASE]) });
    edit((q) => {
      const x = q.tasks.find((y) => y.id === id);
      if (x) x.triage_asked = new Date().toISOString();
    });
    for (const l of w.lines) console.log(l);
    for (const l of L.concurrentBlock(w.agents)) console.log(l);
    return;
  }
  const verdict = val('--verdict');
  if (!verdict) die(`triage <id> --verdict <${T.VERDICTS.join('|')}> [--note "..."] [--by "..."]`);
  const head = git(['rev-parse', BASE]);
  const r = edit((queue) => {
    const s = T.recordVerdict(queue, id, { verdict, note: val('--note'), by: val('--by'), head });
    if (s.error) die(`No verdict recorded: ${s.error}`);
    return { question: s.question, title: s.task.title };
  });
  pulseCursor(`triage ${id} ${verdict}`);
  if (verdict === 'ready') console.log(`${id}: triage ready. It can start (the next fill).`);
  else if (verdict === 'adjust')
    console.log(`${id}: triage adjust. The note is added to the mission (TRIAGE bonus in the track block); it can start (the next fill).`);
  else
    console.log(
      `${id}: triage ${verdict}. It does not start: owner question ${r.question} registered with choices ` +
        `(${T.choicesFor(verdict).join(' / ')}). Ask the owner at the end of the round; the answer: ` +
        `${CQ} resolve ${r.question} --choice <1-3>. Nothing is closed without the owner.`,
    );
}

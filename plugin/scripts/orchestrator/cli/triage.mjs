// =============================================================
// cli/triage.mjs: the intake triage on the command line: `ravenseat triage` and the triage part of `fill`, `next` and `start`.
//
//   ravenseat triage                                   the tasks that need a verdict before they start, and why
//   ravenseat triage <id> --verdict ready|done|stale|adjust [--note "..."] [--by "..."]
//                                               records the triage helper's answer (lib/queueTriage.js recordVerdict)
//   ravenseat triage <id> --prompt [--scratchpad <dir>]
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

import { a, BASE, CONFIG, CLI, die, edit, git, L, missionFile, positional, pulseCursor, read, readMission, require, val } from './context.mjs';
import { logEvent } from './events.mjs';

export const T = require('./lib/queueTriage.js');
const ER = require('./lib/eventRows.js');
// The plan review on the same step (DR-1) and the sensitive zones it counts (PG-5 step 0).
const PR = require('./lib/planReview.js');
const Z = require('./lib/catalogZones.js');

/**
 * The accepted zones a task meets (lib/catalogZones.js), read from the catalog once per call. Without a zone in the
 * catalog nothing more is read (no mission file either): the default is no zones.
 */
export function zonesReader() {
  const zf = Z.zonesOnDisk();
  if (zf.empty) return () => [];
  return (o) => {
    // A zone may match by keyword in the mission, so the mission file's text is read (only when a zone exists).
    const m = readMission(o);
    return zf(o, { missionText: m.error ? null : m.text });
  };
}

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
  const planSetup = PR.setupOf(CONFIG);
  const zonesOf = planSetup.on ? zonesReader() : () => [];
  const list = T.triageCandidates(queue, { now, setup, uncommitted, missionMtimeMs, planSetup, zonesOf });
  return { setup, planSetup, list, skip: new Set(list.map((x) => x.id)) };
}

/** Does this one task need a verdict or a plan review now (start, fill --ids)? The reason, or null. */
export function triageReason(queue, o, { now = Date.now() } = {}) {
  const setup = T.triageSetup(CONFIG, queue);
  const mt = missionMtimeMs(o);
  const t = T.needsTriage(o, queue, { now, setup, missionMtimeMs: mt });
  const planSetup = PR.setupOf(CONFIG);
  const p = planSetup.on ? PR.needsPlanReview(o, queue, { setup: planSetup, zones: zonesReader()(o), missionMtimeMs: mt }) : { need: false };
  const why = [t.need ? t.reason : null, p.need ? p.reason : null].filter(Boolean);
  return why.length ? why.join('; ') : null;
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
        ravenseat: CLI,
        // The plan review on the same step (DR-1): the checklist joins the prompt, one agent for both.
        planReview: s.plan ? { zones: s.zones ?? [] } : null,
      }) + '\n',
    );
    agents.push({ id: o.id, subagent_type: T.TRIAGE, prompt, message: T.triageMessage(o.id, prompt) });
    lines.push(`  ${o.id}: ${s.reason}. Prompt ${prompt}`);
  }
  const plans = steps.filter((s) => s.plan).length;
  return {
    agents,
    lines: [
      `TRIAGE ${steps.length} task(s) first (they do not start until they have a verdict; read-only helper ` +
        `${require('./lib/projectRoot.js').agentRef(T.TRIAGE)}, small budget):`,
      ...lines,
      `  When each answers: ${CLI} triage <id> --verdict <ready|done|stale|adjust> --note "<its note>" (the TRIAGE line).`,
      ...(plans
        ? [`  With a PLANREVIEW line too: add --plan <ok|notes|ask> --plan-note "<its notes>" to the same command.`]
        : []),
    ],
  };
}

/** The line about tasks whose triage step was printed recently (an agent may still run), or null. */
export function askedLine(list) {
  const asked = list.filter((x) => x.asked).map((x) => x.id);
  return asked.length ? `Waiting on a triage verdict (step already given): ${asked.join(', ')}.` : null;
}

/** `ravenseat triage` (the usage is at the top of queue.mjs). */
export function cmdTriage() {
  const [id] = positional(1, ['--verdict', '--note', '--by', '--scratchpad', '--plan', '--plan-note']);
  if (!id) {
    const queue = read();
    const s = triageState(queue);
    if (!s.setup.on && !s.planSetup.on) {
      console.log(`Intake triage is off: ${s.setup.why}.`);
      return;
    }
    if (s.setup.on) console.log(T.whenText(s.setup));
    else console.log(`Intake triage is off (${s.setup.why}); the plan review still runs on its step.`);
    if (s.planSetup.on)
      console.log(`Plan review (${s.planSetup.mode}): before a ${s.planSetup.classes.join(' or ') || 'no class'} task or a task in an accepted sensitive zone starts.`);
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
    const planSetup = PR.setupOf(CONFIG);
    const zones = planSetup.on ? zonesReader()(o) : [];
    const plan = planSetup.on && PR.needsPlanReview(o, queue, { setup: planSetup, zones, missionMtimeMs: missionMtimeMs(o) }).need;
    const w = writeTriageSteps(queue, [{ id, reason, plan, zones }], { scratch: path.resolve(scratch), head: git(['rev-parse', BASE]) });
    edit((q) => {
      const x = q.tasks.find((y) => y.id === id);
      if (x) x.triage_asked = new Date().toISOString();
    });
    for (const l of w.lines) console.log(l);
    for (const l of L.concurrentBlock(w.agents)) console.log(l);
    return;
  }
  const verdict = val('--verdict');
  // --plan ok|notes|ask [--plan-note "..."]: the plan review's answer (DR-1, lib/planReview.js), with or without a verdict.
  const plan = val('--plan');
  if (!verdict && !plan)
    die(`triage <id> --verdict <${T.VERDICTS.join('|')}> [--note "..."] [--plan <${PR.RESULTS.join('|')}> --plan-note "..."] [--by "..."]`);
  const head = git(['rev-parse', BASE]);
  const r = edit((queue) => {
    let question = null;
    let o = null;
    if (verdict) {
      const s = T.recordVerdict(queue, id, { verdict, note: val('--note'), by: val('--by'), head });
      if (s.error) die(`No verdict recorded: ${s.error}`);
      question = s.question;
      o = s.task;
    }
    let p = null;
    // A done or stale verdict already waits on the owner; the plan review is recorded either way.
    if (plan) {
      p = PR.recordPlanReview(queue, id, { result: plan, note: val('--plan-note'), setup: PR.setupOf(CONFIG), by: val('--by') });
      if (p.error) die(`Nothing recorded: ${p.error}`);
      o = p.task;
    }
    return { question, plan: p, title: o?.title };
  });
  if (plan) {
    const p = r.plan;
    if (p.dropped) console.log(`${id}: plan review ${plan} dropped: the note has no file:line, so it counts as ok.`);
    else if (p.question)
      console.log(
        `${id}: plan review ask. It does not start: owner question ${p.question} (${PR.CHOICES.join(' / ')}). ` +
          `Ask the owner at the end of the round; the answer: ${CLI} resolve ${p.question} --choice <1-2>.`,
      );
    else if (plan === 'ok') console.log(`${id}: plan review ok.`);
    else console.log(`${id}: plan review ${plan}. The note is added to the mission (PLAN REVIEW in the track block).`);
    if (!verdict) {
      pulseCursor(`triage ${id} plan ${plan}`);
      return;
    }
  }
  pulseCursor(`triage ${id} ${verdict}`);
  // The triage row (lib/eventRows.js): the verdicts per week (fail open).
  logEvent(ER.triageRow({ task: id, verdict, by: val('--by') ?? null }));
  if (verdict === 'ready' && r.plan?.question) console.log(`${id}: triage ready; it waits on ${r.plan.question} first.`);
  else if (verdict === 'ready') console.log(`${id}: triage ready. It can start (the next fill).`);
  else if (verdict === 'adjust')
    console.log(`${id}: triage adjust. The note is added to the mission (TRIAGE bonus in the track block); it can start (the next fill).`);
  else
    console.log(
      `${id}: triage ${verdict}. It does not start: owner question ${r.question} registered with choices ` +
        `(${T.choicesFor(verdict).join(' / ')}). Ask the owner at the end of the round; the answer: ` +
        `${CLI} resolve ${r.question} --choice <1-3>. Nothing is closed without the owner.`,
    );
}

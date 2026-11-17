// =============================================================
// quickGate.js: CI parity for a built gate guard (ROADMAP 0i step 9b, plans/feillogg-til-gater-2026-11-15.md section
// 3.7 point 4 and section 3.9). Pure rules, no disk: cli/checks.mjs and cli/inspection.mjs read the files and pass them.
//
//   items          the card "add <command> to gates.quick": an active gate guard in the registry (.ravenseat/guards.json)
//                  whose command is not in gates.quick yet. The command is read from the registry, never from the board.
//   commandProblem the command check: one plain line, not a deploy command (config deployCommands), not a push
//   addToQuickText the only write: ADDS one command at the end of gates.quick and keeps everything else in the file. It
//                  can never remove, replace or reorder a command, and refuses a gates.quick that is not a list of
//                  commands rather than replacing it (isAddition checks the result before it is returned).
//   idle, idleLines a gate guard with 0 runs at least `days` after it was built: one INFO line (never a stop)
//   itemId         the item key the board sends: a guard id or null
//   guardKinds     the kinds of check (lib/checksScan.js classify) the active gate guards' commands are, for lifting the
//                  CI cards (tests-in-ci, quality-in-ci) when a guard's kind is not run in CI
// =============================================================
'use strict';

const SV = require('./settingsView.js');
const GR = require('./guardRegistry.js');
const SCAN = require('./checksScan.js');

const COMMAND_MAX = 200;
const DAY = 86_400_000;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
/** The commands of a gates list as trimmed strings (anything else is left out). */
const listOf = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);

/** Words without env prefixes (FOO=bar) and command/exec/env in front, joined by single spaces. */
function plainCommand(command) {
  const words = String(command).trim().split(/\s+/);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ['command', 'exec', 'env'].includes(words[i]))) i++;
  return words.slice(i).join(' ');
}

/**
 * Why this command cannot go into gates.quick, or null. A gate runs on every merge, so it is one plain line: no line
 * break or control character, at most 200 characters, not an option, not a deploy command and not a push.
 * @param {unknown} command
 * @param {{ deployCommands?: string[] }} [opts]  the config's deployCommands
 * @returns {string|null}
 */
function commandProblem(command, { deployCommands = [] } = {}) {
  if (typeof command !== 'string' || !command.trim()) return 'the command is empty';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(command)) return 'the command must be one line without control characters';
  const t = command.trim();
  if (t.length > COMMAND_MAX) return `the command is longer than ${COMMAND_MAX} characters`;
  if (t.startsWith('-')) return 'the command cannot start with -';
  const line = plainCommand(t);
  for (const d of Array.isArray(deployCommands) ? deployCommands : []) {
    const want = plainCommand(String(d ?? ''));
    if (want && line.startsWith(want)) return `"${want}" is a deploy command (deployCommands), and a gate never deploys`;
  }
  if (/(^|[\s;&|(])git\s+(?:-\S+\s+)*push\b/.test(line)) return 'a gate never runs git push';
  return null;
}

/**
 * The card's items: one per active gate guard whose command is not in gates.quick, in registry order. A command the
 * check refuses is never offered.
 * @param {{ registry: object|null, gates?: { quick?: string[], full?: string[] }, deployCommands?: string[] }} input
 * @returns {{ guard: string, title: string, command: string, task: string|null, inFull: boolean }[]}
 */
function items({ registry, gates = {}, deployCommands = [] }) {
  const quick = new Set(listOf(gates?.quick));
  const full = new Set(listOf(gates?.full));
  const out = [];
  const seen = new Set();
  for (const g of Array.isArray(registry?.guards) ? registry.guards : []) {
    if (g?.status !== 'active' || g.kind !== 'gate' || typeof g.command !== 'string') continue;
    const command = g.command.trim();
    if (!command || quick.has(command) || seen.has(command) || commandProblem(g.command, { deployCommands })) continue;
    seen.add(command);
    out.push({ guard: g.id, title: text(g.title), command, task: g.task ?? null, inFull: full.has(command) });
  }
  return out;
}

/**
 * True only when `after` is `before` with exactly `command` added at the end: nothing removed, replaced or reordered.
 * @param {string[]} before @param {string[]} after @param {string} command
 */
function isAddition(before, after, command) {
  if (!Array.isArray(before) || !Array.isArray(after) || after.length !== before.length + 1) return false;
  if (after.at(-1) !== command) return false;
  return before.every((c, i) => after[i] === c);
}

/**
 * The new text of queue.config.json with `command` added to gates.quick. The rest of the file is kept as written
 * (SV.setJsonText). Never removes or replaces: a gates.quick that is not a list of commands is refused.
 * @param {string|null} fileText  the file's text (null: no file yet)
 * @param {string} command
 * @param {{ deployCommands?: string[] }} [opts]
 * @returns {{ error: string|null, changed: boolean, text: string|null, list: string[] }}
 */
function addToQuickText(fileText, command, opts = {}) {
  const fail = (error) => ({ error, changed: false, text: null, list: [] });
  const problem = commandProblem(command, opts);
  if (problem) return fail(problem);
  const cmd = command.trim();
  const src = String(fileText ?? '').replace(/^﻿/, '');
  let obj = {};
  if (src.trim()) {
    try {
      obj = JSON.parse(src);
    } catch {
      return fail('queue.config.json is not valid JSON, so nothing was written');
    }
    if (!isObject(obj)) return fail('queue.config.json must be a JSON object');
  }
  if (obj.gates !== undefined && !isObject(obj.gates)) return fail('gates in queue.config.json is not an object, so nothing was written');
  const now = obj.gates?.quick;
  if (now !== undefined && !(Array.isArray(now) && now.every((c) => typeof c === 'string')))
    return fail('gates.quick in queue.config.json is not a list of commands, so it is not changed');
  const before = now ?? [];
  if (before.some((c) => c.trim() === cmd)) return { error: null, changed: false, text: fileText, list: before };
  const after = [...before, cmd];
  let out;
  try {
    out = SV.setJsonText(fileText, ['gates', 'quick'], after);
  } catch (e) {
    return fail(String(e?.message ?? e));
  }
  // The result is checked again: the only change is the one command at the end, every other key is the same.
  const parsed = JSON.parse(out.replace(/^﻿/, ''));
  const rest = (o) => JSON.stringify({ ...o, gates: { ...(o.gates ?? {}), quick: null } });
  if (!isAddition(before, parsed.gates?.quick, cmd) || rest(parsed) !== rest({ ...obj, gates: { ...(obj.gates ?? {}) } }))
    return fail('the write would have changed more than one added command, so nothing was written');
  return { error: null, changed: true, text: out, list: after };
}

/**
 * Active gate guards with 0 runs, built at least `days` ago (the time log's gate rows, GR.measuresFor).
 * @param {object|null} registry @param {object[]} rows the time log
 * @param {{ now?: number, days?: number }} [opts]
 * @returns {{ id: string, title: string, command: string, built: string, days: number }[]}
 */
function idle(registry, rows, { now = Date.now(), days = 7 } = {}) {
  const out = [];
  for (const g of Array.isArray(registry?.guards) ? registry.guards : []) {
    if (g?.status !== 'active' || g.kind !== 'gate' || !text(g.command)) continue;
    const built = Date.parse(String(g.built ?? ''));
    if (!Number.isFinite(built)) continue;
    const age = Math.floor((now - built) / DAY);
    if (age < days) continue;
    if (GR.measuresFor(g, rows).runs !== 0) continue;
    out.push({ id: g.id, title: text(g.title), command: g.command.trim(), built: g.built, days: age });
  }
  return out;
}

/**
 * One INFO line per idle guard. When the command is not in gates.quick, the line says how to add it.
 * @param {ReturnType<typeof idle>} list @param {{ cli?: string, quick?: string[] }} [opts]
 */
function idleLines(list, { cli = 'ravenseat', quick = [] } = {}) {
  const inQuick = new Set(listOf(quick));
  return (list ?? []).map((g) =>
    inQuick.has(g.command)
      ? `INFO: ${g.id} (${g.title}) has 0 runs in ${g.days} days, although "${g.command}" is in gates.quick. Check that the merge gate runs.`
      : `INFO: ${g.id} (${g.title}) has 0 runs in ${g.days} days: "${g.command}" is not in gates.quick, so no merge runs it. ${cli} checks quick-add ${g.id} adds it (nothing runs from that).`,
  );
}

/** The item the board sends: a guard id (G-1 .. G-999999), or null. */
const itemId = (v) => (typeof v === 'string' && /^G-\d{1,6}$/.test(v) ? v : null);

/**
 * The kinds of check the active gate guards' commands are, with the guards for each kind.
 * @param {object|null} registry @param {{ scripts?: Record<string, string> }} [opts] package.json scripts
 * @returns {Record<string, string[]>}
 */
function guardKinds(registry, { scripts = {} } = {}) {
  const out = {};
  for (const g of Array.isArray(registry?.guards) ? registry.guards : []) {
    if (g?.status !== 'active' || g.kind !== 'gate' || !text(g.command)) continue;
    for (const k of SCAN.classify(SCAN.withScriptBody(g.command, scripts ?? {}))) (out[k] ??= []).push(g.id);
  }
  return out;
}

module.exports = { COMMAND_MAX, commandProblem, items, isAddition, addToQuickText, idle, idleLines, itemId, guardKinds };

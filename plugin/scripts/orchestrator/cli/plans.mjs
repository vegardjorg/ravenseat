// =============================================================
// cli/plans.mjs: the plan command: the plan register (plans.json), see docs/plan-register.md.
//
// planCommand dispatches the plan sub-commands (show, get, new, edit, prioritize, prioritize-many, combine, drop,
// verify, undo, rules, check, modules, backup, active and doc); the rules are in lib/queuePlan.js.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queuePlan.test.ts, queuePlanDoc.test.ts, queuePlanMap.test.ts, queuePlanWork.test.ts, queueFeatures.test.ts.
// =============================================================

import fs from 'node:fs';

import {
  a, byName, cut, die, gitRead, P, readPlans, readQueueForPlan, val, values, WIDTH, withLock, writePlans,
} from './context.mjs';
import {
  editPlans, existsSource, forFlag, planAnswer, planDiffLines, planError, planRole, planRow,
} from './planShared.mjs';
import { planActive, planBackup, planCheck, planModules } from './planCheck.mjs';
import { planDoc } from './planDoc.mjs';

export function planCommand() {
  const under = a[1];
  const json = a.includes('--json');
  if (under === 'show') {
    const queue = readQueueForPlan();
    const reg = readPlans();
    const filter = {
      module: val('--module') ?? null,
      project: val('--project') ?? null,
      priority: values('--priority'),
      maturity: values('--maturity'),
      search: val('--search') ?? null,
      all: a.includes('--all'),
    };
    for (const p of filter.priority)
      if (!P.PRIORITIES.includes(p)) die(`unknown priority ${p} (${P.PRIORITIES.join(', ')})`);
    for (const m of filter.maturity)
      if (!P.MATURITIES.includes(m)) die(`unknown maturity ${m} (${P.MATURITIES.join(', ')})`);
    const entries = P.filterEntries(reg, queue, filter);
    const hidden =
      filter.all || filter.priority.includes('drop')
        ? 0
        : reg.entries.filter((p) => p.priority === 'drop').length;
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          changed: reg.changed ?? null,
          entries,
          hidden_drop: hidden,
          activeOnes: P.activeEntries(reg),
        }),
      );
      return;
    }
    if (!reg.entries.length) {
      console.log('The plan register is empty. Add entries with: cq plan new --file <json>');
      return;
    }
    let previous = null;
    for (const p of entries) {
      const group = `${p.module ?? '(without area)'} / ${p.project}`;
      if (group !== previous) console.log(`\n${group}`);
      previous = group;
      console.log(`  ${planRow(p)}`);
    }
    console.log(
      `\n${entries.length} of ${reg.entries.length} entries${hidden ? `; ${hidden} dropped are hidden (--all)` : ''}.`,
    );
  } else if (under === 'get') {
    const sortKey = a[2];
    if (!sortKey || sortKey.startsWith('--')) die('plan get <id|project|module> [--json]');
    const r = P.get(readPlans(), readQueueForPlan(), sortKey, { existsPath: existsSource });
    if (r.error.length) planError(r.error);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...r }));
      return;
    }
    console.log(
      `${r.type} ${r.sortKey}${r.title ? `: ${r.title}` : ''} (${r.entries.length} entries)`,
    );
    console.log(`Copy: ${r.copy}`);
    for (const p of r.entries) {
      console.log(`\n${planRow(p)}`);
      if (p.summary) console.log(`  ${p.summary}`);
      if (p.priority_reason)
        console.log(`  Priority (${p.priority_set_by}): ${p.priority_reason}`);
      if (p.drop_reason) console.log(`  Dropped: ${p.drop_reason}`);
      if (p.agent_boost)
        console.log(`  Lifted by agent ${p.agent_boost.at} (was ${p.agent_boost.from.priority})`);
      if (p.measured_rule && p.measured_rule.priority !== p.priority)
        console.log(
          `  Rule ${p.measured_rule.nr} (${p.measured_rule.name}) points to ${p.measured_rule.priority}: ${p.measured_rule.reason}`,
        );
      for (const k of p.sources)
        console.log(
          `  source ${k.path}${k.anchor ? ` ${k.anchor}` : ''}${k.role ? ` (${k.role})` : ''}${k.exists === false ? '  DOES NOT EXIST' : ''}`,
        );
      if (p.queue.length)
        console.log(`  queue: ${p.queue.map((o) => `${o.id} ${o.status ?? '?'}`).join(', ')}`);
      for (const s of p.ownerQuestion)
        console.log(
          `  owner question ${s.id}${s.resolved ? ' (resolved)' : ''}${s.text ? `: ${cut(s.text, WIDTH - 20)}` : ''}`,
        );
      if (p.depends_on?.length) console.log(`  depends on: ${p.depends_on.join(', ')}`);
      if (p.blocks.length) console.log(`  blocks: ${p.blocks.join(', ')}`);
      if (p.verified)
        console.log(
          `  verified ${p.verified.date} by ${p.verified.by}${p.verified.commit ? ` (${p.verified.commit})` : ''}: ${p.verified.findings}`,
        );
      if (p.legal) console.log(`  legal: ${cut(JSON.stringify(p.legal), WIDTH - 12)}`);
    }
  } else if (under === 'new') {
    const file = val('--file');
    if (!file) die('plan new --file <json> [--dry] [--json] [--set-by agent|owner]');
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(content) ? content : [content];
    const role = planRole();
    const r = editPlans('plan new', (reg, queue) => {
      const error = [];
      const warnings = [];
      const newOnes = [];
      for (const input of list) {
        const s = P.newEntry(reg, input, {
          role,
          projects: queue.projects ?? {},
          question: queue.question ?? {},
          existsPath: existsSource,
        });
        error.push(...s.error);
        warnings.push(...s.warnings);
        if (s.entry) newOnes.push(s.entry.id);
      }
      return { error, warnings, newOnes };
    });
    planAnswer(r, `${r.newOnes.length} new plan entr(ies): ${r.newOnes.join(', ')}`);
  } else if (under === 'edit') {
    const id = a[2];
    if (!id || id.startsWith('--'))
      die('plan edit <id> [--field name=val ...] [--set \'{"field":...}\'] [--dry] [--json]');
    const t = P.parseFieldArg(values('--field'));
    if (t.error.length) die(t.error.join('\n'));
    let field = t.field;
    if (val('--set') != null) {
      let s;
      try {
        s = JSON.parse(val('--set'));
      } catch (e) {
        die(`--set is not valid JSON: ${e.message}`);
      }
      field = { ...field, ...s };
    }
    if (!Object.keys(field).length) die("no field to edit (--field name=val or --set '{...}')");
    const role = planRole();
    const r = editPlans('plan edit', (reg, queue) =>
      P.editEntry(reg, id, field, {
        role,
        by: byName(),
        projects: queue.projects ?? {},
        question: queue.question ?? {},
        existsPath: existsSource,
      }),
    );
    planAnswer(
      r,
      `Changed ${id}${r.boost ? ' (lifted to now/security by rule 1; shown in the inbox)' : ''}`,
    );
  } else if (under === 'prioritize') {
    const pos = forFlag(2);
    const priority = pos.pop();
    if (!pos.length || !priority)
      die(
        'plan prioritize <id...> <now|owner|later|drop> [--category security for-prod important] [--reason "..."] [--dry] [--json]',
      );
    const role = planRole();
    const r = editPlans('plan prioritize', (reg, queue) =>
      P.prioritize(
        reg,
        pos,
        { priority, category: values('--category'), reason: val('--reason') ?? null },
        {
          role,
          by: byName(),
          projects: queue.projects ?? {},
          question: queue.question ?? {},
          existsPath: existsSource,
        },
      ),
    );
    planAnswer(
      r,
      `Priority ${priority}: ${r.changed.length} changed${r.unchanged.length ? `, ${r.unchanged.length} unchanged` : ''}` +
        `${r.boost.length ? `; lifted by rule 1: ${r.boost.join(', ')}` : ''}`,
    );
  } else if (under === 'prioritize-many') {
    // The whole draft from the priority map in one write (one lock, one changelog entry, one undo).
    const file = val('--file');
    if (!file)
      die(
        'plan prioritize-many --file <json> [--dry] [--expect-changed <iso>] [--set-by agent|owner] [--json]',
      );
    let list;
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      planError([`could not read ${file}: ${e.message}`], 1);
    }
    const role = planRole();
    const r = editPlans('plan prioritize-many', (reg, queue) =>
      P.prioritizeMany(reg, list, {
        role,
        by: byName(),
        projects: queue.projects ?? {},
        question: queue.question ?? {},
        existsPath: existsSource,
      }),
    );
    planAnswer(
      r,
      `Priorities: ${r.changed.length} changed${r.unchanged.length ? `, ${r.unchanged.length} unchanged` : ''}` +
        `${r.boost.length ? `; lifted by rule 1: ${r.boost.join(', ')}` : ''}`,
    );
  } else if (under === 'combine') {
    const pos = forFlag(2);
    const [to, ...from] = pos;
    if (!to || !from.length) die('plan combine <to-id> <from-id...> [--dry] [--json]');
    const r = editPlans('plan combine', (reg) => P.combineTogether(reg, to, from));
    planAnswer(r, `Combined ${from.join(', ')} into ${to} (the others are in the archive)`);
  } else if (under === 'verify') {
    const id = a[2];
    if (!id || id.startsWith('--') || val('--findings') == null)
      die('plan verify <id> --findings "..." [--commit <sha>] [--dry] [--json]');
    const commit =
      val('--commit') ?? (String(gitRead(['rev-parse', '--short', 'HEAD']) ?? '').trim() || null);
    const role = planRole();
    const r = editPlans('plan verify', (reg, queue) =>
      P.verify(
        reg,
        id,
        { findings: val('--findings'), commit, role },
        { projects: queue.projects ?? {}, question: queue.question ?? {}, existsPath: existsSource },
      ),
    );
    planAnswer(r, `Verified ${id}`);
  } else if (under === 'undo') {
    // Like `queue.mjs undo`, but for the plan register's own changelog.
    const textFor = (p) =>
      `no. ${p.nr} ${p.action} by ${p.by} ${p.at} (${p.changes.length} field(s))`;
    const nrError = (reg) => {
      if (val('--nr') == null) return null;
      const last = P.lastUndoable(reg);
      return last && String(last.nr) === String(val('--nr'))
        ? null
        : `the last change that can be undone is ${last ? `no. ${last.nr}` : 'none'}, not no. ${val('--nr')}; nothing undone`;
    };
    if (a.includes('--show')) {
      const reg = readPlans();
      const nf = nrError(reg);
      const s = nf ? { error: [nf], entry: P.lastUndoable(reg) } : P.undo(reg, { show: true });
      if (json)
        console.log(JSON.stringify({ ok: !s.error.length, error: s.error, entry: s.entry ?? null }));
      else {
        if (s.entry) console.log(`Last undoable: ${textFor(s.entry)}`);
        console.log(
          s.error.length
            ? `Can NOT be undone now:\n  ${s.error.join('\n  ')}`
            : 'Can be undone (cq plan undo).',
        );
      }
      return;
    }
    const r = withLock(() => {
      const reg = readPlans();
      const fe = P.expectCheck(reg, val('--expect-changed') ?? null);
      if (fe) planError([fe], fe.startsWith('invalid') ? 1 : 6);
      const nf = nrError(reg);
      const s = nf ? { error: [nf] } : P.undo(reg, { by: byName() });
      if (s.error.length) planError(s.error);
      writePlans(reg);
      return s;
    });
    if (json) console.log(JSON.stringify({ ok: true, entry: r.entry }));
    else {
      console.log(`Undone ${textFor(r.entry)}:`);
      for (const l of planDiffLines(
        r.entry.changes.map((e) => ({ ...e, before: e.after, after: e.before })),
      ))
        console.log(`  ${l}`);
    }
  } else if (under === 'active') {
    planActive(json);
  } else if (under === 'rules') {
    if (json) console.log(JSON.stringify({ ok: true, rules: P.PRIORITY_RULES }));
    else
      for (const r of P.PRIORITY_RULES)
        console.log(
          `${r.nr}. ${r.name} → ${r.priority}${r.categories.length ? `/${r.categories.join(' or ')}` : ''}: ${r.matches}`,
        );
  } else if (under === 'check') {
    planCheck(json);
  } else if (under === 'modules') {
    planModules(json);
  } else if (under === 'backup') {
    planBackup();
  } else if (under === 'doc') {
    planDoc(json);
  } else {
    die(
      'Use: cq plan <show|get|new|edit|prioritize|prioritize-many|combine|verify|undo|active|rules|check|modules|backup|doc> ...  (see the top of the file)',
      under ? 1 : 0,
    );
  }
}

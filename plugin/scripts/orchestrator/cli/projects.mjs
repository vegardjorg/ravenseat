// =============================================================
// cli/projects.mjs: the project and priority commands: projects, project, area, areas, focus, park, continue and rank.
//
// The project register (prefixes, names), the areas, the focus stages (the order work is taken in), park/continue of a
// project, and rank (the order inside the queue). The writes that undo can take back go through editLogged.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueFocus.test.ts, queueBulk.test.ts, queueBoardPlan.test.ts, queueBoardBulk.test.ts, queueBoard.test.ts.
// =============================================================

import fs from 'node:fs';

import {
  a, byName, checkExpect, cut, die, edit, editLogged, hasLock, L, lastEntry, LOCK, positional, read, uncommittedPaths,
  undoHint, val, values, WIDTH,
} from './context.mjs';

/** `ravenseat projects` (the usage is at the top of queue.mjs). */
export function cmdProjects() {
  // ---- Project and feature ----
  const queue = read();
  if (!Object.keys(queue.projects ?? {}).length)
    console.log(
      'The register is empty: create one with ravenseat project <pid> --title "..." --prefix EX- (or edit-many --file).\n',
    );
  for (const r of L.projectOverview(queue)) {
    const parts = [
      `${r.done}/${r.total} done`,
      `${r.min_left} min left`,
      r.activeOnes ? `${r.activeOnes} active` : null,
      r.picked ? `${r.picked} picked` : null,
      r.qa ? `${r.qa} in QA` : null,
      r.proposed ? `${r.proposed} proposed` : null,
      r.pause ? 'PAUSE' : null,
      r.priority_bonus
        ? `priority ${r.priority_bonus > 0 ? '+' : ''}${r.priority_bonus}`
        : null,
      !r.in_register && r.pid !== L.WITHOUT_PROJECT ? 'not in the register' : null,
    ].filter(Boolean);
    console.log(cut(`${r.pid.padEnd(16)} ${parts.join(' · ')}`, WIDTH));
    const prefixes = queue.projects?.[r.pid]?.prefixes ?? [];
    const ar = queue.projects?.[r.pid]?.area;
    const info = [
      r.title,
      r.plan,
      prefixes.length ? `prefix ${prefixes.join(' ')}` : null,
      ar ? `area ${ar}` : null,
      queue.projects?.[r.pid]?.phase ? `phase ${queue.projects[r.pid].phase}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (info) console.log(`  ${cut(info, WIDTH - 2)}`);
    if (r.ownerQuestion.length) {
      const sp = r.ownerQuestion
        .slice(0, 3)
        .map((e) => `${e.sp} (${e.tasks})`)
        .join(', ');
      const more = r.ownerQuestion.length > 3 ? ` +${r.ownerQuestion.length - 3} more` : '';
      console.log(`  ${cut(`↳ waiting on the owner: ${sp}${more}`, WIDTH - 2)}`);
    }
  }
}

/** `ravenseat project` (the usage is at the top of queue.mjs). */
export function cmdProject() {
  const pid = a[1];
  if (!pid || pid.startsWith('--'))
    die(
      'project <pid> [--title ..] [--plan ..] [--prefix EX- ...] [--pause | --continue] [--priority N] [--area <oid|none>] [--file-root <path ...>] [--phase plan|none]',
    );
  if (a.includes('--pause') && a.includes('--continue')) die('choose one of --pause and --continue');
  const field = {};
  if (val('--title') != null) field.title = val('--title');
  if (val('--plan') != null) field.plan = val('--plan');
  if (a.includes('--prefix')) field.prefixes = values('--prefix');
  if (a.includes('--pause')) field.pause = true;
  if (a.includes('--continue')) field.pause = null;
  // The area the project belongs to ("none" takes it out).
  if (val('--area') != null)
    field.area = val('--area') === 'none' ? null : val('--area');
  if (val('--priority') != null) {
    const n = Number(String(val('--priority')).replace(',', '.'));
    if (!Number.isFinite(n))
      die('--priority must be a number (bonus to the priority, e.g. 20 or -10)');
    field.priority_bonus = n === 0 ? null : n;
  }
  // File roots (a signal for classify); --file-root without values removes the list.
  if (a.includes('--file-root')) {
    const r = values('--file-root');
    field.fileRoot = r.length ? r : null;
  }
  // Phase plan = the project exists in the planning work, but has no queue tasks yet ("none" removes it).
  if (val('--phase') != null) field.phase = val('--phase') === 'none' ? null : val('--phase');
  const r = editLogged('project', (queue) => {
    const fresh = !Object.hasOwn(queue.projects ?? {}, pid);
    const reg = L.newRegister(queue.projects, { [pid]: field }, queue.areas);
    if (reg.error.length) die(`Nothing changed:\n  ${reg.error.join('\n  ')}`);
    if (field.phase === 'plan') {
      const includesOr = queue.tasks.filter(
        (o) => o.status !== 'cancelled' && L.projectFor(o, reg.register) === pid,
      ).length;
      if (includesOr)
        die(
          `Nothing changed: ${pid} has ${includesOr} queue task(s); phase plan only applies to projects without queue tasks.`,
        );
    }
    queue.projects = reg.register;
    // One-char prefixes and overlapping prefixes (the longest prefix wins, projectFor). Report, do not refuse.
    const warnings = L.prefixWarnings(queue.projects, { pid });
    const count = queue.tasks.filter((o) => L.projectFor(o, queue.projects) === pid).length;
    return { new: fresh, p: queue.projects[pid], count, warnings };
  });
  console.log(
    `${r.new ? 'Created' : 'Changed'} project ${pid} (${r.count} tasks): ${JSON.stringify(r.p)}`,
  );
  for (const x of r.warnings) console.log(`WARNING: ${x}`);
  if (undoHint()) console.log(undoHint());
}

/** `ravenseat area` (the usage is at the top of queue.mjs). */
export function cmdArea() {
  // ---- Areas, focus and parking ----
  const oid = a[1];
  if (!oid || oid.startsWith('--'))
    die(
      'area <oid> [--title "..."] [--description "..."] [--projects <pid> ...] [--remove <pid> ...] | area <oid> --delete',
    );
  const field = {};
  if (val('--title') != null) field.title = val('--title');
  if (a.includes('--description')) field.description = val('--description') || null;
  if (a.includes('--projects')) field.projects = values('--projects');
  if (a.includes('--remove')) field.remove = values('--remove');
  if (a.includes('--delete')) field.delete = true;
  const r = edit((queue) => {
    // The board sends --expect-changed (the queue's version from the preview); exit 6 when the queue has changed since.
    checkExpect(queue);
    const s = L.setArea(queue, oid, field);
    if (s.error.length) die(`Nothing changed:\n  ${s.error.join('\n  ')}`);
    return s;
  });
  if (r.deleted) console.log(`Deleted area ${oid}.`);
  else
    console.log(
      `${r.new ? 'Created' : 'Changed'} area ${oid}: ${JSON.stringify(r.area)}` +
        `${r.moved.length ? `; projects in: ${r.moved.join(', ')}` : ''}` +
        `${r.removed.length ? `; taken out: ${r.removed.join(', ')}` : ''}`,
    );
}

/** `ravenseat areas` (the usage is at the top of queue.mjs). */
export function cmdAreas() {
  const queue = read();
  if (!Object.keys(queue.areas ?? {}).length)
    console.log(
      'No areas yet: create one with ravenseat area <oid> --title "..." --projects <pid> ...\n',
    );
  for (const r of L.areaOverview(queue)) {
    const parts = [
      `${r.waiting} waiting`,
      `${r.readyOnes} ready`,
      `${r.min_left} min left`,
      r.activeOnes ? `${r.activeOnes} active` : null,
      r.parked ? `${r.parked} parked` : null,
      !r.in_register && r.oid !== L.WITHOUT_AREA ? 'not in the register' : null,
    ].filter(Boolean);
    console.log(cut(`${r.oid.padEnd(18)} ${parts.join(' · ')}`, WIDTH));
    const info = [r.title, r.description].filter(Boolean).join(' · ');
    if (info) console.log(`  ${cut(info, WIDTH - 2)}`);
    if (r.projects.length)
      console.log(`  ${cut(`projects: ${r.projects.join(', ')}`, WIDTH - 2)}`);
  }
}

/** `ravenseat focus` (the usage is at the top of queue.mjs). */
export function cmdFocus() {
  const under = a[1];
  if (under === 'set') {
    const order = positional(2, ['--rest', '--to', '--name', '--by', '--continue-when-empty']);
    const rest = val('--rest');
    // --continue-when-empty on|off: this focus's own answer to "continue the regular queue when the focus has ended"
    // (overrides the config focus.continueWhenEmpty). Left out = the config decides.
    const cweRaw = val('--continue-when-empty');
    const cwe = cweRaw == null ? undefined : { on: true, off: false }[String(cweRaw).toLowerCase()];
    if (cweRaw != null && cwe === undefined) die(`--continue-when-empty must be on or off (got ${cweRaw})`);
    const r = edit((queue) => {
      const s = L.setFocus(queue, {
        order,
        rest: rest ?? undefined,
        to: val('--to') ?? null,
        name: val('--name') ?? null,
        drag_with_dependencies: !a.includes('--without-dependencies'),
        set_by: val('--by') ?? null,
        continue_when_empty: cwe,
      });
      if (s.error.length) die(`Focus not changed:\n  ${s.error.join('\n  ')}`);
      return { s, text: L.focusText(queue) };
    });
    console.log(`Focus set: ${r.text}`);
    for (const x of r.s.warnings) console.log(`WARNING: ${x}`);
  } else if (under === 'save') {
    // The plan view on the board saves the focus and the pause changes (the "Waiting" column) in ONE change, all or
    // nothing (queueLogic.saveFocusPlan). --dry computes on a copy and writes nothing; --expect-changed refuses with
    // exit 6 when the queue has changed after the preview; --json answers with one JSON line (for the board).
    const file = val('--file');
    if (!file)
      die('focus save --file <plan.json> [--dry] [--expect-changed <iso>] [--json] [--by "..."]');
    let input;
    try {
      input = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      die(`could not read ${file}: ${e?.message ?? e}`);
    }
    const json = a.includes('--json');
    const now = new Date().toISOString();
    const plan = { ...input, set_by: val('--by') ?? input?.set_by ?? null };
    const errorOut = (s) => {
      if (!json) die(`Focus not changed:\n  ${s.join('\n  ')}`);
      console.log(JSON.stringify({ ok: false, error: s }));
      if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
      process.exit(1);
    };
    const answer = (queue, r, dry) => {
      if (json)
        console.log(
          JSON.stringify({
            ok: true,
            dry,
            changed: queue.changed ?? null,
            focus: r.focus,
            removed: r.removed,
            paused: r.paused,
            still: r.still,
            warnings: r.warnings,
          }),
        );
      else {
        console.log(
          `${dry ? 'Dry run (nothing written): ' : ''}` +
            (r.focus ? `focus ${L.focusText({ ...queue, focus: r.focus })}` : 'no focus') +
            `${r.paused.length ? ` · pause: ${r.paused.join(', ')}` : ''}` +
            `${r.still.length ? ` · continues: ${r.still.join(', ')}` : ''}`,
        );
        for (const x of r.warnings) console.log(`WARNING: ${x}`);
      }
    };
    if (a.includes('--dry')) {
      const queue = read();
      checkExpect(queue);
      const r = L.saveFocusPlan(L.cloneJson(queue), plan, now);
      if (r.error.length) errorOut(r.error);
      answer(queue, r, true);
    } else {
      let after = null;
      const r = edit((queue) => {
        checkExpect(queue);
        const s = L.saveFocusPlan(queue, plan, now);
        if (s.error.length) errorOut(s.error);
        after = queue;
        return s;
      });
      answer(after, r, false);
    }
  } else if (under === 'evaluate') {
    // The evaluation of each stage (queueLogic.evaluateFocusStep), with the rests and suggestions.
    const queue = read();
    const ev = L.evaluateFocusStep(queue);
    if (a.includes('--json')) {
      console.log(JSON.stringify({ ok: true, focus: !!queue.focus, stages: ev }));
    } else if (!ev.length) console.log('No focus set (ravenseat focus set ...).');
    else {
      const max = a.includes('--all') ? Infinity : 10;
      for (const t of ev) {
        console.log(
          cut(
            `T${t.index + 1} ${t.title} (${t.stage}): ${t.status} · ${t.open} open · ${t.ready} ready · ` +
              `${t.min_left} min left${t.rests.length ? ` · ${t.rests.length} rest(s)` : ''}`,
            WIDTH,
          ),
        );
        for (const r of t.rests.slice(0, max)) console.log(cut(`    ${L.restText(r)}`, WIDTH));
        if (t.rests.length > max) console.log(`    … and ${t.rests.length - max} more (--all shows all)`);
      }
      const done = ev.filter((t) => t.status === 'done').length;
      if (done) console.log(`${done} stage(s) are done: ravenseat focus clean takes them out.`);
    }
  } else if (under === 'clean') {
    // Takes out the stages with status done (queueLogic.cleanFocus); --dry computes without writing.
    const dry = a.includes('--dry');
    const r = dry
      ? L.cleanFocus(L.cloneJson(read()), { by: byName(), dry: true })
      : edit((queue) => L.cleanFocus(queue, { by: byName() }));
    if (dry) console.log(`Dry run (nothing written): ${r.taken_out.length} stage(s) would be taken out.`);
    if (!r.taken_out.length) console.log('No done focus stages to take out.');
    for (const l of L.focusCleanLines(r)) console.log(l);
    if (r.entry) console.log(`Changelog no. ${r.entry.nr}; undo: ravenseat undo`);
  } else if (under === 'off') {
    const oldOne = edit((queue) => L.removeFocus(queue));
    console.log(
      oldOne
        ? 'Focus removed: the queue is ranked as before (score and projectBonus).'
        : 'No focus was set.',
    );
  } else if (under && !under.startsWith('--')) {
    die(
      'focus | focus set <stage> [<stage> ...] [--rest wait|fill] [--to <date>] [--name "..."] [--without-dependencies] [--continue-when-empty on|off] | focus evaluate [--json] | focus clean [--dry] | focus off',
    );
  } else {
    const queue = read();
    if (!queue.focus) {
      console.log(
        'No focus set: the queue is ranked by score and projectBonus.\n' +
          'Set: ravenseat focus set area:<oid> project:<pid> feature:<pid>/<name> ... [--rest wait|fill] [--to <date>]' +
          ' [--continue-when-empty on|off]\n' +
          `When a focus has ended: continue when empty: ${L.focusContinues(queue).setting ? 'on' : 'off'} ` +
          '(config focus.continueWhenEmpty)',
      );
    } else {
      const uncommitted = uncommittedPaths();
      const canStart = L.selectNext(queue, Date.now(), { uncommitted });
      const st = L.focusStatus(queue, { canStart: canStart.map((v) => v.id) });
      console.log(cut(`FOCUS${st.name ? ` "${st.name}"` : ''}: ${st.text}`, WIDTH));
      const f = queue.focus;
      console.log(
        `  set ${f.from ?? '?'}${f.set_by ? ` by ${f.set_by}` : ''}` +
          ` · drag along dependencies: ${f.drag_with_dependencies === false ? 'no' : 'yes'}` +
          `${st.expired ? ' · EXPIRED' : ''}${st.not_started ? ' · not started yet' : ''}` +
          `${st.finished ? ' · FINISHED' : ''}${st.finished_at ? ` (finished ${st.finished_at})` : ''}`,
      );
      // The setting "continue the regular queue when the focus is empty" and where it comes from.
      const cw = st.continue_when_empty;
      console.log(
        `  continue when empty: ${cw.setting ? 'on' : 'off'} (${cw.setting_from})` +
          `${cw.source === 'answer' ? ` · the owner answered continue (${cw.from.replace(/^owner answer /, '')})` : ''}` +
          `${st.halted ? ' · QUEUE PAUSED' : ''}`,
      );
      if (st.active) {
        // Done stages and stages with only rests are marked (the details: ravenseat focus evaluate).
        const ev = L.evaluateFocusStep(queue);
        const mark = (e) =>
          e?.status === 'done'
            ? ' · DONE (ravenseat focus clean)'
            : e?.status === 'done-with-rests'
              ? ` · DONE WITH ${e.rests.length} REST(S) (ravenseat focus evaluate)`
              : '';
        st.per_step.forEach((t, i) =>
          console.log(
            cut(
              `  T${i + 1} ${t.stage.padEnd(30)} ${t.waiting} waiting · ${t.readyOnes} ready · ${t.min_left} min left${mark(ev[i])}`,
              WIDTH,
            ),
          ),
        );
        console.log(
          `  ${st.readyOnes} ready in focus · ${st.inProgress} in progress · ${st.dragged_with} dragged along · ${st.can_start} can start now`,
        );
        const dragged = L.draggedWith(queue);
        if (dragged.size) {
          const list = [...dragged.entries()]
            .slice(0, 12)
            .map(([id, d]) => `${id} (T${d.stage + 1}, by ${d.by})`)
            .join(', ');
          console.log(
            cut(`  Dragged along: ${list}${dragged.size > 12 ? ` +${dragged.size - 12}` : ''}`, WIDTH),
          );
        }
        if (st.ownerQuestion.length)
          console.log(
            cut(
              `  Owner questions in focus: ${st.ownerQuestion
                .slice(0, 5)
                .map((s) => `${s.sp} (${s.tasks})`)
                .join(' · ')}`,
              WIDTH,
            ),
          );
        console.log('NEXT UP:');
        if (!canStart.length) console.log('  nothing can start now (see show and state)');
        for (const v of canStart)
          console.log(
            cut(
              `  ${v.id.padEnd(12)} ${String(v.class ?? '?').padEnd(3)} ${`${v.estimate} min`.padEnd(8)} prio ${v.score}  ${L.stepText(v)}`,
              WIDTH,
            ),
          );
      }
      if (st.notice) console.log(`NOTICE: ${st.notice}`);
    }
  }
}

/** `ravenseat park` (the usage is at the top of queue.mjs). */
export function cmdPark() {
  const ids = positional(1, ['--reason', '--to', '--by', '--expect-changed']);
  const r = editLogged('park', (queue) => {
    const s = L.park(queue, ids, {
      by: val('--by'),
      reason: val('--reason') ?? null,
      to: val('--to') ?? null,
    });
    if (s.error.length) die(`Nothing parked:\n  ${s.error.join('\n  ')}`);
    return s;
  });
  console.log(
    `Parked (stays until ravenseat continue${val('--to') ? ' or the date' : ''}): ${r.parked.join(', ')}`,
  );
  for (const x of r.warnings) console.log(`WARNING: ${x}`);
  if (undoHint()) console.log(undoHint());
}

/** `ravenseat continue` (the usage is at the top of queue.mjs). */
export function cmdContinue() {
  const ids = positional(1, ['--by', '--expect-changed']);
  const r = editLogged('continue', (queue) => {
    const s = L.continue(queue, ids);
    if (s.error.length) die(`Nothing changed:\n  ${s.error.join('\n  ')}`);
    return s;
  });
  if (r.still.length) console.log(`Off hold: ${r.still.join(', ')}`);
  if (r.notParked.length) console.log(`Was not parked: ${r.notParked.join(', ')}`);
  if (undoHint()) console.log(undoHint());
}

/** `ravenseat rank` (the usage is at the top of queue.mjs). */
export function cmdRank() {
  // ---- Block moves ----
  // Moves tasks together within the focus stage and keeps the order they had among themselves (queueLogic.rankBlock), by
  // writing new priority_bonus values in one edit-many (all or nothing).
  const ids = positional(1, ['--over', '--under', '--by', '--expect-changed']);
  const space = {
    top: a.includes('--top'),
    bottom: a.includes('--bottom'),
    over: val('--over') ?? null,
    under: val('--under') ?? null,
  };
  const now = new Date().toISOString();
  // --json gives the answer (and the errors) as JSON for the board, like edit-many --json.
  const json = a.includes('--json');
  const no = (error) => {
    if (!json) die(`Nothing moved:\n  ${error.join('\n  ')}`);
    console.log(JSON.stringify({ ok: false, error }));
    if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
    process.exit(1);
  };
  const compute = (queue) => {
    const rb = L.rankBlock(queue, ids, space, Date.parse(now));
    if (rb.error.length) no(rb.error);
    const tasks = Object.entries(rb.changes).map(([id, t]) => ({ id, priority_bonus: t }));
    return { rb, tasks };
  };
  if (a.includes('--dry')) {
    const queue = read();
    checkExpect(queue);
    const { rb, tasks } = compute(queue);
    const s = L.editMany(queue, tasks, { by: byName(), now, dry: true });
    if (s.error.length) no(s.error);
    if (json)
      console.log(
        JSON.stringify({
          ok: true,
          dry: true,
          changed: queue.changed ?? null,
          changes: s.changes,
          warnings: rb.warnings,
        }),
      );
    else {
      console.log(
        `Dry run (nothing written): ${s.changes.length} priorit(ies) changed. The queue's version: ${queue.changed ?? '(none)'}`,
      );
      for (const l of L.diffLines(s.changes)) console.log(`  ${l}`);
      for (const x of rb.warnings) console.log(`WARNING: ${x}`);
    }
  } else {
    const r = editLogged('rank', (queue) => {
      const { rb, tasks } = compute(queue);
      const s = L.editMany(queue, tasks, { by: byName(), now });
      if (s.error.length) no(s.error);
      return { ...s, warnings: rb.warnings };
    });
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          changed: r.changed,
          changes: r.changes,
          warnings: r.warnings,
          log: lastEntry?.nr ?? null,
        }),
      );
      process.exit(0);
    }
    const where = space.top
      ? 'at the top of the stage'
      : space.bottom
        ? 'at the bottom of the stage'
        : space.over
          ? `right above ${space.over}`
          : `right below ${space.under}`;
    console.log(`Moved ${r.changed.length} task(s) ${where}: ${r.changed.join(', ')}`);
    for (const x of r.warnings) console.log(`WARNING: ${x}`);
    if (undoHint()) console.log(undoHint());
  }
}

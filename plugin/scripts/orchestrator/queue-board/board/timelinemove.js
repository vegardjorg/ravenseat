// =============================================================
// timelinemove.js: the Timeline's drag for order (roadmap TIDSLINJE T-B; plans: gantt investigation 2026-11-18,
// sections 3 and 4). Time is a result, never an input: a move only changes ORDER.
//
//   - A planned bar dragged up or down in its focus step row gets a new place in that step: `ravenseat rank <ids>
//     --over|--under <id>` through POST /api/bulk (the same path as the cards' rank). Marked bars (Ctrl or Cmd click)
//     of one step move as a block.
//   - A step row's title dragged up or down gets a new place in the focus: the saved focus with only the order changed,
//     through POST /api/focus (the same path as the Plan view's Save focus).
//   - Sideways, or a task into another step, is refused with the reason (lib/timelineDrag.js REFUSAL), never mapped.
//   - The keyboard does the same: Space lifts, the arrows move, Enter (or Space) drops, Escape cancels, said in the
//     #tl-live region. The table view has Move up and Move down per planned task.
//   - Every drop runs the dry run first. With board.timelineDragPreview on (default) the preview dialog says what the
//     move does to the plan in words (the server plays the schedule on a copy: plan_effect) with Save order and Cancel;
//     off, the move is saved at once. Every save has Undo in the toast (the changelog number, POST /api/undo { nr }).
//     A save sends the preview's version (expect): when the queue changed in between, the preview comes back fresh.
// The math is pure in lib/timelineDrag.js (window.QueueTimelineDrag). While something is lifted or the dialog is open
// the board holds its redraws (tlHeld, read by board/api.js and board/timeline.js) and catches up afterwards.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md): top-level names are shared with the
// other scripts. Called from board/timeline.js. Tested in lib/__tests__/queueBoardTimelineDragClient.test.ts.
// =============================================================
'use strict';

const TL_MOVE_HINT = 'Up and down move, Enter drops, Escape cancels.';

/** The chart as last drawn: { svg, lay } (null in the table view). */
let tlChart = null;
/** Per planned task in a step row: { rowKey, order, stepText } (from the rows, so the table view has it too). */
let tlPlace = new Map();
/** The step rows that can move, in their order: [{ stage, step, name, label, y, h }]. */
let tlSteps = [];
/** What is lifted (keyboard or pointer), or null. */
let tlLift = null;
/** A pointer press on a bar or a step title, before and during a drag. */
let tlPointer = null;
/** The preview dialog or a save is in progress. */
let tlBusy = false;
/** A drag just ended: the click that follows it is not a click on the bar. */
let tlNoClick = false;

const tlDragLib = () => window.QueueTimelineDrag;
/** Is the drag on (board.timelineDrag, and the Timeline tab)? */
const tlDragOn = () => t.data?.boardTimeline?.on === true && t.data?.boardTimeline?.drag === true;
/** Is the preview before a save on (board.timelineDragPreview)? */
const tlPreviewOn = () => t.data?.boardTimeline?.dragPreview !== false;
/** Should the board hold off redrawing the Timeline (something lifted, dragged, previewed or saving)? */
function tlHeld() {
  return !!tlLift || tlBusy || !!tlPointer?.started;
}
const tlCap = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** Says a move in the live region (and nothing else: the toast is for what was saved). */
function tlSay(text) {
  const box = document.getElementById('tl-live');
  if (!box) return;
  // The same text again (two refusals in a row) is said again: emptied first.
  box.textContent = '';
  box.textContent = text;
}

/** "1 (Alpha)" for step 0 Alpha, "the rest" for the rest, "the plan" for a queue without focus steps. */
function tlStepText(g) {
  if (g.step != null) return `${g.step + 1} (${g.name})`;
  return g.title === 'Planned' ? 'the plan' : 'the rest';
}

/**
 * The rows as the view draws them (board/timeline.js drawTimeline): the order of each step row (its planned tasks by
 * start, the ones after the horizon included) and the step rows that can move. Projects as rows: nothing moves (a
 * project row is not one step).
 */
function tlSetRows(rows, by) {
  tlPlace = new Map();
  tlSteps = [];
  if (!tlDragOn() || by !== 'step') return;
  for (const r of rows) {
    if (r.kind !== 'step') continue;
    const order = [...r.items, ...(r.laterItems ?? [])]
      .filter((it) => it.kind === 'planned')
      .sort((a, b) => a.s - b.s || String(a.id).localeCompare(String(b.id)))
      .map((it) => it.id);
    const stepText = tlStepText(r);
    for (const id of order) tlPlace.set(id, { rowKey: r.key, order, stepText });
    if (r.stage) tlSteps.push({ stage: r.stage, step: r.step, name: r.name, label: `step ${r.step + 1} (${r.name})` });
  }
}

/** The chart after it is drawn (the drop line and the pointer math need its geometry). */
function tlSetChart(svg, lay) {
  tlChart = { svg, lay };
  const at = new Map(lay.groups.map((g) => [g.stage, g]));
  for (const st of tlSteps) {
    const g = at.get(st.stage);
    st.y = g?.y ?? 0;
    st.h = g?.h ?? 0;
  }
}

/** Can this bar move (a planned bar in a step row, with the drag on)? */
const tlMovable = (id) => tlPlace.has(id);

// ---- What is lifted, and what it shows -------------------------------------------------------------------------------

/** The bars of the chart for these ids. */
function tlBars(ids) {
  return ids.map((id) => main.querySelector(`.tl-bar[data-id="${CSS.escape(id)}"]`)).filter(Boolean);
}

/** Takes away the lifted marks, the drop line and the tag. */
function tlClearMarks() {
  for (const e of main.querySelectorAll('.tl-bar.lifted, .tl-title.lifted')) e.classList.remove('lifted');
  for (const e of main.querySelectorAll('.tl-drop-line, .tl-drag-tag')) e.remove();
}

/** Lets go of what is lifted (no save) and catches up on a redraw that was held. */
function tlRelease() {
  tlLift = null;
  tlClearMarks();
  tlCatchUp();
}
function tlCatchUp() {
  if (tlHeld()) return;
  if (t.pending && t.view === 'timeline') getTimeline(true);
}

/** The words of a task's place now (keyboard and pointer). */
function tlTaskText(l) {
  const D = tlDragLib();
  const same = l.slot === l.start;
  const sp = D.spaceFor(l.rest, l.slot, l.slot < l.start) ?? {};
  return D.placeText({ ids: l.ids, place: l.slot + 1, of: l.order.length, step: l.stepText, ...sp, same });
}

/** The words of a step's place now. */
function tlStepPlaceText(l) {
  const others = l.visible.filter((_, i) => i !== l.start).map((k) => tlSteps.find((s) => s.stage === k)?.label ?? k);
  const where =
    l.slot === l.start ? 'where it is now' : l.slot < l.start ? `right above ${others[l.slot]}` : `right below ${others[l.slot - 1]}`;
  return `${tlCap(l.label)}: place ${l.slot + 1} of ${l.visible.length} in the focus, ${where}.`;
}

const tlWho = (l) => (l.kind === 'step' ? l.label : l.ids.length === 1 ? l.ids[0] : `${l.ids.length} tasks`);

/** Lifts a task (and the marked ones of its step with it). false when the block is refused. */
function tlLiftTask(id) {
  const D = tlDragLib();
  const p = tlPlace.get(id);
  if (!p) return false;
  const block = D.blockFor(p.order, id, [...t.marked]);
  if (block.outside.length) {
    tlSay(
      `The marked tasks are in more than one step (${block.outside.join(', ')} too). A block moves within one step: ` +
        'unmark the others first.',
    );
    return false;
  }
  const rest = p.order.filter((x) => !block.ids.includes(x));
  const start = D.slotOf(p.order, block.ids);
  tlLift = { kind: 'task', ids: block.ids, rowKey: p.rowKey, order: p.order, rest, start, slot: start, stepText: p.stepText };
  for (const e of tlBars(block.ids)) e.classList.add('lifted');
  return true;
}

/** Lifts a step row. */
function tlLiftStep(stage) {
  const visible = tlSteps.map((s) => s.stage);
  const start = visible.indexOf(stage);
  if (start < 0) return false;
  tlLift = { kind: 'step', stage, label: tlSteps[start].label, visible, start, slot: start };
  main.querySelector(`.tl-title[data-stage="${CSS.escape(stage)}"]`)?.classList.add('lifted');
  return true;
}

/** The drop line (and, for the pointer, the tag) where the lifted thing would go now. */
function tlShowTarget(tag) {
  for (const e of main.querySelectorAll('.tl-drop-line, .tl-drag-tag')) e.remove();
  const l = tlLift;
  if (!l || !tlChart?.svg?.isConnected) return;
  const { svg, lay } = tlChart;
  const width = Number(svg.getAttribute('width')) || 0;
  let line = null;
  let tagAt = null;
  if (l.kind === 'task' && l.slot !== l.start && l.rest.length) {
    const sp = tlDragLib().spaceFor(l.rest, l.slot, l.slot < l.start);
    const ref = lay.bars.find((b) => b.id === sp.ref);
    const g = lay.groups.find((x) => x.key === l.rowKey);
    if (ref && g) {
      const x = sp.space === 'over' ? Math.max(1, ref.x0 - 3) : Math.min(width - 1, ref.x1 + 3);
      const y0 = TL_AXIS + g.y + 4;
      line = { x1: x, x2: x, y1: y0, y2: TL_AXIS + g.y + g.h - 4 };
      tagAt = { x: x + 6, y: y0 + 2 };
    }
  } else if (l.kind === 'step' && l.slot !== l.start) {
    const others = tlSteps.filter((_, i) => i !== l.start);
    const y = l.slot < others.length ? others[l.slot].y : others[others.length - 1].y + others[others.length - 1].h;
    line = { x1: 0, x2: width, y1: TL_AXIS + y, y2: TL_AXIS + y };
    tagAt = { x: 8, y: TL_AXIS + y + 4 };
  }
  if (line) svg.append(svgEl('line', { class: 'tl-drop-line', ...line }));
  if (tag) {
    const want = tag.at ?? tagAt;
    if (!want) return;
    const w = Math.min(width - 4, tag.text.length * 6.4 + 12);
    // T-C 0b: the tag never covers the step's own label ("done around ..."): it moves beside it or below it.
    const at = tlDragLib().tagSpot({ at: { x: Math.max(2, Math.min(want.x, width - w - 2)), y: want.y }, w, width, avoid: tlNoteBox(svg, lay, want.y) });
    const x = at.x;
    svg.append(
      svgEl(
        'g',
        { class: `tl-drag-tag${tag.refused ? ' refused' : ''}`, 'aria-hidden': 'true' },
        svgEl('rect', { x, y: at.y, width: w, height: 20, rx: 4 }),
        svgEl('text', { x: x + 6, y: at.y + 14, text: tag.text }),
      ),
    );
  }
}

/**
 * The box of the step label ("done around ...") in the row under y (the chart's coordinates), or null. Measured with
 * getBBox where the browser has it, else estimated from the text (about 6.2 pixels per character).
 */
function tlNoteBox(svg, lay, y) {
  const g = lay.groups.find((x) => y >= TL_AXIS + x.y && y < TL_AXIS + x.y + x.h);
  if (!g) return null;
  const note = svg.querySelector(`.tl-row-note[data-row="${CSS.escape(g.key)}"]`);
  if (!note) return null;
  try {
    const b = note.getBBox();
    if (b && b.width > 0) return { x0: b.x, x1: b.x + b.width, y0: b.y, y1: b.y + b.height };
  } catch {
    /* no layout (a test without a renderer): estimated below */
  }
  const x0 = Number(note.getAttribute('x')) || 0;
  const base = Number(note.getAttribute('y')) || 0;
  return { x0, x1: x0 + (note.textContent ?? '').length * 6.2, y0: base - 12, y1: base + 4 };
}

// ---- The keyboard ----------------------------------------------------------------------------------------------------

/**
 * A key on a bar. true when the move took it (the caller does nothing more); false leaves it to the bar (Enter opens
 * the card, as before; Space too when the bar cannot move).
 */
function tlBarKey(e, b) {
  if (!tlDragOn() || !tlMovable(b.id)) return false;
  const lifted = tlLift?.kind === 'task' && tlLift.ids.includes(b.id);
  return tlKey(e, lifted, () => tlLiftTask(b.id));
}

/** A key on a step title. */
function tlStepKey(e, stage) {
  if (!tlDragOn()) return false;
  const lifted = tlLift?.kind === 'step' && tlLift.stage === stage;
  return tlKey(e, lifted, () => tlLiftStep(stage));
}

function tlKey(e, lifted, lift) {
  const D = tlDragLib();
  if (lifted && e.key === 'Tab') {
    tlCancel();
    return false;
  }
  const act = D.keyAction(e.key, lifted);
  if (!act) return false;
  e.preventDefault();
  e.stopPropagation();
  if (act === 'lift') {
    if (tlLift) tlRelease();
    if (!lift()) return true;
    const l = tlLift;
    const now = l.kind === 'step' ? tlStepPlaceText(l) : tlTaskText(l);
    tlSay(`${now.replace(/^([^:]+):/, '$1 lifted:')} ${TL_MOVE_HINT}`);
    return true;
  }
  const l = tlLift;
  if (act === 'cancel') {
    tlCancel();
    return true;
  }
  if (act === 'sideways') {
    tlSay(D.REFUSAL.sideways);
    return true;
  }
  if (act === 'up' || act === 'down') {
    const max = l.kind === 'step' ? l.visible.length - 1 : l.rest.length;
    const m = D.moveSlot(l.slot, act === 'up' ? -1 : 1, max);
    if (m.edge) {
      const where = l.kind === 'step' ? 'in the focus' : D.inStep(l.stepText);
      tlSay(`${tlCap(tlWho(l))} is already in the ${act === 'up' ? 'first' : 'last'} place ${where}.`);
      return true;
    }
    l.slot = m.slot;
    tlShowTarget(null);
    tlSay(l.kind === 'step' ? tlStepPlaceText(l) : tlTaskText(l));
    return true;
  }
  if (act === 'drop') tlDrop();
  return true;
}

/** Escape (or Tab away): nothing moves. */
function tlCancel() {
  const l = tlLift;
  if (!l) return;
  tlSay(`Move cancelled: ${tlWho(l)} stays where it was.`);
  tlRelease();
}

// ---- The pointer -----------------------------------------------------------------------------------------------------

/** A press on a movable bar (b) or step title (stage). A Ctrl or Cmd click marks instead (board/select.js). */
function tlPointerDown(e, what) {
  if (!tlDragOn() || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || tlBusy) return;
  if (what.id != null && !tlMovable(what.id)) return;
  tlPointer = { ...what, x: e.clientX, y: e.clientY, started: false, target: null };
}

/** The pointer's y in the rows' coordinates (under the axis). */
function tlRowsY(clientY) {
  const top = tlChart?.svg?.getBoundingClientRect?.().top ?? 0;
  return clientY - top - TL_AXIS;
}

window.addEventListener('pointermove', (e) => {
  const p = tlPointer;
  if (!p) return;
  const D = tlDragLib();
  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  if (!p.started) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < D.DRAG.dead) return;
    if (tlLift) tlRelease();
    const ok = p.stage ? tlLiftStep(p.stage) : tlLiftTask(p.id);
    if (!ok) {
      tlPointer = null;
      return;
    }
    p.started = true;
  }
  const l = tlLift;
  const y = tlRowsY(e.clientY);
  if (l.kind === 'step') {
    const r = D.stepTarget({ steps: tlSteps, from: l.start, y });
    l.slot = r.to;
    p.target = r;
    tlShowTarget(r.kind === 'same' ? null : { text: `Place ${r.to + 1} of ${r.of} in the focus` });
    return;
  }
  const r = D.taskTarget({ order: l.order, block: l.ids, rowKey: l.rowKey, groups: tlChart.lay.groups, dx, dy, y });
  p.target = r;
  if (r.kind === 'sideways' || r.kind === 'step') {
    l.slot = l.start;
    const svgBox = tlChart.svg.getBoundingClientRect();
    tlShowTarget({ text: r.kind === 'sideways' ? 'Time is calculated: drag up or down' : 'A task stays in its step', refused: true, at: { x: e.clientX - svgBox.left + 12, y: e.clientY - svgBox.top - 26 } });
    return;
  }
  if (r.kind === 'none') return;
  l.slot = r.slot;
  tlShowTarget(r.kind === 'same' ? null : { text: `Place ${r.place} of ${r.of}, ${r.space === 'over' ? `above ${r.ref}` : `below ${r.ref}`}` });
});

function tlPointerEnd(cancelled) {
  const p = tlPointer;
  tlPointer = null;
  if (!p?.started) return;
  tlNoClick = true;
  setTimeout(() => {
    tlNoClick = false;
  }, 0);
  const r = p.target;
  if (cancelled || !tlLift) return tlRelease();
  if (r && (r.kind === 'sideways' || r.kind === 'step')) {
    tlSay(r.text);
    message(r.text);
    return tlRelease();
  }
  if (tlLift.slot === tlLift.start) return tlRelease();
  tlSay(tlLift.kind === 'step' ? tlStepPlaceText(tlLift) : tlTaskText(tlLift));
  tlDrop();
}
window.addEventListener('pointerup', () => tlPointerEnd(false));
window.addEventListener('pointercancel', () => tlPointerEnd(true));

/** A click on a bar: Ctrl or Cmd marks it for a block move; right after a drag it is no click. true: taken. */
function tlBarClick(e, b) {
  if (tlNoClick) return true;
  if (!tlDragOn() || !tlMovable(b.id) || !(e.ctrlKey || e.metaKey)) return false;
  const on = !t.marked.has(b.id);
  markMany([b.id], on);
  for (const bar of tlBars([b.id])) bar.classList.toggle('marked', t.marked.has(b.id));
  const step = tlPlace.get(b.id);
  const here = step ? step.order.filter((id) => t.marked.has(id)).length : 0;
  tlSay(`${b.id} ${t.marked.has(b.id) ? 'marked' : 'unmarked'}: ${here} marked ${tlDragLib().inStep(step?.stepText ?? '')}.`);
  return true;
}

// ---- Drop, preview and save ------------------------------------------------------------------------------------------

/** The job a drop sends: { path, body, title, what, done, focusKey, fresh() }. */
function tlJob(l) {
  const D = tlDragLib();
  if (l.kind === 'task') {
    const sp = D.spaceFor(l.rest, l.slot, l.slot < l.start);
    const what = tlTaskText(l);
    return {
      path: '/api/bulk',
      body: { action: 'rank', ids: [...l.ids], val: { space: sp.space, ref: sp.ref } },
      title: `Move ${tlWho(l)}`,
      what,
      done: `Order saved. ${what}`,
      focusKey: `tl:bar:${l.ids[0]}`,
    };
  }
  const nextVisible = D.reorder(l.visible, l.start, l.slot);
  const make = () => {
    const ctx = planContext();
    const full = window.QueuePlan?.focusOrder?.(ctx) ?? [];
    const order = D.fullOrder(full.length ? full : l.visible, l.visible, nextVisible);
    return { plan: window.QueuePlan.planWithOrder(ctx, order) };
  };
  const what = tlStepPlaceText(l);
  return {
    path: '/api/focus',
    body: make(),
    title: `Move ${l.label}`,
    what,
    done: `Focus order saved. ${what}`,
    focusKey: `tl:step:${l.stage}`,
    fresh: make,
  };
}

/** Enter, Space or a pointer let go: the dry run, then the preview (or the save at once with the preview off). */
function tlDrop() {
  const l = tlLift;
  if (!l) return;
  if (l.slot === l.start) {
    tlSay(`${tlCap(tlWho(l))} stays where it was: nothing to save.`);
    return tlRelease();
  }
  const job = tlJob(l);
  tlBusy = true;
  tlLift = null;
  tlPreview(job);
}

/** A move from the table's Move up and Move down (the same preview as a drop). */
function tlTableMove(id, delta) {
  if (tlBusy) return;
  const D = tlDragLib();
  const p = tlPlace.get(id);
  if (!p) return;
  const start = p.order.indexOf(id);
  const rest = p.order.filter((x) => x !== id);
  const slot = start + delta;
  if (slot < 0 || slot > rest.length) return;
  const job = tlJob({ kind: 'task', ids: [id], rowKey: p.rowKey, order: p.order, rest, start, slot, stepText: p.stepText });
  job.focusKey = `tl:mv:${id}:${delta < 0 ? 'up' : 'down'}`;
  tlBusy = true;
  tlPreview(job);
}

async function tlPreview(job) {
  const preview = tlPreviewOn();
  let dry;
  try {
    dry = await api(job.path, { ...job.body, dry: true, ...(preview ? { plan_effect: true } : {}) });
  } catch (e) {
    message(`Could not check the move: ${e.message}`, true);
    tlDone();
    return;
  }
  if (preview) return tlOpenDialog(job, dry);
  if (!dry.can) {
    message(`Not moved: ${[...(dry.error ?? []), ...(dry.guard ?? []).filter((v) => v.level === 'stop').map((v) => v.text)].join(' ') || 'the move is refused.'}`, true);
    tlDone();
    return;
  }
  await tlSave(job, dry);
}

/** The preview is over (saved, cancelled or failed): the marks go and a held redraw catches up. */
function tlDone() {
  tlBusy = false;
  tlRelease();
}

const tlDropBackground = () => document.getElementById('tl-drop-background');
const tlDropBox = () => document.getElementById('tl-drop');

function tlCloseDialog() {
  const bg = tlDropBackground();
  if (bg) bg.hidden = true;
  tlDropBox()?.replaceChildren();
}

/** The preview dialog: the move, the plan in words, what the dry run changes, Save order and Cancel. */
function tlOpenDialog(job, dry) {
  const bg = tlDropBackground();
  const box = tlDropBox();
  if (!bg || !box) return tlDone();
  const blocked = [...(dry.error ?? []), ...(dry.guard ?? []).filter((v) => v.level === 'stop').map((v) => v.text)];
  const warned = [...(dry.warnings ?? []), ...(dry.guard ?? []).filter((v) => v.level !== 'stop').map((v) => v.text)];
  const lines = Array.isArray(dry.lines) ? dry.lines : [];
  const close = (focusBack = true) => {
    box.removeEventListener('keydown', keys);
    tlCloseDialog();
    if (focusBack) main.querySelector(`[data-focus="${CSS.escape(job.focusKey)}"]`)?.focus?.({ preventScroll: true });
  };
  const cancel = () => {
    close();
    tlSay('Not saved: the order stays as it was.');
    tlDone();
  };
  const keys = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else window.QueueA11y.trapKey(e, box);
  };
  const save = el('button', {
    type: 'button',
    class: 'button',
    text: 'Save order',
    disabled: !dry.can || blocked.length > 0,
    onclick: async () => {
      close(false);
      await tlSave(job, dry);
    },
  });
  const cancelButton = el('button', { type: 'button', class: 'button button-muted', text: 'Cancel', onclick: cancel });
  // replaceChildren would write a null as the text "null": the parts that are not there are left out first.
  // T-C 0a: the plan sentence first, then the move in words; the raw field changes ("A-2 priority_bonus: (none) -> 20")
  // are metadata, so they sit behind a closed Details.
  const parts = [
    el('h2', { id: 'tl-drop-title', class: 'guard-title', text: job.title }),
    el('p', {
      class: 'tl-plan-sentence',
      text: dry.plan?.sentence ?? 'What this does to the plan could not be worked out now; the move itself is below.',
    }),
    el('p', { text: job.what }),
    el('p', {
      class: 'tl-note',
      text: 'Times are calculated: the bars move when the plan is played again. Rough, never a promise. Nothing is saved yet.',
    }),
    lines.length || (dry.before_text != null && dry.after_text != null)
      ? el(
          'details',
          { class: 'tl-drop-details' },
          el('summary', { text: 'Details' }),
          lines.length ? el('ul', { class: 'tl-drop-lines', 'aria-label': 'What changes' }, ...lines.slice(0, 20).map((x) => el('li', { text: x }))) : null,
          dry.before_text != null && dry.after_text != null
            ? el('p', { class: 'tl-drop-lines', text: `Focus: ${dry.before_text} to ${dry.after_text}` })
            : null,
        )
      : null,
    warned.length ? el('ul', {}, ...warned.map((x) => el('li', { class: 'guard-info', text: x }))) : null,
    blocked.length ? el('ul', {}, ...blocked.map((x) => el('li', { class: 'error', text: x }))) : null,
    el('div', { class: 'guard-buttons' }, save, cancelButton),
  ];
  box.replaceChildren(...parts.filter(Boolean));
  box.addEventListener('keydown', keys);
  bg.hidden = false;
  (save.disabled ? cancelButton : save).focus();
}

/** The save with the preview's version; Undo in the toast; a changed queue gives the preview again. */
async function tlSave(job, dry) {
  let answer;
  try {
    answer = await writeWithGuard(job.path, { ...job.body, expect: dry.changed });
  } catch (e) {
    if (e.status === 409 && e.answer?.outdated) {
      message('The queue changed since the preview. Here is the preview again.');
      tlBusy = false;
      await update(true);
      tlBusy = true;
      if (job.fresh) job.body = job.fresh();
      return tlPreview(job);
    }
    message(`Could not save the order: ${e.message}`, true);
    tlDone();
    return;
  }
  if (answer == null) {
    // Cancelled at a warning from the guard rules: nothing saved.
    tlDone();
    return;
  }
  tlSay(job.done);
  if (answer.log != null) undoToast(answer.log, job.done, answer.info);
  else messageWithInfo(job.done, answer);
  tlBusy = false;
  tlRelease();
  await update(true);
}

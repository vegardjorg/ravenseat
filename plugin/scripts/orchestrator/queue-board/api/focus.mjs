// =============================================================
// queue-board/api/focus.mjs: the plan view routes (focus and areas).
//
// The plan view routes: POST /api/focus ("Save focus", and one focus change from a card, the Selection or the
// panel, B21) and POST /api/area (save, delete and move an area). STEP is the step pattern of a focus plan.
//
// Moved out of queue-board.mjs unchanged (SPLIT-1). A handler that needs the server takes its context `ctx` first:
// the live paths and caches as getters (demo mode switches them), the data builders and the write plumbing
// (writeTools.mjs). A POST handler also gets `c`, the per-call tools write() builds (no, run, queueNow, info).
// focusRoutes(ctx) binds them, so queue-board.mjs calls them with the old arguments.
//
// Used by: queue-board.mjs (write()).
// Tested in: lib/__tests__/queueFocusB17.test.ts, queueFocusB20.test.ts (reads STEP from this file), queueFocusB21.test.ts and queueFocusLimit.test.ts.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { PID, pidOrNull, cleanText, errorText } from './writeTools.mjs';

const require = createRequire(import.meta.url);
const L = require('../../lib/queueLogic.js');
const T = require('../../lib/queueBoard.js');

/**
 * A stage from the plan view: area:<oid>, project:<pid>, feature:<pid>/<name> or task:<id> (B20; the id in the form of ID
 * below). queue.mjs validates the rest (an unknown task id is refused there).
 */
const STEP =
  /^(area|project):[a-z0-9]+(?:-[a-z0-9]+)*$|^feature:[a-z0-9]+(?:-[a-z0-9]+)*\/[^\u0000-\u001f\u007f]{1,80}$|^task:[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

/**
 * "Save focus" from the plan view. The body: { plan: { order[], now_count?, rest?, to?, name?,
 * drag_with_dependencies?, pause?[], continue?[] }, dry, expect }.
 *   dry: true → preview (queueBoard.focusPreview on a copy: focus before and after, the stages, rest,
 *                dragged along, the pause changes and "Next up" after saving) and the queue's version `changed`. Writes nothing.
 *   otherwise  → queue.mjs focus save --expect-changed <expect> (all or nothing); 409 with outdated: true when the queue
 *                has changed since the preview.
 */
async function focus(ctx, b, queueNow) {
  const { planEffectOf, queueJson, tmpDir, uncommitted } = ctx;
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  // B21: one change from a card, the Selection or the panel (focusChange below) instead of a whole plan.
  if (b.change != null) return focusChange(ctx, b, queueNow);
  const p = b.plan && typeof b.plan === 'object' && !Array.isArray(b.plan) ? b.plan : null;
  if (!p) return no('missing plan');
  const list = (x) => (Array.isArray(x) ? x.map(String) : x == null ? [] : null);
  const order = list(p.order);
  const pause = list(p.pause);
  const proceed = list(p.continue);
  if (!order) return no('invalid step');
  // The one focus step limit (QA-1c Q12), with the same message as `focus set`, `focus add` and the save itself.
  if (order.length > L.FOCUS_STEPS_MAX) return no(L.FOCUS_STEPS_ERROR);
  if (order.some((x) => !STEP.test(x))) return no('invalid step');
  if (!pause || !proceed || [...pause, ...proceed].some((x) => !PID.test(x)))
    return no('invalid project id in pause/continue');
  if (p.rest != null && !L.FOCUS_REST.includes(p.rest))
    return no('rest must be wait or fill');
  const to = p.to == null || p.to === '' ? null : String(p.to).trim();
  if (to != null && !/^\d{4}-\d\d-\d\d$/.test(to))
    return no('the date must be in the form YYYY-MM-DD');
  const nowCount = p.now_count == null ? null : Number(p.now_count);
  if (nowCount != null && !Number.isInteger(nowCount)) return no('invalid now_count');
  const expectValue = b.expect == null ? null : String(b.expect);
  if (expectValue != null && !Number.isFinite(Date.parse(expectValue))) return no('invalid expect');
  const name = cleanText(p.name, 200);
  const input = {
    order,
    ...(nowCount != null ? { now_count: nowCount } : {}),
    // B22: a plan without a rest is left to saveFocusPlan (the stored focus's rest, else focus.restDefault).
    ...(p.rest != null ? { rest: p.rest } : {}),
    to,
    name: name || null,
    drag_with_dependencies: p.drag_with_dependencies !== false,
    // When the focus is done (lib/logic/focus.js setFocus): left out = the config focus.continueWhenEmpty decides.
    ...(typeof p.continue_when_empty === 'boolean' ? { continue_when_empty: p.continue_when_empty } : {}),
    pause,
    continue: proceed,
  };
  const queue = queueNow();
  if (b.dry === true) {
    const f = T.focusPreview(queue, input, {
      now: Date.now(),
      uncommitted: uncommitted().uncommitted,
    });
    // T-B: a Timeline step drop asks for the plan in words: the same save on a copy, then both played forward.
    let effect = {};
    if (b.plan_effect === true && !f.error.length) {
      let planText = null;
      try {
        const copy = L.cloneJson(queue);
        L.saveFocusPlan(copy, input, new Date().toISOString());
        planText = planEffectOf(queue, copy);
      } catch {
        planText = null;
      }
      effect = { plan: planText };
    }
    return {
      status: 200,
      answer: { ok: true, dry: true, changed: queue.changed ?? null, ...f, ...effect, can: !f.error.length },
    };
  }
  const tmp = path.join(tmpDir(), `queue-board-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(input));
  let r;
  try {
    r = await queueJson([
      'focus',
      'save',
      '--file',
      tmp,
      '--json',
      '--by',
      'theBoard',
      ...(expectValue ? ['--expect-changed', expectValue] : []),
    ]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  ctx.clearQuick();
  console.log(
    `${new Date().toLocaleTimeString('en-GB')} focus save: ${r.ok ? 'ok' : `failed (${errorText(r, '?')})`}`,
  );
  if (!r.ok || r.data?.ok !== true) {
    const outdated = r.code === 6 || r.data?.outdated === true;
    return {
      status: 409,
      answer: {
        ok: false,
        outdated,
        message: outdated
          ? 'The queue has changed since the preview. Review the focus again.'
          : errorText(r, 'ravenseat focus save failed'),
      },
    };
  }
  return {
    status: 200,
    answer: {
      ok: true,
      message: order.length ? 'Focus saved' : 'Focus removed',
      info: r.data.warnings ?? [],
      // T-B: the changelog entry of the save (Undo sends it back as --nr); null when nothing was logged.
      log: r.data.log ?? null,
    },
  };
}

/**
 * B21: one focus change from a card, the Selection or the detail panel. The body: { change: { action: add|remove,
 * steps[], at? }, dry, expect }. A remove takes exactly one step; `at` (1-based place, add only) defaults to last.
 *   dry: true → preview (queueBoard.focusChangePreview: the B20 logic, queueLogic.addFocusStep / removeFocusStep, on a
 *               copy) and the queue's version `changed`. Writes nothing. A no-op (every step already there) cannot be saved.
 *   otherwise  → queue.mjs focus add|remove --json --expect-changed <expect>: the same code writes as in the CLI, one
 *               changelog entry (undo takes it back); 409 with outdated: true when the queue has changed since the preview.
 */
async function focusChange(ctx, b, queueNow) {
  const { queueJson, uncommitted } = ctx;
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  const c = b.change && typeof b.change === 'object' && !Array.isArray(b.change) ? b.change : null;
  if (!c) return no('missing change');
  if (!T.FOCUS_CHANGES.includes(c.action)) return no('action must be add or remove');
  const steps = Array.isArray(c.steps) ? c.steps.map(String) : null;
  if (!steps?.length) return no('invalid step');
  // More steps in one add than the whole focus may hold: the shared limit's message (addFocusStep checks the sum).
  if (steps.length > L.FOCUS_STEPS_MAX) return no(L.FOCUS_STEPS_ERROR);
  if (steps.some((x) => !STEP.test(x))) return no('invalid step');
  if (c.action === 'remove' && steps.length !== 1) return no('remove takes exactly one step');
  const at = c.at == null ? null : Number(c.at);
  if (at != null && (c.action !== 'add' || !Number.isInteger(at) || at < 1)) return no('invalid position');
  const expectValue = b.expect == null ? null : String(b.expect);
  if (expectValue != null && !Number.isFinite(Date.parse(expectValue))) return no('invalid expect');
  const queue = queueNow();
  if (b.dry === true) {
    const f = T.focusChangePreview(
      queue,
      { action: c.action, steps, at },
      { now: Date.now(), uncommitted: uncommitted().uncommitted },
    );
    return {
      status: 200,
      answer: { ok: true, dry: true, changed: queue.changed ?? null, ...f, can: !f.error.length && !f.noop },
    };
  }
  const r = await queueJson([
    'focus',
    c.action,
    ...steps,
    ...(at != null ? ['--at', String(at)] : []),
    '--json',
    '--by',
    'theBoard',
    ...(expectValue ? ['--expect-changed', expectValue] : []),
  ]);
  ctx.clearQuick();
  console.log(
    `${new Date().toLocaleTimeString('en-GB')} focus ${c.action}: ${r.ok ? 'ok' : `failed (${errorText(r, '?')})`}`,
  );
  if (!r.ok || r.data?.ok !== true) {
    const outdated = r.code === 6 || r.data?.outdated === true;
    return {
      status: 409,
      answer: {
        ok: false,
        outdated,
        message: outdated
          ? 'The queue has changed since the preview. Review the change again.'
          : errorText(r, `ravenseat focus ${c.action} failed`),
      },
    };
  }
  return {
    status: 200,
    answer: {
      ok: true,
      message: r.data.noop ? r.data.message : c.action === 'add' ? 'Added to focus' : 'Removed from focus',
      info: r.data.warnings ?? [],
    },
  };
}

/**
 * The areas from the board. The body: { action: save|delete|move, oid, title?, description?, pid?, dry,
 * expect }. dry → the explanation (queueBoard.areaPlan tries on a copy); otherwise queue.mjs area … --expect-changed.
 */
async function area(ctx, b, queueNow) {
  const { queueMjs } = ctx;
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  const action = String(b.action ?? '');
  if (!T.AREA_ACTIONS.includes(action)) return no(`unknown action ${action}`);
  const oid = pidOrNull(b.oid === '' ? null : b.oid);
  if (oid === undefined || (action !== 'move' && !oid)) return no('invalid area id');
  const pid = action === 'move' ? pidOrNull(b.pid) : null;
  if (action === 'move' && !pid) return no('invalid project id');
  const expectValue = b.expect == null ? null : String(b.expect);
  if (expectValue != null && !Number.isFinite(Date.parse(expectValue))) return no('invalid expect');
  const queue = queueNow();
  const plan = T.areaPlan(queue, {
    action,
    oid,
    pid,
    title: b.title == null ? null : cleanText(b.title, 200),
    description: b.description == null ? null : cleanText(b.description, 500),
  });
  if (b.dry === true)
    return {
      status: 200,
      answer: {
        ok: true,
        dry: true,
        changed: queue.changed ?? null,
        error: plan.error,
        lines: plan.lines ?? [],
        can: !plan.error.length,
      },
    };
  if (plan.error.length) return { status: 409, answer: { ok: false, message: plan.error.join('\n') } };
  const r = await queueMjs([...plan.args, ...(expectValue ? ['--expect-changed', expectValue] : [])]);
  ctx.clearQuick();
  console.log(
    `${new Date().toLocaleTimeString('en-GB')} ${plan.args.join(' ')}: ${r.ok ? 'ok' : `failed (${r.error || r.out})`}`,
  );
  if (!r.ok)
    return {
      status: 409,
      answer: {
        ok: false,
        outdated: r.code === 6,
        message:
          r.code === 6
            ? 'The queue has changed since the preview. Review the change again.'
            : r.error || r.out || 'ravenseat area failed',
      },
    };
  return { status: 200, answer: { ok: true, message: r.out } };
}

/** The handlers bound to the server's context (queue-board.mjs builds ctx once and calls them with the old arguments). */
export function focusRoutes(ctx) {
  return {
    focus: (...args) => focus(ctx, ...args),
    area: (...args) => area(ctx, ...args),
  };
}

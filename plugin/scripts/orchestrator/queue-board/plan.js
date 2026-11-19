// =============================================================
// plan.js: the plan view on queue-board. Vanilla JS, no build step.
//
// The Focus tab (B19): one ordered list "In focus" holds the steps in order (step 1 first; the queue takes everything
// ready in a step before anything in the next). Each step row folds open to show its tasks, with a status per task
// (planBasis step_tasks from the server). Below the list, "Not in focus" is the rest (not started while the rest waits)
// and "On pause" is projects on pause, each a section of its own. The focus settings (name, rest, until, drag along,
// when done, Clear focus, Areas) sit in a fold below the lists, closed by default. The saved focus still has a
// `now_count` (the old split between Now and Next); it stays in the data and is sent back unchanged, but is not drawn
// (owner question 1, 2026-11-18).
// Areas, projects and features are dragged between the sections with mouse or keyboard (Space lifts, the arrow keys
// move: up and down within In focus, left and right between the sections; Space drops, Esc cancels). The changes
// are collected in a draft; "Save focus" first shows what changes and what the queue starts next (POST /api/focus with dry),
// and saves only when the owner confirms (queue.mjs focus save, all or nothing, with the queue version from the
// preview). "Areas" creates and edits areas and moves projects between them (POST /api/area), also
// with an explanation before saving.
// The numbers (pending, ready, minutes, owner questions, dragged along) are computed on the server (queueBoard.planBasis);
// here there is only view and interaction. All text is set with textContent (via el), never innerHTML.
// =============================================================
'use strict';

(function () {
  // The three sections in their order on the page (also the order the left and right arrow keys move through).
  const SECTIONS = [
    {
      key: 'focus',
      name: 'In focus',
      help:
        'The steps the queue takes, in order from the top. Everything ready in a step starts before anything in the ' +
        'next step, regardless of score.',
    },
    {
      key: 'later',
      name: 'Not in focus',
      help:
        'Everything outside the steps. With "rest waits" nothing starts from here until the focus changes; with ' +
        '"fill free slots" only when the focus has nothing ready.',
    },
    {
      key: 'waiting',
      name: 'On pause',
      help:
        'Projects on pause. They do not start, not even if something in focus waits on them. Drag a project here to ' +
        'pause it, or out of here to resume.',
    },
  ];
  const sectionName = (key) => SECTIONS.find((k) => k.key === key)?.name ?? key;
  const TYPE_NAME = { area: 'Area', project: 'Project', feature: 'Feature', task: 'Task' };
  // B17 (H4): a step whose tasks are all done says "done", never "does not exist". The status comes from the server
  // (planBasis step_status, from queueLogic.evaluateFocusStep).
  const DONE_TITLE = {
    done: 'Every task in this step is done. The queue takes the step out of the focus by itself.',
    'done-with-rests':
      'Nothing here is left to start. Rests keep the step in the focus until they are settled: QA waiting on you, ' +
      'proposals, the batch queue or owner questions.',
  };
  // B19: the status word per task in an opened step (planBasis step_tasks `state`) and its badge tone. Tones keep one
  // meaning each: ok = can start, warn = waits on you. Everything else is the neutral badge.
  const TASK_STATE = {
    ready: ['ready', 'tone-ok', 'No blockers: starts when a slot is free.'],
    active: ['in progress', '', 'Running, picked or in review.'],
    blocked: ['blocked', '', 'Waits on another task first.'],
    question: ['waits on an answer', 'tone-warn', 'Waits on an owner question: answer it in Decisions.'],
    qa: ['QA waiting on you', 'tone-warn', 'Done, and waits on your QA in Decisions.'],
    proposed: ['proposed', '', 'A proposal that waits on your review.'],
    batched: ['batch queue', '', 'In the batch queue: starts when the batch is packed.'],
    parked: ['on hold', '', 'Put on hold for now.'],
  };

  const s = {
    ctx: null,
    draft: null, // { steps, now_count, pause: Set, rest, to, name, drag_with } (null = no unsaved changes)
    basis: null, // the server's plan (JSON) when the draft was started: changed meanwhile → remark
    openOnes: new Set(), // projects that show their features
    openSteps: new Set(), // steps in In focus whose tasks are folded open
    settingsOpen: false, // the "Focus settings" fold (closed by default, not remembered)
    refocus: null, // id of a fold button that should keep focus after the redraw
    drag: null, // { key } while something is dragged with the mouse
    boosted: null, // { key, for } while something is lifted with the keyboard (for = draft before the lift, for Esc)
    dialog: null, // open dialog (preview or areas)
    taskKeys: new Set(), // B21: task steps the picker put into a draft on this page (Not in focus keeps them)
    menu: null, // QA-1b: the step key whose step menu (Move to top / bottom) is open, or null
    refocusScroll: false, // QA-1b: let the refocus scroll the page (a step moved to the top or bottom moved far)
  };

  // QA-1b: an open task list above this many tasks gets its own scroll area, and In focus with more steps than this
  // draws compact rows. 12 rows fit on a laptop screen beside the rest of the step.
  const TASK_CAP = 12;

  // A press outside an open step menu closes it (as the board's other menus do).
  document.addEventListener('pointerdown', (e) => {
    if (s.menu && !e.target?.closest?.('.plan-step-menu-space')) {
      s.menu = null;
      s.ctx?.drawOnNew();
    }
  });

  // ---- Helpers ----
  const el = (...a) => s.ctx.el(...a);
  const data = () => s.ctx.data;
  const typeFor = (key) => key.slice(0, key.indexOf(':'));
  const restFor = (key) => key.slice(key.indexOf(':') + 1);

  /** "49 h", "3 h 20 min", "45 min". */
  function time(min) {
    const m = Math.round(Number(min) || 0);
    if (m < 60) return `${m} min`;
    const t = Math.floor(m / 60);
    return t >= 10 || !(m % 60) ? `${t} h` : `${t} h ${m % 60} min`;
  }

  /** The saved steps in order (the server still splits them in now and next; here they are one list). */
  const savedSteps = () => [...(data()?.focus?.now ?? []), ...(data()?.focus?.next ?? [])];

  /** The plan as saved in the queue (focus and paused projects). */
  function serverPlan() {
    const f = data()?.focus;
    return {
      steps: savedSteps(),
      // Kept and sent back as it is (owner question 1): the board no longer draws the split.
      now_count: Number(f?.now_count) || 1,
      pause: new Set((data()?.plan?.projects ?? []).filter((p) => p.pause).map((p) => p.pid)),
      // A saved focus keeps its own rest. Without one, a new focus starts with the setting focus.restDefault (B22), which
      // the server sends as focusNow.how.rest; the standard default is fill.
      rest: f
        ? f.rest === 'fill'
          ? 'fill'
          : 'wait'
        : data()?.focusNow?.how?.rest === 'wait'
          ? 'wait'
          : 'fill',
      to: f?.to ? String(f.to).slice(0, 10) : '',
      name: f?.name ?? '',
      drag_with: f ? f.drag_with !== false : true,
      // When the focus is done: true = continue the regular queue, false = pause, null = the config decides
      // (focus.continueWhenEmpty). Only this focus's own value is a choice here (focusStatus continue_when_empty).
      continue_empty:
        f?.continue_when_empty?.setting_from === 'this focus' ? f.continue_when_empty.setting === true : null,
    };
  }
  /** "Config default (pause)": the config's value is known only while the saved focus has none of its own. */
  function configDefaultText() {
    const c = data()?.focus?.continue_when_empty;
    if (!c || c.setting_from !== 'config focus.continueWhenEmpty') return 'Config default';
    return `Config default (${c.setting ? 'continue' : 'pause'})`;
  }
  const normal = (p) => JSON.stringify({ ...p, pause: [...p.pause].sort(), steps: p.steps });
  const current = () => s.draft ?? serverPlan();
  const hasChanges = () => !!s.draft && normal(s.draft) !== normal(serverPlan());

  /** Starts a draft (first change) and remembers the server's plan, so the board can warn if the queue changes meanwhile. */
  function draft() {
    if (!s.draft) {
      s.draft = serverPlan();
      s.basis = normal(s.draft);
    }
    return s.draft;
  }
  function copy(p) {
    return { ...p, steps: [...p.steps], pause: new Set(p.pause) };
  }

  /** The open cards (not Built) a task step can name, in board order. */
  const openCards = () =>
    ['queue', 'proposed', 'batch', 'inProgress', 'review'].flatMap((col) => data()?.columns?.[col] ?? []);
  const taskCard = (id) => openCards().find((k) => k.id === id) ?? null;
  const projectRow = (pid) => data()?.plan?.projects.find((p) => p.pid === pid) ?? null;
  const areaRow = (oid) => data()?.plan?.areas.find((o) => o.oid === oid) ?? null;

  /** Title and numbers for an element (area, project or feature). */
  function info(key) {
    const type = typeFor(key);
    const rest = restFor(key);
    // The saved step's status (active, done-with-rests, done); null for an element that is no saved step.
    const status = data()?.plan?.step_status?.[key] ?? null;
    if (type === 'area') {
      const o = areaRow(rest);
      return { type, title: o?.title ?? rest, counts: o, exists: !!o?.in_register, status };
    }
    if (type === 'project') {
      const p = projectRow(rest);
      return { type, title: p?.title ?? rest, counts: p, exists: !!p, status };
    }
    if (type === 'task') {
      // B20: one task as a step (planBasis task_steps: its title, counts and whether it is still in the queue). B21: a
      // task the picker just put into the draft is no saved step yet, so its title comes from its card.
      const t = data()?.plan?.task_steps?.[key] ?? null;
      const card = t ? null : taskCard(rest);
      return { type, title: t?.title ?? card?.title ?? rest, counts: t, exists: !!t?.exists || !!card, status };
    }
    const pid = rest.slice(0, rest.indexOf('/'));
    const name = rest.slice(rest.indexOf('/') + 1);
    const f = projectRow(pid)?.features.find((x) => x.name === name) ?? null;
    return { type, title: name, pid, counts: f, exists: !!f, status };
  }

  /** Where an element sits in the plan now: focus (a step), waiting (paused project) or later. */
  function columnFor(p, key) {
    if (p.steps.includes(key)) return 'focus';
    if (typeFor(key) === 'project' && p.pause.has(restFor(key))) return 'waiting';
    return 'later';
  }

  // ---- Moving (shared by mouse and keyboard) ----
  /**
   * Moves an element to a section (at position `index` in In focus; otherwise last). Returns an error message when
   * the move makes no sense (an area or a feature cannot be paused).
   */
  function move(key, col, index = null) {
    const type = typeFor(key);
    if (col === 'waiting' && type !== 'project')
      return type === 'area'
        ? 'An area cannot be paused. Drag the projects in the area to On pause, or leave the area in Not in focus.'
        : type === 'task'
          ? 'A task cannot be paused here. Use "Put on hold" on the task, or leave it in Not in focus.'
          : 'A feature cannot be paused. Use "Put on hold" on the tasks, or leave the feature in Not in focus.';
    const p = draft();
    p.steps = p.steps.filter((x) => x !== key);
    if (type === 'project') p.pause.delete(restFor(key));
    if (col === 'focus') {
      const i = index == null ? p.steps.length : Math.max(0, Math.min(index, p.steps.length));
      p.steps.splice(i, 0, key);
    } else if (col === 'waiting') p.pause.add(restFor(key));
    return null;
  }

  // ---- Drawing ----
  function draw(ctx) {
    s.ctx = ctx;
    const d = data();
    const main = ctx.main;
    if (!d?.plan) {
      main.append(el('p', { class: 'empty', text: 'Fetching the queue …' }));
      return;
    }
    const p = current();
    const focus = document.activeElement?.closest?.('.plan-element')?.dataset.key ?? null;
    // The order on the page is also the order on a phone (B19): what happens now, In focus, Not in focus, On pause,
    // then the settings fold. Above 600 px only Not in focus and On pause stand side by side (board.css .plan-rest).
    main.append(
      el(
        'div',
        { class: 'plan-view' },
        // B18: what focus is and what the queue does now because of it come first.
        ctx.howBox?.() ?? null,
        ctx.whatNow?.() ?? null,
        section(SECTIONS[0], p, d.forecast),
        el('div', { class: 'plan-rest' }, section(SECTIONS[1], p), section(SECTIONS[2], p)),
        settingsFold(p),
      ),
    );
    // An open step menu takes the focus to its first item that can be used (QA-1b).
    if (s.menu) {
      const first = main.querySelector('.plan-step-menu [role="menuitem"]:not([disabled])');
      if (first) {
        first.focus();
        return;
      }
    }
    const refocus = s.refocus ? document.getElementById(s.refocus) : null;
    const scroll = s.refocusScroll;
    s.refocus = null;
    s.refocusScroll = false;
    if (refocus && !s.boosted) {
      refocus.focus({ preventScroll: !scroll });
      return;
    }
    const template = s.boosted?.key ?? focus;
    if (template)
      main
        .querySelector(`.plan-element[data-key="${CSS.escape(template)}"]`)
        ?.focus({ preventScroll: !s.boosted });
  }

  /**
   * The forecast box: when the remaining tasks in the focus (or the whole queue without a focus) are done at 50, 85 and
   * 95 %, from the daily throughput (the server computes it, lib/queueForecast.js; the same as `ravenseat forecast`).
   */
  function forecastBox(f) {
    if (!f?.text) return null;
    const how = !f.enough
      ? 'Needs a few done tasks in the window before it can say anything.'
      : f.remaining
        ? `Monte Carlo: ${f.runs} runs drawing a day's throughput from the last ${f.windowDays} days (zero days ` +
          'included). The saved focus counts, not the draft.'
        : 'Nothing left in the focus.';
    return el(
      'section',
      { class: 'plan-forecast', 'aria-labelledby': 'plan-forecast-title' },
      el('h3', { id: 'plan-forecast-title', class: 'plan-forecast-title', text: 'Forecast' }),
      el('p', { class: 'plan-forecast-text', text: f.text }),
      el('p', { class: 'plan-forecast-how', text: how }),
    );
  }

  /** The draft bar beside "In focus": help, whether there is a draft, Discard and Save focus (never in the fold). */
  function toolbar() {
    const changed = hasChanges();
    const serverChanged = s.draft && s.basis !== normal(serverPlan());
    return el(
      'div',
      { class: 'plan-tool', role: 'toolbar', 'aria-label': 'Focus draft' },
      // B30: the "?" opens the help at Focus (the board passes roomHelp in the context).
      s.ctx.help ? s.ctx.help('focus', 'Focus') : null,
      el('span', {
        class: `plan-draft${changed ? ' active' : ''}`,
        role: 'status',
        text: changed
          ? `Draft, not saved${serverChanged ? '. The queue has changed meanwhile; the preview checks against the new one.' : ''}`
          : 'No unsaved changes',
        title: changed
          ? 'The changes do not apply until you press "Save focus" and confirm.'
          : 'Drag areas, projects and features between the sections to edit the focus.',
      }),
      el('button', {
        type: 'button',
        class: 'button button-outline button-small',
        text: 'Add to focus …',
        title:
          'Choose a task, feature, project or area and the step it goes in at. It goes into the draft; Save focus shows ' +
          'what changes before anything is saved.',
        onclick: openPicker,
      }),
      el('button', {
        type: 'button',
        class: 'button button-outline button-small',
        text: 'Discard',
        disabled: !s.draft,
        title: 'Forget the draft and show the focus as saved in the queue. Nothing in the queue changes.',
        onclick: () => {
          s.draft = null;
          s.basis = null;
          s.taskKeys.clear();
          s.ctx.drawOnNew();
        },
      }),
      el('button', {
        type: 'button',
        class: 'button button-filled button-small',
        text: 'Save focus',
        disabled: !changed,
        title:
          'First shows what changes and what the queue starts next. Nothing is saved until you confirm, and everything ' +
          'is saved together or not at all.',
        onclick: () => previewList(),
      }),
    );
  }

  /**
   * "Focus settings" (B19): the fields and buttons that edit the focus as a whole, in a fold below the lists. Closed
   * by default; a real button (aria-expanded, aria-controls) opens a region named by it, in place, as "How focus
   * works" does. The open state lives only as long as the page (no setting, nothing stored).
   */
  function settingsFold(p) {
    const setField = (field, val) => {
      draft()[field] = val;
      s.ctx.drawOnNew();
    };
    const open = s.settingsOpen;
    const summary = [
      p.name ? `"${p.name}"` : null,
      p.rest === 'fill' ? 'the rest fills free slots' : 'the rest waits',
      p.to ? `until ${p.to}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const toggle = el(
      'button',
      {
        type: 'button',
        id: 'plan-settings-toggle',
        class: 'checks-how-toggle plan-settings-toggle',
        'aria-expanded': String(open),
        'aria-controls': 'plan-settings-body',
      },
      el('span', { text: 'Focus settings' }),
      el('span', { class: 'plan-settings-summary', text: summary }),
      s.ctx.icon('focus-chevron'),
    );
    const fields = el(
      'div',
      { class: 'plan-settings-fields' },
      el(
        'label',
        {
          class: 'plan-field',
          title: 'A short name for the focus period, for example "Export first, then API". Optional.',
        },
        el('span', { text: 'Name' }),
        el('input', {
          type: 'text',
          maxlength: 200,
          value: p.name,
          placeholder: 'optional',
          'aria-label': 'Name of the focus period',
          onchange: (e) => setField('name', e.target.value.trim()),
        }),
      ),
      el(
        'label',
        {
          class: 'plan-field',
          title:
            'What happens to tasks outside the steps? "Wait fully" saves money: slots may stay empty. ' +
            '"Fill free slots" starts them only when the focus has nothing ready. A new focus starts with the ' +
            'setting Outside focus in Settings, Plans and focus (fill unless you changed it).',
        },
        el('span', { text: 'Rest' }),
        el(
          'select',
          {
            'aria-label': 'Rest of the queue',
            onchange: (e) => setField('rest', e.target.value),
          },
          el('option', { value: 'wait', text: 'waits fully', selected: p.rest === 'wait' }),
          el('option', {
            value: 'fill',
            text: 'fills free slots',
            selected: p.rest === 'fill',
          }),
        ),
      ),
      el(
        'label',
        {
          class: 'plan-field',
          title:
            'Optional end date (inclusive). Without a date the focus applies until you change it. When the period is over, ' +
            'you get a notice, and the queue goes by score again.',
        },
        el('span', { text: 'Until' }),
        el('input', {
          type: 'date',
          value: p.to,
          min: new Date().toISOString().slice(0, 10),
          'aria-label': 'Focus applies up to and including',
          onchange: (e) => setField('to', e.target.value || ''),
        }),
      ),
      el(
        'label',
        {
          class: 'plan-field plan-check-mark',
          title:
            'When something in focus waits on a task outside the steps (for example a data model another part builds on), ' +
            'that task gets the same step, so the focus does not stall. Recommended.',
        },
        el('input', {
          type: 'checkbox',
          checked: p.drag_with,
          onchange: (e) => setField('drag_with', e.target.checked),
        }),
        el('span', { text: 'Drag dependencies along' }),
      ),
      el(
        'label',
        {
          class: 'plan-field',
          title:
            'What happens when every step is done or the period is over: continue the regular queue by priority, or ' +
            'pause the queue and ask you (an owner question in Decisions). "Config default" uses focus.continueWhenEmpty.',
        },
        el('span', { text: 'When the focus is done' }),
        el(
          'select',
          {
            'aria-label': 'When the focus is done',
            onchange: (e) =>
              setField('continue_empty', e.target.value === 'on' ? true : e.target.value === 'off' ? false : null),
          },
          [
            ['inherit', configDefaultText()],
            ['on', 'Continue the regular queue'],
            ['off', 'Pause and ask me'],
          ].map(([value, text]) =>
            el('option', {
              value,
              text,
              selected: (p.continue_empty === true ? 'on' : p.continue_empty === false ? 'off' : 'inherit') === value,
            }),
          ),
        ),
      ),
    );
    const actions = el(
      'div',
      { class: 'plan-settings-actions' },
      el('button', {
        type: 'button',
        class: 'button button-outline button-small',
        text: 'Clear focus',
        disabled: !p.steps.length,
        title:
          'Moves all steps to Not in focus in the draft. Saving without steps means no focus: the queue goes by score and ' +
          'projectBonus.',
        onclick: () => {
          draft().steps = [];
          s.ctx.drawOnNew();
        },
      }),
      // Owner question 6: areas are setup, not daily focus work, so "Areas …" lives with the settings.
      el('button', {
        type: 'button',
        class: 'button button-outline button-small',
        text: 'Areas …',
        title:
          'Create and name areas, and move projects between them. You see what changes before it ' +
          'is saved.',
        onclick: openAreas,
      }),
    );
    const body = el(
      'div',
      {
        id: 'plan-settings-body',
        class: 'checks-how-body plan-settings-body',
        role: 'region',
        'aria-labelledby': 'plan-settings-toggle',
      },
      fields,
      actions,
    );
    body.hidden = !open;
    const box = el(
      'section',
      { class: `checks-how plan-settings${open ? '' : ' is-closed'}` },
      el('h2', { class: 'checks-how-title' }, toggle),
      body,
    );
    toggle.addEventListener('click', () => {
      s.settingsOpen = !s.settingsOpen;
      toggle.setAttribute('aria-expanded', String(s.settingsOpen));
      body.hidden = !s.settingsOpen;
      box.classList.toggle('is-closed', !s.settingsOpen);
    });
    return box;
  }

  /** The elements in a section, in order. Not in focus: areas, and projects without an area that are not elsewhere. */
  function elementsIn(col, p) {
    if (col === 'focus') return p.steps;
    const d = data();
    if (col === 'waiting') return [...p.pause].sort().map((pid) => `project:${pid}`);
    // B21: a task step taken out of In focus in the draft (a saved one, or one the picker added) stands here, so it can
    // be dragged back. It leaves the list when the draft is saved or discarded.
    const out = [...new Set([...savedSteps(), ...s.taskKeys])].filter(
      (key) => typeFor(key) === 'task' && columnFor(p, key) === 'later',
    );
    for (const o of d.plan.areas) {
      if (o.oid === 'without-area' || !o.in_register) continue;
      const key = `area:${o.oid}`;
      if (columnFor(p, key) === 'later') out.push(key);
    }
    // Projects without a (known) area, and features that have been in a step, sit on their own in Not in focus.
    for (const pr of d.plan.projects) {
      const hasArea = d.plan.areas.some(
        (o) => o.in_register && o.oid !== 'without-area' && o.oid === pr.area,
      );
      const key = `project:${pr.pid}`;
      if (!hasArea && visibleProject(pr, p) && columnFor(p, key) === 'later')
        out.push(key);
    }
    return out;
  }

  /** Projects with something to do (pending or active), or that are in a step or on pause. */
  function visibleProject(pr, p) {
    const key = `project:${pr.pid}`;
    return pr.waiting > 0 || pr.activeOnes > 0 || p.steps.includes(key) || p.pause.has(pr.pid);
  }

  /** One section (In focus, Not in focus, On pause): a real h2 that names it, the help, and the list. */
  function section(k, p, forecast = null) {
    const elements = elementsIn(k.key, p);
    const sorted = k.key === 'focus';
    const sum = elements.reduce(
      (acc, n) => {
        const t = info(n).counts;
        return { waiting: acc.waiting + (t?.waiting ?? 0), min: acc.min + (t?.min_left ?? 0) };
      },
      { waiting: 0, min: 0 },
    );
    const list = el(
      'ol',
      {
        // QA-1b: past TASK_CAP steps, In focus draws compact rows (board.css .plan-list-compact) so 50 steps stay
        // scannable. Only the look changes: the rows are the same .plan-element children the drop bar measures.
        class: `plan-list${sorted && elements.length > TASK_CAP ? ' plan-list-compact' : ''}`,
        'data-col': k.key,
        'aria-label': `${k.name}: ${elements.length} ${elements.length === 1 ? 'element' : 'elements'}`,
        ondragover: (e) => dragOver(e),
        ondragleave: (e) => {
          // Only a leave out of the list counts: moving onto a row (or the drop bar) inside it keeps both marks.
          if (!e.currentTarget.contains(e.relatedTarget)) {
            e.currentTarget.classList.remove('release-her');
            removeDropBars(e.currentTarget);
          }
        },
        ondrop: (e) => release(e, k.key),
      },
      elements.length
        ? elements.map((n, i) => element(n, p, sorted ? i + 1 : null))
        : el('li', {
            class: 'plan-empty',
            text:
              k.key === 'waiting'
                ? 'No projects on pause.'
                : k.key === 'later'
                  ? 'Everything is in focus.'
                  : 'Nothing in focus. Drag an area, project or feature here, or lift one with Space and move it with the arrow keys.',
          }),
    );
    const headId = `plan-head-${k.key}`;
    return el(
      'section',
      { class: `plan-section plan-section-${k.key}`, 'aria-labelledby': headId },
      el(
        'header',
        { class: 'col-header plan-section-head', title: k.help },
        el('h2', { id: headId, text: k.name }),
        el('span', {
          class: 'counter',
          text: `${sum.waiting} · ${time(sum.min)}`,
          title: `${sum.waiting} pending tasks, ${time(sum.min)} estimated left in the section`,
        }),
        sorted ? toolbar() : null,
      ),
      el('p', { class: 'plan-col-help', text: k.help }),
      list,
      sorted ? forecastBox(forecast) : null,
    );
  }

  /** The number row for an area, project or feature (each number has an explanation in its title). */
  function counts(t, { pause = false } = {}) {
    if (!t) return el('span', { class: 'plan-tall', text: 'no open tasks' });
    const parts = [
      el('span', {
        text: `${t.waiting} waiting`,
        title: 'Pending tasks (excluding the batch queue and proposed)',
      }),
      el('span', {
        text: `${t.readyOnes} ready`,
        title:
          'No blockers apart from focus and pause: they can start as soon as they are in focus and a slot is free.',
      }),
      el('span', { text: time(t.min_left), title: 'Estimated time left for the pending ones' }),
    ];
    if (t.activeOnes)
      parts.push(
        el('span', { text: `${t.activeOnes} in progress`, title: 'Running, picked or in review' }),
      );
    if (t.parked)
      parts.push(
        el('span', { text: `${t.parked} on hold`, title: 'Parked tasks (Put on hold)' }),
      );
    if (t.question)
      parts.push(
        el('span', {
          class: 'plan-sp',
          text: `${t.question} question`,
          title: 'Open owner questions that tasks here are waiting on (answer them in Decisions)',
        }),
      );
    if (t.dragged)
      parts.push(
        el('span', {
          class: 'plan-dragged',
          text: `↳ ${t.dragged} dragged along`,
          title:
            'Tasks here that something in focus waits on. They get the focus task\'s step, even if they sit outside the steps.',
        }),
      );
    if (pause) parts.push(el('span', { class: 'badge old', text: 'paused' }));
    return el('span', { class: 'plan-tall' }, parts);
  }

  /** One element (card) in a section: area with projects, project with its features, or feature. */
  function element(key, p, stepNr) {
    const i = info(key);
    const col = columnFor(p, key);
    const name = TYPE_NAME[i.type];
    const header = el(
      'div',
      { class: 'plan-header' },
      s.ctx.icon('handle'),
      stepNr
        ? el('span', {
            class: 'plan-step',
            text: `T${stepNr}`,
            title: `Step ${stepNr}: everything here starts before anything in step ${stepNr + 1}`,
          })
        : null,
      el('span', { class: `badge plan-type plan-type-${i.type}`, text: name }),
      el('span', {
        class: 'plan-name',
        text: i.type === 'feature' ? `${i.pid} › ${i.title}` : i.title,
      }),
      // The project id beside the title, as in a project inside an area and on the cards (B17); a task step (B20)
      // shows its task id the same way.
      i.type === 'project' || i.type === 'task' ? el('span', { class: 'pid', text: restFor(key) }) : null,
      !i.exists
        ? el('span', {
            class: 'badge old',
            text: 'does not exist',
            title: 'The step points to something that no longer exists in the queue. Drag it to Not in focus.',
          })
        : stepNr && DONE_TITLE[i.status]
          ? el('span', { class: 'badge', text: 'done', title: DONE_TITLE[i.status] })
          : null,
      stepNr ? stepMenu(key, stepNr, p.steps.length, i) : null,
    );
    // B19: a step in In focus folds open to show its tasks.
    const children = stepNr ? tasksFold(key, stepNr) : [];
    if (i.type === 'area') {
      // Projects in the area that are not in a step of their own or on pause (those are shown there).
      const mine = (i.counts?.projects ?? [])
        .map((pid) => projectRow(pid))
        .filter((pr) => pr && visibleProject(pr, p))
        .filter((pr) => columnFor(p, `project:${pr.pid}`) === 'later');
      const others = (i.counts?.projects ?? []).filter(
        (pid) => columnFor(p, `project:${pid}`) !== 'later',
      );
      if (mine.length)
        children.push(
          el(
            'ul',
            { class: 'plan-under' },
            mine.map((pr) => underElement(`project:${pr.pid}`, p)),
          ),
        );
      if (others.length)
        children.push(
          el('p', {
            class: 'plan-remark',
            text: `On their own: ${others.join(', ')}`,
            title:
              'Projects in the area that have a step of their own or are on pause. Their own step takes precedence over the area\'s step.',
          }),
        );
    }
    if (i.type === 'project') children.push(...featureList(restFor(key), p));
    return el(
      'li',
      {
        class: `plan-element plan-${i.type}${s.boosted?.key === key ? ' boosted' : ''}`,
        'data-key': key,
        tabindex: 0,
        draggable: 'true',
        'aria-label':
          `${name} ${i.title}, in ${sectionName(col)}` +
          `${stepNr ? `, step ${stepNr}` : ''}. Space lifts, the arrow keys move.`,
        title: `${name} ${i.title}. Drag to another section, or lift with Space and move with the arrow keys.`,
        ondragstart: (e) => dragStart(e, key),
        ondragend: dragEnd,
        onkeydown: (e) => keyPress(e, key),
      },
      header,
      counts(i.counts, { pause: i.type === 'project' && p.pause.has(restFor(key)) }),
      children,
    );
  }

  /**
   * The step menu (QA-1b): a small button at the end of an In focus row that opens Move to top and Move to bottom, so
   * a step goes to either end of 50 steps in two clicks instead of a long drag. It is one tab stop per row (the items
   * are reached with the arrow keys inside the open menu, as on the Selection menu). Both moves go into the draft, as
   * a drag does; the focus stays on the moved step's menu button and the live status says where it is now. The menu
   * is drawn from s.menu, and QueuePlan.busy holds the board's redraws while it is open.
   */
  function stepMenu(key, stepNr, n, i) {
    const open = s.menu === key;
    const buttonId = `plan-step-menu-${key}`;
    const button = el(
      'button',
      {
        type: 'button',
        id: buttonId,
        class: 'button-icon plan-step-menu-button',
        'aria-haspopup': 'menu',
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': `Move step T${stepNr}, ${i.title}`,
        title: 'Move this step to the top or the bottom of the focus.',
        onclick: (e) => {
          e.stopPropagation();
          s.menu = open ? null : key;
          s.refocus = buttonId;
          s.ctx.drawOnNew();
        },
      },
      el('span', { 'aria-hidden': 'true', text: '⋯' }),
    );
    const close = () => {
      s.menu = null;
      s.refocus = buttonId;
      s.ctx.drawOnNew();
    };
    const moveTo = (where) => {
      move(key, 'focus', where === 'top' ? 0 : n);
      s.menu = null;
      s.refocus = buttonId;
      s.refocusScroll = true; // the step moved far: let the page follow it
      s.ctx.status(
        `${i.title} is step ${where === 'top' ? 1 : n} of ${n} now. The change is in the draft until you press "Save focus".`,
      );
      s.ctx.drawOnNew();
    };
    const item = (text, where, disabled) =>
      el('button', {
        type: 'button',
        role: 'menuitem',
        class: 'option-item',
        tabindex: '-1',
        disabled,
        text,
        onclick: (e) => {
          e.stopPropagation();
          moveTo(where);
        },
      });
    const menu = open
      ? el(
          'div',
          {
            class: 'plan-step-menu',
            role: 'menu',
            'aria-label': `Move step T${stepNr}`,
            onkeydown: (e) => {
              const items = [...e.currentTarget.querySelectorAll('[role="menuitem"]:not([disabled])')];
              const at = items.indexOf(document.activeElement);
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                const next = items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
                next?.focus();
              } else if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                e.stopPropagation();
                (e.key === 'Home' ? items[0] : items.at(-1))?.focus();
              } else if (e.key === 'Escape' || e.key === 'Tab') {
                // Esc gives the focus back to the button; Tab closes too, so no menu is left open behind the focus.
                if (e.key === 'Escape') e.preventDefault();
                e.stopPropagation();
                close();
              }
            },
          },
          item('Move to top', 'top', stepNr === 1),
          item('Move to bottom', 'bottom', stepNr === n),
        )
      : null;
    return el('span', { class: 'plan-step-menu-space' }, button, menu);
  }

  /**
   * The fold of a step in In focus (B19): a real button (aria-expanded, aria-controls) and a region named by it with the
   * step's tasks and a status badge per task (planBasis step_tasks: the saved steps only, so a step that is only in the
   * draft says so). The button keeps keyboard focus across the redraw (s.refocus).
   */
  function tasksFold(key, stepNr) {
    const saved = savedSteps().includes(key);
    const tasks = data()?.plan?.step_tasks?.[key] ?? [];
    const open = s.openSteps.has(key);
    const buttonId = `plan-tasks-toggle-${stepNr}`;
    const regionId = `plan-tasks-${stepNr}`;
    const button = el(
      'button',
      {
        type: 'button',
        id: buttonId,
        class: 'link-button plan-expand plan-tasks-toggle',
        'aria-expanded': open ? 'true' : 'false',
        'aria-controls': regionId,
        title: 'Show the tasks in this step and where each one stands.',
        onclick: (e) => {
          e.stopPropagation();
          if (open) s.openSteps.delete(key);
          else s.openSteps.add(key);
          s.refocus = buttonId;
          s.ctx.drawOnNew();
        },
      },
      el('span', { class: 'fold-chevron', 'aria-hidden': 'true' }),
      saved ? `Tasks (${tasks.length})` : 'Tasks',
    );
    // QA-1b: above TASK_CAP tasks the list gets its own scroll area (board.css .plan-tasks-list.is-capped, about 12
    // rows high), so one big step does not push the other 49 off the page. A scroll area must be reachable without a
    // mouse, so it is a tab stop (the arrow keys then scroll it) with a label that says how many tasks it holds, and a
    // visible hint under it says that it scrolls.
    const capped = tasks.length > TASK_CAP;
    const content = !saved
      ? el('p', {
          class: 'plan-remark',
          text: 'Not saved yet: the tasks of this step show here after "Save focus".',
        })
      : !tasks.length
        ? el('p', { class: 'plan-remark', text: 'No open tasks left in this step.' })
        : el(
            'ul',
            {
              class: `plan-tasks-list${capped ? ' is-capped' : ''}`,
              tabindex: capped ? '0' : null,
              'aria-label': capped
                ? `Tasks in step T${stepNr}: ${tasks.length} tasks. The list scrolls.`
                : null,
            },
            tasks.map((x) => {
              const [word, tone, why] = TASK_STATE[x.state] ?? [x.state, '', ''];
              return el(
                'li',
                null,
                el('code', { class: 'plan-tasks-id', text: x.id }),
                ' ',
                // The title stays on one line in a capped list (equal rows); the full text is in the tooltip.
                el('span', { class: 'plan-tasks-title', text: x.title ?? '', title: x.title || null }),
                ' ',
                el('span', { class: `badge${tone ? ` ${tone}` : ''}`, text: word, title: why }),
              );
            }),
          );
    const hint =
      saved && capped
        ? el('p', {
            class: 'plan-tasks-hint',
            text: `All ${tasks.length} tasks are in the list: scroll it, or focus it and use the arrow keys, to see the rest.`,
          })
        : null;
    const region = el(
      'div',
      { id: regionId, class: 'plan-tasks', role: 'region', 'aria-labelledby': buttonId },
      content,
      hint,
    );
    region.hidden = !open;
    return [button, region];
  }

  /** A project inside an area (can be dragged out to a step of its own or to On pause). */
  function underElement(key, p) {
    const i = info(key);
    return el(
      'li',
      {
        class: `plan-element plan-child-element${s.boosted?.key === key ? ' boosted' : ''}`,
        'data-key': key,
        tabindex: 0,
        draggable: 'true',
        'aria-label': `Project ${i.title} in the area. Drag it out to give it a step of its own. Space lifts.`,
        title: `Project ${i.title}. Drag it out of the area to give it a step of its own (for example "Widgets now, the rest of Platform later"), or to On pause to pause it.`,
        ondragstart: (e) => dragStart(e, key),
        ondragend: dragEnd,
        onkeydown: (e) => keyPress(e, key),
      },
      el(
        'div',
        { class: 'plan-header' },
        s.ctx.icon('handle'),
        el('span', { class: 'plan-name', text: i.title }),
        el('span', { class: 'pid', text: restFor(key) }),
      ),
      counts(i.counts),
      ...featureList(restFor(key), p),
    );
  }

  /** "Features (6)" with the shared chevron and, when open, the features (can be dragged to In focus as a step of their own). */
  function featureList(pid, p) {
    const pr = projectRow(pid);
    const features = (pr?.features ?? []).filter(
      (f) => f.waiting > 0 && columnFor(p, f.stage) === 'later',
    );
    if (!features.length) return [];
    const open = s.openOnes.has(pid);
    // The arrow is decoration (aria-hidden); the state is read from aria-expanded, the name from the text.
    const button = el(
      'button',
      {
        type: 'button',
        class: 'link-button plan-expand',
        'aria-expanded': open ? 'true' : 'false',
        title:
          'Show the features in the project. A feature can be dragged to In focus as a step of its own.',
        onclick: (e) => {
          e.stopPropagation();
          if (open) s.openOnes.delete(pid);
          else s.openOnes.add(pid);
          s.ctx.drawOnNew();
        },
      },
      el('span', { class: 'fold-chevron', 'aria-hidden': 'true' }),
      `Features (${features.length})`,
    );
    if (!open) return [button];
    return [
      button,
      el(
        'ul',
        { class: 'plan-under plan-features' },
        features.map((f) =>
          el(
            'li',
            {
              class: `plan-element plan-feature-row${s.boosted?.key === f.stage ? ' boosted' : ''}`,
              'data-key': f.stage,
              tabindex: 0,
              draggable: 'true',
              'aria-label': `Feature ${f.name}. Drag to In focus to give it a step of its own. Space lifts.`,
              title: `Feature ${f.name}: drag to In focus to give it a step of its own.`,
              ondragstart: (e) => dragStart(e, f.stage),
              ondragend: dragEnd,
              onkeydown: (e) => keyPress(e, f.stage),
            },
            el(
              'div',
              { class: 'plan-header' },
              s.ctx.icon('handle'),
              el('span', { class: 'plan-name', text: f.name }),
            ),
            counts(f),
          ),
        ),
      ),
    ];
  }

  // ---- Drag with the mouse ----
  function dragStart(e, key) {
    e.stopPropagation();
    s.drag = { key };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
    e.currentTarget.classList.add('dragged');
  }
  function dragEnd(e) {
    e.currentTarget.classList.remove('dragged');
    for (const x of document.querySelectorAll('.plan-list.release-her'))
      x.classList.remove('release-her');
    removeDropBars(document);
    s.drag = null;
    if (s.ctx.pending()) s.ctx.drawOnNew();
  }
  function dragOver(e) {
    if (!s.drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('release-her');
    showDropBar(e.currentTarget, e.clientY);
  }

  // ---- The drop bar (QA-1a): a thin bar at the exact spot a dragged step will land in In focus ----
  /**
   * Where a drop at height y puts the dragged step in this list: the index from releaseIndex, the same midpoint rule
   * release uses, so the bar and the drop always agree. null when there is no place to show: the list is not ordered
   * (only In focus is; in Not in focus and On pause the place does not matter, and the highlighted list is the target),
   * or the drop would not move the step (it is in this list and would land where it already is).
   */
  function dropTarget(list, y) {
    if (list.dataset.col !== 'focus') return null;
    const index = releaseIndex(list, y);
    // releaseIndex counts the rows without the dragged one, so landing at its own position among all rows is no move.
    const from = [...list.querySelectorAll(':scope > .plan-element')].findIndex((x) => x.dataset.key === s.drag?.key);
    return from >= 0 && from === index ? null : index;
  }
  /**
   * Shows, moves or removes the drop bar in one list. The bar is absolutely positioned (board.css .plan-drop-bar), so it
   * takes no room and the rows, and with them the midpoints releaseIndex reads, never shift while the pointer moves. It
   * sits in the middle of the gap the step lands in: between two rows, just above the first or just below the last.
   * It is only for the eye (aria-hidden): the keyboard way (keyPress) moves the lifted row itself and says the place in
   * the live status, so it has no separate target to mark.
   */
  function showDropBar(list, y) {
    const index = dropTarget(list, y);
    let bar = list.querySelector(':scope > .plan-drop-bar');
    if (index == null) {
      bar?.remove();
      return;
    }
    const others = [...list.querySelectorAll(':scope > .plan-element')].filter((x) => x.dataset.key !== s.drag?.key);
    const top = list.getBoundingClientRect().top;
    const prev = others[index - 1]?.getBoundingClientRect();
    const next = others[index]?.getBoundingClientRect();
    const middle = prev && next ? (prev.bottom + next.top) / 2 : next ? next.top - 2 : prev ? prev.bottom + 2 : top + 4;
    if (!bar) {
      bar = el('li', { class: 'plan-drop-bar', 'aria-hidden': 'true' });
      list.append(bar);
    }
    bar.dataset.index = String(index);
    // From the list's padding edge (where an absolute child is placed), centred on the 3 px bar.
    bar.style.top = `${Math.round(middle - top - (list.clientTop || 0) - 1.5)}px`;
  }
  /** Removes every drop bar under root (one list, or the document after a drop or a cancelled drag). */
  function removeDropBars(root) {
    for (const x of root.querySelectorAll('.plan-drop-bar')) x.remove();
  }
  /** The position in the list where the element is dropped: before the first element whose middle is below the mouse. */
  function releaseIndex(list, y) {
    const elements = [...list.querySelectorAll(':scope > .plan-element')].filter(
      (x) => x.dataset.key !== s.drag?.key,
    );
    const i = elements.findIndex((x) => {
      const r = x.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return i < 0 ? elements.length : i;
  }
  function release(e, col) {
    if (!s.drag) return;
    e.preventDefault();
    const key = s.drag.key;
    const index = releaseIndex(e.currentTarget, e.clientY);
    removeDropBars(document);
    s.drag = null;
    const error = move(key, col, index);
    if (error) s.ctx.message(error, true);
    s.ctx.drawOnNew();
  }

  // ---- Keyboard: Space lifts, arrows move, Space drops, Esc cancels ----
  function keyPress(e, key) {
    if (e.target !== e.currentTarget) return;
    const p = current();
    if (!s.boosted) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        s.boosted = { key, before: copy(p), hasDraft: !!s.draft };
        s.ctx.status(
          `${info(key).title} is lifted. The arrow keys move it (up and down in In focus, Home and End to the top and the bottom, left and right between the sections), Space drops, Esc cancels.`,
        );
        s.ctx.drawOnNew();
      }
      return;
    }
    if (s.boosted.key !== key) return;
    const col = columnFor(p, key);
    const sequence = SECTIONS.map((k) => k.key);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      let j = sequence.indexOf(col) + (e.key === 'ArrowLeft' ? -1 : 1);
      // An area or a feature cannot be on pause: skip that section.
      if (sequence[j] === 'waiting' && typeFor(key) !== 'project') j = -1;
      if (j < 0 || j >= sequence.length) return;
      move(key, sequence[j]);
      s.ctx.status(`In ${SECTIONS[j].name}. Space drops, Esc cancels.`);
      s.ctx.drawOnNew();
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) && col === 'focus') {
      e.preventDefault();
      e.stopPropagation();
      const list = draft().steps;
      const i = list.indexOf(key);
      // QA-1b: Home and End take a lifted step to the top and the bottom (the step menu does the same with a mouse).
      const j =
        e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : i + (e.key === 'ArrowUp' ? -1 : 1);
      if (j < 0 || j >= list.length) return;
      list.splice(i, 1);
      list.splice(j, 0, key);
      s.ctx.status(`Step ${j + 1} of ${list.length} in In focus.`);
      s.ctx.drawOnNew();
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      s.boosted = null;
      s.ctx.status('Dropped. The change is in the draft until you press "Save focus".');
      s.ctx.drawOnNew();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const l = s.boosted;
      s.boosted = null;
      s.draft = l.hasDraft ? l.before : null;
      if (!l.hasDraft) s.basis = null;
      s.ctx.status('Cancelled.');
      s.ctx.drawOnNew();
    }
  }


  // ---- The dialog (focus preview, areas) ----
  function makeDialog() {
    let background = document.getElementById('plan-dialog-background');
    if (!background) {
      background = el(
        'div',
        { id: 'plan-dialog-background', class: 'guard-background', hidden: true },
        el('div', {
          id: 'plan-dialog',
          class: 'guard bulk plan-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'plan-dialog-title',
        }),
      );
      background.addEventListener('click', (e) => {
        if (e.target === background) closeDialog();
      });
      background.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeDialog();
        } else {
          // Focus stays in the dialog (the shared trap in a11y.js).
          window.QueueA11y.trapKey(e, document.getElementById('plan-dialog'));
        }
      });
      document.body.append(background);
    }
    return background;
  }
  function showDialog(content, focusSelector) {
    const background = makeDialog();
    const box = document.getElementById('plan-dialog');
    if (!s.dialog) s.dialog = { from: document.activeElement };
    // replaceChildren() would turn a null (a part a dialog leaves out) into the text "null".
    box.replaceChildren(...content.filter((x) => x != null));
    background.hidden = false;
    const template =
      (focusSelector ? box.querySelector(focusSelector) : null) ?? box.querySelector('button');
    template?.focus();
  }
  function closeDialog() {
    const background = document.getElementById('plan-dialog-background');
    if (background) background.hidden = true;
    const from = s.dialog?.from;
    s.dialog = null;
    if (from?.isConnected) from.focus();
    s.ctx?.drawOnNew();
  }
  const open = () => !!s.dialog;

  /**
   * The plan sent to the server. The steps go in their order; now_count is the saved one, sent back unchanged (only
   * held between 1 and the number of steps), since the board no longer draws the split (owner question 1).
   */
  function planForServer(p) {
    const order = [...p.steps];
    const serverPause = serverPlan().pause;
    return {
      order,
      ...(order.length ? { now_count: Math.min(Math.max(p.now_count || 1, 1), order.length) } : {}),
      rest: p.rest,
      to: p.to || null,
      name: p.name || null,
      drag_with_dependencies: p.drag_with,
      // Left out = the config decides (the server and setFocus treat a missing value so).
      ...(typeof p.continue_empty === 'boolean' ? { continue_when_empty: p.continue_empty } : {}),
      pause: [...p.pause].filter((pid) => !serverPause.has(pid)),
      continue: [...serverPause].filter((pid) => !p.pause.has(pid)),
    };
  }

  /**
   * What the preview dialog saves. The draft (Save focus) sends the whole plan; a card action (B21, changeFocus) sends one
   * change ({ change: { action, steps, at? } }) that the server makes with the B20 logic (focus add / focus remove).
   * `fresh()` gives the job again after the queue changed under the preview.
   */
  function draftJob() {
    return {
      title: 'Save focus',
      saveLabel: 'Save focus',
      explanation:
        'The focus decides the order in which the queue starts work: everything in step 1 before step 2, regardless of score. ' +
        'Review what changes before you save. Nothing is saved yet.',
      body: { plan: planForServer(current()) },
      saved: () => {
        s.draft = null;
        s.basis = null;
        s.taskKeys.clear();
      },
      fresh: draftJob,
    };
  }
  function changeJob(change) {
    const add = change.action === 'add';
    const n = change.steps.length;
    const job = {
      title: add ? 'Add to focus' : 'Remove from focus',
      saveLabel: add ? 'Add to focus' : 'Remove from focus',
      explanation: add
        ? `${n === 1 ? 'The task goes' : `The ${n} tasks go`} into the focus as ${n === 1 ? 'its own step' : 'their own steps'}, ` +
          `${change.at ? `at step ${change.at}` : 'last in the list'}. The rest of the focus stays as it is. Review what ` +
          'changes before you save. Nothing is saved yet. Undo takes it back.'
        : 'The step comes out of the focus; the rest of the focus stays as it is. Review what changes before you save. ' +
          'Nothing is saved yet. Undo takes it back.',
      body: { change },
      saved: () => {},
      fresh: () => job,
    };
    return job;
  }

  async function previewList(job = draftJob()) {
    showDialog([
      el('h2', { id: 'plan-dialog-title', text: job.title }),
      el('p', { class: 'bulk-loading', text: 'Working out what changes …' }),
    ]);
    let answer;
    try {
      answer = await s.ctx.api('/api/focus', { ...job.body, dry: true });
    } catch (e) {
      return showDialog([
        el('h2', { id: 'plan-dialog-title', text: job.title }),
        el('p', { class: 'bulk-error', text: e.message }),
        buttons([['Close', closeDialog, 'button-outline']]),
      ]);
    }
    const content = [
      el('h2', { id: 'plan-dialog-title', text: job.title }),
      el('p', { class: 'bulk-explanation', text: job.explanation }),
      el(
        'dl',
        { class: 'facts' },
        el('dt', { text: 'Before' }),
        el('dd', { text: answer.before_text }),
        el('dt', { text: 'After' }),
        el('dd', { text: answer.after_text }),
      ),
    ];
    if (answer.error?.length)
      content.push(
        el(
          'ul',
          { class: 'guard-list bulk-error' },
          answer.error.map((x) => el('li', { text: x })),
        ),
      );
    if (answer.lines?.length)
      content.push(
        el(
          'ul',
          { class: 'plan-lines' },
          answer.lines.map((x) => el('li', { text: x })),
        ),
      );
    if (answer.warnings?.length)
      content.push(
        el('h3', { class: 'setting-title', text: 'Warnings' }),
        el(
          'ul',
          { class: 'guard-list' },
          answer.warnings.map((x) => el('li', { text: x })),
        ),
      );
    if (answer.next_text)
      content.push(
        el('h3', { class: 'setting-title', text: 'Next up after saving' }),
        el('p', { class: 'sp-meta', text: answer.next_text }),
        answer.next?.length
          ? el(
              'ul',
              { class: 'plan-lines' },
              answer.next.map((v) => el('li', null, el('code', { text: v.id }), ` ${v.title}`)),
            )
          : null,
      );
    content.push(
      buttons([
        ['Cancel', closeDialog, 'button-outline'],
        answer.can ? [job.saveLabel, () => save(job, answer.changed), 'button-filled'] : null,
      ]),
    );
    showDialog(content, '.button-filled');
  }

  async function save(job, expectValue) {
    try {
      const answer = await s.ctx.api('/api/focus', { ...job.body, expect: expectValue });
      job.saved();
      closeDialog();
      s.ctx.messageWithInfo(answer.message ?? 'Focus saved', answer);
      await s.ctx.update(true);
    } catch (e) {
      if (e.answer?.outdated) {
        s.ctx.message('The queue has changed since the preview. Here is the new one.', true);
        await s.ctx.update(true);
        return previewList(job.fresh());
      }
      s.ctx.message(e.message, true);
    }
  }

  function buttons(list) {
    return el(
      'div',
      { class: 'guard-buttons' },
      list
        .filter(Boolean)
        .map(([text, fn, cls]) =>
          el('button', { type: 'button', class: `button ${cls}`, text, onclick: fn }),
        ),
    );
  }

  // ---- "Add to focus …" (B21): pick a task, feature, project or area and a position, into the draft ----
  const PICK_KINDS = [
    ['task', 'Task'],
    ['feature', 'Feature'],
    ['project', 'Project'],
    ['area', 'Area'],
  ];
  // The words the pickers count with: [one, many].
  const PICK_NOUN = {
    task: ['task', 'tasks'],
    feature: ['feature', 'features'],
    project: ['project', 'projects'],
    area: ['area', 'areas'],
    step: ['step', 'steps'],
  };

  /**
   * The steps of one kind that are not in the draft's In focus yet, as picker options:
   * { value: the step key, main: the id or name, sub: the title or project (quieter), search: lowercase text }.
   */
  function pickOptions(kind, p) {
    const d = data();
    let all = [];
    if (kind === 'task') all = openCards().map((k) => option(`task:${k.id}`, k.id, k.title ?? ''));
    else if (kind === 'feature')
      all = (d.plan?.projects ?? []).flatMap((pr) =>
        (pr.features ?? []).map((x) => option(`feature:${pr.pid}/${x.name}`, `${pr.pid} › ${x.name}`, '')),
      );
    else if (kind === 'project')
      all = (d.plan?.projects ?? []).map((pr) => option(`project:${pr.pid}`, pr.title ?? pr.pid, pr.pid));
    else
      all = (d.plan?.areas ?? [])
        .filter((o) => o.in_register && o.oid !== 'without-area')
        .map((o) => option(`area:${o.oid}`, o.title ?? o.oid, o.oid));
    return all.filter((o) => !p.steps.includes(o.value));
  }
  /** One picker option; `badge` is the step number (T3) in the step list, shown first. */
  function option(value, main, sub, badge = null) {
    return { value, main, sub, badge, search: [badge, main, sub].filter(Boolean).join(' ').toLowerCase() };
  }
  /**
   * The steps in order as picker options, by the label a step has in In focus: T<n>, then the task id and title for a
   * task step, the name and project for a feature, the title and id for a project, the title for an area.
   */
  function stepOptions(steps) {
    return steps.map((key, i) => {
      const x = info(key);
      const main = x.type === 'task' ? restFor(key) : x.title;
      const sub = x.type === 'task' ? x.title : x.type === 'feature' ? x.pid : x.type === 'project' ? restFor(key) : '';
      return option(key, main, sub, `T${i + 1}`);
    });
  }

  /**
   * A searchable single choice (QA-1b): a text field with role combobox over a listbox of options, the WAI-ARIA
   * pattern the Plans command line uses (plans/work.js buildPalette). Typing filters the options by every word (id
   * and title both count); exactly one shown option is chosen (aria-selected, and aria-activedescendant on the field),
   * so the arrow keys change the choice while the focus stays in the field. The number of matches is said in a polite
   * live region under the list. Esc in the field clears the search first and only bubbles to the dialog (which then
   * closes) when the field is already empty. With a handful of options every one shows, as the old select did.
   *   id      the field's id (the label's `for`); the list is `${id}-list`, the count `${id}-count`
   *   noun    [one, many] for the count, e.g. ['task', 'tasks']
   *   chosen  the value chosen from the start (default: the first option)
   * Returns { root, input, value(), setOptions(options, noun?), onChange }; onChange (set by the caller) runs on every
   * change of the choice.
   */
  function searchPick({ id, label, noun, options, chosen = null, placeholder = 'Type to search by id or title' }) {
    const listId = `${id}-list`;
    const countId = `${id}-count`;
    let all = options;
    let shown = all;
    let words = noun;
    let value = chosen ?? all[0]?.value ?? null;
    const input = el('input', {
      id,
      type: 'text',
      class: 'plan-pick-search',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'true', // the list is always shown in the dialog
      'aria-controls': listId,
      'aria-describedby': countId,
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder,
    });
    const list = el('ul', { id: listId, class: 'plan-pick-list', role: 'listbox', 'aria-label': label });
    const count = el('p', { id: countId, class: 'plan-pick-count', 'aria-live': 'polite' });
    const api = { input, value: () => value, setOptions, onChange: null };

    const word = (n) => (n === 1 ? words[0] : words[1]);
    /** Redraws the shown options with the choice marked, and the count. */
    function render() {
      list.replaceChildren(
        ...shown.map((o) => {
          const i = all.indexOf(o);
          return el(
            'li',
            {
              id: `${id}-o${i}`,
              role: 'option',
              class: `plan-pick-option${o.value === value ? ' active' : ''}`,
              'aria-selected': o.value === value ? 'true' : 'false',
              'data-value': o.value,
              // The field keeps the focus (and so the keyboard) when an option is clicked.
              onmousedown: (e) => e.preventDefault(),
              onclick: () => choose(o.value),
            },
            o.badge ? el('span', { class: 'plan-step', text: o.badge }) : null,
            o.badge ? ' ' : null,
            el('span', { class: 'plan-pick-main', text: o.main }),
            o.sub ? ' ' : null,
            o.sub ? el('span', { class: 'plan-pick-sub', text: o.sub }) : null,
          );
        }),
      );
      const active = list.querySelector('[aria-selected="true"]');
      if (active) input.setAttribute('aria-activedescendant', active.id);
      else input.removeAttribute('aria-activedescendant');
      active?.scrollIntoView({ block: 'nearest' });
      count.textContent = !input.value.trim()
        ? `${all.length} ${word(all.length)}`
        : shown.length
          ? `${shown.length} of ${all.length} match`
          : 'No matches';
    }
    function choose(v) {
      value = v;
      render();
      api.onChange?.();
    }
    /** Filters by the words in the field; a choice the filter hides moves to the first match (or none). */
    function filter() {
      const parts = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      shown = all.filter((o) => parts.every((w) => o.search.includes(w)));
      if (!shown.some((o) => o.value === value)) value = shown[0]?.value ?? null;
      render();
      api.onChange?.();
    }
    /** New options (and, optionally, new count words), with the search cleared and the first option chosen. */
    function setOptions(next, nextNoun = words) {
      all = next;
      words = nextNoun;
      input.value = '';
      value = all[0]?.value ?? null;
      filter();
    }
    input.addEventListener('input', filter);
    input.addEventListener('keydown', (e) => {
      const i = shown.findIndex((o) => o.value === value);
      // Up and down one, Page up and down ten; no wrap, so the number of presses to an end is predictable.
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
      if (step) {
        e.preventDefault();
        e.stopPropagation();
        if (!shown.length) return;
        choose(shown[Math.max(0, Math.min(shown.length - 1, (i < 0 ? 0 : i) + step))].value);
      } else if (e.key === 'Enter') {
        // The choice is already made by the arrows; Enter must not do anything else here.
        e.preventDefault();
      } else if (e.key === 'Escape' && input.value) {
        // First Esc clears the search; the dialog stays open (it closes on the next Esc).
        e.preventDefault();
        e.stopPropagation();
        input.value = '';
        filter();
      }
    });
    api.root = el('div', { class: 'plan-pick' }, input, list, count);
    render();
    return api;
  }

  /**
   * The position control (QA-1b): a labelled group of three choices, First, After a step and Last (the default, as the
   * one-click "Add to focus"). "After a step" opens a searchable list of the steps by their label, the last step chosen
   * from the start, so 50 steps never mean a 50-item select. Without steps there is nothing to choose: the step
   * becomes step 1. Returns { root, index() } where index() is the 0-based place among `steps` (n = last), or null
   * when "After a step" has no step chosen (its search matches nothing).
   */
  function positionControl(steps, onChange) {
    const n = steps.length;
    if (!n)
      return {
        root: el('p', { class: 'sp-meta', text: 'Position: there are no steps yet, so it becomes step 1.' }),
        index: () => 0,
      };
    const after = searchPick({
      id: 'plan-pick-after',
      label: 'Steps in focus',
      noun: PICK_NOUN.step,
      options: stepOptions(steps),
      chosen: steps[n - 1],
      placeholder: 'Type to search the steps',
    });
    after.onChange = onChange;
    const afterBox = el(
      'div',
      { class: 'field plan-pick-after', hidden: true },
      el('label', { for: 'plan-pick-after', text: 'After step' }),
      after.root,
    );
    let where = 'last';
    const choices = [
      ['first', 'First', 'Step 1, before everything in focus now.'],
      ['after', 'After a step', 'Right after the step you choose below.'],
      ['last', 'Last', `Step ${n + 1}, after everything in focus now.`],
    ].map(([value, text, title]) =>
      el(
        'label',
        { class: 'plan-pick-where-choice', title },
        el('input', {
          type: 'radio',
          name: 'plan-pick-where',
          value,
          checked: value === where,
          onchange: (e) => {
            if (!e.target.checked) return;
            where = value;
            afterBox.hidden = where !== 'after';
            onChange?.();
          },
        }),
        el('span', { text }),
      ),
    );
    const root = el(
      'fieldset',
      { class: 'plan-pick-where' },
      el('legend', { text: 'Position' }),
      el('div', { class: 'plan-pick-where-choices' }, choices),
      afterBox,
    );
    const index = () => {
      if (where === 'first') return 0;
      if (where === 'last') return n;
      const i = steps.indexOf(after.value());
      return i < 0 ? null : i + 1;
    };
    return { root, index };
  }

  /**
   * "Add to focus …" (B21, QA-1b). Two ways in:
   *   - the Focus tab toolbar: choose a kind, search for what, and a position; Add puts it into the draft (Save focus
   *     then shows what changes), positions counted in the draft;
   *   - "Add to focus at …" on a card, in the detail panel or the Selection (`fixed`: the task keys, already chosen):
   *     only the position is chosen, counted in the saved focus, and Preview opens the same dry preview as the
   *     one-click "Add to focus" with the change { action: 'add', steps, at? }. `at` is the 1-based place (First is 1,
   *     after step k is k+1); Last leaves it out, so it is exactly the one-click change.
   */
  function openPicker({ fixed = null } = {}) {
    const p = current();
    const steps = fixed ? savedSteps() : p.steps;
    const field = (id, label, control) =>
      el('div', { class: 'field' }, el('label', { for: id, text: label }), control);
    const primary = el('button', { type: 'button', class: 'button button-filled', text: fixed ? 'Preview' : 'Add' });
    let what = null;
    let kind = null;
    const none = el('p', { class: 'sp-meta', hidden: true, text: 'Everything of this kind is in focus already.' });
    // Add (or Preview) only when there is something to add and a place to put it.
    const refresh = () => {
      const empty = what ? !what.value() : !fixed.length;
      primary.disabled = empty || where.index() == null;
    };
    const where = positionControl(steps, () => refresh());
    if (!fixed) {
      kind = el(
        'select',
        { id: 'plan-pick-kind', 'aria-label': 'Kind' },
        PICK_KINDS.map(([v, text]) => el('option', { value: v, text })),
      );
      what = searchPick({ id: 'plan-pick-what', label: 'What', noun: PICK_NOUN.task, options: pickOptions('task', p) });
      what.onChange = refresh;
      // A new kind refills the list (and clears the search); the count then speaks of that kind.
      const fill = () => {
        const list = pickOptions(kind.value, p);
        none.hidden = list.length > 0;
        what.input.disabled = !list.length;
        what.setOptions(list, PICK_NOUN[kind.value]);
      };
      kind.addEventListener('change', fill);
      none.hidden = what.value() != null;
      what.input.disabled = what.value() == null;
    }
    primary.addEventListener('click', () => {
      const index = where.index();
      if (index == null) return;
      if (fixed) {
        // Last (index n) is the one-click change: no `at`.
        const change = { action: 'add', steps: fixed, ...(index < steps.length ? { at: index + 1 } : {}) };
        return previewList(changeJob(change));
      }
      const key = what.value();
      if (!key) return;
      const error = move(key, 'focus', index);
      if (error) return s.ctx.message(error, true);
      if (typeFor(key) === 'task') s.taskKeys.add(key);
      s.ctx.status(`${info(key).title} is in the draft at step ${index + 1}. Save focus shows what changes.`);
      closeDialog();
    });
    refresh();
    const n = fixed?.length ?? 0;
    showDialog(
      [
        el('h2', { id: 'plan-dialog-title', text: fixed ? 'Add to focus at …' : 'Add to focus' }),
        el('p', {
          class: 'bulk-explanation',
          text: fixed
            ? `Choose where ${n === 1 ? 'the task goes' : `the ${n} tasks go`} in the focus, as ${n === 1 ? 'its own step' : 'their own steps'}. ` +
              'Preview shows what changes before anything is saved.'
            : 'Choose what goes into the focus and at which step. It goes into the draft: nothing changes in the queue ' +
              'until Save focus, which shows what changes first.',
        }),
        fixed
          ? el(
              'ul',
              { class: 'plan-pick-chosen', 'aria-label': n === 1 ? 'The task' : `The ${n} tasks` },
              fixed.map((k) =>
                el('li', null, el('code', { text: restFor(k) }), ' ', el('span', { text: info(k).title })),
              ),
            )
          : null,
        kind ? field('plan-pick-kind', 'Kind', kind) : null,
        what ? field('plan-pick-what', 'What', what.root) : null,
        what ? none : null,
        where.root,
        el(
          'div',
          { class: 'guard-buttons' },
          el('button', { type: 'button', class: 'button button-outline', text: 'Cancel', onclick: closeDialog }),
          primary,
        ),
      ],
      fixed ? 'input[name="plan-pick-where"]:checked' : '#plan-pick-kind',
    );
  }

  // ---- Areas (POST /api/area): explanation before saving ----
  function openAreas() {
    const d = data();
    const areas = d.plan.areas.filter((o) => o.in_register && o.oid !== 'without-area');
    const newId = el('input', {
      id: 'area-new-id',
      type: 'text',
      maxlength: 40,
      placeholder: 'e.g. export',
      autocomplete: 'off',
    });
    const newTitle = el('input', {
      id: 'area-new-title',
      type: 'text',
      maxlength: 200,
      placeholder: 'e.g. Export',
      autocomplete: 'off',
    });
    const content = [
      el('h2', { id: 'plan-dialog-title', text: 'Areas' }),
      el('p', {
        class: 'bulk-explanation',
        text:
          'An area groups projects that belong together, so you prioritize a few areas instead ' +
          'of many projects. A project belongs to one area. Every change is shown before it is saved.',
      }),
      el('h3', { class: 'setting-title', text: 'The areas' }),
      areas.length
        ? el(
            'ul',
            { class: 'plan-area-list' },
            areas.map((o) => {
              const title = el('input', {
                type: 'text',
                maxlength: 200,
                value: o.title ?? '',
                'aria-label': `Title of the area ${o.oid}`,
              });
              return el(
                'li',
                { class: 'plan-area-row' },
                el('code', { text: o.oid }),
                title,
                el('button', {
                  type: 'button',
                  class: 'button button-outline button-small',
                  text: 'Save title',
                  title: 'Give the area a new title. You see the change before it is saved.',
                  onclick: () =>
                    areaAction({ action: 'save', oid: o.oid, title: title.value.trim() }),
                }),
                el('button', {
                  type: 'button',
                  class: 'button button-outline button-small',
                  text: 'Delete',
                  disabled: o.projects.length > 0,
                  title: o.projects.length
                    ? `Move the projects out first (${o.projects.join(', ')}).`
                    : 'Delete the area. Refused while the focus uses it.',
                  onclick: () => areaAction({ action: 'delete', oid: o.oid }),
                }),
              );
            }),
          )
        : el('p', { class: 'empty', text: 'No areas yet. Create the first one below.' }),
      el('h3', { class: 'setting-title', text: 'New area' }),
      el(
        'div',
        { class: 'plan-area-new' },
        el(
          'div',
          { class: 'field' },
          el('label', { for: 'area-new-id', text: 'Id (short, lowercase letters and hyphens)' }),
          newId,
        ),
        el(
          'div',
          { class: 'field' },
          el('label', { for: 'area-new-title', text: 'Title' }),
          newTitle,
        ),
        el('button', {
          type: 'button',
          class: 'button button-muted button-small',
          text: 'Create area',
          title: 'Creates the area. You see the change before it is saved.',
          onclick: () =>
            areaAction({
              action: 'save',
              oid: newId.value.trim(),
              title: newTitle.value.trim(),
            }),
        }),
      ),
      el('h3', { class: 'setting-title', text: 'Projects' }),
      el(
        'ul',
        { class: 'plan-area-list' },
        d.plan.projects
          .filter((pr) => pr.movable)
          .map((pr) =>
            el(
              'li',
              { class: 'plan-area-row' },
              el('span', { class: 'plan-name', text: pr.title ?? pr.pid }),
              el('code', { text: pr.pid }),
              el(
                'select',
                {
                  'aria-label': `Area for ${pr.pid}`,
                  title: 'Move the project to another area. You see the change before it is saved.',
                  onchange: (e) =>
                    areaAction({ action: 'move', pid: pr.pid, oid: e.target.value || null }),
                },
                el('option', {
                  value: '',
                  text: 'No area',
                  selected: !areas.some((o) => o.oid === pr.area),
                }),
                areas.map((o) =>
                  el('option', {
                    value: o.oid,
                    text: o.title ?? o.oid,
                    selected: o.oid === pr.area,
                  }),
                ),
              ),
            ),
          ),
      ),
      buttons([['Close', closeDialog, 'button-outline']]),
    ];
    showDialog(content);
  }

  async function areaAction(b) {
    let answer;
    try {
      answer = await s.ctx.api('/api/area', { ...b, dry: true });
    } catch (e) {
      return s.ctx.message(e.message, true);
    }
    if (!answer.can) {
      s.ctx.message(answer.error.join('\n'), true);
      return openAreas();
    }
    showDialog(
      [
        el('h2', { id: 'plan-dialog-title', text: 'Edit area' }),
        el(
          'ul',
          { class: 'plan-lines' },
          answer.lines.map((x) => el('li', { text: x })),
        ),
        buttons([
          ['Cancel', openAreas, 'button-outline'],
          [
            'Save',
            async () => {
              try {
                const r = await s.ctx.api('/api/area', { ...b, expect: answer.changed });
                s.ctx.message(r.message || 'Saved');
                await s.ctx.update(true);
              } catch (e) {
                s.ctx.message(e.message, true);
                if (e.answer?.outdated) await s.ctx.update(true);
              }
              openAreas();
            },
            'button-filled',
          ],
        ]),
      ],
      '.button-filled',
    );
  }

  window.QueuePlan = {
    draw,
    /** Should the board hold off redrawing (something is dragged or lifted, or a dialog is open)? */
    busy: () => !!s.drag || !!s.boosted || !!s.menu || open(),
    /** Does the plan have an unsaved draft (the focus line says so)? */
    hasDraft: hasChanges,
    openAreas: (ctx) => {
      s.ctx = ctx;
      openAreas();
    },
    /**
     * B21: one focus change from a card, the Selection or the detail panel ({ action: 'add'|'remove', steps, at? }):
     * the dry preview first, saved only on confirm (POST /api/focus { change }).
     */
    changeFocus: (ctx, change) => {
      s.ctx = ctx;
      previewList(changeJob(change));
    },
    /**
     * QA-1b: "Add to focus at …" from a card, the Selection or the detail panel. Opens the picker with these task steps
     * already chosen; only the position is picked, then the same dry preview as changeFocus.
     */
    pickFocus: (ctx, steps) => {
      s.ctx = ctx;
      openPicker({ fixed: [...steps] });
    },
  };
})();

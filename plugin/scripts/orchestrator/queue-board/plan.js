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
  };

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
      rest: f?.rest === 'fill' ? 'fill' : 'wait',
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
    const refocus = s.refocus ? document.getElementById(s.refocus) : null;
    s.refocus = null;
    if (refocus && !s.boosted) {
      refocus.focus({ preventScroll: true });
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
            '"Fill free slots" starts them only when the focus has nothing ready.',
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
        class: 'plan-list',
        'data-col': k.key,
        'aria-label': `${k.name}: ${elements.length} ${elements.length === 1 ? 'element' : 'elements'}`,
        ondragover: (e) => dragOver(e),
        ondragleave: (e) => {
          if (!e.currentTarget.contains(e.relatedTarget))
            e.currentTarget.classList.remove('release-her');
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
    const content = !saved
      ? el('p', {
          class: 'plan-remark',
          text: 'Not saved yet: the tasks of this step show here after "Save focus".',
        })
      : !tasks.length
        ? el('p', { class: 'plan-remark', text: 'No open tasks left in this step.' })
        : el(
            'ul',
            { class: 'plan-tasks-list' },
            tasks.map((x) => {
              const [word, tone, why] = TASK_STATE[x.state] ?? [x.state, '', ''];
              return el(
                'li',
                null,
                el('code', { class: 'plan-tasks-id', text: x.id }),
                ' ',
                el('span', { class: 'plan-tasks-title', text: x.title ?? '' }),
                ' ',
                el('span', { class: `badge${tone ? ` ${tone}` : ''}`, text: word, title: why }),
              );
            }),
          );
    const region = el(
      'div',
      { id: regionId, class: 'plan-tasks', role: 'region', 'aria-labelledby': buttonId },
      content,
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
    s.drag = null;
    if (s.ctx.pending()) s.ctx.drawOnNew();
  }
  function dragOver(e) {
    if (!s.drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('release-her');
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
          `${info(key).title} is lifted. The arrow keys move it (up and down in In focus, left and right between the sections), Space drops, Esc cancels.`,
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
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && col === 'focus') {
      e.preventDefault();
      e.stopPropagation();
      const list = draft().steps;
      const i = list.indexOf(key);
      const j = i + (e.key === 'ArrowUp' ? -1 : 1);
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
    box.replaceChildren(...content);
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
  /** The steps of one kind that are not in the draft's In focus yet: [key, label]. */
  function pickOptions(kind, p) {
    const d = data();
    let all = [];
    if (kind === 'task') all = openCards().map((k) => [`task:${k.id}`, `${k.id} ${k.title}`]);
    else if (kind === 'feature')
      all = (d.plan?.projects ?? []).flatMap((pr) =>
        (pr.features ?? []).map((x) => [`feature:${pr.pid}/${x.name}`, `${pr.pid} › ${x.name}`]),
      );
    else if (kind === 'project')
      all = (d.plan?.projects ?? []).map((pr) => [`project:${pr.pid}`, `${pr.title ?? pr.pid} (${pr.pid})`]);
    else
      all = (d.plan?.areas ?? [])
        .filter((o) => o.in_register && o.oid !== 'without-area')
        .map((o) => [`area:${o.oid}`, o.title ?? o.oid]);
    return all.filter(([key]) => !p.steps.includes(key));
  }
  function openPicker() {
    const p = current();
    const n = p.steps.length;
    const field = (id, label, control) =>
      el('div', { class: 'field' }, el('label', { for: id, text: label }), control);
    const kind = el(
      'select',
      { id: 'plan-pick-kind', 'aria-label': 'Kind' },
      PICK_KINDS.map(([v, text]) => el('option', { value: v, text })),
    );
    const what = el('select', { id: 'plan-pick-what', 'aria-label': 'What' });
    const none = el('p', { class: 'sp-meta', hidden: true, text: 'Everything of this kind is in focus already.' });
    const where = el(
      'select',
      { id: 'plan-pick-where', 'aria-label': 'Position' },
      Array.from({ length: n + 1 }, (_, i) =>
        el('option', {
          value: String(i + 1),
          text: `Step ${i + 1}${i === 0 ? ' (first)' : ''}${i === n ? ' (last)' : ''}`,
          selected: i === n,
        }),
      ),
    );
    const add = el('button', { type: 'button', class: 'button button-filled', text: 'Add' });
    const fill = () => {
      const list = pickOptions(kind.value, p);
      what.replaceChildren(...list.map(([v, text]) => el('option', { value: v, text })));
      none.hidden = list.length > 0;
      what.disabled = !list.length;
      add.disabled = !list.length;
    };
    kind.addEventListener('change', fill);
    fill();
    add.addEventListener('click', () => {
      const key = what.value;
      if (!key) return;
      const error = move(key, 'focus', Number(where.value) - 1);
      if (error) return s.ctx.message(error, true);
      if (typeFor(key) === 'task') s.taskKeys.add(key);
      s.ctx.status(`${info(key).title} is in the draft at step ${where.value}. Save focus shows what changes.`);
      closeDialog();
    });
    showDialog(
      [
        el('h2', { id: 'plan-dialog-title', text: 'Add to focus' }),
        el('p', {
          class: 'bulk-explanation',
          text:
            'Choose what goes into the focus and at which step. It goes into the draft: nothing changes in the queue ' +
            'until Save focus, which shows what changes first.',
        }),
        field('plan-pick-kind', 'Kind', kind),
        field('plan-pick-what', 'What', what),
        none,
        field('plan-pick-where', 'Position', where),
        el(
          'div',
          { class: 'guard-buttons' },
          el('button', { type: 'button', class: 'button button-outline', text: 'Cancel', onclick: closeDialog }),
          add,
        ),
      ],
      '#plan-pick-kind',
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
    busy: () => !!s.drag || !!s.boosted || open(),
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
  };
})();

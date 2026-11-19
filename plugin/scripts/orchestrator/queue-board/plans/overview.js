// =============================================================
// overview.js: the overview page in the Plans room (see docs/board.md).
// Vanilla JS, no build step, no CDN. All text is set with textContent (via h.el), never innerHTML.
//
// One screen that answers "where are we":
//   - "Working now" at the top: entries a /plans session is working on (active_session, pulse marker, gone after 2 hours),
//   - one shared legend, then eight module cards (count, a priority bar and a maturity bar with labelled segments, how
//     much is built, and up to three warning counts: owner questions, legal and stale, each only when it is over 0); a
//     click opens the list filtered on the module, and a Details disclosure under each card holds the full breakdown,
//   - "Waiting on you": the five owner questions and legal points that block the most, with an answer button,
//   - the capacity in Now, with a notice when Now grows faster than the queue drains,
//   - recently changed and recently registered.
// The rules (moduleSummary, waitingOnYou, workingNow, capacity and recent) are the pure functions in queuePlanView.js;
// here is only the drawing. The deadline band above the page is drawn by map.js (plans.js inserts it). The page writes nothing.
// =============================================================
'use strict';

(function () {
  const V = window.QueuePlanView;
  /** The Drop symbol (as PRIORITY.drop in queuePlanView.js), for the dropped count in a card's details. */
  const PRIORITY_DROP = '✕';

  /**
   * A bar split into labelled segments (B32, PL1). Each segment shows its symbol and count as text and the word in its
   * tooltip, so its meaning never rests on color alone; the shared legend above the cards says the words once. A
   * segment grows with its count but is never narrower than its own text. A group at 0 draws no segment.
   */
  function bar(h, parts, cls) {
    return h.el(
      'span',
      { class: 'overview-bar', 'aria-hidden': 'true' },
      ...parts
        .filter((x) => x.count > 0)
        .map((x) =>
          h.el(
            'span',
            {
              class: `overview-del ${cls}-${x.id}`,
              title: `${x.text}: ${x.count}`,
              '--grow': String(x.count),
            },
            h.el('span', { class: 'overview-del-symbol', text: x.symbol }),
            ` ${x.count}`,
          ),
        ),
    );
  }

  /** One row on the card face: a short label and its bar. */
  function barRow(h, label, parts, cls) {
    return h.el(
      'span',
      { class: 'overview-bar-row' },
      h.el('span', { class: 'overview-label', text: label }),
      bar(h, parts, cls),
    );
  }

  /** A legend sample: the same segment look as on the cards, with the symbol in it. */
  function swatch(h, x, cls) {
    return h.el(
      'li',
      { class: 'overview-legend-item' },
      h.el('span', {
        class: `overview-legend-swatch overview-del ${cls}-${x.id}`,
        'aria-hidden': 'true',
        text: x.symbol,
      }),
      h.el('span', { text: x.text }),
    );
  }

  /** The one shared legend above the area cards (B32): what each segment's symbol and color mean. */
  function legendEl(h) {
    const L = V.AREA_LEGEND;
    const group = (title, parts, cls) =>
      h.el(
        'span',
        { class: 'overview-legend-group' },
        h.el('span', { class: 'overview-legend-title', text: title }),
        h.el('ul', { class: 'overview-legend-list', 'aria-label': title }, ...parts.map((x) => swatch(h, x, cls))),
      );
    return h.el(
      'div',
      { class: 'overview-legend' },
      group('Priority', L.priority, 'pri'),
      group('Maturity', L.maturity, 'mod'),
    );
  }

  /**
   * The full breakdown of one card, behind a "Details" disclosure after the card button (its own tab stop, never
   * inside the button): every group with its word and count, also those at 0.
   */
  function detailsEl(h, k) {
    const line = (title, parts) =>
      h.el(
        'div',
        { class: 'overview-details-line' },
        h.el('dt', { text: title }),
        h.el(
          'dd',
          null,
          h.el(
            'ul',
            { class: 'overview-details-groups' },
            ...parts.map((x) =>
              h.el(
                'li',
                null,
                h.el('span', { class: 'overview-details-symbol', 'aria-hidden': 'true', text: x.symbol }),
                ` ${x.text} ${x.count}`,
              ),
            ),
          ),
        ),
      );
    return h.el(
      'details',
      { class: 'overview-card-details' },
      h.el(
        'summary',
        { 'data-focus': `moduleDetails:${k.oid}` },
        'Details',
        h.el('span', { class: 'hidden-for-eye', text: ` for ${k.title}` }),
      ),
      h.el(
        'dl',
        { class: 'overview-details-list' },
        line('Priority', k.priority),
        line('Maturity', k.maturity),
        k.dropped ? line('Dropped', [{ symbol: PRIORITY_DROP, text: 'Drop', count: k.dropped }]) : null,
      ),
    );
  }
  function moduleCard(h, k) {
    const pst = Math.round(k.share * 100);
    // A warning count is shown only when there is something to act on: "0 owner questions" is not a warning.
    const notice = (draw, n, one, more, cls) =>
      n
        ? h.el(
            'span',
            { class: `overview-warning has ${cls}` },
            h.el('span', { 'aria-hidden': 'true', text: draw }),
            ` ${n} ${n === 1 ? one : more}`,
          )
        : null;
    return h.el(
      'li',
      { class: 'overview-summary-space' },
      h.el(
        'button',
        {
          type: 'button',
          class: 'overview-summary',
          'data-focus': `moduleCard:${k.oid}`,
          'aria-label': V.areaCardLabel(k),
          onclick: () => {
            const f = V.emptyFilter();
            f.module = [k.oid];
            h.goToList({ filter: f, search: '', entry: null });
          },
        },
        h.el(
          'span',
          { class: 'overview-summary-header' },
          h.el('span', { class: 'overview-summary-title', text: k.title }),
          h.el('span', {
            class: 'overview-summary-count',
            text: `${k.count} ${k.count === 1 ? 'entry' : 'entries'}${k.dropped ? `, ${k.dropped} dropped` : ''}`,
          }),
        ),
        barRow(h, 'Priority', k.priority, 'pri'),
        barRow(h, 'Maturity', k.maturity, 'mod'),
        h.el('span', {
          class: 'overview-built',
          text: `Built ${k.built} of ${k.count} (${pst} %)`,
        }),
        h.el(
          'span',
          { class: 'overview-warnings' },
          notice('?', k.ownerQuestions, 'owner question', 'owner questions', 'v-owner'),
          notice('§', k.legal, 'legal point', 'legal points', 'v-legal'),
          notice('⟳', k.stale, 'stale', 'stale', 'v-stale'),
          k.active
            ? h.el(
                'span',
                { class: 'overview-warning has v-active' },
                h.el('span', { class: 'pulse', 'aria-hidden': 'true', text: '◉' }),
                ` ${k.active} being worked on`,
              )
            : null,
        ),
      ),
      detailsEl(h, k),
    );
  }

  function workingNowEl(h, d) {
    const list = V.workingNow(d);
    if (!list.length) return null;
    return h.el(
      'section',
      { class: 'overview-box overview-working', 'aria-label': 'Working now' },
      h.el('h2', { class: 'overview-title', text: 'Working now' }),
      h.el(
        'ul',
        { class: 'overview-list' },
        ...list.map((x) =>
          h.el(
            'li',
            { class: 'overview-row' },
            h.el('span', { class: 'pulse', 'aria-hidden': 'true', text: '◉' }),
            h.el('span', { class: 'overview-mark', text: 'Being worked on in Claude Code' }),
            h.el('button', {
              type: 'button',
              class: 'link-button',
              text: `${x.id} ${x.title}`,
              'data-focus': `working:${x.id}`,
              onclick: () => h.goToEntry(x.id),
            }),
            // "updated 9 min ago" in words (B31, PL4); the exact time stays in the tooltip.
            h.el('span', {
              class: 'overview-time',
              title: h.date(x.at),
              text: `${x.by ? `${x.by}, ` : ''}updated ${updatedAgo(x.at) ?? h.date(x.at)}`,
            }),
          ),
        ),
      ),
    );
  }

  /** How long ago a pulse came, in the shared words (lib/queueDecisions.js agoText): "just now", "9 min ago". */
  function updatedAgo(iso) {
    const ms = Date.now() - Date.parse(iso);
    const D = window.QueueDecisions;
    if (!Number.isFinite(ms) || !D) return null;
    return D.agoText(ms / 60_000);
  }

  /**
   * One owner question in "Waiting on you": the compact row from the shared renderer (board/question.js), so the type
   * name, the question and the button verb are the ones Decisions and Plans > Decisions use. The line leads with what
   * the answer unlocks in the queue, then the plan entries it blocks and the deadline.
   */
  function ownerRow(h, d, x) {
    const Q = window.QueueQuestion;
    const row = (d.decisions?.openOnes ?? []).find((b) => String(b.id) === x.id);
    const item = row ? Q?.fromPlan(row) : null;
    if (!item) return null;
    return h.el(
      'li',
      { class: 'overview-row overview-waiting overview-question' },
      Q.compact(item, {
        meta: [
          x.blocks ? `blocks ${x.blocks} plan ${x.blocks === 1 ? 'entry' : 'entries'}` : null,
          x.deadline ? `deadline ${x.deadline}${x.urgent ? ' (urgent)' : ''}` : null,
        ],
        onOpen: () => h.use({ surface: 'decision', sp: x.id }, { scroll: true }),
      }),
    );
  }

  function waitingEl(h, d) {
    const v = V.waitingOnYou(d);
    return h.el(
      'section',
      { class: 'overview-box', 'aria-label': 'Waiting on you' },
      h.el(
        'h2',
        { class: 'overview-title' },
        'Waiting on you',
        v.total > v.points.length
          ? h.el('span', {
              class: 'overview-under',
              text: ` (the ${v.points.length} that block the most of ${v.total})`,
            })
          : null,
      ),
      v.points.length
        ? h.el(
            'ol',
            { class: 'overview-list' },
            ...v.points.map((x) =>
              (x.type === 'owner' && ownerRow(h, d, x)) || h.el(
                'li',
                { class: 'overview-row overview-waiting' },
                h.el('span', {
                  class: `badge overview-type t-${x.type}`,
                  text: x.type === 'owner' ? V.DEC_TYPE.question : '§ Legal',
                }),
                h.el('span', { class: 'overview-id', text: x.id }),
                h.el('span', {
                  class: 'overview-text',
                  text: x.text.length > 160 ? `${x.text.slice(0, 157)} …` : x.text,
                  title: x.text,
                }),
                h.el('span', {
                  class: 'overview-time',
                  text:
                    `blocks ${x.blocks} ${x.blocks === 1 ? 'entry' : 'entries'}` +
                    `${x.tasks ? `, ${x.tasks} queue tasks waiting` : ''}` +
                    `${x.deadline ? `, deadline ${x.deadline}` : ''}${x.urgent ? ' (urgent)' : ''}`,
                }),
                h.el('button', {
                  type: 'button',
                  class: 'button-small button-muted',
                  text: 'Answer',
                  'aria-label': `Answer ${x.id}`,
                  'data-focus': `answer:${x.type}:${x.id}`,
                  onclick: () =>
                    x.type === 'owner'
                      ? h.use({ surface: 'decision', sp: x.id }, { scroll: true })
                      : h.use({ surface: 'jur', jur: x.id }, { scroll: true }),
                }),
              ),
            ),
          )
        : h.el('p', { class: 'empty', text: 'Nothing is waiting on you.' }),
    );
  }

  function capacityEl(h, d) {
    const k = d.capacity;
    if (!k) return null;
    return h.el(
      'section',
      { class: 'overview-box', 'aria-label': 'Capacity in Now' },
      h.el('h2', { class: 'overview-title', text: 'Capacity in Now' }),
      h.el('p', { class: 'overview-capacity', text: k.text }),
      k.notice
        ? h.el(
            'p',
            { class: 'overview-capacity-warning' },
            h.el('span', { 'aria-hidden': 'true', text: '⚠ ' }),
            h.el('span', { class: 'hidden-for-eye', text: 'Warning: ' }),
            k.warning_text,
          )
        : null,
      (k.without_size ?? []).length
        ? h.el('p', {
            class: 'overview-under',
            text: `Without size: ${k.without_size.slice(0, 12).join(', ')}${k.without_size.length > 12 ? ' …' : ''}`,
          })
        : null,
    );
  }

  function entryButton(h, id) {
    return h.el('button', {
      type: 'button',
      class: 'link-button',
      text: id,
      onclick: () => h.goToEntry(id),
    });
  }

  function recentEl(h, d) {
    const n = d.recent ?? { changed: [], registered: [] };
    return h.el(
      'section',
      { class: 'overview-box', 'aria-label': 'Recent' },
      h.el('h2', { class: 'overview-title', text: 'Recent changed' }),
      n.changed.length
        ? h.el(
            'ul',
            { class: 'overview-list' },
            ...n.changed.map((x) =>
              h.el(
                'li',
                { class: `overview-row${x.undone ? ' undone' : ''}` },
                h.el('span', { class: 'badge', text: `nr. ${x.nr}` }),
                h.el('span', {
                  class: 'overview-time',
                  text: `${h.date(x.at)} · ${x.action ?? ''} · ${x.by ?? ''}${x.undone ? ' · undone' : ''}`,
                }),
                ...x.ids.filter((id) => /^PL-/.test(id)).map((id) => entryButton(h, id)),
              ),
            ),
          )
        : h.el('p', { class: 'empty', text: 'No changes in the changelog.' }),
      h.el('h2', { class: 'overview-title', text: 'Recent registered' }),
      n.registered.length
        ? h.el(
            'ul',
            { class: 'overview-list' },
            ...n.registered.map((x) =>
              h.el(
                'li',
                { class: 'overview-row' },
                entryButton(h, x.id),
                h.el('span', { class: 'overview-text', text: x.title }),
                h.el('span', { class: 'overview-time', text: h.date(x.at) }),
              ),
            ),
          )
        : h.el('p', { class: 'empty', text: 'No entries with a registration time.' }),
    );
  }

  window.QueuePlanOverview = {
    /** The whole overview page. `h` is the helpers from plans.js (workHelp). */
    side(h, d) {
      if (!d.exists)
        return h.el('p', {
          class: 'empty plans-fetching',
          text: 'The plan register does not exist yet (scripts/.queue/plans.json).',
        });
      return h.el(
        'div',
        { class: 'plans-overview', 'data-scroll': 'overview' },
        workingNowEl(h, d),
        h.el(
          'section',
          { class: 'overview-modules', 'aria-label': 'Areas' },
          h.el('h2', { class: 'hidden-for-eye', text: 'Areas' }),
          legendEl(h),
          h.el(
            'ul',
            { class: 'overview-shortlist' },
            ...V.moduleSummary(d).map((k) => moduleCard(h, k)),
          ),
        ),
        h.el(
          'div',
          { class: 'overview-bottom' },
          waitingEl(h, d),
          h.el('div', { class: 'overview-column' }, capacityEl(h, d), recentEl(h, d)),
        ),
      );
    },
  };
})();

// =============================================================
// plans/filter.js: the Filter and Sort menus in the Plans room (P4 of plans/plans-tab-ux-review-2026-11-19.md).
//
// The same pattern as the Tasks room's Filter menu (QA-1d, board/menus.js and board/views.js), with the same CSS
// classes, so the two rooms look and work alike:
//   - one Filter button that says what is in use ("Filter", "Filter · 2", "Filter · Inbox"), fixed width,
//   - the menu: Show all (when something narrows), Quick filters (a name and a short line each), Saved (the viewer's
//     own views, with Delete and "Save current as…"), then one section per facet with counts, and Reset,
//   - a Sort button ("Sort: Roadmap order") with a menu of choices, each with a short line,
//   - below 600 px the two become one "Filter and sort" button with a tray: Sort, the view controls the caller passes
//     (Group by and Compact on the Roadmap), then the filter.
// It replaces the old left filter column. The facet logic stays in lib/queuePlanView.js (facetNumber, QUICK_FILTERS,
// PLAN_SORTS, filterButtonText), so the menu and the url read the same rules.
//
// plans.js redraws the whole room on every change, so the open menu lives in its state (h.menu()) and is drawn open
// again; every control has a data-focus key, and plans.js puts the focus back on it after the redraw.
// All text is set with textContent.
//
// The helpers (h) come from plans.js: el, state, data, width, menu/setMenu, ownViews/saveView/deleteView,
// saveAsOpen/setSaveAsOpen, saveName/setSaveName, newFilter, applyView, showAll, sort/setSort.
// =============================================================
(function () {
  'use strict';
  const V = window.QueuePlanView;
  /** Below this width the Filter and Sort buttons become one "Filter and sort" button with a tray (plan section 7.7). */
  const TRAY_BELOW = 600;

  /** The rows the arrow keys move between, in menu order. */
  const rowsIn = (menu) => [...menu.querySelectorAll('.view-option, input[type="checkbox"]')];

  /**
   * The keys in an open menu: Escape closes it (or only the name field) with focus back on its button, the arrow keys
   * move between the rows. stopPropagation keeps the room's own keys (work.js) out of it.
   */
  function menuKeys(h, button) {
    return (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (e.target?.dataset?.focus === 'pf-save-name') h.setSaveAsOpen(false);
        else h.setMenu(null, button);
        return;
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target?.dataset?.focus !== 'pf-save-name') {
        const rows = rowsIn(e.currentTarget);
        const i = rows.indexOf(document.activeElement);
        const j = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        e.preventDefault();
        e.stopPropagation();
        rows[j]?.focus();
      }
    };
  }

  /** One quick, saved or sort row in the B23 menu style: the name, and under it a short line that describes it. */
  function optionRow(h, { key, name, explain, current, pressed, title, onclick, extra }) {
    const explainId = `${key.replace(/[^a-z0-9-]/gi, '-')}-explain`;
    return h.el(
      'li',
      { class: 'filter-row view-row' },
      h.el(
        'button',
        {
          type: 'button',
          class: 'view-option',
          'data-focus': key,
          'aria-label': name,
          'aria-describedby': explainId,
          'aria-current': current ? 'true' : null,
          'aria-pressed': pressed == null ? null : pressed ? 'true' : 'false',
          title: title ?? null,
          onclick,
        },
        h.el('span', { class: 'view-name', text: name }),
        h.el('span', { class: 'view-explain', id: explainId, text: explain }),
      ),
      extra ?? null,
    );
  }

  /** The Quick filters and Saved sections (the Tasks room's presetSections). */
  function presets(h, button) {
    const t = h.state();
    const own = h.ownViews();
    const inUse = V.filterButtonText(t, own).name;
    const quick = h.el(
      'section',
      { class: 'filter-section', 'aria-labelledby': 'pf-quick' },
      h.el('div', { class: 'filter-section-header' }, h.el('h3', { id: 'pf-quick', text: 'Quick filters' })),
      h.el(
        'ul',
        { class: 'filter-list' },
        V.QUICK_FILTERS.map((v) =>
          optionRow(h, {
            key: `pf-quick:${v.id}`,
            name: v.name,
            explain: v.explain,
            current: inUse === v.name,
            onclick: () => h.applyView(v),
          }),
        ),
      ),
    );
    const saveRow = h.saveAsOpen()
      ? h.el(
          'div',
          { class: 'filter-footer view-save' },
          h.el('input', {
            type: 'text',
            maxlength: '60',
            'data-focus': 'pf-save-name',
            placeholder: 'Name of the saved filter',
            'aria-label': 'Name of the saved filter',
            value: h.saveName?.() ?? '',
            oninput: (e) => h.setSaveName?.(e.target.value),
            onkeydown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                h.saveView(e.target.value);
              }
            },
          }),
          h.el('button', {
            type: 'button',
            class: 'button button-outline button-small',
            'data-focus': 'pf-save',
            text: 'Save',
            title: 'Saves the filter, the search and the sort you see now under the name, in this browser.',
            onclick: (e) => h.saveView(e.currentTarget.parentElement.querySelector('input')?.value ?? ''),
          }),
        )
      : h.el(
          'div',
          { class: 'filter-footer view-save' },
          h.el('button', {
            type: 'button',
            class: 'link-button',
            'data-focus': 'pf-save-as',
            text: 'Save current as…',
            title: 'Save the filter, the search and the sort you see now under a name, in this browser.',
            onclick: () => h.setSaveAsOpen(true),
          }),
        );
    const saved = h.el(
      'section',
      { class: 'filter-section', 'aria-labelledby': 'pf-saved' },
      h.el('div', { class: 'filter-section-header' }, h.el('h3', { id: 'pf-saved', text: 'Saved' })),
      own.length
        ? h.el(
            'ul',
            { class: 'filter-list' },
            own.map((v, i) =>
              optionRow(h, {
                key: `pf-own:${i}`,
                name: v.name,
                explain: v.sort && v.sort !== 'roadmap' ? 'Your filter, search and sort.' : 'Your filter and search.',
                current: inUse === v.name,
                title: 'Your saved filter, in this browser.',
                onclick: () => h.applyView(v),
                extra: h.el('button', {
                  type: 'button',
                  class: 'pause-button',
                  'data-focus': `pf-delete:${i}`,
                  text: 'Delete',
                  title: `Delete the saved filter "${v.name}" from this browser. The plans do not change.`,
                  onclick: () => h.deleteView(v.name),
                }),
              }),
            ),
          )
        : h.el('p', { class: 'empty', text: 'No saved filters yet.' }),
      saveRow,
    );
    return [quick, saved];
  }

  /** The facet sections with counts, then Reset (the Tasks room's filter sections). */
  function sections(h, d) {
    const t = h.state();
    const facets = V.facetNumber(d.entries ?? [], t.filter, t.search, d).filter((f) => f.option.length);
    const parts = facets.map((f) =>
      h.el(
        'section',
        { class: 'filter-section', 'aria-labelledby': `pf-h-${f.id}` },
        h.el('div', { class: 'filter-section-header' }, h.el('h3', { id: `pf-h-${f.id}`, text: f.title })),
        h.el(
          'ul',
          { class: 'filter-list' },
          f.option.map((v) => {
            const id = `pf-${f.id}-${String(v.val).replace(/[^a-z0-9-]/gi, '_')}`;
            return h.el(
              'li',
              { class: 'filter-row' },
              h.el('input', {
                type: 'checkbox',
                id,
                'data-focus': id,
                checked: v.selected,
                onchange: (e) => {
                  const fresh = { ...t.filter };
                  const list = new Set(fresh[f.id] ?? []);
                  if (e.target.checked) list.add(v.val);
                  else list.delete(v.val);
                  fresh[f.id] = [...list];
                  h.newFilter(fresh);
                },
              }),
              h.el(
                'label',
                { for: id },
                // the priority symbol sits beside its word, never alone (B32)
                f.id === 'pri'
                  ? h.el('span', {
                      class: `plans-pri pri-${v.val}`,
                      'aria-hidden': 'true',
                      text: V.PRIORITY[v.val]?.symbol ?? '',
                    })
                  : null,
                h.el('span', { class: 'filter-name', text: v.text }),
                h.el('span', { class: 'filter-count', text: String(v.count), title: `${v.count} plans match` }),
              ),
            );
          }),
        ),
      ),
    );
    parts.push(
      h.el(
        'div',
        { class: 'filter-footer' },
        h.el('button', {
          type: 'button',
          class: 'button button-outline',
          'data-focus': 'pf-reset',
          text: 'Reset',
          title: 'Uncheck every filter section. The search stays.',
          disabled: V.countFilters(t.filter) === 0,
          onclick: () => h.newFilter(V.emptyFilter()),
        }),
      ),
    );
    return parts;
  }

  /** The first row when something narrows: Show all (clears the filter and the search). */
  function topRow(h) {
    const t = h.state();
    if (!V.countFilters(t.filter) && !t.search) return null;
    return h.el(
      'div',
      { class: 'filter-footer filter-top' },
      h.el('button', {
        type: 'button',
        class: 'button button-outline button-small',
        'data-focus': 'pf-show-all',
        text: 'Show all',
        title: 'Remove the filter and the search, and show every plan again',
        onclick: () => h.showAll(),
      }),
    );
  }

  /** The filter menu's content: Show all, Quick filters, Saved, the sections and Reset. */
  function filterContent(h, d, button) {
    return [topRow(h), ...presets(h, button), ...sections(h, d)].filter(Boolean);
  }

  /** The sort choices as a section (in the Sort menu and the tray). */
  function sortSection(h, button) {
    const now = V.cleanSort(h.sort());
    return h.el(
      'section',
      { class: 'filter-section', 'aria-labelledby': 'pf-sort-h' },
      h.el('div', { class: 'filter-section-header' }, h.el('h3', { id: 'pf-sort-h', text: 'Sort' })),
      h.el(
        'ul',
        { class: 'filter-list' },
        V.PLAN_SORTS.map((x) =>
          optionRow(h, {
            key: `pf-sort:${x.id}`,
            name: x.text,
            explain: x.explain,
            pressed: x.id === now,
            onclick: () => {
              h.setSort(x.id);
              h.setMenu(null, button);
            },
          }),
        ),
      ),
    );
  }

  /** A menu button and, when open, its menu, in one wrapper (the outside-click rule looks for .plans-menu-wrap). */
  function menuButton(h, { name, key, menuId, text, label, title, active, cls, buttonCls, first, content, menuLabel, menuCls }) {
    const open = h.menu() === name;
    return h.el(
      'div',
      { class: `filter plans-menu-wrap ${cls}` },
      h.el(
        'button',
        {
          type: 'button',
          class: `button button-outline filter-button ${cls}-button${buttonCls ? ` ${buttonCls}` : ''}${active ? ' active' : ''}`,
          'data-focus': key,
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': menuId,
          'aria-label': label ?? null,
          title: title ?? null,
          onclick: () => (open ? h.setMenu(null, key) : h.setMenu(name, first)),
        },
        h.el('span', { class: 'filter-label', text }),
      ),
      open
        ? h.el(
            'div',
            {
              id: menuId,
              class: `filter-menu plans-filter-menu${menuCls ? ` ${menuCls}` : ''}`,
              role: 'group',
              'aria-label': menuLabel,
              onkeydown: menuKeys(h, key),
            },
            content(),
          )
        : null,
    );
  }

  /**
   * The toolbar's Filter and Sort controls.
   * @param h helpers from plans.js
   * @param d the /api/plans payload
   * @param {{ sort?: boolean, trayExtra?: Node[] }} opts sort: offer Sort (not on the maps, where order does not
   *   apply); trayExtra: view controls that move into the tray on a narrow screen (the Roadmap's Group by and Compact)
   */
  function controls(h, d, { sort = true, trayExtra = [] } = {}) {
    const t = h.state();
    const b = V.filterButtonText(t, h.ownViews());
    const firstFilterRow = t.search || b.n ? 'pf-show-all' : `pf-quick:${V.QUICK_FILTERS[0].id}`;
    if (h.width() < TRAY_BELOW) {
      const extra = (trayExtra ?? []).filter(Boolean);
      return h.el(
        'div',
        { class: 'plans-filter-controls narrow' },
        menuButton(h, {
          name: 'tray',
          key: 'plans-tray',
          menuId: 'plans-tray-menu',
          text: sort ? `Filter and sort${b.n ? ` · ${b.n}` : ''}` : b.text,
          label: `${sort ? 'Filter and sort' : 'Filter'}${b.name ? `, ${b.name} in use` : ''}${b.n ? `, ${b.n} active` : ''}`,
          title: b.title,
          active: b.active,
          cls: 'plans-tray',
          first: sort ? `pf-sort:${V.cleanSort(h.sort())}` : firstFilterRow,
          menuLabel: sort ? 'Filter and sort' : 'Filter',
          menuCls: 'plans-tray-menu',
          content: () => [
            sort ? sortSection(h, 'plans-tray') : null,
            extra.length
              ? h.el(
                  'section',
                  { class: 'filter-section plans-tray-view', 'aria-labelledby': 'pf-view-h' },
                  h.el('div', { class: 'filter-section-header' }, h.el('h3', { id: 'pf-view-h', text: 'View' })),
                  h.el('div', { class: 'plans-tray-view-row' }, extra),
                )
              : null,
            ...filterContent(h, d, 'plans-tray'),
          ].filter(Boolean),
        }),
      );
    }
    const sortNow = V.PLAN_SORTS.find((x) => x.id === V.cleanSort(h.sort()));
    return h.el(
      'div',
      { class: 'plans-filter-controls' },
      menuButton(h, {
        name: 'filter',
        key: 'plans-filter',
        menuId: 'plans-filter-menu',
        text: b.text,
        label: b.label,
        title: b.title,
        active: b.active,
        cls: 'plans-filter',
        buttonCls: 'filter-fixed',
        first: firstFilterRow,
        menuLabel: 'Filter',
        content: () => filterContent(h, d, 'plans-filter'),
      }),
      sort
        ? menuButton(h, {
            name: 'sort',
            key: 'plans-sort',
            menuId: 'plans-sort-menu',
            text: `Sort: ${sortNow.text}`,
            title: `Sorted by ${sortNow.text.toLowerCase()}: ${sortNow.explain}`,
            active: sortNow.id !== 'roadmap',
            cls: 'plans-sort',
            first: `pf-sort:${sortNow.id}`,
            menuLabel: 'Sort',
            content: () => [sortSection(h, 'plans-sort')],
          })
        : null,
    );
  }

  /**
   * Once, from plans.js: a click outside an open menu closes it. composedPath is the path when the click happened,
   * so a control the menu just redrew still counts as inside.
   */
  function install(h) {
    document.addEventListener('click', (e) => {
      if (!h.menu()) return;
      const inside = e
        .composedPath()
        .some((n) => n && n.classList && typeof n.classList.contains === 'function' && n.classList.contains('plans-menu-wrap'));
      if (!inside) h.setMenu(null, null);
    });
  }

  window.QueuePlanFilter = { controls, install, TRAY_BELOW };
})();

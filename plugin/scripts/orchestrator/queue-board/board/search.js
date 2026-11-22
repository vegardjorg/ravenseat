// =============================================================
// search.js: the suggestions and the hint for the structured search in the search box (roadmap 0ø J6,
// board.structuredSearch). The rules (parse, match, suggest) are lib/boardSearch.js (window.QueueSearch); this file only
// draws. The search box becomes a combobox: the suggestions are a listbox under it, Arrow Down and Up move, Enter or Tab
// takes the marked one, Esc closes the list (a second Esc is the search box's own clear). A field the search does not
// know becomes a hint under the box (and in a live region for a screen reader); the board is never emptied by a typo.
// With board.structuredSearch off, nothing here shows and the box searches plain words as before.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md): after route.js (displayOn), before
// start.js (whose input listener sets the search on the board).
// =============================================================
'use strict';

/** The open suggestions: {from, to, items} from QueueSearch.suggest, and the marked one (-1 = none). */
let searchSuggest = { from: 0, to: 0, items: [] };
let searchActive = -1;

/** Is the structured search on and its rules loaded? */
function structuredOn() {
  return Boolean(window.QueueSearch) && displayOn('structuredSearch');
}

/** The values on the board now, for the value suggestions (class, project, label, plan). */
function searchKnown() {
  const sets = {
    class: new Set(),
    project: new Set(),
    label: new Set(),
    plan: new Set(),
  };
  for (const { k } of t.perId?.values?.() ?? []) {
    if (k.class) sets.class.add(k.class);
    if (k.project) sets.project.add(k.project);
    if (k.plan) sets.plan.add(k.plan);
    for (const l of Array.isArray(k.labels) ? k.labels : []) sets.label.add(l);
  }
  const order = window.QueueSearch?.CLASSES ?? [];
  return {
    class: order.filter((c) => sets.class.has(c)),
    project: [...sets.project].sort(),
    label: [...sets.label].sort(),
    plan: [...sets.plan].sort(),
  };
}

/** Closes the suggestions and the hint (the hint in the live region stays until the text changes). */
function closeSearchHelp() {
  const box = $('search');
  searchSuggest = { from: 0, to: 0, items: [] };
  searchActive = -1;
  $('search-help').hidden = true;
  $('search-suggest').replaceChildren();
  box.setAttribute('aria-expanded', 'false');
  box.removeAttribute('aria-activedescendant');
}

/** Sets the combobox roles on the search box when the structured search is on, and takes them away when it is off. */
function searchRoles() {
  const box = $('search');
  if (structuredOn()) {
    box.setAttribute('role', 'combobox');
    box.setAttribute('aria-autocomplete', 'list');
    box.setAttribute('aria-controls', 'search-suggest');
    box.setAttribute('aria-describedby', 'search-hint-live');
    if (!box.hasAttribute('aria-expanded')) box.setAttribute('aria-expanded', 'false');
  } else {
    for (const a of [
      'role',
      'aria-autocomplete',
      'aria-controls',
      'aria-describedby',
      'aria-expanded',
      'aria-activedescendant',
    ])
      box.removeAttribute(a);
  }
}

/** Draws the suggestions for the word at the caret, and the hint for the whole text. */
function drawSearchHelp() {
  searchRoles();
  const box = $('search');
  if (!structuredOn()) {
    closeSearchHelp();
    $('search-hint-live').textContent = '';
    return;
  }
  const S = window.QueueSearch;
  const text = box.value;
  const caret = box.selectionStart ?? text.length;
  let s = S.suggest(text, caret, searchKnown());
  // An empty box shows the fields, so they can be found without reading the docs.
  if (!text.trim() && document.activeElement === box) s = { from: 0, to: text.length, items: fieldItems(S) };
  const hints = S.parse(text).hints;
  const hint = hints[0] ?? '';
  $('search-hint').textContent = hint;
  $('search-hint').hidden = !hint;
  if ($('search-hint-live').textContent !== hint) $('search-hint-live').textContent = hint;
  searchSuggest = s;
  searchActive = -1;
  const list = $('search-suggest');
  list.replaceChildren(
    ...s.items.map((item, i) =>
      el('li', {
        id: `search-option-${i}`,
        class: 'search-option',
        role: 'option',
        'aria-selected': 'false',
        text: item.label,
      }),
    ),
  );
  list.hidden = !s.items.length;
  const open = s.items.length > 0 || Boolean(hint);
  $('search-help').hidden = !open;
  box.setAttribute('aria-expanded', s.items.length ? 'true' : 'false');
  box.removeAttribute('aria-activedescendant');
}

/** Every field as a suggestion (for the empty box). */
function fieldItems(S) {
  return S.FIELDS.flatMap((f) =>
    S.suggest(f, f.length, {})
      .items.filter((x) => x.insert.startsWith(f))
      .slice(0, 1),
  );
}

/** Marks suggestion i (wraps around). */
function markSuggestion(i) {
  const n = searchSuggest.items.length;
  if (!n) return;
  searchActive = (i + n) % n;
  const box = $('search');
  for (const li of $('search-suggest').children)
    li.setAttribute('aria-selected', li.id === `search-option-${searchActive}` ? 'true' : 'false');
  box.setAttribute('aria-activedescendant', `search-option-${searchActive}`);
  $(`search-option-${searchActive}`)?.scrollIntoView?.({ block: 'nearest' });
}

/** Puts suggestion i into the box, and lets the board search (the input event start.js listens to). */
function takeSuggestion(i) {
  const item = searchSuggest.items[i];
  if (!item) return;
  const box = $('search');
  const out = window.QueueSearch.applySuggestion(box.value, searchSuggest, item);
  box.value = out.text;
  box.focus();
  box.setSelectionRange?.(out.caret, out.caret);
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

$('search').addEventListener('input', drawSearchHelp);
$('search').addEventListener('focus', drawSearchHelp);
$('search').addEventListener('click', drawSearchHelp);
$('search').addEventListener('blur', () => {
  // Later than a click on a suggestion (which keeps the focus with mousedown below).
  setTimeout(() => {
    if (document.activeElement !== $('search')) closeSearchHelp();
  }, 0);
});
$('search').addEventListener('keydown', (e) => {
  if (!structuredOn()) return;
  const open = searchSuggest.items.length > 0 && !$('search-help').hidden;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open) {
      drawSearchHelp();
      if (!searchSuggest.items.length) return;
    }
    e.preventDefault();
    markSuggestion(searchActive + (e.key === 'ArrowDown' ? 1 : searchActive < 0 ? 0 : -1));
    return;
  }
  if ((e.key === 'Enter' || e.key === 'Tab') && open && searchActive >= 0) {
    e.preventDefault();
    takeSuggestion(searchActive);
    return;
  }
  if (e.key === 'Escape' && !$('search-help').hidden) {
    // The first Esc closes the list; the box keeps its text.
    e.preventDefault();
    e.stopPropagation();
    closeSearchHelp();
  }
});
$('search-suggest').addEventListener('mousedown', (e) => e.preventDefault());
$('search-suggest').addEventListener('click', (e) => {
  const li = e.target.closest?.('.search-option');
  if (li) takeSuggestion(Number(li.id.replace('search-option-', '')));
});

window.QueueSearchBox = { drawSearchHelp, closeSearchHelp, searchKnown };

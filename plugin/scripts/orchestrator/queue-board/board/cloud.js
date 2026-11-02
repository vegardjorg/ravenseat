// =============================================================
// cloud.js: the "Cloud" view: bundles with a ready command for cloud-start.mjs (claude --cloud, draws
// from the cloud credit).
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- The "Cloud" view: bundles with a ready command for cloud-start.mjs (claude --cloud, draws from the cloud credit) ----
let fetchingCloud = false;
async function getCloudQueue() {
  if (fetchingCloud || !t.key) return;
  fetchingCloud = true;
  try {
    const answer = await api('/api/cloud-bundles');
    t.cloudQueue = { data: answer.data, error: null };
  } catch (e) {
    t.cloudQueue = { data: t.cloudQueue.data, error: e.message };
  } finally {
    fetchingCloud = false;
    if (t.view === 'cloud') draw();
  }
}

async function copyText(text, ok) {
  try {
    await navigator.clipboard.writeText(text);
    message(ok);
  } catch {
    message('Could not copy automatically: select the command and copy it yourself.', true);
  }
}

/** The help text in the Cloud view. The base branch comes from queue.config.json (baseBranch). */
const cloudHelp = () =>
  'Copy a command and run it in a terminal in the project folder. It starts a cloud session with claude --cloud, ' +
  `which draws from the cloud credit. The cloud sees only what is pushed to ${t.data?.baseBranch ?? 'main'}. ` +
  'When the session reports CLOUD-DONE, press "Completed in cloud", and the orchestrator merges.';

function cloudRow(id, title, ...extra) {
  return el(
    'li',
    { class: 'cloud-row' },
    el('span', { class: 'cloud-id', text: id }),
    el('span', { class: 'cloud-name', text: title ?? '' }),
    ...extra,
  );
}

function drawCloudQueue() {
  const d = t.cloudQueue.data;
  const inCloud = [...(t.perId?.values() ?? [])].map((x) => x.k).filter((k) => k?.in_cloud);
  const chunk = (title, content) =>
    el(
      'section',
      { class: 'cloud-del' },
      el('h2', { class: 'cloud-title', text: title }),
      content,
    );

  const inProgress = inCloud.length
    ? el(
        'ul',
        { class: 'cloud-list' },
        ...inCloud.map((k) =>
          cloudRow(
            k.id,
            k.title,
            k.cloud_session?.execution ? cloudLink(k.cloud_session.execution) : null,
            el('button', {
              type: 'button',
              class: 'button button-muted',
              text: 'Completed in cloud',
              onclick: () =>
                action({ type: 'cloud-done', id: k.id }, `${k.id} is fetched from the cloud`),
            }),
          ),
        ),
      )
    : el('p', { class: 'empty', text: 'Nothing running in the cloud now.' });

  let bundles;
  if (!d)
    bundles = el('p', {
      class: 'empty',
      text: t.cloudQueue.error ? `Could not fetch the bundles: ${t.cloudQueue.error}` : 'Fetching the bundles …',
    });
  else if (!d.bundles.length)
    bundles = el('p', {
      class: 'empty',
      text: d.pushed
        ? 'No cloud-suitable tasks now.'
        : `Could not find the base branch (${t.data?.baseBranch ?? 'main'}) on the remote. Push it, so the cloud can see the code.`,
    });
  else
    bundles = el(
      'ol',
      { class: 'cloud-bundles' },
      ...d.bundles.map((b, i) =>
        el(
          'li',
          { class: 'cloud-bundle-summary' },
          el('p', {
            class: 'cloud-bundle-header',
            text:
              `Bundle ${i + 1} · ${b.ids.length} ${b.ids.length === 1 ? 'task' : 'tasks'} · ` +
              `${b.minutes} min · ${b.areas.join(' + ')}`,
          }),
          el('ul', { class: 'cloud-list' }, ...b.ids.map((id) => cloudRow(id, b.titles?.[id]))),
          el(
            'div',
            { class: 'cloud-command' },
            el('code', { text: b.command }),
            el('button', {
              type: 'button',
              class: 'button button-filled',
              text: 'Copy command',
              onclick: () =>
                copyText(b.command, 'The command is copied. Run it in the terminal.'),
            }),
          ),
        ),
      ),
    );

  const sessions = d ? ` · ${d.sessions} of at most ${d.max} sessions` : '';
  main.append(
    el(
      'div',
      { class: 'cloud-view' },
      // Opened from a saved view while the tab is hidden: say where the tab is turned on.
      boardSwitch('showCloud')
        ? null
        : el('p', {
            class: 'cloud-help',
            text: 'The Cloud tab is hidden. Turn it on in Settings, Board (or cq board-setting cloud on).',
          }),
      el('p', { class: 'cloud-help', text: cloudHelp() }),
      chunk(`In cloud now (${inCloud.length}${sessions})`, inProgress),
      chunk(`Ready bundles (${d?.bundles.length ?? 0})`, bundles),
    ),
  );
}

// The gear opens the settings in the side panel.
$('settings').append(icon('gear'));
$('settings').addEventListener('click', openSettings);

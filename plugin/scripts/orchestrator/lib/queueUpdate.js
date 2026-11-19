// =============================================================
// queueUpdate.js: the update banner on the board (see docs/board.md, "Update banner").
//
// Two independent notices, both computed on the server (queue-board.mjs) and drawn by board.js:
//   - NEW VERSION: at start (and at most once per 24 hours, cached in <dataFolder>/update-check.json) the server fetches
//     the published plugin.json from GitHub with a plain GET (no headers of its own, nothing about the user or the
//     project) and a short timeout. Any error (network, timeout, invalid JSON, no valid version) gives null and no
//     message. Off with updates.check: false in queue.config.json (the old name board.updateCheck: false still works),
//     or when DISABLE_UPDATES or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set.
//   - THE CLI LINE (cli/update.mjs, roadmap 0u3): `ravenseat show` and `ravenseat doctor` say the same in one line
//     (cliNotice). show only reads the cache and starts a detached refresh when it is old (startRefresh); at most once a
//     day per version (`shown`); quiet in --json, agents, CI and hooks (quietReason).
//   - SETUP NOT RUN (local, no network, also with the check off): `ravenseat setup --settings` records the plugin version it set
//     up in <dataFolder>/setup.json. A plugin install whose version differs from that record (or has none) shows that
//     setup must be run again (the status line holds the plugin's versioned path).
// Closing the banner hides the new-version part for that version until a newer one is out (localStorage in board.js,
// and `dismissed` in update-check.json through POST /api/update-dismiss, the same field `ravenseat update dismiss`
// writes; rules in `visible`). The setup part cannot be closed; it goes away when setup has been run.
//
// The file is both a CommonJS module (vitest, lib/__tests__/queueUpdate.test.ts, and queue-board.mjs) and a script in
// the browser (queue-board.mjs serves it as /queueUpdate.js and it sets window.QueueUpdate), like queueMascot.js.
// The functions that touch the disk or the network get fs and fetch passed in, so the tests never go on the net.
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueueUpdate = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** The published manifest (the main branch of the public repo). */
  const MANIFEST_URL =
    'https://raw.githubusercontent.com/vegardjorg/ravenseat/main/plugin/.claude-plugin/plugin.json';
  const CHANGELOG_URL = 'https://github.com/vegardjorg/ravenseat/blob/main/CHANGELOG.md';
  /** The marketplace name in the repo's .claude-plugin/marketplace.json (a test checks they match). */
  const MARKETPLACE = 'ravenseat';
  const PLUGIN = 'ravenseat';
  /** At most one check per day. */
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const TIMEOUT_MS = 3000;
  /** Any of these set (not empty, "0" or "false") turns the network check off. */
  // Not DISABLE_AUTOUPDATER: the Claude desktop app sets it in every session (it updates Claude Code itself), so it
  // says nothing about what the user wants, and the banner would never show there.
  const ENV_OFF = ['DISABLE_UPDATES', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
  /** The localStorage key in the browser for the version whose banner was closed. */
  const DISMISS_KEY = 'queue-board-update-dismissed';

  const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

  /** A version as { core: [major, minor, patch], pre: [...] }, or null when it is not semver. */
  function parse(v) {
    const m = SEMVER.exec(String(v ?? '').trim());
    if (!m) return null;
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
  }

  /**
   * Compares two semver versions: -1 when a is older, 0 when equal, 1 when a is newer, null when one is not valid.
   * A prerelease (1.0.0-beta) is older than the release (1.0.0); build metadata (+abc) is ignored.
   */
  function compare(a, b) {
    const x = parse(a);
    const y = parse(b);
    if (!x || !y) return null;
    for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
      const p = x.pre[i];
      const q = y.pre[i];
      if (p === undefined) return -1;
      if (q === undefined) return 1;
      const pn = /^\d+$/.test(p);
      const qn = /^\d+$/.test(q);
      if (pn && qn) {
        if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
      } else if (pn !== qn) return pn ? -1 : 1;
      else if (p !== q) return p < q ? -1 : 1;
    }
    return 0;
  }

  /** Whether an environment variable counts as set (not empty, "0" or "false"). */
  const isSet = (v) => v != null && !['', '0', 'false'].includes(String(v).trim().toLowerCase());

  /**
   * Why the network check is off, or null when it is on. config is the merged queue.config.json, env is process.env.
   * @returns {string|null}
   */
  function disabledReason(config, env = {}) {
    if (config?.updates?.check === false) return 'updates.check is false';
    // The old name (before 0u3), still read: either one false turns the check off.
    if (config?.board?.updateCheck === false) return 'board.updateCheck is false (the old name of updates.check)';
    const name = ENV_OFF.find((n) => isSet(env[n]));
    return name ? `${name} is set` : null;
  }

  /**
   * The whole state file as a plain object ({} when missing or broken). Besides the cache ({ checkedAt, latest }) it
   * holds `dismissed` (the version closed on the board or with `ravenseat update dismiss`), `shown` ({ version, at }:
   * when `ravenseat show` last printed the line) and `refreshStartedAt` (the last background refresh the CLI started).
   */
  function readState(fs, file) {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
    } catch {
      return {};
    }
  }

  /** Merges fields into the state file. false when it could not be written (it is a convenience, never an error). */
  function writeState(fs, file, patch) {
    try {
      fs.mkdirSync(folderOf(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...readState(fs, file), ...patch }, null, 2) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /** The version that was dismissed (board X or `ravenseat update dismiss`), or null. */
  function dismissedVersion(fs, file) {
    const d = readState(fs, file).dismissed;
    return parse(d) ? String(d) : null;
  }

  /** Hides the notice for this version (and older ones) everywhere until a newer one is out. false for a non-semver. */
  function dismiss(fs, file, version) {
    if (!parse(version)) return false;
    return writeState(fs, file, { dismissed: String(version) });
  }

  /** Records that `ravenseat show` printed the line for this version (once per day per version). */
  function markShown(fs, file, version, now = Date.now()) {
    return writeState(fs, file, { shown: { version: String(version), at: now } });
  }

  /** The newer of two dismissed versions (either may be null or invalid). */
  function newerOf(a, b) {
    if (!parse(a)) return parse(b) ? String(b) : null;
    if (!parse(b)) return String(a);
    return compare(a, b) >= 0 ? String(a) : String(b);
  }

  /** A loopback http(s) URL (the only override the manifest URL takes: tests point it at a local server). */
  const isLoopback = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(String(u ?? ''));

  /** The manifest URL: QUEUE_UPDATE_URL when it is a loopback address (tests), otherwise the published one. */
  function manifestUrl(env = {}) {
    return isLoopback(env.QUEUE_UPDATE_URL) ? String(env.QUEUE_UPDATE_URL) : MANIFEST_URL;
  }

  /**
   * May the CLI go on the network for this check? Under a test runner (VITEST) only a loopback QUEUE_UPDATE_URL, so the
   * many tests that run `show` or `doctor` never reach GitHub.
   */
  function networkAllowed(env = {}) {
    return !isSet(env.VITEST) || isLoopback(env.QUEUE_UPDATE_URL);
  }

  /** A background refresh is not started again within this time (offline: at most one try per hour). */
  const REFRESH_RETRY_MS = 60 * 60 * 1000;

  /**
   * Why the CLI keeps the notice to itself here, or null when it may speak. JSON output, an agent (a worktree, or the
   * role marker QUEUE_AGENT_ROLE / QUEUE_ROLE), CI and hooks (QUEUE_HOOK, set by the hooks that run a command) stay
   * quiet, so agent output and scripts stay clean.
   * @param {{ argv?: string[], env?: object, inWorktree?: boolean }} o
   * @returns {'json'|'agent'|'ci'|'hook'|null}
   */
  function quietReason({ argv = [], env = {}, inWorktree = false } = {}) {
    if (argv.includes('--json')) return 'json';
    if (inWorktree || isSet(env.QUEUE_AGENT_ROLE) || isSet(env.QUEUE_ROLE)) return 'agent';
    if (isSet(env.CI)) return 'ci';
    if (isSet(env.QUEUE_HOOK)) return 'hook';
    return null;
  }

  /** The one CLI line: what is out, what you have, and how to update. */
  function cliLine({ mode, installed, latest }) {
    const how =
      mode === 'plugin'
        ? `claude plugin update ${PLUGIN}@${MARKETPLACE}, then ravenseat setup --settings`
        : 'git pull in your Ravenseat folder, then node scripts/install.mjs <your project folder> --overwrite';
    return `ravenseat ${latest} is out (you have ${installed}): ${how}`;
  }

  /**
   * What `ravenseat show` (surface 'show') or `ravenseat doctor` ('doctor') says about a new version. Reads only the
   * state file, never the network, and never throws.
   *   line     the text, or null (off, quiet, nothing newer, dismissed, or already shown today in show)
   *   version  the newer version the line is about (for markShown), or null
   *   refresh  the cache is missing or older than 24 hours and no refresh was started within the hour: the caller may
   *            start one in the background (startRefresh), so the answer is there next time
   * @returns {{ line: string|null, version: string|null, refresh: boolean }}
   */
  function cliNotice(o) {
    const none = { line: null, version: null, refresh: false };
    try {
      if (o.quiet || disabledReason(o.config, o.env ?? {})) return none;
      const now = o.now ?? Date.now();
      const state = readState(o.fs, o.cacheFile);
      const cache = readCache(o.fs, o.cacheFile);
      const age = cache ? now - cache.checkedAt : -1;
      const fresh = !!cache && age >= 0 && age < MAX_AGE_MS;
      const started = typeof state.refreshStartedAt === 'number' ? now - state.refreshStartedAt : -1;
      const refresh = !fresh && !(started >= 0 && started < REFRESH_RETRY_MS);
      const installed = parse(o.installed) ? String(o.installed) : null;
      if (!cache || !installed || compare(cache.latest, installed) !== 1) return { ...none, refresh };
      const dismissed = parse(state.dismissed) ? String(state.dismissed) : null;
      if (dismissed && compare(cache.latest, dismissed) !== 1) return { ...none, refresh };
      if (o.surface !== 'doctor') {
        const s = state.shown;
        const since = s && typeof s.at === 'number' ? now - s.at : -1;
        if (s?.version === cache.latest && since >= 0 && since < MAX_AGE_MS) return { ...none, refresh };
      }
      return { line: cliLine({ mode: o.mode, installed, latest: cache.latest }), version: cache.latest, refresh };
    } catch {
      return none;
    }
  }

  /**
   * Starts `<script> update refresh` as a detached process with no stdio (the same latestVersion code and timeout as the
   * board) and records the start, so the CLI never waits on the network. false when it could not start. Never throws.
   * @param {{ spawn: Function, execPath: string, script: string, fs: object, cacheFile: string, now?: number }} o
   */
  function startRefresh(o) {
    try {
      writeState(o.fs, o.cacheFile, { refreshStartedAt: o.now ?? Date.now() });
      const child = o.spawn(o.execPath, [o.script, 'update', 'refresh'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: require('./hideWindows.cjs').hiddenWindowsEnv(process.env), // hidden windows below it (lib/hideWindows.cjs: windowsHide here does not reach what the run starts)
      });
      child?.on?.('error', () => {});
      child?.unref?.();
      return true;
    } catch {
      return false;
    }
  }

  /** The cache file as { checkedAt, latest }, or null when it is missing or broken. */
  function readCache(fs, file) {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof c?.checkedAt !== 'number' || !parse(c.latest)) return null;
      return { checkedAt: c.checkedAt, latest: String(c.latest) };
    } catch {
      return null;
    }
  }

  /**
   * Fetches the published version: a plain GET with only the timeout signal (no headers of our own). null on any error.
   * @returns {Promise<string|null>}
   */
  async function fetchLatest(fetchFn, o = {}) {
    try {
      const r = await fetchFn(o.url ?? MANIFEST_URL, { signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS) });
      if (!r || !r.ok) return null;
      const m = JSON.parse(await r.text());
      return parse(m?.version) ? String(m.version) : null;
    } catch {
      return null;
    }
  }

  /**
   * The latest published version, from the cache when it is younger than 24 hours, otherwise from the net (and then
   * written to the cache). null when the check is off, on any error, or when there is nothing to compare with.
   * Never throws.
   * @param {object} o
   * @param {object} o.config      queue.config.json (merged)
   * @param {object} [o.env]       process.env
   * @param {string} o.cacheFile   <dataFolder>/update-check.json
   * @param {object} o.fs          node:fs (readFileSync, writeFileSync, mkdirSync)
   * @param {Function} o.fetch     the fetch function (globalThis.fetch on the server, a mock in the tests)
   * @param {number} [o.now]       Date.now()
   * @returns {Promise<{ latest: string, checkedAt: number, cached: boolean } | null>}
   */
  async function latestVersion(o) {
    try {
      if (disabledReason(o.config, o.env ?? {})) return null;
      const now = o.now ?? Date.now();
      const cache = readCache(o.fs, o.cacheFile);
      if (cache && now - cache.checkedAt >= 0 && now - cache.checkedAt < MAX_AGE_MS)
        return { ...cache, cached: true };
      const latest = await fetchLatest(o.fetch, o);
      if (!latest) return null;
      // Merged into the file, so the dismissal and the "shown" stamp survive a refresh. A failed write is fine: the
      // cache is a convenience, and without it the board checks again at the next start.
      writeState(o.fs, o.cacheFile, { checkedAt: now, latest });
      return { latest, checkedAt: now, cached: false };
    } catch {
      return null;
    }
  }

  /** The folder of a file path, without node:path (the file also runs in the browser). */
  function folderOf(file) {
    const s = String(file);
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > 0 ? s.slice(0, i) : '.';
  }

  /** The version `ravenseat setup --settings` recorded last (<dataFolder>/setup.json), or null. */
  function readSetupRecord(fs, file) {
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parse(r?.pluginVersion) ? String(r.pluginVersion) : null;
    } catch {
      return null;
    }
  }

  /**
   * The steps to update, as { text, command } (command may be null). Plugin: claude plugin update, reload, setup.
   * Vendored: pull this repo and run the installer again (INSTALL.md).
   * @param {'plugin'|'vendored'} mode
   * @param {string} [projectFolder] the project's main tree (for the vendored installer command)
   */
  function steps(mode, projectFolder) {
    if (mode === 'plugin')
      return [
        { text: 'Update the plugin in a terminal:', command: `claude plugin update ${PLUGIN}@${MARKETPLACE}` },
        { text: 'Run /reload-plugins in Claude Code, or start a new session.', command: '/reload-plugins' },
        { text: 'Refresh the project settings (the status line path holds the version). It also names the project files older than the plugin:', command: 'ravenseat setup --settings' },
      ];
    const target = projectFolder ? `"${String(projectFolder).split('\\').join('/')}"` : '<your project folder>';
    return [
      { text: 'In your Ravenseat folder, get the new version:', command: 'git pull' },
      { text: 'From that folder, install it into the project again:', command: `node scripts/install.mjs ${target} --overwrite` },
    ];
  }

  /**
   * The same news as the board's setup banner, for ravenseat show. Only when setup HAS been recorded and is older than the
   * running version: a project that never ran setup has not asked to hear about it on every show.
   */
  function setupBehindLine({ mode, installed, setupVersion }) {
    if (!setupVersion) return null;
    if (notice({ mode, installed, setupVersion })?.setup !== 'run') return null;
    return `Setup is behind: ravenseat ${installed} is installed, the project was set up for ravenseat ${setupVersion}. Run: ravenseat setup --settings`;
  }

  /**
   * What the banner says, computed on the server and sent in the state as `update`. null when there is nothing to say.
   * @param {object} o
   * @param {'plugin'|'vendored'} o.mode
   * @param {string|null} o.installed      the running version (plugin.json, or ravenseat-version.json in a vendored install)
   * @param {string|null} [o.latest]       the published version (latestVersion), null when unknown or off
   * @param {string|null} [o.setupVersion] the version setup --settings recorded last
   * @param {string} [o.projectFolder]
   * @returns {null | { installed: string|null, newVersion: null|{ latest, changelog, steps }, setup: null|'run'|'restart' }}
   */
  function notice(o) {
    const installed = parse(o.installed) ? String(o.installed) : null;
    let newVersion = null;
    if (installed && o.latest && compare(o.latest, installed) === 1)
      newVersion = { latest: String(o.latest), changelog: CHANGELOG_URL, steps: steps(o.mode, o.projectFolder) };
    // Setup: only for a plugin install (the vendored installer writes the settings itself). An older or missing record
    // means setup was not run after the update. A NEWER record means the plugin was updated and set up while this
    // board still runs the old version: then the board itself must be restarted.
    let setup = null;
    if (o.mode === 'plugin' && installed) {
      const c = o.setupVersion ? compare(o.setupVersion, installed) : -1;
      if (c === null || c < 0) setup = 'run';
      else if (c > 0) setup = 'restart';
    }
    if (!newVersion && !setup) return null;
    const out = { installed, newVersion, setup, setupVersion: o.setupVersion ?? null };
    // The version dismissed in <dataFolder>/update-check.json (the board's X or `ravenseat update dismiss`), shared by
    // every browser and the CLI. Only set when there is one, so the shape stays as before otherwise.
    if (parse(o.dismissed)) out.dismissed = String(o.dismissed);
    return out;
  }

  /**
   * Which parts the board shows, given the version whose banner was closed in this browser (localStorage, may be null)
   * and the one dismissed on the server (n.dismissed): the newer of the two counts.
   * The new-version part stays hidden until a version newer than the closed one is out; setup always shows.
   * @returns {{ newVersion: boolean, setup: boolean }}
   */
  function visible(n, local) {
    if (!n) return { newVersion: false, setup: false };
    const v = n.newVersion?.latest;
    const dismissed = newerOf(local, n.dismissed);
    const hiddenByDismiss = !!(v && dismissed && compare(v, dismissed) !== 1);
    return { newVersion: !!v && !hiddenByDismiss, setup: !!n.setup };
  }

  return {
    MANIFEST_URL,
    CHANGELOG_URL,
    MARKETPLACE,
    PLUGIN,
    MAX_AGE_MS,
    TIMEOUT_MS,
    ENV_OFF,
    DISMISS_KEY,
    REFRESH_RETRY_MS,
    parse,
    compare,
    disabledReason,
    readState,
    dismissedVersion,
    dismiss,
    markShown,
    manifestUrl,
    networkAllowed,
    quietReason,
    cliLine,
    cliNotice,
    startRefresh,
    readCache,
    fetchLatest,
    latestVersion,
    readSetupRecord,
    setupBehindLine,
    steps,
    notice,
    visible,
  };
});

// =============================================================
// queue-board/data/setup.mjs: the install and the project setup the gear shows (server only, never served).
//
// The update banner (the installed version read once at start, the published one fetched at most once a day,
// updateNotice for the state), the setup panel of GET /api/settings (migrations, orchestrator, models, install, hooks
// and skills), the tidy line (cached five minutes) and readJson.
//
// Moved out of queue-board.mjs unchanged (SPLIT-1b). setupData(ctx) builds the functions once; the caches live in its
// closure and resetSetup() drops the tidy line (demo mode). The live paths and ctx.demoOn are getters on ctx; the
// install, the update cache and the setup record are read from the real folders at start, as before the split.
//
// Used by: queue-board.mjs (builds ctx; the server start calls refreshLatest), queue-board/api/settings.mjs and
// queue-board/data/state.mjs (updateNotice).
// Tested in: lib/__tests__/queueUpdate.test.ts, queueBoardSettingsGroups.test.ts, helperCustom.test.ts and the other
// tests that start the board server.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../../lib/queueBoard.js');
const L = require('../../lib/queueLogic.js');
const U = require('../../lib/queueUpdate.js');

/** setupData(ctx): the builders bound to the server's context, with their caches in this closure. */
export function setupData(ctx) {
  const { CONFIG, MAIN_TREE, BASE, HERE, REAL } = ctx;

  // ---- The update banner (lib/queueUpdate.js) ------------------------------------------------------------------------
  // The installed version: the plugin manifest (setupSources finds it), or ravenseat-version.json next to the scripts in a vendored
  // install (install.mjs writes it). Read once: a plugin update installs into a new folder, so this board keeps its version.
  const INSTALL = (() => {
    const src = T.setupSources(HERE, REAL.GIT_ROOT, (f) => fs.existsSync(f));
    let version = null;
    try {
      const file = src.manifest ?? path.join(HERE, 'ravenseat-version.json');
      version = JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null;
    } catch {
      version = null;
    }
    return { mode: src.mode, version };
  })();
  const UPDATE_CACHE = path.join(REAL.FOLDER, 'update-check.json');
  const SETUP_RECORD = path.join(REAL.FOLDER, 'setup.json');
  // The published version. Fetched at start and then at most once per 24 hours (the cache on disk); null when unknown,
  // turned off or on any error (no message: the banner simply does not show).
  let latestPublished = null;
  async function refreshLatest() {
    if (typeof globalThis.fetch !== 'function') return;
    const r = await U.latestVersion({
      config: CONFIG,
      env: process.env,
      cacheFile: UPDATE_CACHE,
      fs,
      fetch: globalThis.fetch,
    });
    if (r) latestPublished = r.latest;
  }
  /** What the banner says now (null = nothing). The setup record is read on every state build (a tiny file). */
  const updateNotice = () =>
    // In demo mode the demo banner has the top; the update notice comes back on the real board.
    ctx.demoOn ? null : U.notice({
      mode: INSTALL.mode,
      installed: INSTALL.version,
      latest: latestPublished,
      setupVersion: U.readSetupRecord(fs, SETUP_RECORD),
      projectFolder: MAIN_TREE,
      // The version closed on the board or with `ravenseat update dismiss` (the same file as the cache).
      dismissed: U.dismissedVersion(fs, UPDATE_CACHE),
    });

  /** A JSON file, or null when it is missing or broken. */
  function readJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * The tidy line in Settings > Project (lib/tidy.js, roadmap 1b): the same count as doctor's tidy row, with the command
   * to copy. Read only. Kept for five minutes, since it runs git status in every worktree; null value fields = unknown.
   * tidy.doctor false hides the count (the line still shows the command).
   */
  const TIDY_CACHE_MS = 5 * 60_000;
  let tidyCache = null;
  function tidySummary(queue, config) {
    const command = `${require('../../lib/projectRoot.js').cliCommand()} tidy`;
    if (config.tidy?.doctor === false) return { off: true, command };
    if (tidyCache && Date.now() - tidyCache.at < TIDY_CACHE_MS) return tidyCache.value;
    let value;
    try {
      const TIDY = require('../../lib/tidy.js');
      const minAge = Number(config.tidy?.minAgeHours);
      const t = TIDY.scan({
        main: ctx.GIT_ROOT,
        base: String(config.baseBranch ?? 'main'),
        prefix: config.branchPrefix ?? 'queue/',
        tasks: queue.tasks ?? [],
        minAgeHours: Number.isFinite(minAge) && minAge >= 0 ? minAge : 3,
        sharedLinks: config.sharedLinks,
        production: config.productionBranch ?? null,
        exclude: config.excludeBranches ?? [],
        dataFolder: ctx.FOLDER,
        sizes: 'removable',
      }).totals;
      value = { worktrees: t.worktrees, branches: t.branches, size: TIDY.sizeText(t.worktreeBytes, t.capped), command, at: new Date().toISOString() };
    } catch (e) {
      value = { error: String(e?.message ?? e).split('\n')[0], command };
    }
    tidyCache = { at: Date.now(), value };
    return value;
  }

  /** The setup in the settings panel (read only, from the real sources). */
  function setup(queue, stat) {
    // The migrations are shown only when the project has turned on the migration flow (config().migrations.folder).
    const m = CONFIG.migrations ?? {};
    let migrations = null;
    if (m.folder) {
      let files = [];
      let error = null;
      try {
        files = fs.readdirSync(path.join(ctx.GIT_ROOT, ...String(m.folder).split('/')));
      } catch (e) {
        error = e?.code ?? 'could not read the folder';
      }
      migrations = {
        folder: m.folder,
        error,
        next: queue.next_migr ?? null,
        highest: T.highestMigration(files, m.filePattern),
      };
    }
    const cursor = readJson(ctx.CURSOR);
    // Plugin install: the hooks and skills ship in the plugin folder. Vendored: they are in the project's .claude/.
    const src = T.setupSources(HERE, ctx.GIT_ROOT, (f) => fs.existsSync(f));
    const settings = readJson(src.hooksFile);
    const manifest = src.manifest ? readJson(src.manifest) : null;
    return {
      baseBranch: BASE,
      migrations,
      orchestrator: { ...L.orchestratorStatus(cursor), updated: cursor?.updated ?? null },
      models: stat.models,
      install: {
        mode: src.mode,
        name: manifest?.name ?? null,
        version: manifest?.version ?? null,
      },
      hooks: settings ? T.hooksCoverage(settings) : null,
      skills: T.skillsCoverage((name) =>
        fs.existsSync(path.join(src.skillsFolder, name, 'SKILL.md')),
      ),
      rules: T.SKILL_RULES.map((r) => r.text),
      rulesSource: T.SKILL_SOURCE,
    };
  }

  return {
    UPDATE_CACHE,
    refreshLatest,
    updateNotice,
    readJson,
    tidySummary,
    setup,
    /** Every cache of this module back to its start value (demo mode switched the paths behind them). */
    resetSetup() {
      tidyCache = null;
    },
  };
}

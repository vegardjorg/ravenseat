// =============================================================
// settings/gates.js: the rows of Gates, Tests and evidence, and Checks tab and learning (sections 4 to 6).
//
// Part of the settings registry (SPLIT-1): lib/settingsRegistry.js puts the area files together, in the order of
// AREAS there, into SETTINGS. A new row goes into the area file of its category, inside the section of that category,
// with its "Friction:" comment, as row(key, category, type, title, explanation, options) from ./rowKit.js; its default
// goes into lib/queueConfig.js STANDARD and its table row into plugin/docs/queue.md. A `requires` goes into
// ./requires.js. The row's place in this list is its place on the board and in `ravenseat settings`.
//
// Used by: lib/settingsRegistry.js.
// Tested in: lib/__tests__/settingsRegistry.test.ts (coverage, complete rows) and
// lib/__tests__/settingsRegistrySplit.test.ts (no row lost, moved or changed by the split).
// =============================================================
'use strict';

const { row, BASIC, QUEUE, offWeakens, rankWeakens } = require('./rowKit.js');

/** The rows of this area, in the order they are shown. */
const ROWS = Object.freeze([
  // ---- 4. Gates ----
  row('gates.quick', 'gates', 'list', 'Quick gate',
    'The commands a track runs before delivery. Set them up with `ravenseat kickstart gates --apply`.', {
      ...BASIC,
      protects: 'A track that delivers work its own quick checks would have failed.',
    }),
  row('gates.full', 'gates', 'list', 'Full gate',
    'The full set of commands receive and merge run. Empty = nothing runs and the gate counts as green, so set it up ' +
    'with `ravenseat kickstart gates --apply`.', {
      ...BASIC,
      protects: 'Broken code merged into the base branch, since receive and merge run these commands before it goes in.',
    }),
  row('maxFixRounds', 'gates', 'integer', 'Fix rounds before an owner question',
    'At this many fix rounds a task becomes an owner question instead of another round.',
    { protects: 'A task that loops through fix rounds without end instead of coming to you.' }),
  row('fixPlateau', 'gates', 'onoff', 'Ask when a fix round stalls',
    'Before a fix round, ask when the previous one committed nothing or the check fails the same way.'),
  row('fixRound.continueWithinMin', 'gates', 'integer', 'Continue the agent for a fix round (minutes)',
    'A fix round goes to the agent that delivered when it stopped at most this many minutes ago (warm cache). 0 = always a new agent.'),
  row('fixRound.continueMaxContextK', 'gates', 'integer', 'Continue only under this context (thousand tokens)',
    'A fix round goes to a new agent when the one that delivered had more context than this at its last stop. 0 = no cap.'),
  row('doneCheck.timeoutSec', 'gates', 'integer', 'Done command time budget (seconds)',
    'A run of the task\'s done command that takes longer is red.'),
  row('doneCheck.tailLines', 'gates', 'integer', 'Done command output lines kept',
    'How many of the last output lines are kept for the fix brief (only the tail, so early secrets are not copied).'),
  row('gates.precheck', 'gates', 'list', 'Precheck',
    'The fail-fast checks before the full gate. Empty = the standard checks the project has; [] = no precheck.'),
  row('gates.precheckBudgetSec', 'gates', 'integer', 'Precheck budget (seconds)',
    'The time budget per precheck when the check sets none.'),
  row('gates.timeoutSec', 'gates', 'integer', 'Track gate budget (seconds)',
    'The time budget for the gate run a track starts itself; a gate over it is red. Empty = the base gate budget; 0 = no budget.'),
  row('wait.blockSec', 'gates', 'integer', 'Longest blocking call (seconds)',
    'Gates, receive and merge wait at most this long, then print RUNNING with the command that waits on. At most 590; 0 = wait until done.'),
  // Friction: none. A hidden window changes no output, exit code or stdio; it only stops a console window opening for
  // each git, cmd or npm call below a detached run (a test run made the screen blink). On by default for that reason;
  // off only as an escape hatch if the preload ever gets in a project's way. Windows only; off weakens no guard.
  row('windows.hideConsoles', 'gates', 'onoff', 'Hide console windows (Windows)',
    'Detached runs (the wait mode, gates, the tree guard, the update check) start everything below them with hidden ' +
    'windows, so a test run opens no console window per git call. Off: the windows show as before.'),
  row('gates.flakyRerun', 'gates', 'onoff', 'Rerun red gate commands once',
    'A red gate in a track reruns only its red commands once on the same commit. Green then counts as flaky.'),
  // Friction: it stops a fix round, but only one that could never help (the gate's own program is missing on this
  // machine, on the tip and on the base), and replaces it with one owner question. On by default for that reason; the
  // rule is narrow (first program only, never "Cannot find module"), so a code failure still gets its fix round.
  row('gates.brokenVerdict', 'gates', 'onoff', 'Ask when a gate cannot run',
    'A red quick gate whose own program is not installed here (also on the base branch) is a setup problem: receive ' +
    'asks you once instead of starting a fix round. A changed gates setup forgets the verdict. Off: a fix round as before.'),
  // Friction: off by default, since clean can stop work: a project whose tests need an ignored local file (a .env, a
  // local config) is red in the copy until that file is listed in gates.clean.include. On: about 2 s more per full gate
  // with linked dependencies (measured 2026-11-20, plans/gos1-clean-gate-analyse-2026-11-20.md), no extra model tokens
  // beyond a wait turn now and then. Only the full gate before merge uses it, never the quick checks.
  row('gates.runner', 'tests', 'choice', 'Where the full gate runs',
    'Worktree: the full gate before merge runs in the track\'s worktree, where untracked and ignored files and the shared ' +
    'node_modules can change the result (the evidence line says so). Clean: it runs in a fresh copy of the exact commit ' +
    'with dependencies linked (or installed) from the lockfile, so a green gate means this commit passed. Clean adds ' +
    'about 2 seconds with linked dependencies and can turn red when tests need an ignored local file; list those in ' +
    'gates.clean.include.', {
      choices: ['worktree', 'clean'],
      protects: 'A green full gate that passed only because of files or packages the commit does not have.',
    }),
  // Friction: none while gates.runner is worktree. Link is the default: about 2 s, and no install script runs at the
  // orchestrator's gate. Install closes the lockfile gap too but takes 25 to 60 s and runs postinstall scripts; auto
  // installs only when the commit's lockfile differs from the linked folder's.
  row('gates.clean.dependencies', 'tests', 'choice', 'Dependencies in the clean copy',
    'Link: the shared folders (sharedLinks, such as node_modules) are linked into the copy, about 2 seconds. Install: ' +
    'a frozen install from the commit\'s lockfile (npm ci, pnpm, yarn or bun), 25 to 60 seconds, and it runs install ' +
    'scripts. Auto: install only when the commit\'s lockfile differs from the one the linked folder was installed from.', {
      choices: ['link', 'install', 'auto'],
    }),
  // Friction: none while gates.runner is worktree. A git worktree copy keeps .git, so tests that call git still work;
  // archive is for a project that wants no .git in the copy.
  row('gates.clean.copy', 'tests', 'choice', 'How the clean copy is made',
    'Worktree: git worktree add --detach, which keeps .git for tests that call git and handles Git LFS. Archive: git ' +
    'archive, a plain copy of the files with no .git.', { choices: ['worktree', 'archive'] }),
  // Friction: it removes friction (the escape hatch for a false red). Empty by default: nothing outside the commit.
  row('gates.clean.include', 'tests', 'list', 'Ignored files copied into the clean copy',
    'Ignored files or folders the tests need, copied from the worktree into the clean copy (for example .env.test). ' +
    'Never an absolute path, .., .git, a key or token file, or an env file that may hold real keys: the gate runs with ' +
    'secrets taken out of its environment, and a file must not bring them back.'),
  // Friction: none while gates.runner is worktree. Only the full gate before merge by default, never a track's quick
  // checks: base and push add the same 2 s to the merge and the push checks.
  row('gates.clean.kinds', 'tests', 'list', 'Which gate runs use the clean copy',
    'full: the gate on the delivered tip before merge (receive). base: the gate on the merge commit. push: the full gate ' +
    'in the main checkout before a batch push. A track\'s own run in its worktree never uses it.'),
  // Friction: off: a kept copy takes disk until the sweep. On only while you look into a red clean run.
  row('gates.clean.keepOnRed', 'tests', 'onoff', 'Keep a red clean copy',
    'Keep the copy of a red clean run for inspection. The next clean run or the doctor removes it after ' +
    'gates.clean.sweepAfterHours.'),
  // Friction: none. One hour, as for the gate temp folders: a running gate is never touched (its process is alive).
  row('gates.clean.sweepAfterHours', 'tests', 'integer', 'Remove old clean copies after (hours)',
    'A clean copy whose run has ended is removed after this many hours by the next clean run or the doctor, links ' +
    'first. A copy that cannot be removed stays and the doctor warns.'),
  row('gateEvidence.mode', 'gates', 'choice', 'Gate evidence',
    'Who is trusted that the checks passed: Ravenseat running them itself (own), your CI (external), or the track\'s own ' +
    'word (off). Own is the default, because a track could write a green result it never got. Own: receive and merge ' +
    'run the gates themselves and check your answers and edits against the owner log. External: a green CI check on ' +
    'the same commit counts as the full gate. Off: the track\'s own word counts.', {
      choices: ['own', 'external', 'off'],
      weakens: rankWeakens(['own', 'external', 'off']),
      protects: 'A track that writes a green gate result or an owner row it never got, and has it believed at receive and merge.',
      whyNot: 'External trusts a CI run you do not see, under the check names you list. Off believes the track\'s ' +
        'gates=OK and every owner row in the queue file. A project with empty gates.quick and gates.full runs nothing ' +
        'under own anyway, so off saves no time there; it only removes the owner row check.',
      changes: 'External: a green listed check on the same commit counts as the full gate; the quick gates still run ' +
        'here and owner rows are checked. Off: receive and merge take gates=OK as given and owner rows are not checked. ' +
        'Doctor will report it.',
    }),
  row('gateEvidence.external', 'gates', 'list', 'External checks that count',
    'The GitHub check names (workflow or job) whose green run on the same commit counts as the full gate in mode ' +
    'external. Empty = none counts, and the full gate runs here.'),
  row('baseGate.enabled', 'gates', 'choice', 'Base gate after merge',
    'After a merge the base branch\'s new tip is checked; a red base stops further merges until it is green again.', {
      choices: ['auto', true, false],
      weakens: offWeakens,
      protects: 'Merging more tracks on top of a base branch that is already red.',
      whyNot: 'A red base hides which merge broke it, and every later track is checked against broken code.',
      changes: 'The tip is not checked after a merge, and a red base does not stop the next one. Doctor will report it.',
    }),
  row('baseGate.commands', 'gates', 'list', 'Base gate commands',
    'Empty = the quick gates. A list runs after the quick gates (for example the full gate).'),
  row('baseGate.timeoutSec', 'gates', 'integer', 'Base gate budget (seconds)',
    'The time budget for the whole base gate that runs after a merge, shared by its commands (900 by default). Raise it ' +
    'when your full gate is slower than that.'),
  row('baseGate.tailLines', 'gates', 'integer', 'Base gate output lines kept',
    'The output lines kept for the fix task. Empty = the done command\'s value.'),
  row('baseGate.flakyRerun', 'gates', 'onoff', 'Rerun a red base gate once',
    'A red base gate reruns only the failed commands once on the same commit; green then is a flaky finding.'),

  // ---- 5. Tests and evidence ----
  // What makes a green gate worth something: the tests a track adds or removes, red on base and the QA evidence. Split
  // out of Gates by the owner decision of 2026-11-17 (H2); the keys stayed. The two test weakening switches are basic.
  row('gates.redOnBase', 'tests', 'object', 'Prove that new tests catch the bug',
    'Off until you set a test command, since Ravenseat must know how to run one test file. On: at receive, a track\'s ' +
    'new tests must pass with the change and at least one must fail without it, which shows the test really catches ' +
    'the bug. Only a warning, because a pure refactor rightly has no failing test. The two fix rows in this group need it.',
    { protects: 'A new test that passes with or without the change, so it proves nothing about the bug.' }),
  row('gates.redOnBaseStrict', 'tests', 'onoff', 'A fix needs a proven red test',
    'Off by default: a fix task without a test that fails on the base gets one warning at receive. On: merge stops on it, ' +
    'and the owner can merge past it with --allow-no-test, which is logged. Needs gates.redOnBase.', {
      weakens: offWeakens,
      protects: 'A fix merged with no test that fails without it, so the same bug can come back unnoticed.',
      whyNot: 'Fixes without a proven red test are only warned about and logged as fixed without test.',
      changes: 'Merge no longer stops on a fix without a proven red test; receive still warns.',
    }),
  row('gates.fixWithoutTestWarning', 'tests', 'onoff', 'Warn about a fix without a red test',
    'Needs gates.redOnBase, which is off until you set a test command. A fix task whose red on base check proves no ' +
    'test gets one FIX WITHOUT TEST line at receive, so you see that the bug may come back. On by default: it is one ' +
    'line and stops nothing.', {
      weakens: offWeakens,
      protects: 'A fix that comes in with a test that would pass without it, read past as one more red on base line.',
      whyNot: 'The fix-specific line names the task it fixes, so the owner sees the bug may come back.',
      changes: 'Receive prints only the plain red on base line; the finding log still marks the row fixed without test.',
    }),
  row('testWeakening.enabled', 'tests', 'onoff', 'Test weakening warning',
    'Receive warns about deleted or moved test files and added skip or focus markers.', {
      ...BASIC,
      weakens: offWeakens,
      protects: 'A track that gets green by deleting, moving or skipping tests.',
      whyNot: 'A green gate means little when the tests that would fail were taken away in the same change.',
      changes: 'Receive no longer reports deleted tests or added skip markers. Doctor will report it.',
    }),
  row('testWeakening.focusStop', 'tests', 'onoff', 'Stop on a focus marker',
    'A focus marker (.only, fit, fdescribe) on an added line stops the merge, since the other tests never ran.', {
      ...BASIC,
      weakens: offWeakens,
      protects: 'A merge where only the focused tests ran.',
      whyNot: 'With .only in place the rest of the suite is skipped, so the gate says green without checking it.',
      changes: 'A focus marker gives only a warning, and the merge goes on. Doctor will report it.',
    }),
  // A log row only: the warning and the focus stop are their own rows, so off weakens no guard (owner decision 2026-11-17).
  row('testWeakening.findingLog', 'tests', 'onoff', 'Log test weakening as a finding',
    'What the test weakening check finds also becomes a finding log row, classed as a weak test. Nothing is printed. ' +
    'Off: no such row; the warning and the focus stop stay, so no guard is weaker.'),
  // Friction: none. It appends about 250 bytes to a local, gitignored file after a run that has already ended, the file
  // is cut to its newest 1000 rows past 512 KB, and a failed write is ignored, so it can never slow or stop a run. On by
  // default (TC-1, 2026-11-19): the pick of test:changed and the time a run takes can only be judged from rows that were
  // there all along. A log row only, so off weakens no guard.
  row('testRuns.log', 'tests', 'onoff', 'Log test runs',
    'Each test:changed and plain npm test run in this repo is one row in a local file (time, mode, picked and total ' +
    'files, run time, exit, test and failed counts), read with node scripts/test-changed.mjs --stats. Off: no rows.'),
  // Friction: a 0.5 s CPU sample before vitest starts; on a busy machine the run gets fewer workers, so it can take
  // longer, but it stops nothing. On by default (roadmap 0s V9): under load the 60 s timeouts and worker RPC timeouts
  // gave false reds, which cost a rerun each. Off: the vitest config's values always.
  row('testChanged.adaptLoad', 'tests', 'onoff', 'Adapt test runs to load',
    'test:changed measures the load before it starts vitest. With CPU at least 70 % or free memory under 20 % it runs ' +
    'with a quarter of the cores and 120 s timeouts, and says so in one line. RAVENSEAT_TEST_LOAD=off turns it off for ' +
    'one run. Off: the vitest config\'s workers and timeouts always.'),
  row('testWeakening.testPaths', 'tests', 'list', 'More test paths',
    'More file patterns that count as test files for the test weakening warning, on top of the usual ones (the same ' +
    'pattern rules as protectedPaths).'),
  row('testWeakening.markers', 'tests', 'list', 'More skip markers',
    'More regular expressions for an added line in a test file.'),
  row('qa.evidenceTypes', 'tests', 'list', 'Evidence types',
    'The kinds of QA evidence a track may report on an EVIDENCE line, such as a screenshot or a test run. Receive asks ' +
    'for evidence on the labels in qa.evidenceLabels.'),
  row('qa.autoTypes', 'tests', 'list', 'Automatic evidence types',
    'Evidence types closed by `ravenseat qa auto --run` when the auto command is green.'),
  row('qa.manualTypes', 'tests', 'list', 'Manual evidence types',
    'Evidence types a person gathers by hand. They are collected in one manual round for many tasks, not one at a time.'),
  row('qa.autoCommand', 'tests', 'object', 'Automatic evidence command',
    'The command `qa auto --run` runs, with {refs} and {id}. Empty = qa auto only lists.'),
  row('qa.evidenceLabels', 'tests', 'list', 'Labels that need evidence',
    'Receive warns when a task with one of these labels delivers without evidence.'),

  // ---- 6. Checks tab and learning ----
  // The Checks tab and everything that suggests a guard: the inspection queue, known bugs and the learning loop over the
  // finding log (learning.* stays the key space). The category's note explains the shared cap of three proposals (M7).
  row('checksPanel.mode', 'learning', 'onoff', 'Show the Checks tab',
    'The Checks tab with suggested checks. Not set, it follows the guidance switch.', { ...BASIC, ...QUEUE }),
  row('checksPanel.marker', 'learning', 'onoff', 'Red dot on the Checks tab',
    'A small red dot on the Checks tab while an important suggestion is open, so you notice it without opening the ' +
    'tab. Off hides the dot for every reason; the suggestions stay. learning.guardFailedMarker only decides whether a ' +
    'guard that did not hold lights it.', { ...BASIC, ...QUEUE }),
  row('gates.fromKnownBugs', 'learning', 'choice', 'Gates from known bugs',
    'A known bug that can happen again becomes a gate task: propose (you approve), auto or off.', {
      choices: ['propose', 'auto', 'off'],
      weakens: (v, std) => v === 'auto' && std !== 'auto',
      protects: 'Tasks, and the tokens they use, that start without your approval.',
      whyNot: 'Auto approves every proposed gate task at once; each one runs an agent and uses tokens without asking.',
      changes: 'Gate tasks from known bugs are approved by the queue itself. Doctor will report it.',
    }),
  row('inspection.mode', 'learning', 'choice', 'Propose a guard for a failure that repeats',
    'When the same failure shows up in the gates or CI again and again, Ravenseat proposes one task to build a guard ' +
    'for it; you approve or decline. On by default, since a proposal only waits for your answer. Off: no such ' +
    'proposals, and the Checks card with recipes for failures that keep coming back (and its Build as gate button) is ' +
    'hidden too. Nothing is stopped either way.', {
      ...BASIC,
      choices: ['on', 'off'],
    }),
  row('inspection.minRepeats', 'learning', 'integer', 'Repeats before a proposal',
    'How many separate tasks, branch days or CI commits must fail the same way before it is proposed.'),
  row('inspection.windowDays', 'learning', 'integer', 'Inspection window (days)',
    'Only failures from this many recent days count toward a proposal (30 by default), so a failure fixed for good ' +
    'long ago is not proposed again.'),
  row('inspection.registryFile', 'learning', 'text', 'Guard registry file',
    'The tracked list of guards and what each one guards against, relative to the project root.', { edit: 'file' }),
  // The repeat count on class and area (lib/findingRepeats.js). The count and the guard failed marker are on: they cost
  // no tokens, print nothing and stop nothing. The proposals are off: each one asks for the owner's time.
  row('learning.repeats', 'learning', 'onoff', 'Count failures that come back',
    'Counts failures of the same kind in the same part of the code, across tasks, from the finding log. It prints ' +
    'nothing and stops nothing; the Checks tab uses it to say that a guard did not hold and to suggest recipes. On by ' +
    'default, since it costs no tokens. Off also hides those.', {
      weakens: offWeakens,
      protects: 'A kind of failure that keeps coming back in one place, or past a guard, going unseen because each one ' +
        'was fixed alone.',
      whyNot: 'Without the count the Checks tab cannot say that a guard did not hold, and no guard is proposed.',
      changes: 'The guard failed card, its red marker and the guard proposals from the finding log are gone.',
    }),
  row('learning.windowDays', 'learning', 'integer', 'Repeat window (days)',
    'Only findings this recent count toward a repeat. A guard can be older.'),
  row('learning.areaRepeats', 'learning', 'integer', 'Repeats in one area',
    'How many incidents of a class in one area (separate tasks) make it due. A fix without a proven test counts twice.'),
  row('learning.projectRepeats', 'learning', 'integer', 'Repeats across the project',
    'How many incidents of a class in the whole project make it due when no single area is. An untested fix counts twice.'),
  row('learning.guardFailedMarker', 'learning', 'onoff', 'Red marker when a guard did not hold',
    'A failure class back where a guard for it was in place lights the red marker on the Checks tab, until a new ' +
    'guard or a fix with a proven test is in place there. It stops nothing. On by default: it is rare, and a guard ' +
    'that no longer holds is worth seeing. checksPanel.marker hides the dot for every reason.', {
      weakens: offWeakens,
      protects: 'A guard everyone trusts that no longer catches its own class.',
      whyNot: 'It is the one gap that always gets the red marker, and it is rare, so it does not nag.',
      changes: 'The guard failed card stays on the Checks tab at medium priority, without the red marker.',
    }),
  row('learning.proposals', 'learning', 'onoff', 'Propose guards from the finding log',
    'A class that keeps coming back in one area becomes one proposed gate task (you approve it). It shares one cap ' +
    'of three open proposals with the inspection queue and the gate lines. Off by default, like every opt-in check, ' +
    'since each proposal asks for your time.'),
  // The database probe recipes (0i section 3.8). Off by default: a probe gate is heavy, needs a running database, and
  // is the one kind of gate that can change data elsewhere when it points at the wrong host. On, it only shows a recipe;
  // building one still takes the owner's click and approve, and the mission demands the host check and the rollback.
  row('learning.dbProbes', 'learning', 'onoff', 'Database probe recipes',
    'Off by default: a probe gate is heavy, needs a running database and can change data when it points at the wrong ' +
    'one. On: for access control and migration failures that keep coming back, the Checks tab shows a recipe for ' +
    'database probes (pgTAP, supabase test db, testcontainers), only when a local or throwaway database is found. A ' +
    'gate built from it must check that its database host is local before it writes, and roll back. Turn on ' +
    'dbGuard.localOnly too, so such a gate is refused when it points at a shared database.'),
  // Recipe precision (0i step 9, lib/recipePrecision.js). On by default, as the plan says (damped automatically): it only
  // moves a recipe the owner keeps declining from the card to the list, never stops work or hides a class, and the owner
  // can show one recipe again (ravenseat checks recipe <id> show). Off, every recipe whose `when` holds is offered.
  row('learning.recipeDamping', 'learning', 'onoff', 'Stop offering recipes you keep declining',
    'A recipe whose gate proposals are seldom accepted is listed on the Checks tab with its numbers, but no longer ' +
    'offered on the card. On by default, so a recipe you keep saying no to stops asking. It stops nothing, and ' +
    'ravenseat checks recipe <id> show offers one again. Off: every recipe that fits is offered.'),
  row('learning.recipeMinProposals', 'learning', 'integer', 'Decided proposals before damping',
    'How many of a recipe\'s proposals must be accepted or declined before it can be damped. Waiting ones do not count.'),
  row('learning.recipeMinProposalsDb', 'learning', 'integer', 'Decided proposals before damping a database recipe',
    'The same for a database probe recipe. Higher, since they are few and often declined for their cost.'),
  row('learning.recipeMinAccepted', 'learning', 'integer', 'Accepted share that keeps a recipe (percent)',
    'A recipe below this share of accepted proposals, after enough are decided, is damped. 1 to 100.'),
  // CI parity for a built gate guard (0i step 9b, lib/quickGate.js). All on: the card only offers, and its write takes
  // the owner's click, only ADDS a command to gates.quick and is refused from a track worktree; the lift only orders the
  // CI cards (never the red marker, section 3.9); the idle line is INFO. None of them stops work or runs a command, so
  // off is less advice, not a weaker guard: no weakens (owner decision 2026-11-17), like scopeNotes.* and client.canary.
  row('learning.quickGateCard', 'learning', 'onoff', 'Suggest adding a built guard to the quick gate',
    'A gate guard in the registry whose command is not in gates.quick gets a card on the Checks tab: one click (or ' +
    'ravenseat checks quick-add <G-n>) adds that command at the end of gates.quick, so every track runs it. Nothing ' +
    'runs from the card, and the write can only add a command, never remove or replace one. On by default, since you ' +
    'still decide. Off: no card, and no guard is weaker.'),
  row('learning.ciParityLift', 'learning', 'onoff', 'Point out a guard that CI skips',
    'When a gate guard\'s kind of check (tests, types, lint) is not run in CI, the cards tests-in-ci and quality-in-ci ' +
    'are put first in their priority and name the guard. They are never raised to the red marker. On by default, ' +
    'since it only changes the order. Off: the usual order, and no guard is weaker.'),
  // One row for the idle guard line (0x L2): the number of days, 0 for off. The old switch learning.idleGuardInfo is
  // no row; false in a file still turns the line off (lib/queueConfig.js resolveOwn), and setting the number turns that
  // switch on with it (cli/settings.mjs).
  row('learning.idleGuardDays', 'learning', 'integer', 'Note a guard that has never run (days)',
    'ravenseat guards and ravenseat doctor give one INFO line for a gate guard with 0 runs since it was built, this ' +
    'many days after it was built. 7 by default, since a guard that never runs protects nothing. It is INFO only and ' +
    'never stops anything. 0 turns it off: no line (the registry still shows 0 runs), and no guard is weaker. The old ' +
    'learning.idleGuardInfo false in queue.config.json still turns it off.'),
]);

module.exports = { ROWS };

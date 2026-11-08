# Red team: what a careless user can do to Ravenseat

Ravenseat merges code that agents wrote into your repo. The questions people ask before they let it do that are about
fear, not features: *can it lose my uncommitted work, can an agent fake a green result, can it push something I did not
want?* This page answers them with tests you can run yourself, and says plainly where there is no good answer.

```bash
npm run redteam          # the red team tests only (about 1 minute)
npm run redteam:report   # the same, and rewrites the result section at the bottom of this page
```

The questions in plain language, each with the tests behind its answer, are in the [FAQ](faq.md).

## How the tests are built

- **Only the agent is fake.** Real git, real `ravenseat` processes, the real hooks from `plugin/hooks/hooks.json`. An
  agent is a small script that commits and writes a result line, so a run costs nothing and git is never mocked.
- **One final check after every scenario.** Before a scenario the lab takes a picture of the user's things; afterwards
  one shared function (`expectUserThingsIntact` in [`lab.ts`](../scripts/orchestrator/__tests__/redteam/lab.ts)) checks
  that uncommitted, untracked, staged and stashed work is unchanged, the same branch is checked out, history only grew,
  the remote is untouched, no merge is left half done, every task is in the queue exactly once, none is done or merged
  without leave, no lock is held by a dead process, and `queue.json` reads. It is a model of *allowed* changes, not
  "nothing changed": a successful task should change the repo, and the scenario says what it may change. The check
  has its own test, one red case per rule.
- **Every safety test has been red.** When a test is written, its guard is turned off for a moment and the test must
  fail. A safety test that has never failed proves little.
- **A known weakness is a test of what should happen, never a green "it is still broken".** It has its own
  reproduction, and a weakness that gets worse cannot hide behind a passing test.

### Status and level

| Status | Meaning |
| --- | --- |
| PASS | The behaviour you want is verified by a test |
| FAIL | A guarantee is broken (none today) |
| KNOWN LIMITATION | The weakness is documented, with a reproduction |
| NOT VERIFIED | No good enough test yet |

The level says how much the test has been looked at, because a test with the right name is not the same as a proven
property:

- **mapped**: a test with the right name appears to cover it; not reviewed for this page.
- **verified**: read, run, and it checks the right property.
- **challenged**: also shown red with the guard removed.

Challenged is required for the main guarantees only, not for all of the 3,000 tests.

## The map

Tests are named by file. The red team scenarios are in `plugin/scripts/orchestrator/__tests__/redteam/`; the rest are
in `plugin/scripts/orchestrator/lib/__tests__/` and `plugin/scripts/orchestrator/__tests__/`.

<!-- redteam-map:start -->
| # | The fear | Status | Level | Tests |
| --- | --- | --- | --- | --- |
| 1 | My uncommitted work is overwritten by a merge | PASS | challenged | `rt01-uncommitted-work`, `flows`, `lab` |
| 2 | An interrupted merge leaves the repo half merged | PASS | verified | `queueFaultInjection`, `queueMergeResume`, `rt07-interrupted` |
| 3 | Claude dies in the middle of a task | PASS | challenged | `rt24-cold-restart`, `queueFaultInjection`, `rt07-interrupted` |
| 4 | Two sessions start or merge the same task | PASS | challenged | `rt03-two-sessions`, `mergeLock`, `queueLock` |
| 5 | Two agents change the same file | PASS | challenged | `rt05-same-file`, `conflictPredict`, `queueFaultInjection` |
| 6 | An agent reports green without passing | PASS | verified | `queueGateEvidence`, `flows`, `rt03-two-sessions` |
| 7 | The tests are green but too weak | KNOWN LIMITATION | - | `rt17-empty-gate` |
| 8 | The agent weakens a test to get green | PASS | challenged | `rt08-weakened-test`, `testWeakening`, `mergeGuard` |
| 9 | A task that always fails is retried forever | PASS | challenged | `rt06-rt22-permanent-failure`, `doneCheck` |
| 10 | The queue does not continue after a restart | PASS | challenged | `rt24-cold-restart`, `queueHandover`, `attempt` |
| 11 | Circular dependencies wait forever, silently | PASS | verified | `queueCycles` |
| 12 | Unclear requirements give the wrong result | NOT VERIFIED | - | none: needs real agents |
| 13 | An agent changes files outside its task | PASS | challenged | `rt13-outside-files`, `mergeGuard` |
| 14 | A tool the queue needs is missing | PASS | challenged | `rt14-missing-tool`, `queueDoctor`, `doctorBaseline`, `kickstart`, `conflictPredict` |
| 15 | A test that hangs holds my merge forever | PASS | challenged | `rt13-hanging-gate`, `gateLoad` |
| 16 | I keep coding while the queue works | PASS | verified | `rt01-uncommitted-work`, `rt07-interrupted`, `queueExternal`, `conflictPredict` |
| 17 | Switching from lite to full mode and back | PASS | challenged | `liteMode` |
| 18 | The cost grows without anyone noticing | PASS | challenged | `costGuard`, `costEstimate`, `queueSaverMode`, `rt06-rt22-permanent-failure` |
| 19 | A large queue makes the board unusable | PASS | verified | `queueBoardPerformance` |
| 20 | A folder with spaces or æøå in its name breaks something | PASS | challenged | `rt20-odd-paths`, `shellCommands`, `fixLinks` |
| RT-09 | An old task starts from stale assumptions | PASS | challenged | `queueTriage` |
| RT-14 | A broken queue file loses the queue | PASS | verified | `queueStateSafety`, `queueFaultInjection`, `rt21-no-task-lost` |
| RT-16 | A changed helper agent runs without anyone approving it | PASS | challenged | `rt16-changed-helper`, `helperCustom` |
| RT-17 | A gate that always says 0 passes for a check | PASS | challenged | `rt17-empty-gate` |
| RT-18 | Something is pushed that must not be | PASS | challenged | `rt18-push-hook`, `pushGuard` |
| RT-21 | A task disappears, is doubled, or is done without proof | PASS | challenged | `rt21-no-task-lost` |
| RT-22 | One blocked task stops all the other work | PASS | challenged | `rt06-rt22-permanent-failure` |
| RT-23 | A web page I visit can read or change my board | PASS | challenged | `rt23-board-guard`, `queueBoardServe`, `queuePlanRead` |
| RT-25 | A project without git, or without a first commit, starts work that cannot run | PASS | challenged | `rt25-no-first-commit`, `checksCatalog` |
<!-- redteam-map:end -->

Notes on some rows:

- **3 and 10:** the orchestrator and the agent are killed with no handover note, and a new process works only from what is
  on disk: the task is continued through `attempt close` and `resume`, a killed `receive` is received again, and locks
  of dead processes are taken over while a live one still stops it. Each case is merged once and done once. For 15
  minutes after a cold death `takeover` still says the old orchestrator may be alive, because a Claude session has no
  pid to check; it asks you rather than guessing.
- **5 and 13:** two real tracks change the same line: the second merge stops, names the file and the other task, and
  its fix round is told both. A file outside a task's list gives a warning; a protected path stops the merge before
  `git merge`.
- **14:** git, node for the hooks, `gh` and `claude` are each removed from PATH in turn, and each gives a named stop.
  A fake node that prints v18.0.0, first on PATH, makes doctor FAIL the hooks' node by its version. A gate whose
  program is not on PATH (`pytest -q`, `cargo test`) gives a named WARN, and no gate is run. Not covered: the WARN looks
  at doctor's PATH, which may differ from the agents'; only the first word of each command part is looked up, so a
  program behind `$VAR`, inside an npm script or behind `npx` is not judged. On Windows the old-node case needs the .NET
  Framework `csc` to build its fake, and is skipped without it.
- **18:** the daily budget is off by default. The cost guard warns at three times the class average once a class has
  three finished tasks in seven days; before that it warns at three times the task's own estimate, so the first runaway
  track of a class is named too, and the warning says which baseline it used. Not covered: before a class has measured
  history the estimate is the static class default, which can be far from the real cost (a task without a class gets the
  K default), and a cloud track's use is not in the local transcripts, so it is not measured.
- **8:** a warning, never a stop. Receive and the review package name a test file left with no assertions; removing
  some assertions while one remains is ordinary tidying and is not named (see the limitations).
- **9 and RT-22:** a task red in every round gets its fix rounds (two in the test, three by default), then one owner
  question; the task waiting on it waits,
  and three independent tasks start.
- **RT-18:** 17 written forms of a forced push (flag at the end, extra spaces, an env prefix, a quoted `git`, `-uf`,
  `bash -c`, `powershell -c`, `git -C`, a `cd` first, after an `echo;`, and others) and four pushes of other refs are
  refused through the hooks as Claude Code runs them, for both the Bash and the PowerShell tool. No hole was found.
- **RT-21:** a task set done by hand while its branch has unmerged commits, or that never started, is allowed (you may
  have merged it yourself) but warned about, with the tasks it frees and the way back.
- **RT-23:** the real board runs on a free port and gets real HTTP requests. A foreign Host (also the DNS rebinding
  form, an attacker's domain that points at 127.0.0.1) gives 421, a missing or wrong key 401, a write from a foreign
  Origin 403, a write that is not JSON 415, and a body over 16 KB is cut off (the connection is dropped). Every refused
  write leaves `queue.json` byte for byte unchanged, and the same write with the right key, Host and Origin works. Each
  guard was turned off in the source once, and its test went red. A mission file behind a symlink or junction is no
  longer shown (finding 11). The guards do not stop another program running as you: it can read the key from the
  terminal, or the queue files directly.

## What the red team found

Fourteen findings so far. Each one came from a test going red on the code as it was, and each fix has a test that is red
without it.

| # | Finding | Now |
| --- | --- | --- |
| 1 | Two tasks waiting on each other were accepted without a word, and both stayed waiting | `add` and `edit` refuse a cycle and name it; `doctor` names one already in the file |
| 2 | A hand-edited task without a domain crashed `next` | The lists show `?` for a missing field |
| 3 | Deleting every assertion in a test gave no warning | A warning when a whole test file loses its assertions (scenario 8) |
| 4 | With the base gate off, a hanging test held a merge for good (170 s and counting) | The merge's gates always get the time budget |
| 5 | A gate of `exit 0` alone passed for a check | `doctor` warns when every gate checks nothing, also behind an npm script |
| 6 | A staged change of the user's made `git merge` refuse after it had rewritten the user's files with CRLF (`core.autocrlf=true`) | The merge stops before `git merge`, with a clear message, and touches nothing |
| 7 | The same for an uncommitted change in a file the branch changes | The overlap is checked first; the files are named and nothing is touched |
| 8 | Two gate runs at the same moment read each other's evidence as tampering | One lock per evidence file; the second run waits |
| 9 | `set <id> done` by hand freed the waiting tasks without proof or a word | A warning with the freed tasks and the way back |
| 10 | A half-written `queue.json.<pid>.tmp` from a dead process was never mentioned | `doctor` names it and says it can be deleted |
| 11 | The board showed a task's mission file through a symlink or junction, so a mission path could point at any file on the machine | The mission file gets the same path guard as the reading view (no links, the real path must match); otherwise the text itself is shown |
| 12 | In a repo with git but no commit yet, `start` marked a task running, and the agent stopped at its first step: its worktree is made from a commit | `start` and `fill` refuse before anything is marked and say to make a first commit; the Checks tab has a card with the text to give Claude |
| 13 | With git missing from PATH, `doctor` passed and blamed the repo ("no commits", "version unknown") | `doctor` fails first, by name, with how to fix it |
| 14 | When an agent died with uncommitted work, `resume` did not say so, and the new agent started without it (the work was kept, but unseen) | `resume` names the changes and how to commit them to the branch first |

## Limitations

What these tests cannot show, or show to be weak. Read this before you trust the green.

- **Green is not correct.** A gate can only be as good as the checks you give it. Ravenseat says when the gates check
  nothing at all (RT-17), but not when a real test suite is too thin. The second test in `rt17-empty-gate` is the
  reproduction: one check that does nothing next to one real check is counted, not stopped.
- **Weakening a test bit by bit.** Removing some assertions while one remains is not named, because it is also what
  ordinary tidying looks like. The second test in `rt08-weakened-test` is the reproduction. Deleted tests and skip
  markers are named; none of these stop a merge, the reviewers decide.
- **Unclear requirements** cannot be tested without real agents, and no deterministic test can show that an agent
  understood a task. An optional round with real agents and a fixed budget is planned, not done.
- **Files outside a task's ownership** stop the merge only on protected paths (hooks, CI and test config, queue settings
  and similar). An ordinary file outside the task's list gives a warning for the reviewers.
- **Not a sandbox.** The guards are Claude Code hooks that read the commands an agent runs. They do not read the
  contents of a script the agent runs, and an agent runs with your user account. See
  [guarantees and limits](guide.md#guarantees-and-limits).
- **One machine.** The result below comes from one run on one machine. The same tests run in CI on Ubuntu and Windows
  on every push, as part of `npm test`.

## Result

<!-- redteam-result:start -->
Generated by `npm run redteam:report`; do not edit by hand. Last run 2026-11-08 08:01 UTC on commit `5455118`,
Node 24.16.0 on win32. 77 tests: 76 passed, 0 failed.

| File | Scenario | Tests | Result | Time |
| --- | --- | --- | --- | --- |
| `docs` | the red team page and the FAQ | 5 | PASS (1 skipped) | 0.0 s |
| `flows` | flow 1: a cloud track comes home and is merged, on a repo with the user's mess; flow 2: a cloud track comes home with red gates; flow 3: the user has a staged change when the merge runs | 3 | PASS | 56.1 s |
| `lab` | the final check is green when nothing that matters changed; the final check goes red for each broken rule | 22 | PASS | 89.5 s |
| `rt01-uncommitted-work` | RT-01: my uncommitted work survives a whole task | 2 | PASS | 40.0 s |
| `rt03-two-sessions` | RT-03: two sessions on the same queue | 3 | PASS | 44.2 s |
| `rt05-same-file` | scenario 5: two agents change the same file | 1 | PASS | 53.2 s |
| `rt06-rt22-permanent-failure` | RT-06 and RT-22: a task that never passes stops at the cap, and the independent work goes on | 1 | PASS | 43.4 s |
| `rt07-interrupted` | RT-07: interrupted in the middle, the user works on, and the queue finishes it | 2 | PASS | 45.3 s |
| `rt08-weakened-test` | RT-08: the agent cannot quietly weaken a test to get green | 2 | PASS | 14.8 s |
| `rt13-hanging-gate` | RT-13: a test that hangs never holds my merge forever | 2 | PASS | 45.5 s |
| `rt13-outside-files` | scenario 13: an agent changes files outside its task | 2 | PASS | 42.2 s |
| `rt14-missing-tool` | scenario 14: a tool the queue needs is missing | 4 | PASS | 28.6 s |
| `rt16-changed-helper` | RT-16: a changed helper agent does not run without anyone approving it | 1 | PASS | 15.2 s |
| `rt17-empty-gate` | RT-17: a gate that always says 0 does not pass for a check | 2 | PASS | 8.2 s |
| `rt18-push-hook` | RT-18: nothing pushes what it must not, however the command is written | 6 | PASS | 15.5 s |
| `rt20-odd-paths` | RT-20: a folder with spaces and æøå in its name works the whole way | 2 | PASS | 41.6 s |
| `rt21-no-task-lost` | RT-21: no task disappears, none is doubled, none is done without proof | 3 | PASS | 49.2 s |
| `rt23-board-guard` | RT-23: a web page I visit, or another program on my machine, cannot read or change my board | 8 | PASS | 1.1 s |
| `rt24-cold-restart` | RT-24: the orchestrator dies cold in the middle, and a new one finishes the work from the disk | 3 | PASS | 72.7 s |
| `rt25-no-first-commit` | RT-25: no git, or no first commit, never starts work that cannot run | 3 | PASS | 5.1 s |

<details><summary>Every test</summary>

**docs**

- PASS: the map: each row has a known status and level, and names only tests that exist
- PASS: every red team test file is on the map (the page itself and the lab helpers aside)
- PASS: each FAQ question has one "Verified by" line, and it names only tests that exist
- PASS: every relative link on both pages resolves to a file
- SKIPPED: the generated result covers every red team test file (if not: npm run redteam:report)

**flows**

- PASS: only the track's file lands, A becomes done, and everything of the user's is as it was
- PASS: nothing lands, nothing becomes done, and everything of the user's is as it was
- PASS: the merge stops, and the staging and everything else of the user's is as it was

**lab**

- PASS: an untouched repo with the user's mess
- PASS: an allowed change: a task merged into main, its file, its branch, done in the queue
- PASS: a lock held by a live process is fine
- PASS: an uncommitted file with changed content
- PASS: an untracked file removed
- PASS: an uncommitted change reverted
- PASS: a new stray file
- PASS: the staging changed
- PASS: the stash dropped
- PASS: another branch checked out
- PASS: history rewritten
- PASS: a file outside what the scenario allows
- PASS: a user branch moved or deleted
- PASS: a branch nobody allowed
- PASS: the remote changed
- PASS: a merge left half done
- PASS: queue.json broken
- PASS: a task lost
- PASS: a task doubled
- PASS: a task done without leave
- PASS: a task merged twice
- PASS: an orphan lock (its process is gone) and a token without an owner

**rt01-uncommitted-work**

- PASS: a local track is received and merged; only its file lands, and the user's changes are as they were
- PASS: the user has their own uncommitted version of the track's file: the merge stops and keeps it

**rt03-two-sessions**

- PASS: start and fill at the same time: the task is started once, with one attempt, and the queue reads
- PASS: two tracks received at the same moment: both green, neither reads the other's evidence as tampering
- PASS: both sessions receive and merge the same delivered track: merged once, done once, the user's work intact

**rt05-same-file**

- PASS: predicted while they run; the second merge stops on the conflict, keeps the first, and its fix round knows why

**rt06-rt22-permanent-failure**

- PASS: A is red in every round: two fix rounds, then one owner question; B waits; C, D and E start

**rt07-interrupted**

- PASS: killed in the gates after the merge: --resume marks done once and keeps the user's commit and edits
- PASS: killed in the base check before the merge: --resume says so, and a plain merge finishes it once

**rt08-weakened-test**

- PASS: every assertion removed from a test file: receive warns, and the review package names the file
- PASS: one assertion removed and one kept: no warning (ordinary tidying)

**rt13-hanging-gate**

- PASS: receive: a gate that hangs is red within the time budget
- PASS: merge with the base gate off: the gates after the merge stop at the budget, red, and nothing of the user's is touched

**rt13-outside-files**

- PASS: an ordinary file outside owned_files: the merge goes through and names the file
- PASS: a protected path outside owned_files: the merge stops before git merge, and nothing lands

**rt14-missing-tool**

- PASS: git is not on PATH: doctor fails on it by name, and changes nothing
- PASS: node is not on PATH for the hooks: doctor fails on it by name
- PASS: gh is not on PATH with the CI watch on: it says so and watches nothing
- PASS: claude is not installed at cloud-start: it says so, and the task goes back to waiting

**rt16-changed-helper**

- PASS: approved, it reviews; changed after the approval, the next receive leaves it out and on is refused

**rt17-empty-gate**

- PASS: the forms that check nothing, also behind an npm script; a real command is never one
- PASS: doctor warns when every gate checks nothing, and only counts them when a real one is there

**rt18-push-hook**

- PASS: hooks.json wires the guard for both shells
- PASS: Bash: a forced push is refused in every form
- PASS: Bash: a push of another branch than main is refused
- PASS: PowerShell: a forced push is refused in every form
- PASS: PowerShell: a push of another branch than main is refused
- PASS: a track agent never pushes, not even main; the orchestrator may push main

**rt20-odd-paths**

- PASS: a local track: receive with the gate, merge, done; the user's work intact
- PASS: a cloud track: collected and merged; doctor reads the odd paths

**rt21-no-task-lost**

- PASS: 20 tasks and many changes at the same moment, a merge among them: every task once, only the merged one done
- PASS: done by hand without proof is allowed but warned about, with the tasks it frees (finding 9)
- PASS: after a crash in the middle of a write: the dead lock is taken over, the half file ignored, nothing lost

**rt23-board-guard**

- PASS: without the key, or with a wrong one, nothing is read and nothing is changed (401)
- PASS: a foreign Host is refused before anything else (421), also with the right key
- PASS: DNS rebinding: an attacker domain that resolves to 127.0.0.1 is still a foreign Host (421)
- PASS: a write from a foreign Origin is refused (403), even with the right key and Host
- PASS: a write that is not JSON is refused (415): what a plain HTML form or a "simple" request can send
- PASS: a body over 16 KB is refused, and nothing is changed
- PASS: GET /api/task shows a mission file inside the project, but never one a symlink or junction leads outside
- PASS: with the right key, Host and Origin the same write works

**rt24-cold-restart**

- PASS: agent killed mid-work with the orchestrator: the new one closes the attempt, continues the branch, and merges once
- PASS: the orchestrator dies in the middle of receive, after the agent delivered: a new one receives and merges once
- PASS: locks: one left by a dead process never blocks the new orchestrator, one held by a live process always does

**rt25-no-first-commit**

- PASS: start and fill refuse in a repo with no commit, mark nothing, and say to make a first commit; after one, start works
- PASS: a base branch that does not exist, in a repo that has commits, gets its own message
- PASS: without git, init refuses and says why the queue needs git

</details>
<!-- redteam-result:end -->

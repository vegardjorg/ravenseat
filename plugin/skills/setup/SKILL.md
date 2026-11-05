---
name: setup
description: 'Set up the current project for the work queue (Ravenseat plugin): queue.config.json, docs, CLAUDE.queue.md, .gitignore, recommended settings, the empty queue, a smoke test, and optionally the user''s own TODOs and plans as queue entries. Use when the user types "/cq:setup", "set up the queue", "install the queue in this project", or when a queue command says there is no queue.config.json.'
disable-model-invocation: true
---

# /cq:setup: set up this project for the work queue

You set up the CURRENT project. Ask the user where a step says ASK. Do not push anything.
Extra instructions from the user: **$ARGUMENTS** (empty = none).

## 0. Check

- `node --version` is 20 or newer, and the project is a git repository with at least one commit. Note the main
  integration branch (often `main`, sometimes `develop` or `staging`).
- `cq help` works. If `cq` is not found, the plugin's `bin/` folder is not on PATH in this shell: use
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrator/cq.mjs"` instead of `cq` in every step below.
- If `queue.config.json` already exists, the project is set up: say so, run `cq show`, and stop unless the user asks
  for more.

## 1. Write the project files

Show the plan first: `cq setup --dry`. Then ASK the user two things in one question:
- may it add the line `@CLAUDE.queue.md` to `CLAUDE.md` (the queue's rules for Claude: batch push, pathspec commits,
  worktree rules)?
- may it add the recommended settings to `.claude/settings.json` (it lists them: a 1 hour prompt cache for subagents,
  compaction at 300k context, worktrees from HEAD)? A plugin cannot set these itself. They matter for cost, but they
  apply to the whole project, so it is the user's call.

Then run `cq setup` with `--claude-md` and/or `--settings` for what the user said yes to. Nothing existing is replaced.

## 2. Configure `queue.config.json`

ASK first: **lite (recommended for a first run)** or full? Lite is the core loop only: add a task with just a title,
the agents do it, you merge; questions for the user still wait on the board. Full adds classes, value, focus, the
batch queue, the plan register and helper agents. Lite: fill in only `projectName`, `baseBranch` and the gates below,
skip `modules`, and in step 3 run `cq init --lite` with the lite smoke test. Full: `cq init --full`, and everything
below. The user can switch later with `cq mode full` or `cq mode lite`.

Fill in, asking the user where you are not sure:
- `projectName`: a short name. `baseBranch`: the integration branch tracks branch from and merge into; `cq setup` has set it to the current branch, so check it.
- `gates.quick` and `gates.full`: the project's real check commands (type check, lint, tests). `cq setup` has set what it could read from the project. Check them: read `package.json`
  scripts (or the equivalent for the stack) and propose them; empty lists are allowed (gates then pass trivially, and the
  push guard, `cq receive` and `cq merge` say that no checks ran).
- `migrations`: only if the project has numbered database migrations. Otherwise leave `folder` as `null`.
- `modules`: ASK which areas the product has (for example "auth", "billing", "mobile"); use the answer for `modules`
  and `projectModuleSuggestion`.
- `reviewers`, `board.port`, `board.title`: the defaults are fine to start with.

Keys starting with `_` or `$` are comments.

### Safety basics (one question)

Run `cq doctor` and read its baseline lines (`secrets`, `gates`, `ci`, `lockfile`, `prod`, `largefile`). Tell the
user in plain words what it found (a FAIL under `secrets` first: a key in git must be changed, not only removed). Then
ASK one question, and write only what the user says yes to:
- "Which branch goes live (production)?" Write it as `productionBranch` (leave `null` if they do not know). If it is
  the same as `baseBranch`, say once that every batch push then goes straight to production; their call.
- Only when doctor says `no CI config found` and the project is on GitHub: "Want a small GitHub Actions workflow that
  runs your `gates.quick` on every push and pull request? (`.github/workflows/cq-gates.yml`; you add your runtime setup
  step, for example setup-node and npm ci.)" On yes, run `cq setup --ci`. It never overwrites an existing workflow. For
  other hosts, point to the README section "Safety baseline" instead of writing anything.
- When checks are missing, say that `/cq:kickstart` takes them one step at a time, whenever the user wants. Do not run it
  as part of setup unless they ask.
- Deploy commands (`deployCommands`) stay empty unless the user names theirs; the push guard then asks before any of
  them runs. The secret check before push is on by default (`secretScan`); mention it, do not change it.

### How much guidance (one question)

Ask once, after the cq init in the next step has made the queue: "Do you want Ravenseat to point out what is missing, like
CI, tests and next steps (recommended if you are new to agents or CI), or do you run your own setup?" On "my own setup", run
`cq guidance quiet`. It stops that advice, the light review, the intake triage and the gate proposals. The safety guards
stay on, and nothing then tells them if no check runs. The board's settings or `cq guidance guided` turn it back.

## 3. Create the queue and smoke test it

Lite:

```
cq init --lite
cq add "Demo task" --mission "Write a one-paragraph note about the repository layout."
cq show
cq set T-001 cancelled
```

Full:

```
cq init --full
cq plan modules
cq add --json '{"id":"EX-1","title":"Demo task","domain":"demo","class":"U","project":"example","feature":"Demo","mission":"Write a one-paragraph note about the repository layout.","value":5,"content_min":60}'
cq show
cq next
cq set EX-1 cancelled
```

`init` creates the queue in `scripts/.queue/` (gitignored). In full mode it has one example project `example` (prefix
`EX-`); offer to rename it with `cq project`. In lite mode the project is `tasks` (ids `T-001`, `T-002` ...). Then tell the user they can open the board with `/cq:board` (Claude starts it in the background
and gives a URL with an access key; never stop it by killing node by name).

### What the project has, and what to add (one question)

Skip this if the user chose "my own setup" above. Run `cq checks`. It reads the project's files and runs nothing. Tell the
user in at most eight lines: what you found (say that nothing was run, so it shows what is set up, not that it works), and the
top three suggestions with their `why`, in plain words. Then ASK one question, with these answers:
- "Not now" (recommended if they are new): stop here. The suggestions stay on the board's Checks tab.
- One of the suggestions: run `cq checks plan <key> --approved`. Say that it is about N minutes of agent work, uses tokens, and
  ends in a plan and suggested build steps, not code. A suggestion with `action: gates` needs no agent: `cq kickstart gates --apply`.
- "I do not want this": run `cq checks off`. It removes the Checks tab and this overview. Gates and guards are not touched.

Never add more than the user picked, and do not list the whole catalog unless they ask.

## 4. Bring in the user's own work

ASK: "Do you want me to look through your own notes, TODOs and plans (for example `docs/`, `TODO.md`, `ROADMAP.md`,
TODO/FIXME comments, and GitHub issues if `gh` is available) and add them as plan entries or queue tasks?"

If yes (in lite mode only concrete queue tasks, with `cq add "<title>" --mission "…"`; no plan entries):
1. List what you found (file, short title) and propose for each: plan entry (`cq plan new`) for ideas and larger
   plans, queue task (`cq add`) for concrete, ready work. Show the proposal before writing anything.
2. Plan entries without the user's priority get `"priority": "owner"`, `"maturity": "idea"`,
   `"priority_set_by": "agent"` and a one-sentence `priority_reason`. Each entry needs an existing `project` (create
   projects first, from the user's answer about areas) and `sources` as `[{ "path": "<path>" }]`.
3. Queue tasks you add here go straight to `waiting` and can start at once, so add only the ones the user said yes to
   in step 1. Only tasks an agent adds (`added_by` is a track id, a reviewer or an "... agent") start as `proposed` and
   wait for `cq approve <id>` or Approve on the board.
4. Never copy document contents into the register; point to them with `sources`.

## 5. Commit

The track agents work in git worktrees and only see committed files, so commit the project files before the first
parallel run, with a pathspec:

```
git add queue.config.json docs/queue CLAUDE.queue.md .gitignore
git commit -m "chore: set up the Ravenseat work queue" -- queue.config.json docs/queue CLAUDE.queue.md .gitignore
```

Add `CLAUDE.md` and `.claude/settings.json` to both lists when step 1 changed them, and
`.github/workflows/cq-gates.yml` when `cq setup --ci` wrote it. Do not push unless the user asks.

## 6. Tell the user how to start

- `/cq:queue` runs this chat as the orchestrator; `/cq:add-to-queue` turns a request into queue tasks; `/cq:plans`
  is plan work; `/cq:pick` does one task by hand.
- `/cq:board` starts the board and gives the link; `cq help` lists every command.
- `cq doctor` checks the setup and the project's safety baseline any time.

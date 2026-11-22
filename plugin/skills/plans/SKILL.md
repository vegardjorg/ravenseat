---
name: plans
description: Fetch and work with plans in the plan register (scripts/.queue/plans.json, ravenseat plan). Fetches a plan entry, a project or an area, checks status against the code with read-only Explore agents, gives a short report and waits for the owner's instruction. Saves the plan work (document, plan entry, owner questions, verification). Never builds. Use when the user types "/plans …", pastes a copy line from the board, or wants to look at, prioritise or verify a plan.
---

# /plans: work with plans in the plan register

Argument: **$ARGUMENTS**. The form is `<id|project|module>`, optionally with an instruction after it, e.g.
`/plans PL-EX-1 (Example › Login › Password reset). Instruction: …` (the copy line from the board).
`/plans jur <J-id>` and `/plans owner <Q-id>` go straight to a legal point or an owner question. Empty argument: run
`ravenseat plan show` and ask what the owner wants to work on.

Background: `docs/queue/plan-register.md`. The register lives in the main tree's `scripts/.queue/plans.json` and is written
ONLY through `ravenseat plan …` (same lock, atomic writes, change log and `plan undo` as the
queue). Never `node -e` or Write against `plans.json` or `queue.json`.

**You only do plan work.** Do not build, do not change code or tests, do not start tracks and do not run
`ravenseat start`, `set` or `fill`. If something is to be built, the next step is `/add-to-queue <plan entry>`.

## 1. Fetch

1. `ravenseat plan get <argument>`: the entries, the sources (with "DOES NOT EXIST" for dead
   paths), the queue tasks with status, owner questions, legal points, dependencies and the copy line. Use `--json`
   when you need exact fields.
2. **Mark the entry as being worked on** (pulse marker on the board): `ravenseat plan active <entry-id>` once per entry.
   The marker expires after 2 hours without updates; `plan active <entry-id> --end` when done.
3. Read the source documents, only the sections the entry points to (`anchor`): `grep -n '^#'` first, then Read with
   `offset`/`limit`. Gitignored notes exist only in the main tree: use an absolute path.

## 2. Status against the code

Start 1 to 3 **Explore agents in the same turn** (read only). Give each a bounded part of the entry and ask for short
answers with file paths: what exists for this today, which queue tasks are finished and what they delivered
(`ravenseat info <id>`), and whether `maturity` and the document match what is actually built. A small entry needs only
one agent.

## 3. Short report to the owner

Plain text, at most about 20 lines, for a non-technical reader:
- **What the plan says**, in two or three sentences.
- **What is built**, and what is missing, with file paths where it helps.
- **Gaps and contradictions** between the plan, other plans and the code.
- **Blocking owner questions and legal points**, each in plain language with a recommendation.
- **Priority:** what the rules give (`ravenseat plan rules`), and whether that differs from what is set.
- **Proposed next step** ("ready for the queue", "needs an owner answer first", "merge with PL-…", "drop: …").
- **Decision:** the `Decision:` line from `plan get`, when there is one (see 3b).

## 3b. Decision section for a large plan

When `plan get` prints a `Decision: missing` or `incomplete` line (size L or XL, or a sensitive zone, while
`plans.decisionNote` is on), write the one-page section in the plan's investigation document with the headings of
the plugin's `docs/decision-note.md`: need and evidence, success measure, non-goals, alternatives (at least: do not build, buy
or integrate, smallest version), cost, stop criteria (a state plus a date), the strongest case against and the cheapest
test, plus reversibility for a zone. Write the case against as a premortem: "assume this plan failed in 3 months; why?".
Link it as a source with role `decision` and the section as anchor (with the save in step 5). Never set the plan to
`ready` past a missing section yourself: tell the owner, who can set it or skip with
`plan edit <id> --skip-decision "<reason>"`. Small plans get nothing.

## 3c. Devil's advocate (only when `plans.devilsAdvocate` is on)

When the section is written and `ravenseat plan challenge <id> --json` gives a `brief` (an XL plan or a sensitive zone),
offer the owner one challenger run in the report; it costs one agent run. On a yes: start one `reviewer-challenger`
agent with exactly that brief (it holds the decision section and the code paths, never the investigation; give it no
other document), save its answer to a file in your scratchpad, and run `ravenseat plan challenge <id> --answer <file>`.
That checks three objections and one cheapest test and appends them under the section. Report them; change nothing
else because of them. Off, or `brief: null`: say nothing.

## 4. Wait for instruction

Stop after the report, unless the argument already had an instruction: then carry it out (still only plan work).

## 5. Save the plan work

- **The document:** update the plan in `docs/` and commit with `git commit -- <files>`; push only when the owner says
  "push".
- **The entry:** `ravenseat plan edit <id> --field name=value …` or `--set '{"field":…}'`; new entry with
  `plan new --file <json>`; priority with `plan prioritize <id…> <now|owner|later|drop> --reason "…"`; merge with
  `plan combine <to> <from…>`. Use `--dry` first for bulk changes. The owner's own choices are saved with
  `--set-by owner`.
- **Priority limits:** an agent never changes a priority the owner has set (`priority_set_by: owner`), except that a
  new security finding may raise it to Now. Drop needs one sentence of reason.
- **Owner questions:** `ravenseat question <id> --text "…" --type <question|condition|lawyer|owner-task> --category product --context "<what it is about and why now>" --if-yes "<what follows from the recommendation>" --if-no "<what follows otherwise>" --recommendation "…"`,
  linked in `ownerQuestions` (the card fields are required for type question; the category is a key in
  `ask-catalog/categories.json`). The owner's answer: `ravenseat resolve <id> --answer "…"`.
- **Verification:** `ravenseat plan verify <id> --findings "short finding" [--commit <sha>]` after checking against the
  code. It resets the stale warning.

## Sort the inbox (`/plans inbox`)

The Inbox holds plans captured with **+ New plan** or `plan capture`, and findings a track reported, that nobody has
sorted. With `/plans inbox` (or when the owner asks you to sort it) you write one **proposal** per item; the owner
confirms each one on the board (Accept, Edit, Decline or Merge). You never apply a proposal yourself.

1. `ravenseat plan inbox --json`: the items, with what is already proposed. Check `plans.inboxTriage` in the `INBOX:`
   line or the config: `off` means `plan propose` is refused, so stop; `idle` means sort them when a slot is free;
   `on-request` (the default) means only when the owner asks.
2. For each item: look for a duplicate (`ravenseat plan show --search "…" --json`), read `ravenseat plan rules`, and
   decide project, priority (with a one-sentence `priority_reason` naming the rule, unless it stays `later`),
   `now_category` for Now, maturity, size, a one-sentence summary, and `sources` if a plan document exists. Never a new
   title and never drop: a duplicate goes in `merge`, a plan not worth keeping is said in `priority_reason`.
3. Write the proposal as JSON to a file and run `ravenseat plan propose <id> --file <file>`. The fields are `project`,
   `priority`, `now_category`, `priority_reason`, `maturity`, `size`, `summary`, `sources`, plus `merge` (up to 5
   plan ids it looks like) and `outline` (a short suggested outline, shown folded, up to 6000 characters). Give only
   what you would change. The owner's own text is kept: Accept stores it in `original_text` when the summary changes.
4. Tell the owner how many proposals wait: "Accept them on the board (key 1), or Edit, Decline, Merge."
5. `plan accept`, `plan decline` and `plan merge` (all with `--set-by owner`) are the owner's: run them only when the
   owner says so in this session, for that item. `plans.inboxAutoApply` (off by default) lets `plan propose` apply a
   proposal for a captured plan that stays at `later` with no merge; never turn it on yourself.

## 6. End of session

- `plan active <entry-id> --end` for the entries you marked.
- If a backup script is configured (`planBackup` in `queue.config.json`), offer `ravenseat plan backup` when the register
  changed. Run it only when the owner says yes.
- Short closing line: what changed and the change-log number from `ravenseat` (undo with `ravenseat plan undo`).

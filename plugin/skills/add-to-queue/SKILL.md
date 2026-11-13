---
name: add-to-queue
description: Add saved-up or new work to the work queue (scripts/.queue, `ravenseat`) as tracks of the right size (K 90-120 min, D about 40, D+ 25-30, U about 60; small non-blocking tasks in the batch queue), with risk class, project and feature, ownership, dependencies and owner questions. Also takes a plan entry from the plan register (`/add-to-queue PL-…`) and sets the plan field. Use when the user says "add to the queue", "/add-to-queue …", or wants to send work to the continuous queue. Builds nothing itself.
---

# Add to the work queue

What goes in: **$ARGUMENTS** (if empty, ask what to add, or use the tasks the user described in the conversation).

You only ADD work. Do not build, do not start agents, do not run `ravenseat start`/`set`; the orchestrator does that.
Background: `${CLAUDE_PLUGIN_ROOT}/skills/parallel-wave/SKILL.md` and `docs/queue/queue.md`.

**Lite mode:** run `ravenseat mode` first. If it says `lite`, skip steps 0 to 5: add one task per thing the user asked for
with `ravenseat add "<short title>" --mission "<self-contained mission: what, why, where, how to check it>"` (add
`--files <paths>` when you know the files it owns, `--depends <ids>` when it must wait for other tasks, `--priority 1-10`
only when the user gave a priority). No class,
size, value, project, feature, splitting or packing; ids, class K and the defaults come by themselves, and nothing
is refused for being small. A task that needs the owner's decision first still waits on a registered question: use
`ravenseat add --json '{"tasks":[{"title":"…","mission":"…","waiting_on":["Q-1"]}],"question":{"Q-1":{"type":"question","text":"…","recommendation":"…"}}}'`.
Then do step 7.

0. **Plan entry as input.** If the argument is a plan entry (`PL-…`), or the work belongs to one
   (`ravenseat plan show --search "…"`), fetch it with `ravenseat plan get <id> --json` and check:
   maturity `ready` (otherwise say what is missing and suggest `/plans <id>` first), no open blocking owner questions
   (otherwise tasks that must wait get them in `waiting_on`), and that content only found in gitignored notes is lifted
   into the mission (worktree agents cannot see gitignored files). Every task gets `"plan": "<entry-id>"` and `project`
   from the entry. `add` refuses an unknown entry, and the entry becomes `in-queue` by itself.
1. **Split into tracks of the right size per class** (fixed overhead is a large share of a small track):
   - **K** (client/UI/ordinary code), weight 1.0: **90-120 min of content**. No K under about 30 min alone; pack it
     with related K work in the same project/feature. Split only if the track would pass about 250k context.
   - **D** (database/RPC/contract changes), weight 1.3: **about 40 min** (30-50), at most 3 migrations.
   - **D+** (new tables, retention/anonymisation, unauthenticated endpoints, patching a shared function), weight 1.8:
     **25-30 min**, one function family. Never merged with other work.
   - **U** (investigation), weight 0.6: about 60 min.
   - Keep apart: K and D; tasks with different owner questions; unrelated hotspot files. Parallelism before cohesion.
   - **Small-task guard (`add` enforces it):** 10 min or less: not in the queue; ask the owner "fix now
     (recommended) or batch queue?". Over 10 min but under the lower target for the class and value 7 or less:
     batch queue (`"batched": true`). Unsure value: ask with a recommended value. Deliberate own track:
     `"own_track": "<reason>"`. Not for D+, for tasks others depend on, or for tasks with open owner questions.
   `content_min` = the time the content would take as a K track (estimate = content_min × weight).
2. **Write one self-contained track description per track** to `scripts/.queue/mission/<id>.md`: what and why, "Read
   also" (exact repo-relative paths, one per line, with `:line`, `:a-b` or `§ N` when only part matters; no globs or
   folders: the mission starts with these as a read-in-one-turn list), numbered content, tests (red first), review
   needs and "Do NOT touch".
3. **Map ownership with Grep/Glob, do not guess:** `owned_files` (exact paths, or folders ending in "/"), `owner_db`
   (functions created or redefined), `shared_patch` (shared functions patched), `migr_tens` (0 without migrations).
   Then `reads`: the files the task builds on but does not change. Grep for the imports and calls of what the task
   uses (the modules it imports, the functions and types it calls, the config it reads) and list those files, or a
   folder with "/". A file in `owned_files` is never also in `reads`. Leave out what everything uses (a shared
   utility nobody changes): `reads` makes the task wait while another task changes the file.
4. **Project and feature (REQUIRED):** every task gets `project` (from `ravenseat projects`) and `feature` (a short
   name the owner recognises). Tasks with visible UI get `"labels": ["visual"]`. Unsure of the project:
   `ravenseat classify --file <in.json>`. No fitting project: create one first:
   `ravenseat project <pid> --title "<clear title>" --prefix <PREFIX>- [--plan docs/<plan>.md] [--area <oid>]`.
4b. **Cloud or local:** set `requires` (list) when the task needs something a cloud session lacks: `db`, `web`,
   `local-files`, `unit`. Class D/D+ and DB ownership keep a task local anyway.
5. **Make one JSON file** (e.g. `scripts/.queue/mission/<prefix>-in.json`):
   ```json
   { "tasks": [{ "id": "EX-1a", "title": "short title", "domain": "web",
       "project": "example", "feature": "Login page", "labels": ["visual"],
       "class": "K", "mission": "scripts/.queue/mission/EX-1a.md", "value": 7, "content_min": 90,
       "migr_tens": 0, "depends_on": [], "waiting_on": ["Q-EX-1"], "owned_files": ["src/login/"], "reads": ["src/api/session.ts"],
       "owner_db": [], "shared_patch": [], "requires": [], "plan": "PL-EX-1", "source": "docs/plan.md § 3",
       "added_by": "<session>" }],
     "question": { "Q-EX-1": { "type": "question", "text": "The question, clear for the owner",
       "recommendation": "…", "source": "docs/plan.md § 3" } } }
   ```
   `id`: unique, letters/digits/"."/"_"/"-". `waiting_on` takes ONLY registered question ids (with text and type,
   from before or in the same file); `add` and `edit` refuse anything else, and the whole file stops. Types:
   `question`, `condition`, `lawyer`, `owner-task`. When the owner answers (`ravenseat resolve <id> --answer "…"`), every
   waiting task gets the answer appended to its mission.
5b. **Acceptance criteria:** a task with user-visible behaviour gets 1-3 short, checkable criteria
   (`"acceptance": ["..."]` in the file, or `ravenseat add ... --accept "..."`); they are locked once the task starts.
6. **Add and check:** `ravenseat add --file <file.json>` and `ravenseat show --project <pid>`.
   `add` rejects the whole file on error: fix and retry.
7. **Report briefly:** the ids added, project and feature, dependencies, and owner questions (with recommendation).
   No commit needed: `scripts/.queue/` is gitignored.
8. **Investigations and proposals become plan entries:** if it is an idea or proposal not ready to build, register it
   with `ravenseat plan new --file <json>` (`"priority": "owner"`, `"maturity": "idea"`, `"priority_set_by": "agent"`, a
   reason, and a linked owner question). Mention the entry id in the report.

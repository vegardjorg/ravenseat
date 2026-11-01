# bench: measuring cost, savings and system load for the queue

A small, dependency-free harness for answering "does the queue save anything, and what does parallelism cost the
machine?" with real tasks instead of before/after impressions. It reads a project's own logs at run time, joins them
per task and per session, and writes a markdown report with paired comparisons and bootstrap confidence intervals.

The harness is MVP on purpose: plain Node (CommonJS libs, one ESM CLI), no new dependencies, vitest tests with
synthetic fixtures only.

## Privacy rule (read first)

This repo is public. The benchmark measures a real project, so:

- The manifest (which names real tasks), the load log, the human minutes log, `records.json` and `report.md` all
  live OUTSIDE this repo. The default results root is `~/.cq-bench/results` (or `BENCH_RESULTS`). `bench.mjs`
  refuses to write anywhere inside the repo except `bench/results/`, which `bench/.gitignore` keeps out of git.
- Nothing from a measured project (task ids, titles, paths, numbers) is ever written into a file in this repo.
  The fixtures in `bench/__tests__/fixtures.ts` are invented.

## Commands

```
node bench/bench.mjs validate --manifest <file>
node bench/bench.mjs assign   --pairs <pairs.json> --arms cq,manual [--seed 1]
node bench/bench.mjs sample   --out <load.jsonl> [--interval 30] [--duration-min 600] [--queue <queue.json>] [--disk <dir>]
node bench/bench.mjs sample   --stop --out <load.jsonl>
node bench/bench.mjs sample   --once [--queue <queue.json>]
node bench/bench.mjs human    --log <human.jsonl> --task <id> --min <n> [--arm <arm>] [--activity <text>]
node bench/bench.mjs collect  --manifest <file> [--out <dir>] [--queue f] [--time-log f] [--transcripts dir] [--load f] [--human f] [--git repo] [--no-cache]
node bench/bench.mjs report   --records <records.json> [--out <report.md>]
```

- `sample` runs in the foreground; start it in a separate terminal (or as a background job) for the whole
  experiment. It stops on Ctrl+C, after `--duration-min`, or when `<out>.stop` appears (`sample --stop` writes it;
  this also works on Windows, where a detached process is awkward to signal). One failed sample never stops it.
  `BENCH_LOAD="free=50,cpu=20,procs=300,node=12,disk=40,tracks=3"` replaces the measurement (tests).
- `human` appends one row of human minutes. Log every block of hands-on time (reading, prompting, reviewing,
  merging) per task; time not tied to a task is logged with `--arm` only and is spread over the arm's tasks.
- `collect` only reads: the queue file, the time log, the transcripts, the load and human logs, and `git log`.
  It keeps one analysis per transcript in `<out>/.transcript-cache.json` and reuses it while the file's size and
  mtime are unchanged, so a daily collect only parses new or changed transcripts (a month of them can take a quarter
  of an hour on a busy disk). `--no-cache` reads every file.
- `assign` shuffles the arms within each matched pair with a fixed seed, so neither arm always gets the "first" task.

## Run manifest

One JSON file per experiment. A synthetic example is in `example/manifest.example.json`; copy it outside the repo
before putting real ids in it. Paths in `sources` are relative to the manifest file; command line flags override them.

| Field | Meaning |
|---|---|
| `experiment` | Id, `[A-Za-z0-9._-]`, used in the results folder name |
| `arms[]` | `name`, `kind` (`cq`, `manual-fresh`, `manual-long`, `other`), `models` (agent type to model, as in `queue.config.json` `models`), `maxParallel`, optional `window` `{from, to}` (sessions with no task link that start in it belong to the arm) and `sessions` (main session ids: the orchestrator for a cq arm, the long chat for `manual-long`) |
| `tasks[]` | `id` (queue id), `arm`, `pair` (matched pair id), `stratum` (e.g. class and size band), `label` (the track label in the logs, default `id`; must differ when the same task is replayed in two arms), `replay` `{base}` (built again from that commit in a throwaway worktree), `sessions` (main session ids for a manual arm), `outcome` (`merged`, `failed`, `abandoned`: required for replays and manual tasks outside the queue) |
| `sources` | `queue`, `timeLog`, `transcripts` (the `~/.claude/projects/<slug>` folder), `load`, `human`, `gitRepo`, `gates` (an extra JSONL with gate rows) |
| `settings` | `seed`, `bootstrap` (resamples), `defectWindowDays`, `loadMatchSec` (max distance from a gate run to a load sample), `prices` (per model, USD per MTok: `input`, `output`, `cache_read`, `cache_5m`, `cache_1h`), `sessionTypes` (agent type or session id to session type, overrides the defaults) |

`validate` reports every problem at once (unknown arm, a pair with two tasks in one arm, a label used twice, and so on).

## What is measured, and from where

| Record | Source | Notes |
|---|---|---|
| Session tokens and USD | transcripts (preferred), else the time log's last cumulative `done` row per agent | Priced per model; a model without a price in `settings.prices` is priced as the default model and listed as a warning |
| Session type | agent type, track label, main session lists | `orchestrator`, `planning`, `track`, `fix` (a `-r<N>`/`-round<N>` label, or a second build agent on the task), `reviewer`, `helper`; work on an abandoned task is counted as `cancelled` |
| Context peak, compactions | transcripts (`compact_boundary` rows), time log `compact` rows | cq writes one `compact` row per main session compaction (`scope: "session"`, `orchestrator` marks the bound orchestrator, which then counts as an orchestrator session) and one per new track compaction (`scope: "track"`, the running count per `agent_id`). The log rows count only for a session whose transcript shows no compaction. Per task and per arm, plus orchestrator compactions per arm |
| Task class, estimate, status, times, queue cost, findings | the queue file | Replays take nothing from the queue except class and estimate |
| Gate runs and reruns | the time log's `gates` rows (`rerun_nr`, `green`, `mode`, `concurrent_gates`, `free_memory_pct`); single `gate` rows for timeouts; cq's `gate` rows | cq's `gates.mjs` writes one `gate` row per run (`kind` quick/full/precheck, `ok`, `exit`, `attempt`, `timed_out`): read as a gate run with `rerun_nr = attempt - 1`, and as a step for timeouts. Per task (gate runs, reruns) and per arm |
| Load | `sample` JSONL | free memory, CPU, load average (not on Windows), process and node counts, disk, running tracks |
| Human minutes | `human` JSONL | |
| Defects after merge | the queue (later `<id>-F*`/`-FIX*`/`-FIKS*`/`-QA*` tasks, or `bug`/`fix` labelled tasks owning the same files) and `git log` reverts naming the task, within `defectWindowDays`; a task added after the merge that names it in `fixes` | The `fixes` link is explicit, so the window does not apply to it. A fix task is counted once even when several rules match |

Field names are normalized first (`lib/fields.js`), so a queue or log written with Norwegian field names (an older
vendored install of the same queue model) reads the same as a cq one.

## Metrics (lib/metrics.js)

- **USD per merged change** per arm: all usage in the arm (every session type, overhead included) divided by the
  tasks that reached `merged`. This replaces USD per estimated content minute, whose denominator moves when the
  estimates change.
- Per task: own USD plus an equal share of the arm's overhead (sessions with no task), human minutes, fix rounds,
  defects. This is the unit of the paired comparison.
- Usage and tokens by session type, cache read share, compactions, context peaks, wall time, human minutes per merged
  change, gate runs, reruns, rerun seconds, timeouts, review H+M findings, defects per merged change.
- Load: Spearman correlation of parallelism (running tracks at the gate run, or concurrent gates) and free memory with
  gate duration and reruns; gate duration, rerun share and timeout share per parallelism band; per task, mean running
  tracks during the build against build minutes per estimated minute and fix rounds.
- Paired comparison of two arms on `usd`, `wall_min`, `human_min`, `defects`, `fix_rounds` or `merged`: mean
  difference B - A with a pair bootstrap CI, median difference, and the ratio of totals B / A with its CI.
  `stats.pairsNeeded` gives the number of pairs for a target effect.

## Layout

```
bench/
  bench.mjs              CLI
  lib/fields.js          English/Norwegian field mapping
  lib/manifest.js        manifest validation, defaults, seeded pair assignment
  lib/loadSampler.js     load sampler
  lib/prices.js          per-model pricing (defaults from plugin/.../lib/timeCost.js)
  lib/collect.js         sources -> records
  lib/metrics.js         records -> numbers
  lib/stats.js           median, bootstrap, correlation, sample size
  lib/report.js          numbers -> markdown
  lib/paths.js           results location and the in-repo guard
  example/               synthetic manifest
  __tests__/             vitest tests, synthetic fixtures
```

Run the tests with `npx vitest run bench` (the bench folder is in the `vitest.config.mjs` include list).

## Extending

- A new metric: add it to `metrics.js` (pure, on the records), a column in `report.js`, a test with a hand-computed
  expectation in `metrics.test.ts`.
- A new source: read it in `collect.collectAll`, join it in `collect.build`, and add a warning when it is missing, so
  a gap never looks like a zero.
- A new field name in a project's logs: one line in `fields.js`.

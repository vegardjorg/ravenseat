---
title: Put a cap on the test workers
category: tests
priority: low
when: has-gates, found:test
content_min: 15
why: Test tools start about one worker per core by default. That is fine for one run, but several runs on one machine fight for memory and go red from timeouts instead of real errors.
---

## Investigate

- How many workers does the test tool start by default here, and how much memory does one full run take at its peak (`ravenseat machine --measure` shows it)?
- Do the `gate` rows in the time log show red runs with a low `min_free_memory_pct`?

## Plan and build

- A fixed cap on the workers in the test tool's config (for example `maxWorkers`, or `maxForks` in a forks pool), set low enough that a run leaves room for the rest of the machine.
- Compare the longest run and the lowest free memory before and after, not the average, and keep the cap only if the peak fell without the time growing much.

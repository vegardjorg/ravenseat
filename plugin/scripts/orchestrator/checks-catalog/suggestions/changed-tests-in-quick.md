---
title: Run only the changed tests in the quick gates
category: tests
priority: low
when: has-gates, found:test
content_min: 30
why: When the test suite takes minutes, every track runs all of it for each delivery. Running only what a change touches in the quick gates saves the most machine time, and the full suite still runs in the full gates.
---

## Investigate

- How long do the quick gates take today (the `gate` rows in the time log), and how much of that is the test suite?
- Does the test tool have a mode for changed files only (for example `vitest --changed`, `jest --changedSince`)?
- The trap: such modes follow imports. Which tests read files directly (scanning docs, config, migrations or source as text) instead of importing them? They are invisible to the selection, so they silently stop running.

## Plan and build

- The quick gate runs the changed tests against the base branch. The full gates keep the whole suite, unchanged.
- A short list of the tests that read files directly, which always runs when the diff touches those files, with a check that fails when a new test of that kind is not on the list.
- Show on one real change that a test reading a file directly still runs and goes red.

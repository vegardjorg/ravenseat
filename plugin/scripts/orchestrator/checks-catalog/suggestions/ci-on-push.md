---
title: Run your checks on every push (CI)
category: ci
priority: high
when: no-ci, has-remote
content_min: 45
also_task: KS-CI
why: Nothing checks the code on a clean machine, so "it works on my computer" is the only proof. It is optional, and it uses CI minutes.
---

## Investigate

- Which host is the remote on, and what does its CI cost on the owner's plan?
- Which of gates.quick can run on a clean machine? What do they need (runtime, install step, services, secrets)?
- How long do they take, so what would a month of pushes cost?

## Plan and build

- One workflow that runs exactly gates.quick on a push to the base branch and on pull requests, not a list of its own.
- Least rights, superseded runs cancelled, docs-only pushes skipped, actions pinned.
- The first run can only be checked after the owner pushes: say so.

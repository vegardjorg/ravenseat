---
title: Add a linter
category: quality
priority: medium
when: known-stack, missing:lint
content_min: 30
why: A linter catches common mistakes and unused code, and keeps what the agents write consistent.
---

## Investigate

- Which linter is standard for this stack, with the recommended rules only?
- How many findings does it give today, and how many can it fix by itself?

## Plan and build

- The linter with the recommended rules and one command.
- The automatic fixes as a separate step, so they do not hide in other changes.
- Add it as a gate when it passes.

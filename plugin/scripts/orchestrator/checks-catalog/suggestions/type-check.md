---
title: Add a type check
category: quality
priority: medium
when: known-stack, missing:types
content_min: 45
why: A type check finds wrong names and wrong values in seconds, without running the code. It is especially useful when agents change code they did not write.
---

## Investigate

- Which tool fits (tsc for JavaScript and TypeScript, mypy or pyright for Python)?
- How many errors does it give on the code today, with the mildest useful setting?

## Plan and build

- The tool with a mild setting, and one command that runs it.
- A way to handle the errors that exist today (fix now, or a baseline), then add it as a gate.
- No full conversion to a new language.

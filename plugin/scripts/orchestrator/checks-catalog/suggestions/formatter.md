---
title: Add a formatter
category: quality
priority: low
when: known-stack, missing:format
content_min: 30
why: Agents format code differently from each other and from you. Without a formatter, the same change gives larger diffs and more merge conflicts between tracks, and reviews spend time on spacing.
---

## Investigate

- Which formatter fits the stack (Prettier or Biome for JS and TS, Black or ruff format for Python, gofmt for Go, rustfmt for Rust)?
- How much of the code would change on the first run?

## Plan and build

- The formatter with a config file in git, one script or command to run it, and a check mode (`--check`) as a quick gate.
- The first run as its own commit, so it does not hide in a feature change (and can go in .git-blame-ignore-revs).

---
title: Find unused code and dependencies
category: quality
priority: low
when: known-stack, missing:unused
content_min: 30
why: Code and libraries nobody uses still cost: agents read them and change them, reviews look at them, and each unused library is one more thing that can have a hole. A tool finds them in seconds (knip for JS and TS, vulture for Python, cargo-udeps or cargo-machete for Rust, deadcode for Go).
---

## Investigate

- Which tool fits the stack, and what does it report today?
- Which findings are real, and which are entry points or config the tool cannot see?

## Plan and build

- The tool with a config that lists the real entry points, run as a gate or in CI once the first findings are handled.
- The findings that are safe to remove today, as proposals.

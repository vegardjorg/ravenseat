---
title: Check your libraries for known holes
category: dependencies
priority: medium
when: known-stack, missing:audit
content_min: 30
why: Most code in a project is other people's libraries, and holes in them get published. The tool only has to compare versions.
---

## Investigate

- Which audit command fits the stack, and what does it report today?
- Which findings affect code that goes live, and which only affect development tools?

## Plan and build

- One audit step on a schedule or on pull requests, set so that development-only noise does not stop work.
- The findings that matter today as proposals for fixes.

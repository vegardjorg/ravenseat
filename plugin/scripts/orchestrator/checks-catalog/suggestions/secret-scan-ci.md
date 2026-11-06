---
title: Scan for secrets in CI
category: security
priority: low
when: has-ci, missing:secret-scan
content_min: 30
why: ravenseat checks your own pushes for secrets. A scan in CI also catches pushes from others and from outside the queue.
---

## Investigate

- Which scanner fits (gitleaks is a common start), and does the host offer one for free?
- Does a run over the current code give real findings or only noise?

## Plan and build

- One scan step on pushes and pull requests, with a short list of known false findings if needed.
- Real findings go to the owner, with files and never values.

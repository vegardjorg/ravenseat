---
title: Find copied code in CI
category: quality
priority: low
when: known-stack, has-ci, none-in-ci:duplication
important_when: ledger-recent:duplication
content_min: 30
why: Parallel tracks often write the same code twice under different names. Receive already names a helper the base defines with the same name (NOTE reuse), but a copy with a new name, or a block pasted into a function, slips past it. A copy detector in CI compares the code itself, with no agent and no tokens. It turns important only when the finding log shows duplication three times in one area within 30 days.
---

## Investigate

- Which detector fits the stack, and is it still maintained (look at its last release before you pick it)? The usual ones:
  - JS and TS (and most other languages): jscpd, `npx jscpd --gitignore --min-tokens 50 --reporters console src`.
  - Python: pylint's duplicate-code check, `pylint --disable=all --enable=duplicate-code <package>`.
  - Java, Kotlin, C# and more: PMD CPD, `pmd cpd --minimum-tokens 100 --dir src`.
  - Go: dupl, `dupl -t 100 .` (also a linter in golangci-lint).
  - Ruby: flay. Rust and the rest: jscpd covers them.
- What it reports today: how many copies, how many are real, and how many are generated code, tests or fixtures to leave out.
- Which copies are the same helper the NOTE reuse lines at receive have named, so the two point at one clean-up.

## Plan and build

- One CI step with the chosen tool, its config file in git (for jscpd `.jscpd.json` with `ignore` and `threshold`), and the folders it leaves out.
- A start that does not go red: report only first, then a threshold at today's level, so only new copies fail. Lower it as copies are cleaned up.
- The copies worth merging today, each as a proposal of its own, not as part of this change.
- The cost in CI minutes; a copy detector is usually seconds.
- Do not install or run it outside the plan, and do not make it a gate in the queue before CI has run it green for a while.

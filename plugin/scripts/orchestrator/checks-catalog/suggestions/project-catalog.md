---
title: Write down the stack and the design choices
category: quality
priority: low
when: known-stack, catalog-missing
important_when: ledger-recent:duplication|scope-drift
content_min: 20
action: ask
why: A track only knows what it reads. Without a short catalog of what the project uses, which helpers to reuse and which design choices hold, a track writes a helper again, adds a second library for the same job or makes an architecture choice nobody asked for. The catalog lives in docs/queue/catalog/, is tracked in git, and only you can accept a design choice. It turns important only when the finding log shows duplication or scope drift three times in one area within 30 days.
---

## Ask Claude

Run `ravenseat catalog init` to write a first draft of `docs/queue/catalog/` from my manifests. Then read the code and propose, for me to decide: the "Prefer" lines for `stack.md` (one per job, such as dates, HTTP, validation, logging, tests: what to use and what not to add), the few building blocks for `reuse.md` that a track would not find by itself, and at most five design choices as `decisions/D-0001-<slug>.md` with `status: proposed`, each with one invariant that can be checked and the paths it covers. Do not set any choice to accepted: I do that with `ravenseat catalog accept <id> --by owner`. Run `ravenseat catalog check` and show me what it says. Show me the diff and change nothing more until I say yes; I commit the folder myself.

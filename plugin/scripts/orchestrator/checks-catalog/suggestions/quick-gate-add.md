---
title: Run a built gate guard on every merge
category: tests
priority: medium
when: guard-not-in-quick
action: quick-gate
content_min: 5
why: A gate guard in the registry only guards when a gate runs its command. Its command is not in gates.quick, so a merge can go through without it. One click adds the command at the end of gates.quick; nothing runs from the card, and the write never removes or replaces a command.
---

## Investigate

- Is the command fast enough to run on every merge? A slow one may belong in gates.full instead.

## Plan and build

- Add the command to gates.quick with `ravenseat checks quick-add <G-n>`, then commit queue.config.json.

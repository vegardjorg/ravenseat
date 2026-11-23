---
title: A heavy run without a track has run long
category: machine
priority: low
when: processes-untagged
content_min: 5
action: ask
why: A gate command, done command or base gate Ravenseat started has run for more than 30 minutes and belongs to no track, so no track's time or silence covers it. It is often a full gate in the main checkout and fine, but a hanging one blocks the next base gate and slows every track. Display only: nothing is stopped.
---

## Ask Claude

Ravenseat's process guard shows a long heavy run without a track (the card names the pid, the command, its age and the stop command). Run `ravenseat doctor` and show me its `processes` rows. Tell me what the run is (the command line, read only) and whether it still makes progress (its output or the gate log). Only if I say so, end it with the stop command from the card.

---
title: A track runs far over its estimate
category: machine
priority: medium
when: tracks-overtime
content_min: 5
action: ask
why: A running track has been at work for more than tracks.overtimeFactor times its estimate (2 by default). It may be busy and fine, stuck in a loop the silence check cannot see because it keeps working, or the task was bigger than planned. A warning only: the track is never stopped. tracks.overtimeFactor 0 turns it off.
---

## Ask Claude

Ravenseat says a running track is far over its estimate (the card names the track, the minutes it has run and its estimate). Run `ravenseat explain <id>` for each and tell me what it is doing now, whether it still makes progress (commits, the track's report) and whether the task is bigger than planned. Suggest one of: let it run, `ravenseat resume <id> --reason context`, or split the task. Do not stop or change the track without asking me.

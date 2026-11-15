---
title: Keep the queue's files in git as a backup
category: security
priority: low
when: off:share.queueData,repo-private
content_min: 1
action: setting
setting: share.queueData
why: The queue (queue.json) and the plan register (plans.json) live only on this machine, ignored by git. This repo is private, so Turn on can keep those two in git as a backup, readable by everyone with access to the repo and its forks. Everything else in the data folder stays ignored: the time log, missions, reports, answers, locks and evidence can never be shared. The push guard refuses a commit with them if the repo later turns public. Off again with ravenseat share off.
---

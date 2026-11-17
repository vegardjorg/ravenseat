---
title: Scan each track's commits for keys at receive
category: security
priority: low
when: off:secretScan.atReceive
important_when: secrets-open
content_min: 1
action: setting
setting: secretScan.atReceive
why: The push check stops a key from leaving your machine, but once a track is merged the key is already in the base branch's history. Turned on, receive scans the track's own commits and a hit stops the merge until the track takes it out. High when a secret file is already in git, which shows that keys do get committed here.
---

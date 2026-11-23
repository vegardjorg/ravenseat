---
title: Possible keys in the repo or its history
category: security
priority: high
when: has-git, keyscan-open
content_min: 5
action: ask
why: The last `ravenseat secrets scan` found text shaped like a key in a file git tracks, or in an old commit. Anyone with a copy of the repo can read it, also after the file is deleted. Changing (rotating) a real key where it was issued is the fix that works; purging the history is a separate step done by hand. The card shows counts only, never a value. A false alarm is set aside by its hash with `ravenseat secrets ignore <hash>`.
---

## Ask Claude

Run `ravenseat secrets scan --history` and show me its list (file, line or commit, rule, hash). Never print, quote or repeat a matched value, also not in part. For each finding, look at the named line only to judge whether it is a real key or a test value, a placeholder or a pattern, and tell me which and why. For a real key: tell me where it was most likely issued so I can change it there, then help me move it out of the code into an environment variable or a password manager. For one that is only in the history: explain what purging with git filter-repo would mean for this repo and its clones, but do not run anything that rewrites the history or force-pushes. For a false alarm, after I say yes, run `ravenseat secrets ignore <hash>`.

---
title: Propose a guard when the same kind of failure keeps coming back
category: tests
priority: low
when: off:learning.proposals, ledger-due
content_min: 5
action: setting
setting: learning.proposals
why: The finding log shows the same class of failure in the same part of the code in separate tasks (or three times across the project), and nothing proposes a guard for it yet. With this on, each such class and place becomes one gate task proposed to you, never approved by itself, red first like every gate task. It shares one cap of three open proposals with the inspection queue and the gate lines, and a proposal you cancel is not made again for that class and place. Off by default, since a proposal asks for your time.
---

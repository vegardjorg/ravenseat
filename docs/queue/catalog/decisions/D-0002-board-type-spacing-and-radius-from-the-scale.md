---
id: D-0002
title: Board type, spacing and radius from the scale
status: proposed
kind: design
source: ["plugin/scripts/orchestrator/queue-board/board.css","plugin/scripts/orchestrator/lib/__tests__/queueBoardScale.test.ts"]
paths: ["plugin/scripts/orchestrator/queue-board/**"]
invariant: Board styles take font sizes, spacing and radii from the --text-*, --distance-* and --radius* tokens; no text under 12 px, weights only 400 and 600.
supersedes: null
plan: null
---
The scale is in board.css; queueBoardScale.test.ts counts raw px so the number only goes down.
No check rule here: the test already guards it, and a line rule would hit the scale definitions themselves.

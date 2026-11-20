---
id: D-0003
title: Board surfaces by role
status: proposed
kind: design
source: ["plugin/scripts/orchestrator/queue-board/board.css"]
paths: ["plugin/scripts/orchestrator/queue-board/**"]
invariant: The app root is surface-container-low, a card is surface-container-lowest, a sheet or panel is surface; a new piece takes the role it is, not a nearby colour.
supersedes: null
plan: null
---
The roles are named at the top of board.css. They keep the rooms the same depth in light and dark.

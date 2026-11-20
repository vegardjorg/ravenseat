---
id: D-0001
title: Board colours only from the tokens
status: proposed
kind: design
source: ["plugin/scripts/orchestrator/lib/queueBoard.js#PALETTE","plugin/scripts/orchestrator/queue-board/board.css"]
paths: ["plugin/scripts/orchestrator/queue-board/**"]
invariant: Board code takes every colour from the --color-* tokens (light and dark); no hex, rgb() or hsl() outside the palette, except black rgb() for shadows and the scrim.
check:
  forbid: "(?<![\\w&/=?#])#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\b|(?:^|[:,(]|\\s)#[0-9a-fA-F]{3,4}\\b(?![\\w-]|\\s*[{.:\\[>~+]|\\s+[A-Za-z])|\\b(?:rgb|hsl)a?\\((?!\\s*0[\\s,]+0[\\s,]+0\\b)"
  hit: ["  color: #1a73e8;","background: rgba(20, 30, 40, .4)","  border: 1px solid #ccc;"]
  miss: ["color: var(--color-primary);","box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);","<a href=\"#add\">","see issue #123 in the tracker"]
  mode: "warn"
supersedes: null
plan: null
---
The board has one palette (lib/queueBoard.js PALETTE, light and dark) written into board.css as --color-* tokens.
A colour set by hand breaks dark mode and the contrast checks, so board code names a token. Black rgb() stays for
shadows and the scrim, which are the same in both themes. The palette itself lives outside these paths.

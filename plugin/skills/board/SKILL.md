---
name: board
description: Start the local queue board (kanban, plans, dependencies, statistics, "Waiting on you") for the current project; it opens itself in the user's browser. Use when the user types "/ravenseat:board", "start the board", "open the board", "show me the queue board", or asks how to see the board.
---

# Start the board

The board is a small local web server (`ravenseat board`). It keeps running until it is stopped, so it must never run in
the foreground: that would block this chat until the command times out.

The board's key gives every owner action, so it is kept from you: the board opens the user's browser itself with the
key, and prints the link without it. Never look for the key, never pass `--key-file`, and never call the board's API.

1. Check that the project has the queue: `queue.config.json` in the project root. If not, offer `/ravenseat:setup` and stop.
2. Start it with the Bash tool **in the background** (`run_in_background: true`):

   ```
   ravenseat board
   ```

   Add `--port <n>` only if the user asks for another port (default: `board.port` in `queue.config.json`, else 2000).
3. Wait for the line `Opened the board in your browser.` and tell the user the board is open in their browser. If it
   says it could not open a browser, pass that line on as it is. The key changes on every start; a tab with an old key
   says "The key is old".
4. Tell the user in two short lines:
   - `ravenseat board open` opens the running board again (a closed tab, or another browser window), and `--task <id>` opens it on that card; the board runs
     while this Claude Code session runs; ask again, or run `/ravenseat:board`, to restart it;
   - to run it from their own terminal instead (it then keeps running after Claude Code closes), from the project
     folder: `node "<plugin root>/scripts/orchestrator/ravenseat.mjs" board`. Find `<plugin root>` with
     `dirname "$(dirname "$(command -v ravenseat)")"` in the Bash tool and give them the full command, not the placeholder.

If the port is taken, a board may already run there: offer `ravenseat board open` first, then another port with
`--port`. Do not stop a process you did not start.

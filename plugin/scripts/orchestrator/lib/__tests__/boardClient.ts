// =============================================================
// boardClient.ts: test helper (not a test) for the board's client scripts in queue-board/.
//
// The board itself is classic scripts in queue-board/board/ that share the page's global scope (see docs/board.md).
// The tests run the client with an indirect eval in jsdom, and a strict eval keeps its top-level names to itself, so
// the board's scripts are joined into one text (in the order index.html loads them) and evaluated once, which gives
// them one shared scope, as in the browser.
// =============================================================
import { readFileSync } from 'fs';
import { join } from 'path';

export const CLIENT = join(__dirname, '..', '..', 'queue-board');

/** The board's own scripts as paths under queue-board/ ('board/core.js', ...), in the order index.html loads them. */
export function boardScripts(): string[] {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  return [...html.matchAll(/<script src="\/(board\/[a-z]+\.js)" defer><\/script>/g)].map((m) => m[1]);
}

/** All of the board's scripts joined in load order (one text, for one indirect eval or a text check). */
export function boardSource(): string {
  return boardScripts()
    .map((f) => readFileSync(join(CLIENT, f), 'utf8'))
    .join('\n');
}

/**
 * The source of one client script for the indirect eval: a path under queue-board/ ('a11y.js', '../lib/queueGraph.js'),
 * or 'board/' for all of the board's own scripts as one text.
 */
export function clientSource(f: string): string {
  return f === 'board/' ? boardSource() : readFileSync(join(CLIENT, f), 'utf8');
}

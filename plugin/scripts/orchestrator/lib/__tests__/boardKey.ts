// =============================================================
// boardKey.ts: how a test gets the board's key now that the board never prints it (0l bolk 5).
//
// The board writes the link with the key to the file given with --key-file (and opens no browser then). A test starts
// the board with keyFileArgs().args and reads [line, base, key] with boardOpen(out, file) once the start line is there,
// the same shape as the old match on "Open: http://...#key=...". `boardOrigin` is the Origin a browser sends on a POST
// from the board; a write without it is refused while the key is hidden.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The start line without the key: "Open: http://127.0.0.1:<port>/ (...)". */
export const START_LINE = /Open: (http:\/\/[^/\s]+)\//;

/** The board's extra arguments with a fresh key file, and that file. */
export function keyFileArgs(): { args: string[]; file: string } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'board-key-')), 'link.txt');
  return { args: ['--key-file', file], file };
}

/** [start line, base url, key] once the start line and the key file are both there; null before. */
export function boardOpen(out: string, file: string): RegExpExecArray | null {
  const m = START_LINE.exec(out);
  if (!m || !fs.existsSync(file)) return null;
  const k = /#key=([A-Za-z0-9_-]+)/.exec(fs.readFileSync(file, 'utf8'));
  if (!k) return null;
  const r = [m[0], m[1], k[1]] as unknown as RegExpExecArray;
  r.index = m.index;
  r.input = out;
  return r;
}

/** The Origin header the board's own page sends, for a base url like http://127.0.0.1:2000. */
export const boardOrigin = (base: string) => ({ origin: base });

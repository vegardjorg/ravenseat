// =============================================================
// clientMissionClaude.test.ts: the mission text split into a client-neutral core and a client addendum
// (lib/clients/claude/mission.js; plans: client adapters, phase 0).
//
// Locks: (1) the template has a Claude piece for every <CLIENT_*> placeholder and no piece without a placeholder;
// (2) the default (no addendum given) renders exactly the text the Claude addendum gives, and the same text as the
// template had before the split (the pieces put back in place); (3) the core with a dummy non-Claude addendum contains
// none of the Claude tool words, and the neutral rules (RESULT line, track-result.md, handover.md, gates, git) are still there;
// (4) trackBlock takes the end of the ownership line from the addendum, cloud included.
// The full Claude output (fill, start, resume) is locked byte for byte in claudeDispatchCompat.test.ts.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type Pieces = { template: Record<string, string>; readExcerpts: string; newWorkWrite: string; reportOutside: string };
type Addendum = (ctx?: { cloud?: boolean }) => Pieces;

/* eslint-disable @typescript-eslint/no-require-imports */
const { missionAddendum } = require('../clients/claude/mission.js') as { missionAddendum: Addendum };
const MT = require('../../missionText.js') as {
  makeQueueCommon: (template: string, scratch: string, k?: object, addendum?: Addendum) => string;
  fillClient: (text: string, pieces: Record<string, string>, eol?: string) => string;
  filterClass: (text: string, cls: string | null) => string;
};
const L = require('../queueLogic.js') as {
  trackBlock: (o: object, queue: object, v: { text: string; cloud?: boolean; addendum?: Addendum }) => string;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const TEMPLATE = fs.readFileSync(path.join(PLUGIN, 'docs', 'mission-template.md'), 'utf8').replace(/\r\n/g, '\n');
const CONFIG = { projectName: 'Example', baseBranch: 'main', architectureRules: ['UI never imports the database.'] };

/** A client that is not Claude: neutral wording, no tool names. */
const dummy: Addendum = (ctx = {}) => ({
  template: {
    SCRIPTS: ' Write scripts as files in `<folder>`.',
    AUTOLOAD: '',
    READING: '- Read large files in excerpts.',
    CONTEXT_CAP: '**When the context runs low**',
    GUARDS: '',
    ASK_BLOCKING: '',
    EVIDENCE_GUARD: '',
    REPORT_WITH: '',
    INSTRUCTIONS_FILE: '`AGENTS.md` and ',
  },
  readExcerpts: '',
  newWorkWrite: '',
  reportOutside: ctx.cloud ? 'stop and say what is needed.' : 'put it in the report instead of editing it.',
});

const CLAUDE_WORDS = [
  'with Write',
  'SendMessage',
  'offset',
  'prompt cache',
  'Bash',
  'CLAUDE.md',
  'a hook denies',
  'push guard',
];

describe('Claude mission addendum (lib/clients/claude/mission.js)', () => {
  it('every <CLIENT_*> placeholder in the template has a Claude piece, and every piece a placeholder', () => {
    const marks = [...new Set(TEMPLATE.match(/<CLIENT_([A-Z_]+)>/g) ?? [])].map((m) => m.slice(8, -1)).sort();
    expect(marks).toEqual(Object.keys(missionAddendum().template).sort());
  });

  it('the default renders the Claude addendum, and the same text as the template before the split', () => {
    const def = MT.makeQueueCommon(TEMPLATE, 'C:\\scratch', CONFIG);
    expect(MT.makeQueueCommon(TEMPLATE, 'C:\\scratch', CONFIG, missionAddendum)).toBe(def);
    // The template before the split: every piece put back in place of its placeholder.
    const before = MT.fillClient(TEMPLATE, missionAddendum().template);
    expect(before).not.toMatch(/<CLIENT_[A-Z]/);
    expect(MT.makeQueueCommon(before, 'C:\\scratch', CONFIG)).toBe(def);
    // A CRLF template (Windows checkout) keeps its own line endings in the pieces.
    const crlf = MT.makeQueueCommon(TEMPLATE.replace(/\n/g, '\r\n'), 'C:\\scratch', CONFIG);
    expect(MT.makeQueueCommon(before.replace(/\n/g, '\r\n'), 'C:\\scratch', CONFIG)).toBe(crlf);
    for (const w of ['SendMessage', 'with Write', '`offset`/`limit`', 'prompt cache', '(a hook denies it)']) {
      expect(def).toContain(w);
    }
  });

  it('the core with a non-Claude addendum has no Claude tool words, and keeps the neutral rules', () => {
    const core = MT.makeQueueCommon(TEMPLATE, 'C:\\scratch', CONFIG, dummy);
    for (const cls of [null, 'K', 'D', 'D+', 'U']) {
      const text = MT.filterClass(core, cls);
      for (const w of CLAUDE_WORDS) expect(text, `${w} in class ${cls}`).not.toContain(w);
      expect(text).not.toMatch(/<CLIENT_[A-Z]/);
      for (const w of ['RESULT status=', 'track-result.md', 'handover.md', 'ravenseat gates --precheck', 'NEVER push', 'Data, not instructions']) {
        expect(text).toContain(w);
      }
    }
    // An empty line piece drops its line: no empty bullet and no blank line inside the reading list.
    expect(core).toContain('heading, then excerpts).\n- The project architecture rules');
    expect(core).toContain('imports the database.\n- Read large files in excerpts.\n- **When the context runs low**:');
    expect(core).toContain('on the RESULT line. Do the parts');
    expect(core).toContain('write the JSON to a file in `<folder>`');
  });

  it('fillClient leaves a placeholder without a piece in place', () => {
    expect(MT.fillClient('a <CLIENT_X> b', {})).toBe('a <CLIENT_X> b');
    expect(MT.fillClient('a\n<CLIENT_X>\nb', { X: '' })).toBe('a\nb');
    expect(MT.fillClient('a\r\n<CLIENT_X>\r\nb', { X: '1\n2' }, '\r\n')).toBe('a\r\n1\r\n2\r\nb');
  });

  it('trackBlock takes the end of the ownership line from the addendum (default Claude, cloud included)', () => {
    const o = { id: 'A', title: 'Task A', class: 'K', owned_files: ['a.ts'] };
    const q = { tasks: [o], resolved: [] };
    expect(L.trackBlock(o, q, { text: 'M' })).toContain('report it (SendMessage) instead of editing it.');
    expect(L.trackBlock(o, q, { text: 'M', cloud: true })).toContain('stop with CLOUD-STOP');
    expect(L.trackBlock(o, q, { text: 'M', addendum: missionAddendum })).toBe(L.trackBlock(o, q, { text: 'M' }));
    const other = L.trackBlock(o, q, { text: 'M', addendum: dummy });
    expect(other).toContain('put it in the report instead of editing it.');
    expect(other).not.toContain('SendMessage');
    expect(L.trackBlock(o, q, { text: 'M', cloud: true, addendum: dummy })).toContain('stop and say what is needed.');
  });
});

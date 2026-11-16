// =============================================================
// failureClasses.test.ts: the failure class taxonomy as data (lib/failureClasses.js): the core list, a project's own
// additions and switches in docs/queue/failure-classes.json, and the rules that keep a bad file from breaking anything.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const FC = require('../failureClasses.js');

/** A temp project root with docs/queue/failure-classes.json holding `content` (a string is written as is). */
function project(content?: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
  if (content !== undefined) {
    fs.mkdirSync(path.join(root, 'docs', 'queue'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'docs', 'queue', 'failure-classes.json'),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return root;
}

describe('coreClasses', () => {
  it('has the 17 ids of the contract, other last, each with a title', () => {
    const ids = FC.coreClasses().map((c: { id: string }) => c.id);
    expect(ids).toHaveLength(17);
    // Repeated work and work outside the mission are counted per area, so they get their own classes.
    expect(ids).toContain('duplication');
    expect(ids).toContain('scope-drift');
    expect(ids).toContain('unchecked-error');
    expect(ids).toContain('ui-state');
    expect(ids[ids.length - 1]).toBe('other');
    for (const c of FC.coreClasses()) expect(c.title.length).toBeGreaterThan(3);
  });
  it('a caller cannot change the core list by mutating what it got', () => {
    FC.coreClasses()[0].id = 'changed';
    expect(FC.coreClasses()[0].id).toBe('unchecked-error');
  });
});

describe('normalizeClass', () => {
  it('a known id stays, an unknown id, "-", case and junk become other', () => {
    expect(FC.normalizeClass('time-zone')).toBe('time-zone');
    expect(FC.normalizeClass('-')).toBe('other');
    expect(FC.normalizeClass('Time-Zone')).toBe('other');
    expect(FC.normalizeClass('made-up')).toBe('other');
    expect(FC.normalizeClass(null)).toBe('other');
  });
  it('called with one argument (as lib/findingLog.js does) it checks against the core classes', () => {
    expect(FC.normalizeClass('data-loss')).toBe('data-loss');
    expect(FC.normalizeClass('-')).toBe('other');
    expect(FC.normalizeClass('audit-trail')).toBe('other');
  });
});

describe('promptLine', () => {
  it('every reviewer file names exactly the core classes, so the agents cannot drift from the JSON', () => {
    const dir = path.join(__dirname, '..', '..', '..', '..', 'agents');
    const want = FC.promptLine(FC.coreClasses()).replace(/\.$/, '');
    const files = fs.readdirSync(dir).filter((f: string) => /^reviewer.*\.md$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) {
      const line = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).find((l: string) => l.trim().startsWith('Classes: '));
      expect(line, f).toBeDefined();
      expect(line!.trim().replace(/\)$/, '').replace(/\.$/, ''), f).toBe(want);
    }
  });
  it('is one short line with every id', () => {
    const line = FC.promptLine(FC.coreClasses());
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(300);
    for (const c of FC.coreClasses()) expect(line).toContain(c.id);
  });
});

describe('classesFor', () => {
  it('without a project file it is the core list, no warnings', () => {
    const r = FC.classesFor(project());
    expect(r.classes.map((c: { id: string }) => c.id)).toEqual(FC.coreClasses().map((c: { id: string }) => c.id));
    expect(r.warnings).toEqual([]);
  });
  it('a project adds a kebab-case class and turns a core class off', () => {
    const r = FC.classesFor(
      project({ classes: [{ id: 'audit-trail', title: 'missing audit row' }, { id: 'time-zone', off: true }] }),
    );
    const ids = r.classes.map((c: { id: string }) => c.id);
    expect(ids).toContain('audit-trail');
    expect(ids).not.toContain('time-zone');
    expect(ids[ids.length - 1]).toBe('other');
    expect(FC.normalizeClass('audit-trail', r.classes)).toBe('audit-trail');
    expect(FC.normalizeClass('time-zone', r.classes)).toBe('other');
    expect(r.warnings).toEqual([]);
  });
  it('a new id that collides with the core, is not kebab-case, or tries to turn other off is ignored with a warning', () => {
    const r = FC.classesFor(
      project({
        classes: [
          { id: 'injection', title: 'my own injection' },
          { id: 'Bad Id', title: 'x' },
          { id: 'no-title' },
          { id: 'other', off: true },
          'just a string',
        ],
      }),
    );
    expect(r.classes.find((c: { id: string }) => c.id === 'injection').title).toBe(
      FC.coreClasses().find((c: { id: string }) => c.id === 'injection').title,
    );
    expect(r.classes.map((c: { id: string }) => c.id)).toContain('other');
    expect(r.classes.map((c: { id: string }) => c.id)).not.toContain('Bad Id');
    expect(r.warnings.length).toBe(5);
  });
  it('a broken file never throws: the core list and one warning', () => {
    for (const bad of ['{ not json', '"a string"', '[1,2]', '{"classes": 7}']) {
      const r = FC.classesFor(project(bad));
      expect(r.classes).toHaveLength(17);
      expect(r.warnings.length).toBeGreaterThanOrEqual(1);
    }
  });
});

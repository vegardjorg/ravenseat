// =============================================================
// secretLiterals.test.ts: the project's own secret values, redacted as literals (lib/secretLiterals.js, roadmap 1c
// SEC-T item 5, SP-1 in plans/sammy-pack-vurdering-2026-11-20.md).
//
// Why: pattern redaction misses a database password or a short self-hosted token (no provider format, under 16
// characters). The values in the project's own .env files are known secrets, so everything Ravenseat stores from
// transcripts and commands loses them as literals. Values under 6 characters and plain ones (true, localhost, numbers)
// are skipped, the example files are never read, and redact.envValues false turns it off. Temporary folders only; the
// fake values are plainly fake and joined at run time, and no test name or message holds one.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const SL = require('../secretLiterals');
const { redact } = require('../askBundle');
const { storeText } = require('../storeText');
const S = require('../silentSnapshot');

const DB = ['fake', 'db', 'pass', '42'].join('-');
const URL_PW = ['fake', 'url', 'pw9'].join('');
const LOCAL = ['fake', 'local', 'tok', 'en'].join('');
const PROD = ['fake', 'prod', 'value'].join('_');
const EXAMPLE = ['fake', 'example', 'only'].join('_');
const SHORT = ['ab', 'c1'].join('');

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});
afterEach(() => SL.reset());

/** A main tree with .env, .env.local, .env.production and .env.example. */
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-literals-'));
  temporary.push(root);
  fs.writeFileSync(
    path.join(root, '.env'),
    [
      '# a comment',
      `DB_PASSWORD=${DB}`,
      `export DATABASE_URL="postgres://app:${URL_PW}@db.internal:5432/app"`,
      `SHORT=${SHORT}`,
      'DEBUG=true',
      'PORT=5432',
      'HOST=localhost',
      'SITE=http://localhost:3000',
      'EMPTY=',
      'REF=${OTHER}',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, '.env.local'), `LOCAL_TOKEN='${LOCAL}' # set by hand\n`);
  fs.writeFileSync(path.join(root, '.env.production'), `PROD_SECRET=${PROD}\n`);
  fs.writeFileSync(path.join(root, '.env.example'), `DB_PASSWORD=${EXAMPLE}\n`);
  return root;
}

describe('which values are kept', () => {
  it('reads .env, .env.local and .env.* in the main tree; never the example files; skips short and plain values', () => {
    const root = project();
    const text = [DB, URL_PW, LOCAL, PROD, EXAMPLE, SHORT, 'true', '5432', 'localhost', 'http://localhost:3000'].join(' | ');
    const out = SL.redactLiterals(text, SL.literalsFor(root));
    for (const gone of [DB, URL_PW, LOCAL, PROD]) expect(out.text.includes(gone)).toBe(false);
    for (const kept of [EXAMPLE, SHORT, 'true', '5432', 'localhost', 'http://localhost:3000']) expect(out.text.includes(kept)).toBe(true);
    expect(out.count).toBe(4);
    expect(out.text).toContain(SL.MARK);
  });

  it('a project without .env files has none; a longer value is replaced before a shorter one inside it', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-literals-none-'));
    temporary.push(empty);
    expect(SL.literalsFor(empty)).toEqual([]);
    const out = SL.redactLiterals(`x ${DB}-more y`, [DB, `${DB}-more`]);
    expect(out.text).toBe(`x ${SL.MARK} y`);
  });
});

describe('every write route gets it (askBundle.redact, storeText, the silent snapshot)', () => {
  it('on by default: the stored text loses the literal values, and the counts name the rule, never the value', () => {
    const root = project();
    SL.reset({ mainTree: root, enabled: true });
    const tail = `gate failed: connect as app with ${DB} to db; token ${LOCAL}`;
    const r = redact(tail);
    expect(r.text.includes(DB)).toBe(false);
    expect(r.text.includes(LOCAL)).toBe(false);
    expect(r.rules['env-value']).toBe(2);
    expect(JSON.stringify(r.rules).includes(DB)).toBe(false);
    expect(storeText(tail).includes(DB)).toBe(false);
    expect(S.redactText(`said ${PROD} here`).includes(PROD)).toBe(false);
    expect(S.redactCommand(`psql -h db -c select ${LOCAL}`).includes(LOCAL)).toBe(false);
    expect(S.redactCommand(`node tool.mjs ${PROD}`).includes(PROD)).toBe(false);
  });

  it('redact.envValues false: nothing is read and the text keeps the value (the pattern rules still run)', () => {
    const root = project();
    SL.reset({ mainTree: root, enabled: false });
    expect(redact(`x ${DB} y`).text).toContain(DB);
  });
});

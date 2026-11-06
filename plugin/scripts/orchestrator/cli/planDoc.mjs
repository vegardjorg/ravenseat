// =============================================================
// cli/planDoc.mjs: the plan doc commands: the document register, the document check and the web check.
//
// plan doc lists and changes the documents; plan doc check and plan doc web check them (the web check fetches the
// published pages, at most 2 MB each).
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: cli/plans.mjs.
// Tested in: lib/__tests__/queuePlanDoc.test.ts.
// =============================================================

import fs from 'node:fs';

import { a, byName, cut, die, P, readPlans, readQueueForPlan, val, values, WIDTH } from './context.mjs';
import {
  docFindingsLine, editPlans, existsSource, planAnswer, planDiffLines, planError, planRole, readDoc,
} from './planShared.mjs';

/** Reads a page (GET only, without login, at most 2 MB, 10 s). Gives { status, text } or { error }. */
async function getPage(url) {
  try {
    const answer = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'queue-plan-doc-web' },
    });
    const text = (await answer.text()).slice(0, 2 * 1024 * 1024);
    return { status: answer.status, text };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'timeout' : (e?.code ?? e?.message ?? 'error') };
  }
}
/** The answer from `plan doc check` and `plan doc web` (text or JSON), with what was written. */
function docCheckAnswer(json, findings, ran, written) {
  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        ran,
        findings,
        ...(written
          ? {
              dry: Boolean(written.dry),
              changed_doc: written.changed,
              changes: written.changes,
              log: written.log,
              changed: written.version,
            }
          : {}),
      }),
    );
    return;
  }
  console.log(`Consistency check (${ran.join(', ')}): ${findings.length} findings.`);
  for (const f of findings) console.log(`  ${cut(docFindingsLine(f), WIDTH - 2)}`);
  if (written) {
    console.log(
      `${written.dry ? 'Preview (nothing written): ' : ''}Problems updated in ${written.changed.length} document(s)${written.changed.length ? `: ${written.changed.join(', ')}` : ''}`,
    );
    for (const l of planDiffLines(written.changes)) console.log(`  ${l}`);
    for (const x of written.warnings ?? []) console.log(`WARNING: ${x}`);
    if (written.log)
      console.log(`Changelog no. ${written.log} in plans.json; undo: ravenseat plan undo`);
  } else if (findings.some((f) => f.doc && f.check !== 'revision'))
    console.log('Enter them as problems: add --write (--dry shows them first).');
}
/** Enters the findings as problems (under the lock, logged and undoable) when --write is given. */
function docWriteFindings(findings, ran) {
  if (!a.includes('--write')) return null;
  const role = planRole();
  return editPlans('plan doc check', (reg, queue) =>
    P.syncConsistency(reg, findings, ran, {
      role,
      by: byName(),
      question: queue.question ?? {},
      existsPath: existsSource,
    }),
  );
}
/** `plan doc check [--write] [--dry] [--json]`: vendor lists and overdue revisions. */
function planDocCheck(json) {
  const r = P.docConsistency(readPlans(), readQueueForPlan(), { readDoc });
  if (!r.ran.length) {
    if (json) console.log(JSON.stringify({ ok: true, ran: [], findings: [] }));
    else console.log('The document register is empty; nothing to check.');
    return;
  }
  docCheckAnswer(json, r.findings, r.ran, docWriteFindings(r.findings, r.ran));
}
/**
 * `plan doc web [--write] [--dry] [--json]`: fetches the published web addresses (read-only, manual only) and checks that
 * they answer and show the version the register states. The lock is not held while the pages are fetched; the write takes it afterwards.
 */
async function planDocWeb(json) {
  const adr = P.webAddresses(readPlans());
  const findings = [];
  for (const { doc, pub } of adr) findings.push(...P.assessWebAnswer(doc, pub, await getPage(pub.url)));
  if (!json) console.log(`Fetched ${adr.length} web address(es).`);
  docCheckAnswer(json, findings, ['web'], docWriteFindings(findings, ['web']));
}
// ---- Documents and agreements -------------------------------------------------------------------
// `plan doc ...` writes to `documents` in plans.json with the same lock, --expect-changed, changelog and undo as
// the plan entries (editPlans). The logic (validation, versionSkew, revision, "What must be done") is in queuePlan.js.

/** One line in `plan doc show`. */
function docRow(d) {
  const miss = P.versionSkew(d).length ? ' MISS' : '';
  const nr = P.nextRevision(d);
  const rev = nr?.date
    ? `rev ${nr.date}${nr.overdue ? ' OVERDUE' : ''}`
    : nr?.event
      ? 'rev on event'
      : '';
  const ver = d.version
    ? `v${d.version}${d.current_version && d.current_version !== d.version ? ` (applies ${d.current_version})` : ''}`
    : '';
  const prob = (d.problems ?? []).length ? ` ${(d.problems ?? []).length} problem` : '';
  const fixedLine = `${d.id.padEnd(18)} ${String(d.status ?? '').padEnd(11)} ${String(d.audience ?? '').padEnd(10)} ${ver.padEnd(16)} `;
  return cut(`${fixedLine}${d.title}${rev ? `  [${rev}]` : ''}${prob}${miss}`, WIDTH);
}
/** Reads one document or a list from --file. */
function readDocFile() {
  const file = val('--file');
  if (!file) die('plan doc new --file <json> [--dry] [--json] [--set-by agent|owner]');
  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(content) ? content : [content];
}
export function planDoc(json) {
  const under = a[2];
  const ctxFor = (queue, role) => ({
    role,
    by: byName(),
    question: queue.question ?? {},
    existsPath: existsSource,
  });
  if (under === 'show') {
    const reg = readPlans();
    // A register written before the document register existed has no `documents` field: treat it as empty.
    if (!Array.isArray(reg.documents)) reg.documents = [];
    const filter = {
      group: values('--group'),
      status: values('--status'),
      audience: values('--audience'),
      priority: values('--priority'),
      problems: a.includes('--problems'),
      search: val('--search') ?? null,
      all: a.includes('--all'),
    };
    for (const g of filter.group)
      if (!P.DOC_GROUPS.some((x) => x.id === g))
        die(`unknown group ${g} (${P.DOC_GROUPS.map((x) => x.id).join(', ')})`);
    for (const st of filter.status)
      if (!P.DOC_STATUSES.includes(st)) die(`unknown status ${st} (${P.DOC_STATUSES.join(', ')})`);
    const match = P.filterDoc(reg, filter);
    const must = P.docMustBeDone(reg.documents);
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          changed: reg.changed ?? null,
          documents: match.map((d) => ({
            ...d,
            miss: P.versionSkew(d),
            next_revision: P.nextRevision(d),
            reasons: P.docReasons(d),
          })),
          must_be_done: must,
          timeline: P.revisionTimeline(reg.documents, { days: 90 }),
        }),
      );
      return;
    }
    if (!reg.documents.length) {
      console.log(
        'The document register is empty. Add documents with: ravenseat plan doc new --file <json>',
      );
      return;
    }
    if (must.length) {
      console.log('What must be done:');
      for (const m of must)
        console.log(
          cut(`  ${m.id.padEnd(18)} ${m.reasons.map((g) => g.text).join('; ')}`, WIDTH),
        );
    }
    for (const g of P.DOC_GROUPS) {
      const list = match.filter((d) => d.group === g.id);
      if (!list.length) continue;
      console.log(`\n${g.title} (${list.length})`);
      for (const d of list) console.log(`  ${docRow(d)}`);
    }
    console.log(`\n${match.length} of ${reg.documents.length} documents.`);
  } else if (under === 'get') {
    const id = a[3];
    if (!id || id.startsWith('--')) die('plan doc get <DOC-id> [--json]');
    const r = P.getDoc(readPlans(), readQueueForPlan(), id, { existsPath: existsSource });
    if (r.error.length) planError(r.error);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...r }));
      return;
    }
    const d = r.doc;
    console.log(`${d.id}: ${d.title}`);
    console.log(`Copy: ${r.copy}`);
    console.log(`  group ${d.group}, audience ${d.audience}, status ${d.status}`);
    console.log(
      `  version ${d.version ?? '-'}, current (accepted) ${d.current_version ?? '-'}`,
    );
    if (d.source)
      console.log(`  source ${d.source}${r.source_exists === false ? '  DOES NOT EXIST' : ''}`);
    for (const p of d.published ?? [])
      console.log(`  published ${p.where} ${p.version ?? ''} ${p.url ?? p.path ?? ''}`.trimEnd());
    if (d.priority)
      console.log(
        `  priority ${d.priority}${d.now_category?.length ? `/${d.now_category.join('+')}` : ''} (${d.priority_set_by}): ${d.priority_reason ?? ''}`,
      );
    if (r.next_revision?.date)
      console.log(
        `  next revision ${r.next_revision.date}${r.next_revision.overdue ? ' (OVERDUE)' : ` (in ${r.next_revision.days} days)`}`,
      );
    else if (r.next_revision?.event) console.log(`  revision ${r.next_revision.event}`);
    for (const rv of d.revisions ?? [])
      console.log(
        `  revised ${rv.date}${rv.version ? ` v${rv.version}` : ''}${rv.remark ? `: ${rv.remark}` : ''}`,
      );
    for (const g of r.miss) console.log(`  VERSION_SKEW: ${g.text}`);
    for (const p of d.problems ?? [])
      console.log(`  problem (${p.severity}): ${p.text}${p.source ? ` [${p.source}]` : ''}`);
    if (r.depends_on_docs.length)
      console.log(
        `  depended on by: ${r.depends_on_docs.map((x) => `${x.id} ${x.status ?? '?'}`).join(', ')}`,
      );
    if (r.used_by.length) console.log(`  used by: ${r.used_by.join(', ')}`);
    if (d.legal_points?.length)
      console.log(`  legal points: ${d.legal_points.join(', ')}`);
    if (r.planEntries.length)
      console.log(`  planEntries: ${r.planEntries.map((p) => p.id).join(', ')}`);
    for (const s of r.ownerQuestions)
      console.log(
        `  owner question ${s.id}${s.resolved ? ' (resolved)' : ''}${s.text ? `: ${cut(s.text, WIDTH - 20)}` : ''}`,
      );
    for (const g of r.reasons) console.log(`  MUST BE DONE: ${g.text}`);
  } else if (under === 'new') {
    const list = readDocFile();
    const role = planRole();
    const r = editPlans('plan doc new', (reg, queue) => {
      const error = [];
      const warnings = [];
      const newOnes = [];
      for (const input of list) {
        const s = P.newDoc(reg, input, ctxFor(queue, role));
        error.push(...s.error);
        warnings.push(...s.warnings);
        if (s.doc) newOnes.push(s.doc.id);
      }
      return { error, warnings, newOnes };
    });
    planAnswer(r, `${r.newOnes.length} new document(s): ${r.newOnes.join(', ')}`);
  } else if (under === 'edit') {
    const id = a[3];
    if (!id || id.startsWith('--'))
      die('plan doc edit <DOC-id> [--field name=val ...] [--set \'{"field":...}\'] [--dry] [--json]');
    const t = P.parseFieldArg(values('--field'));
    if (t.error.length) die(t.error.join('\n'));
    let field = t.field;
    if (val('--set') != null) {
      try {
        field = { ...field, ...JSON.parse(val('--set')) };
      } catch (e) {
        die(`--set is not valid JSON: ${e.message}`);
      }
    }
    if (!Object.keys(field).length) die("no field to edit (--field name=val or --set '{...}')");
    const role = planRole();
    const r = editPlans('plan doc edit', (reg, queue) =>
      P.editDoc(reg, id, field, ctxFor(queue, role)),
    );
    planAnswer(r, `Changed ${id}${r.boost ? ' (lifted to now/security by rule 1)' : ''}`);
  } else if (under === 'revise') {
    const id = a[3];
    if (!id || id.startsWith('--'))
      die(
        'plan doc revise <DOC-id> [--version v] [--date YYYY-MM-DD] [--remark "..."] [--dry] [--json]',
      );
    const role = planRole();
    const r = editPlans('plan doc revise', (reg, queue) =>
      P.reviseDoc(
        reg,
        id,
        {
          version: val('--version') ?? null,
          date: val('--date') ?? null,
          remark: val('--remark') ?? null,
          by: byName(),
        },
        ctxFor(queue, role),
      ),
    );
    planAnswer(r, `Revision registered for ${id}`);
  } else if (under === 'check') {
    planDocCheck(json);
  } else if (under === 'web') {
    planDocWeb(json).catch((e) => die(`plan doc web failed: ${e?.message ?? e}`));
  } else {
    die('Use: ravenseat plan doc <show|get|new|edit|revise> ...  (see the top of the file)', under ? 1 : 0);
  }
}

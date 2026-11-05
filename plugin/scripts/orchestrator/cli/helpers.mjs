// =============================================================
// cli/helpers.mjs: the helpers command: the helper agents (list, on/off, and the custom helpers add, scan, approve, when, remove).
//
// Every write goes to queue.json under the lock and wins over queue.config.json; the board's Helper agents tab calls
// this command. The rules are in lib/queueHelpers.js, lib/helperFiles.js and lib/helperScan.js.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueHelpers.test.ts, helperCustom.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import { a, CONFIG, CQ, cut, die, edit, HELP, MAIN_TREE, positional, read, require, val, values } from './context.mjs';

/** `cq helpers` (the usage is at the top of queue.mjs). */
/** `cq guidance [guided|quiet]`: the one switch for advice about the project (lib/guidance.js). Never a guard. */
export function cmdGuidance() {
  const GD = require('./lib/guidance.js');
  const wanted = a[1];
  if (wanted && !GD.MODES.includes(wanted)) die(`Use: ${CQ} guidance [${GD.MODES.join('|')}]`);
  if (wanted)
    edit((queue) => {
      if (wanted === 'quiet') queue.guidance = 'quiet';
      else delete queue.guidance;
    });
  const mode = GD.modeOf(read());
  console.log(
    mode === 'quiet'
      ? `Guidance: quiet. No advice about CI, gates or lockfiles, no light review, no intake triage, no gate proposals. The secret check, merge guard, base gate and the limits on agents stay on. A helper you switch on yourself stays on. Back: ${CQ} guidance guided.`
      : `Guidance: guided. Ravenseat points out what is missing and offers next steps. For no advice: ${CQ} guidance quiet.`,
  );
}

export function cmdHelpers() {
  // ---- The helper agents (lib/queueHelpers.js): list, switch one on or off, and the custom helpers of the project
  // (add, scan, approve, when, remove). Every write goes to queue.json (helpers.<agent>) under the lock, like `limit`,
  // and wins over queue.config.json. The board's "Helper agents" tab calls this command (it never writes the files
  // itself, and it can never approve). A custom helper's file is checked against its approved sha256 here (lib/
  // helperFiles.js); one that changed is turned off. Nothing in an agent file is ever run: it is read, hashed, scanned
  // and copied. ----
  const HF = require('./lib/helperFiles.js');
  const HS = require('./lib/helperScan.js');
  const [, mode, name] = a;
  const WITH_VALUE = ['--name', '--classes', '--labels', '--paths', '--mostly-paths', '--title', '--text', '--by', '--sha256'];
  const verified = () => HF.verifiedSetup(CONFIG, read(), MAIN_TREE);
  // A custom helper by name (for scan, approve, when, remove), or stop with a clear message.
  const customHelper = (n, { registeredOnly = false } = {}) => {
    const { setup, hashes } = verified();
    const h = setup[String(n ?? '')];
    if (!h) die(`${n ?? '(no name)'} is not a helper (cq helpers lists them)`);
    if (h.source !== 'custom') die(`${n} is a builtin helper: only custom helpers are added, scanned and approved`);
    if (registeredOnly && !h.registered)
      die(`${n} comes from queue.config.json (helpers), not from cq helpers add: change it there`);
    return { h, current: hashes[n] ?? null };
  };
  const readAgent = (h) => {
    const abs = HF.insideRoot(MAIN_TREE, h.path);
    if (!abs || !fs.existsSync(abs)) die(`The agent file ${h.path ?? '(no path)'} is missing.`);
    const buffer = fs.readFileSync(abs);
    return { abs, text: buffer.toString('utf8'), sha256: HF.sha256(buffer) };
  };
  const conditions = (target) => {
    for (const [flag, key] of [
      ['--classes', 'classes'],
      ['--labels', 'labels'],
      ['--paths', 'paths'],
      ['--mostly-paths', 'mostlyPaths'],
    ])
      if (a.includes(flag)) target[key] = HELP.splitList(values(flag));
    return target;
  };

  if (mode === 'add') {
    const [file] = positional(2, WITH_VALUE);
    if (!file) die('use: cq helpers add <file.md> [--name <name>] [--classes K,U] [--labels a,b] [--paths p,q]');
    const src = HF.readSource(file, process.cwd());
    if (src.error) die(src.error);
    const fm = HS.readFrontmatter(src.text.split(/\r?\n/));
    if (!fm.found) die(`${file} has no frontmatter (--- name, description, tools ---): not an agent definition`);
    const fromFile = fm.keys.name?.value?.replace(/^['"]|['"]$/g, '') || path.basename(src.abs, path.extname(src.abs));
    const wanted = val('--name') ?? fromFile;
    const target = HELP.agentFile(wanted);
    const check = HELP.checkNewName(wanted, {
      config: CONFIG,
      setup: verified().setup,
      fileExists: fs.existsSync(path.join(MAIN_TREE, target)),
      pluginAgents: HF.pluginAgentNames(),
    });
    if (check.error) die(check.error);
    const text = HELP.withAgentName(src.text, check.name);
    const description = (fm.keys.description?.value ?? '').replace(/^['"]|['"]$/g, '');
    const r = edit((queue) => {
      const abs = path.join(MAIN_TREE, target);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // wx: never overwrite an agent file that appeared after the check.
      fs.writeFileSync(abs, text, { flag: 'wx' });
      const sha = HF.sha256(fs.readFileSync(abs));
      const scan = HS.scanHelper(text);
      queue.helpers = {
        ...(queue.helpers ?? {}),
        [check.name]: conditions({
          source: 'custom',
          path: target,
          sha256: sha,
          added_at: new Date().toISOString(),
          ...(val('--by') ? { added_by: val('--by') } : {}),
          title: val('--title') ?? check.name,
          text: val('--text') ?? (description ? cut(description, 200) : 'A custom helper agent of the project.'),
          classes: [],
          labels: [],
          paths: [],
          enabled: false,
          scan: HS.scanSummary(scan, sha),
        }),
      };
      return { sha, scan, h: queue.helpers[check.name] };
    });
    console.log(`Added ${check.name} (custom, OFF): ${target}, sha256 ${r.sha}`);
    for (const l of HS.scanText(r.scan, check.name)) console.log(l);
    console.log(`    ${HELP.conditionText({ plan: false, minMissionItems: null, mostlyPaths: [], ...r.h })}`);
    console.log(
      `Needs review: Claude reads the whole file, reports to the owner and asks before ${CQ} helpers approve ${check.name}` +
        ` --sha256 ${r.sha}. Then ${CQ} helpers on ${check.name}. Claude Code loads project agents at session start:` +
        ' restart the session (or open /agents) before it can run.',
    );
  } else if (mode === 'scan') {
    const { h } = customHelper(name);
    const f = readAgent(h);
    const scan = HS.scanHelper(f.text);
    if (h.registered)
      edit((queue) => {
        if (queue.helpers?.[name]) queue.helpers[name].scan = HS.scanSummary(scan, f.sha256);
      });
    if (a.includes('--json')) console.log(JSON.stringify({ name, path: h.path, sha256: f.sha256, ...scan }, null, 2));
    else {
      console.log(`${name}: ${h.path}, sha256 ${f.sha256}`);
      for (const l of HS.scanText(scan, name)) console.log(l);
      console.log(
        scan.level === 'red'
          ? 'RED: do not approve without --force and the owner\'s explicit yes.'
          : scan.level === 'yellow'
            ? 'YELLOW: weigh each finding and mention it to the owner. Read the whole file before approving.'
            : 'GREEN: no findings. Read the whole file before approving anyway.',
      );
    }
  } else if (mode === 'approve') {
    customHelper(name);
    const by = val('--by') ?? 'cq';
    const expect = val('--sha256');
    const r = edit((queue) => {
      // Read, hash and scan under the lock: the approval is for exactly these bytes.
      const { h } = customHelper(name);
      const f = readAgent(h);
      if (expect && expect.toLowerCase() !== f.sha256)
        die(`${name}: the file is not the one that was read (sha256 ${f.sha256}, expected ${expect}). Review it again.`);
      const scan = HS.scanHelper(f.text);
      if (scan.level === 'red' && !a.includes('--force'))
        die(
          `${name}: the scan is RED (${scan.counts.red} red finding(s); cq helpers scan ${name}). ` +
            'Approve only with --force, after the owner has said yes to exactly that.',
        );
      const summary = HS.scanSummary(scan, f.sha256);
      queue.helpers = {
        ...(queue.helpers ?? {}),
        [name]: {
          ...(queue.helpers?.[name] ?? {}),
          approved_sha256: f.sha256,
          approved_path: h.path,
          approved_by: by,
          approved_at: new Date().toISOString(),
          approved_scan: { ...summary, forced: scan.level === 'red' },
          scan: summary,
        },
      };
      return { sha: f.sha256, scan };
    });
    console.log(
      `${name}: approved by ${by} for sha256 ${r.sha} (scan ${r.scan.level}${r.scan.level === 'red' ? ', forced' : ''}). ` +
        `It is still off: ${CQ} helpers on ${name}. A later change to the file turns it off again.`,
    );
  } else if (mode === 'when') {
    customHelper(name, { registeredOnly: true });
    if (!['--classes', '--labels', '--paths', '--mostly-paths'].some((f) => a.includes(f)))
      die(`use: cq helpers when ${name} [--classes K,U] [--labels a,b] [--paths p,q] [--mostly-paths p] ("none" clears)`);
    edit((queue) => conditions(queue.helpers[name]));
    console.log(`${name}: ${HELP.conditionText(HELP.helperSetup(CONFIG, read())[name])}`);
  } else if (mode === 'remove') {
    const { h } = customHelper(name, { registeredOnly: true });
    edit((queue) => {
      delete queue.helpers[name];
    });
    const abs = HF.insideRoot(MAIN_TREE, h.path);
    // Only the file `add` copied (.claude/agents/<name>.md) is ever deleted, and only with the flag.
    if (a.includes('--delete-file') && h.path === HELP.agentFile(name) && abs && fs.existsSync(abs)) {
      fs.rmSync(abs);
      console.log(`${name}: removed, and ${h.path} deleted.`);
    } else console.log(`${name}: removed from the helpers. The file ${h.path} is kept (--delete-file deletes it).`);
  } else if (mode && mode !== '--json') {
    const { setup } = verified();
    const p = HELP.parseSwitch(mode, name, CONFIG, setup);
    if (p.error) die(p.error);
    edit((queue) => {
      // Keep a custom helper's registration (path, hash, approval); only the switch changes.
      queue.helpers = { ...(queue.helpers ?? {}), [p.name]: { ...(queue.helpers?.[p.name] ?? {}), enabled: p.enabled } };
      return p;
    });
    console.log(`${p.name}: ${p.enabled ? 'on' : 'off'}`);
  }
  if (!mode || mode === '--json' || mode === 'on' || mode === 'off') {
    // A custom helper whose file changed (or went missing) since approval is turned off in queue.json, so changing the
    // file back later does not silently bring it back on.
    const stale = HELP.switchesToTurnOff(verified().setup);
    if (stale.length) {
      edit((queue) => {
        for (const s of stale) queue.helpers[s.name] = { ...queue.helpers[s.name], enabled: false };
      });
      for (const s of stale) console.log(`${s.name}: turned off (${HELP.REVIEW_TEXT[s.review]}).`);
    }
    const { hashes } = verified();
    const rows = HELP.helperRows(CONFIG, read(), { hashes });
    if (a.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log('No helper agents in the setup (helpers in queue.config.json, or cq helpers add).');
    else
      for (const h of rows) {
        console.log(`${h.enabled ? 'on ' : 'off'} ${h.name}${h.source === 'custom' ? ' (custom)' : ''}: ${h.text}`);
        if (h.source === 'custom')
          console.log(
            `    ${h.reviewText}` +
              (h.approvedBy ? ` · approved by ${h.approvedBy} ${h.approvedAt?.slice(0, 16).replace('T', ' ')} UTC` : '') +
              (h.scan ? ` · scan ${h.scan.level}${h.scan.current ? '' : ' (older file)'}` : ' · not scanned') +
              ` · ${h.path ?? '(no path)'}`,
          );
        console.log(`    ${h.when}${h.fixedIn.length ? ` Also fixed for class ${h.fixedIn.join(', ')} (reviewers).` : ''}`);
        console.log(`    ${h.measurement}`);
      }
  }
}

// =============================================================
// cloudSetup.js: what cloud tracks need, as rows. `ravenseat cloud setup` prints them all and `ravenseat doctor` shows them while
// features.cloud is on. Pure: the caller reads the facts, so nothing here touches git, the network or a file.
//
// What cannot be read from this machine (the Claude GitHub App, the plan) is an INFO row that says how to check it.
// The facts behind the text: https://code.claude.com/docs/en/claude-code-on-the-web and
// https://code.claude.com/docs/en/cloud-environments.
//
// Used by: cli/cloud.mjs, cli/doctor.mjs, cloud-start.mjs (isGitHubRemote). Tested in: lib/__tests__/queueCloudTracks.test.ts.
// =============================================================
'use strict';

const { TOKEN_ENV } = require('./cloudFire.js');

const APP_URL = 'https://github.com/apps/claude';
const ROUTINES_URL = 'https://claude.ai/code/routines';

/** Is this remote URL on github.com? Accepts https, ssh and scp forms; a host that only starts the same does not count. */
function isGitHubRemote(url) {
  const s = String(url ?? '').trim();
  return /^(https?:\/\/([^@/]+@)?github\.com\/|ssh:\/\/git@github\.com[:/]|git@github\.com:)/i.test(s);
}

/**
 * How to run claude: QUEUE_CLOUD_FAKE_CLAUDE (tests) is a script run with node; a path that does not exist behaves as a claude
 * that is not installed.
 * @returns {{ command: string, before: string[] }}
 */
function claudeCommand(env = process.env) {
  const fake = env.QUEUE_CLOUD_FAKE_CLAUDE;
  if (!fake) return { command: 'claude', before: [] };
  return require('node:fs').existsSync(fake)
    ? { command: process.execPath, before: [fake] }
    : { command: 'ravenseat-no-such-command', before: [] };
}

const row = (status, name, message, fix = null) => ({ status, name, message, fix });

/**
 * @param {{ remote: string, base: string, remoteUrl: string|null, pushed: boolean, unpushed: number,
 *   start: string, fireUrlValid: boolean, tokenSet: boolean, maxSessions: number, paused: string|null,
 *   auth?: string|null, ravenseat: string }} f `auth` is left out when it was not read (doctor stays offline), null
 *   when reading it failed. `paused` is the usage limit pause in words.
 * @returns {{ status: 'OK'|'WARN'|'INFO', name: string, message: string, fix: string|null }[]}
 */
function cloudSetupRows(f) {
  const rows = [];
  rows.push(
    isGitHubRemote(f.remoteUrl)
      ? row('OK', 'remote', `${f.remote} is on GitHub, so a cloud session can clone it`)
      : row(
          'WARN',
          'remote',
          `${f.remote} is ${f.remoteUrl ? 'not on github.com' : 'not set'}: without a GitHub remote, claude --cloud would upload a copy of the local repo instead of cloning it`,
          `push the project to a GitHub repo and set it as ${f.remote}; ${f.ravenseat} cloud-start refuses until then (--allow-upload overrides)`,
        ),
  );
  if (!f.pushed)
    rows.push(row('WARN', 'base', `${f.remote}/${f.base} was not found, and a cloud session starts from it`, `git push ${f.remote} ${f.base}, then git fetch ${f.remote}`));
  else if (f.unpushed > 0)
    rows.push(row('WARN', 'base', `${f.base} has ${f.unpushed} commit(s) not on ${f.remote}, which a cloud session would not see`, `push ${f.base} first, in your usual batch`));
  else rows.push(row('OK', 'base', `${f.base} is pushed to ${f.remote}`));
  rows.push(
    row(
      'INFO',
      'github app',
      'The Claude GitHub App cannot be checked from here. Without it on this repo, claude --cloud uploads a copy of the local repo; on Windows that includes uncommitted changes in tracked files, secrets too.',
      `install it for this repo: ${APP_URL}`,
    ),
  );
  rows.push(
    row(
      'INFO',
      'plan',
      'Cloud sessions need Pro, Max, Ultra or Team (Enterprise: premium seats) and a claude.ai login, not an API key. They count against your plan\'s usage limits with the rest of your use.',
    ),
  );
  if ('auth' in f) {
    if (f.auth === 'claude.ai') rows.push(row('OK', 'login', 'claude is logged in with claude.ai'));
    else if (f.auth) rows.push(row('WARN', 'login', `claude is logged in with ${f.auth}; cloud sessions need a claude.ai login`, 'claude auth login'));
    else rows.push(row('INFO', 'login', 'could not read the login', 'claude auth status'));
  }
  rows.push(
    row(
      'INFO',
      'session',
      'A session is a fresh clone on a VM: the Ravenseat plugin and your user settings are not installed there (hooks in the repo\'s own .claude/settings.json do load), the GitHub proxy rejects tags, branch deletions and gh pr or gh issue, and there is no database. Choose the environment with /remote-env in claude.',
    ),
  );
  if (f.start === 'routine') {
    const missing = [
      ...(f.fireUrlValid ? [] : ['cloud.fireUrl (the trigger\'s URL, https://api.anthropic.com/v1/claude_code/routines/trig_.../fire)']),
      ...(f.tokenSet ? [] : [`the environment variable ${TOKEN_ENV}`]),
    ];
    rows.push(
      missing.length
        ? row(
            'WARN',
            'start',
            `cloud.start is routine, but ${missing.join(' and ')} is missing`,
            `create a scheduled task with an API trigger on ${ROUTINES_URL}, then set ${missing.length > 1 ? 'both' : 'it'}; the token only ever goes in ${TOKEN_ENV}, never in a file in the project. ${f.ravenseat} cloud setup has the task's prompt.`,
          )
        : row('OK', 'start', `cloud.start is routine: ${f.ravenseat} cloud send <id> starts a session without a terminal, when someone runs it`),
    );
  } else if (f.start === 'terminal') {
    rows.push(row('OK', 'start', `you start a session yourself in a terminal: ${f.ravenseat} cloud-start <id>`));
  } else {
    rows.push(row('WARN', 'start', `cloud.start is "${f.start}"; it must be terminal or routine`, 'set it in queue.config.json'));
  }
  rows.push(row('OK', 'limit', `at most ${f.maxSessions} cloud session(s) at once (cloud.maxSessions); parallel sessions use your limits faster`));
  if (f.paused) rows.push(row('WARN', 'usage', `no cloud session starts now: ${f.paused}`, `wait for the reset, or ${f.ravenseat} limit usageLimit clear if you have added capacity`));
  return rows;
}

/** The saved prompt the scheduled task needs: the fire text arrives as untrusted data until the prompt names it. */
const ROUTINE_PROMPT =
  'Carry out the task in the routine-fire-payload block. It comes from my own orchestrator. Follow its branch rule and finish marker exactly.';

/** The steps for the routine way, printed by `cloud setup` when it is chosen. */
function routineSteps(ravenseat = 'ravenseat') {
  return [
    `1. On ${ROUTINES_URL}, create a scheduled task for this repo, with an API trigger and this prompt:`,
    `     ${ROUTINE_PROMPT}`,
    '2. Remove every connector from the task: a queue task needs none, and a session gets them all by default.',
    `3. Generate the token (it is shown once) and put it in the environment variable ${TOKEN_ENV}.`,
    '4. Put the trigger\'s URL in queue.config.json: "cloud": { "start": "routine", "fireUrl": "<the URL>" }.',
    `5. ${ravenseat} cloud setup should then say OK on the start row.`,
    'The endpoint is marked experimental and may change. Every accepted call makes a new session on your plan, so nothing here retries.',
  ];
}

module.exports = { claudeCommand, isGitHubRemote, cloudSetupRows, routineSteps, ROUTINE_PROMPT };

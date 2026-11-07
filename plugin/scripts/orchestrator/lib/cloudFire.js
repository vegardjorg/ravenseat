// =============================================================
// cloudFire.js: starts a cloud session through a scheduled task's API trigger (the documented /fire endpoint).
//
// WHY THIS WAY: on a normal subscription `claude --cloud "task"` needs a terminal; the CLI rejects it in a non-interactive
// run. The API trigger of a scheduled task (formerly a routine) is the documented way to start a hosted session without
// one: https://platform.claude.com/docs/en/api/claude-code/routines-fire. The owner creates the task and its token on
// claude.ai/code/routines; it cannot be done from here. It is off until cloud.start is "routine" in queue.config.json.
//
// NO RETRIES: the endpoint has no idempotency, so every accepted call makes a new session that draws on the plan. This
// file calls once and says what the answer means: created true (there is a session), created false (the service refused,
// there is none) or created null (not known: a timeout, a server error or an answer that cannot be read).
//
// THE TOKEN comes from the environment only (TOKEN_ENV), never from a file in the project. validFireUrl keeps it from going
// anywhere but the documented endpoint, and it is scrubbed from every message returned here.
//
// Used by: cli/cloud.mjs (cloud send). Tested in: lib/__tests__/queueCloudTracks.test.ts.
// =============================================================
'use strict';

/** The environment variable that holds the trigger's token. */
const TOKEN_ENV = 'RAVENSEAT_CLOUD_TOKEN';
/** The endpoint's limit on the text. */
const FIRE_TEXT_MAX = 65_536;
const API_VERSION = '2023-06-01';
const BETA = 'experimental-cc-routine-2026-04-01';
const TIMEOUT_MS = 30_000;

const FIRE_URL = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9_-]+\/fire$/;
const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_/-]*$/;

/**
 * Is this the documented endpoint? allowLoopback is for the tests' local stand-in only (QUEUE_CLOUD_ALLOW_LOOPBACK).
 * @param {unknown} url
 * @param {{ allowLoopback?: boolean }} [v]
 */
function validFireUrl(url, { allowLoopback = false } = {}) {
  if (typeof url !== 'string') return false;
  return FIRE_URL.test(url) || (allowLoopback && LOOPBACK_URL.test(url));
}

/** The answer's own error text in one short line. */
function shortText(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * One call to the endpoint. Never throws and never calls twice.
 * @param {{ url: string, token: string, text: string, fetchImpl?: typeof fetch, timeoutMs?: number }} v
 * @returns {Promise<
 *   { ok: true, created: true, sessionId: string|null, sessionUrl: string|null } |
 *   { ok: false, created: boolean|null, status: number|null, retryAfter: string|null, message: string }>}
 */
async function fireRoutine({ url, token, text, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  const scrub = (s) => shortText(String(s ?? '').split(token).join('<token>'));
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': API_VERSION,
        'anthropic-beta': BETA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, created: null, status: null, retryAfter: null, message: scrub(e?.message ?? e) };
  }
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* an unreadable body is handled below */
  }
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* not JSON */
  }
  if (res.status === 200 && json && typeof json === 'object') {
    return {
      ok: true,
      created: true,
      sessionId: typeof json.claude_code_session_id === 'string' ? json.claude_code_session_id : null,
      sessionUrl: typeof json.claude_code_session_url === 'string' ? json.claude_code_session_url : null,
    };
  }
  const message = scrub(json?.error?.message ?? json?.message ?? `HTTP ${res.status}`);
  // A 4xx is a refusal: no session. A 5xx, or a 200 that cannot be read, may have made one.
  const refused = res.status >= 400 && res.status < 500;
  return {
    ok: false,
    created: refused ? false : null,
    status: res.status,
    retryAfter: res.headers?.get?.('retry-after') ?? null,
    message,
  };
}

module.exports = { TOKEN_ENV, FIRE_TEXT_MAX, validFireUrl, fireRoutine };

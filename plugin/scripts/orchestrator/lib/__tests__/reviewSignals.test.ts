// =============================================================
// reviewSignals.test.ts: review signals lift a reviewer in by what the diff ADDS (lib/reviewSignals.js).
//
// Why: the fixed reviewers follow the class (K and U none, D reviewer, D+ also reviewer-security), and helpers are
// chosen by paths only. So a class K task that changed the sign-in flow, added a secret, fetched a URL built from data or
// wrote raw HTML got no security review at all. A review signal reads the added lines of the diff (code files only,
// never tests, comment lines or docs) and the changed paths, and lifts its reviewer in with a one-line reason.
//
// Locks: (1) each built-in signal hits on its words and paths; (2) narrow on purpose: no hit on the word "auth" alone,
// on reading the signed-in user, on a removed line, a test file, a comment line or a .md file; (3) a literal URL is
// not a hit, a URL built from data is (fail-closed when the line cannot be read); (4) the class is the floor: a signal
// only adds a reviewer, never removes a fixed one, and a fixed reviewer gets the reason added; (5) the project can add
// paths and words, add its own signal and switch a built-in off; an invalid word is reported, not thrown;
// (6) the hit rate per signal is measured from the tasks' records; (7) switching a built-in off is a weakening.
// =============================================================
import { describe, it, expect } from 'vitest';

const RS = require('../reviewSignals.js');
const HELP = require('../queueHelpers.js');
const REG = require('../settingsRegistry.js');

/** A unified diff that adds `lines` to `file` (a new file when `isNew`). */
function diffAdding(file: string, lines: string[], { removed = [] as string[] } = {}) {
  return [
    `diff --git a/${file} b/${file}`,
    'index 0000000..1111111 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length} +1,${lines.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

const hitsFor = (file: string, lines: string[], config: object = {}, extra: object = {}) =>
  RS.signalHits({ config, changedPaths: [file], diff: diffAdding(file, lines), ...extra });
const names = (hits: { name: string }[]) => hits.map((h) => h.name);

describe('added lines', () => {
  it('reads the added lines per file, never the removed ones or the +++ header', () => {
    const d = diffAdding('src/a.ts', ['const x = 1;'], { removed: ['const y = 2;'] }) + diffAdding('src/b.ts', ['let z;']);
    expect(RS.addedLines(d)).toEqual([
      { file: 'src/a.ts', text: 'const x = 1;' },
      { file: 'src/b.ts', text: 'let z;' },
    ]);
  });

  it('a deleted file has no added lines', () => {
    const d = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone', ''].join('\n');
    expect(RS.addedLines(d)).toEqual([]);
  });
});

describe('what counts as product code', () => {
  it.each(['src/x.test.ts', 'src/__tests__/x.ts', 'tests/x.py', 'test/x.js', 'spec/x.rb', 'e2e/login.ts', 'x_test.go', 'test_x.py', 'src/x.spec.tsx'])(
    '%s is a test file',
    (p) => expect(RS.isTestPath(p)).toBe(true),
  );
  it.each(['src/x.ts', 'app/(auth)/login.tsx', 'lib/session.js', 'views.py', 'app/controllers/x.rb', 'src/X.vue', 'index.html'])(
    '%s is a code file',
    (p) => expect(RS.isCodePath(p) && !RS.isTestPath(p)).toBe(true),
  );
  it.each(['README.md', 'docs/auth.md', 'notes.txt', 'data.json', 'img/login.png'])('%s is not a code file', (p) =>
    expect(RS.isCodePath(p)).toBe(false),
  );
  it.each(['// signOut()', '  /* setSession */', ' * refresh_token', '# login(request)', '<!-- innerHTML -->', '-- service_role'])(
    '%s is a comment line',
    (t) => expect(RS.isCommentLine(t)).toBe(true),
  );
});

describe('the auth signal', () => {
  it.each([
    'await supabase.auth.signInWithPassword({ email, password });',
    'await supabase.auth.signOut();',
    'await supabase.auth.setSession(tokens);',
    'await supabase.auth.refreshSession();',
    'supabase.auth.onAuthStateChange((e, s) => go(s));',
    'await supabase.auth.verifyOtp({ phone, token });',
    'await supabase.auth.mfa.challenge({ factorId });',
    'await supabase.auth.exchangeCodeForSession(code);',
    "signIn('github', { callbackUrl });",
    'await signInWithEmailAndPassword(auth, email, password);',
    'const body = { refresh_token: rt };',
    "localStorage.setItem('token', t);",
    "await SecureStore.setItemAsync('session', s);",
    "await AsyncStorage.setItem('access', token);",
    'document.cookie = `session=${id}`;',
    'login(request, user)',
    'reset_session',
    'session[:user_id] = user.id',
    'const t = jwt.sign(payload, key);',
  ])('hits on: %s', (line) => {
    const hits = hitsFor('src/screens/Profile.tsx', [line]);
    expect(names(hits)).toContain('auth');
    const h = hits.find((x: { name: string }) => x.name === 'auth');
    expect(h.reviewer).toBe('reviewer-security');
    expect(h.reason).toMatch(/^signal auth: src\/screens\/Profile\.tsx/);
  });

  it.each([
    'app/(auth)/login.tsx',
    'src/auth/guard.ts',
    'lib/session.ts',
    'hooks/useAuth.ts',
    'src/mfa/Enroll.tsx',
    'src/PasskeyButton.tsx',
    'src/webauthn.ts',
    'src/StepUp.tsx',
    'middleware.ts',
    'app/views/oauth_callback.py',
  ])('hits on the changed path %s', (p) => {
    const hits = RS.signalHits({ config: {}, changedPaths: [p], diff: diffAdding(p, ['export const a = 1;']) });
    expect(names(hits)).toContain('auth');
    expect(hits.find((x: { name: string }) => x.name === 'auth').reason).toContain(p);
  });

  it.each([
    'const { user } = useAuth();',
    "import { useAuth } from '../hooks/useAuth';",
    'const auth = getAuth();',
    "<Text>{t('auth.title')}</Text>",
    'const author = post.author;',
    'const { data } = await supabase.auth.getUser();',
  ])('narrow: no hit on %s in a plain screen', (line) => {
    expect(names(hitsFor('src/screens/Home.tsx', [line]))).not.toContain('auth');
  });

  it('no hit in a test file, a comment line, a removed line or a .md file', () => {
    expect(names(hitsFor('src/__tests__/login.test.ts', ['await supabase.auth.signOut();']))).toEqual([]);
    expect(names(hitsFor('src/x.ts', ['// await supabase.auth.signOut();']))).toEqual([]);
    expect(names(hitsFor('docs/login.md', ['await supabase.auth.signOut();']))).toEqual([]);
    const removed = diffAdding('src/x.ts', ['const a = 1;'], { removed: ['await supabase.auth.signOut();'] });
    expect(RS.signalHits({ config: {}, changedPaths: ['src/x.ts'], diff: removed })).toEqual([]);
  });

  it('a path hit in a test or docs path does not count', () => {
    expect(RS.signalHits({ config: {}, changedPaths: ['src/__tests__/session.test.ts', 'docs/auth/setup.md'], diff: '' })).toEqual([]);
  });
});

describe('the url-from-data signal', () => {
  it.each([
    'const r = await fetch(url);',
    'await fetch(`${base}/api`);',
    'await fetch(input.href, { method: "POST" });',
    "await axios.get(req.query.target);",
    'r = requests.get(url)',
    'await fetch(',
    "await fetch('' + host + '/x');",
  ])('hits on: %s', (line) => {
    expect(names(hitsFor('src/api/client.ts', [line]))).toContain('url-from-data');
  });

  it.each([
    "await fetch('https://api.example.com/v1/items');",
    'await fetch(`https://api.example.com/v1/items/${id}`);',
    "await fetch('/api/items');",
    'await fetch(`/api/items/${id}`);',
    "await fetch('https://api.example.com/v1/' + id);",
  ])('no hit on a literal or fixed-host URL: %s', (line) => {
    expect(names(hitsFor('src/api/client.ts', [line]))).not.toContain('url-from-data');
  });
});

describe('the html-sink and secret signals', () => {
  it.each(['el.innerHTML = html;', '<div dangerouslySetInnerHTML={{ __html: body }} />', "el.insertAdjacentHTML('beforeend', x);", 'document.write(x);', '<div v-html="body"></div>', 'return mark_safe(text)'])(
    'html-sink hits on: %s',
    (line) => expect(names(hitsFor('src/View.tsx', [line]))).toContain('html-sink'),
  );

  it.each(['const key = process.env.SUPABASE_SERVICE_ROLE_KEY;', "createClient(url, Deno.env.get('SERVICE_ROLE'))", 'const k = env.STRIPE_SECRET_KEY;', 'const pem = `-----BEGIN ' + 'PRIVATE KEY-----`;'])(
    'secret hits on: %s',
    (line) => expect(names(hitsFor('src/server/admin.ts', [line]))).toContain('secret'),
  );

  it('no html-sink hit on textContent or on reading innerHTML in a comparison', () => {
    expect(names(hitsFor('src/View.tsx', ['el.textContent = text;']))).toEqual([]);
  });
});

describe('the project setup (review.signals)', () => {
  it('adds paths and words to a built-in signal', () => {
    const config = { review: { signals: { auth: { paths: ['src/gate/**'], words: ['\\bmyLogin\\('] } } } };
    expect(names(RS.signalHits({ config, changedPaths: ['src/gate/x.ts'], diff: diffAdding('src/gate/x.ts', ['a()']) }))).toContain('auth');
    expect(names(hitsFor('src/x.ts', ['myLogin(user)'], config))).toContain('auth');
    // The built-in words are still there.
    expect(names(hitsFor('src/x.ts', ['await supabase.auth.signOut();'], config))).toContain('auth');
  });

  it('switches a built-in off', () => {
    const config = { review: { signals: { auth: { enabled: false } } } };
    expect(names(hitsFor('src/x.ts', ['await supabase.auth.signOut();'], config))).toEqual([]);
  });

  it('adds its own signal with its own reviewer', () => {
    const config = { review: { signals: { payments: { reviewer: 'reviewer', words: ['\\bstripe\\.charges\\.'] } } } };
    const hits = hitsFor('src/pay.ts', ['await stripe.charges.create(x);'], config);
    expect(hits).toEqual([{ name: 'payments', reviewer: 'reviewer', reason: expect.stringMatching(/^signal payments: src\/pay\.ts/) }]);
  });

  it('an invalid word is reported in the setup and skipped, never thrown', () => {
    const setup = RS.signalSetup({ review: { signals: { auth: { words: ['(unclosed'] } } } });
    expect(setup.auth.problems.join(' ')).toMatch(/\(unclosed/);
    expect(names(hitsFor('src/x.ts', ['await supabase.auth.signOut();'], { review: { signals: { auth: { words: ['(unclosed'] } } } }))).toContain('auth');
  });

  it('a signal of its own without a reviewer or without paths and words is a problem and never hits', () => {
    const setup = RS.signalSetup({ review: { signals: { x: { words: ['a'] }, y: { reviewer: 'reviewer' } } } });
    expect(setup.x.problems.length).toBeGreaterThan(0);
    expect(setup.y.problems.length).toBeGreaterThan(0);
    expect(names(hitsFor('src/a.ts', ['a'], { review: { signals: { x: { words: ['a'] } } } }))).toEqual([]);
  });

  it('a very long line is cut before the words are tried (no slow match on minified code)', () => {
    const t0 = Date.now();
    hitsFor('src/min.js', ['a'.repeat(200_000) + ' fetch(url)']);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('the class is the floor (reviewersForTask)', () => {
  const diff = diffAdding('src/Login.tsx', ['await supabase.auth.signOut();']);

  it('a class K task with an auth change gets reviewer-security with the reason', () => {
    const r = HELP.reviewersForTask({ id: 'A', class: 'K' }, { config: {}, changedPaths: ['src/Login.tsx'], diff });
    const sec = r.find((x: { type: string }) => x.type === 'reviewer-security');
    expect(sec).toBeTruthy();
    expect(sec.fixed).toBe(false);
    expect(sec.signal).toBe(true);
    expect(sec.reasons.join(' ')).toMatch(/signal auth: src\/Login\.tsx/);
  });

  it('a D+ task keeps its fixed reviewer-security and gets the reason added, once', () => {
    const r = HELP.reviewersForTask({ id: 'A', class: 'D+' }, { config: {}, changedPaths: ['src/Login.tsx'], diff });
    const sec = r.filter((x: { type: string }) => x.type === 'reviewer-security');
    expect(sec).toHaveLength(1);
    expect(sec[0].fixed).toBe(true);
    expect(sec[0].reasons).toEqual(expect.arrayContaining(['class D+', expect.stringMatching(/^signal auth/)]));
  });

  it('without a diff nothing changes (callers that do not pass one)', () => {
    const r = HELP.reviewersForTask({ id: 'A', class: 'K' }, { config: {}, changedPaths: ['src/Home.tsx'] });
    expect(r.map((x: { type: string }) => x.type)).not.toContain('reviewer-security');
  });

  it('a signal never removes a fixed reviewer, even when every signal is off', () => {
    const config = { review: { signals: { auth: { enabled: false }, secret: { enabled: false }, 'url-from-data': { enabled: false }, 'html-sink': { enabled: false } } } };
    const r = HELP.reviewersForTask({ id: 'A', class: 'D+' }, { config, changedPaths: ['src/Login.tsx'], diff });
    expect(r.map((x: { type: string }) => x.type)).toEqual(['reviewer', 'reviewer-security']);
  });
});

describe('the hit rate per signal', () => {
  it('counts the checked tasks and the hits per signal from the task records', () => {
    const queue = {
      tasks: [
        { id: 'A', class: 'K', review_signals: { at: '2026-11-14T10:00:00Z', hits: ['auth'] } },
        { id: 'B', class: 'K', review_signals: { at: '2026-11-14T10:00:00Z', hits: [] } },
        { id: 'C', class: 'K', review_signals: { at: '2026-11-14T10:00:00Z', hits: ['auth', 'secret'] } },
        { id: 'D', class: 'K', review_signals: { at: '2026-11-14T10:00:00Z', hits: [] } },
        { id: 'E', class: 'K' },
      ],
    };
    const st = RS.signalStatistics(queue, {});
    expect(st.checked).toBe(4);
    expect(st.signals.auth).toEqual({ hits: 2, pct: 50, broad: false });
    expect(st.signals.secret).toEqual({ hits: 1, pct: 25, broad: false });
    expect(st.signals['html-sink']).toEqual({ hits: 0, pct: 0, broad: false });
  });

  it('a signal that hits on a large share of at least 10 checked tasks is marked broad', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `T${i}`, review_signals: { at: 'x', hits: i < 5 ? ['auth'] : [] } }));
    expect(RS.signalStatistics({ tasks }, {}).signals.auth.broad).toBe(true);
  });

  it('the text per signal names the rate, and says when it is broad', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `T${i}`, review_signals: { at: 'x', hits: i < 5 ? ['auth'] : [] } }));
    const lines = RS.statisticsLines(RS.signalStatistics({ tasks }, {}));
    expect(lines.join('\n')).toMatch(/auth: 5 of 10 checked tasks \(50 %\).*broad/);
    expect(RS.statisticsLines(RS.signalStatistics({ tasks: [] }, {})).join('\n')).toMatch(/No tasks checked yet/);
  });
});

describe('the setting', () => {
  it('review.signals is a registered setting, and switching a built-in off weakens it', () => {
    const row = REG.rowFor('review.signals');
    expect(row).toBeTruthy();
    expect(row.weakens({ auth: { enabled: false } }, {})).toBe(true);
    expect(row.weakens({ auth: { paths: ['x/'] } }, {})).toBeFalsy();
    expect(row.weakens({ mine: { enabled: false } }, {})).toBeFalsy();
  });
});

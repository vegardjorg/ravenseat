// =============================================================
// commandSecrets.test.ts: the password-flag rule for a command line (lib/commandSecrets.js, roadmap 1c SEC-T item 2).
//
// Why: the generic secret rule needs 16+ characters, so a short password typed in a command passed the doctor row for
// approved commands. Here any length counts, placeholders do not, and the answer is a rule id and a token index, never
// the value. The fake values are joined at run time and are plainly fake.
// =============================================================
import { describe, expect, it } from 'vitest';

import { matchCommand, secretValues, tokenize } from '../commandSecrets';

const PW = ['fake', 'pw', '7'].join('');
const SHORT = ['ab', 'c1'].join('');

describe('matchCommand: secrets of any length in a command line', () => {
  it('finds a password flag, an env assignment, a header and the short flags of the tools that take one', () => {
    expect(matchCommand(`psql --password ${PW} -h db`)).toBe('password-flag');
    expect(matchCommand(`tool --api-token=${SHORT}`)).toBe('password-flag');
    expect(matchCommand(`PGPASSWORD=${SHORT} psql -h db`)).toBe('secret-env');
    expect(matchCommand(`export API_TOKEN=${PW}`)).toBe('secret-env');
    expect(matchCommand(`$env:DB_PASSWORD="${PW}"; psql`)).toBe('secret-env');
    expect(matchCommand(`$env:DB_PASSWORD = "${PW}"`)).toBe('secret-env');
    expect(matchCommand(`curl -H "X-Api-Key: ${SHORT}" https://api.example.com`)).toBe('secret-header');
    expect(matchCommand(`curl -H "Authorization: Bearer ${SHORT}" https://api.example.com`)).toBe('secret-header');
    expect(matchCommand(`sshpass -p ${PW} ssh host`)).toBe('password-flag');
    expect(matchCommand(`mysql -u root -p${PW} db`)).toBe('password-flag');
    expect(matchCommand(`redis-cli -a ${PW} ping`)).toBe('password-flag');
  });

  it('placeholders and references are not hits: $X, ${X}, <password>, ***, xxx, a wildcard, true', () => {
    for (const cmd of [
      'PGPASSWORD=$PGPASSWORD psql',
      'psql --password ${DB_PASSWORD}',
      'tool --token <token>',
      'tool --password ***',
      'tool --password xxx',
      'curl -H "Authorization: Bearer $TOKEN" https://x',
      'tool --token *',
      'NO_AUTH=true node x.js',
      'tool --password %PGPASSWORD%',
    ])
      expect(matchCommand(cmd), cmd).toBeNull();
  });

  it('names that only carry a secret word, paths and URLs are not hits; plain commands neither', () => {
    for (const cmd of [
      'gpg --password-file ./pw.txt',
      'git commit --author "A B <a@example.com>"',
      'tool --key ./server.pem',
      'tool --auth-type basic',
      'SSH_AUTH_SOCK=/tmp/agent.sock ssh host',
      'tool --token-url https://auth.example.com/token',
      'mkdir -p build',
      'git add -p',
      'npm test',
      'mysql -p db',
    ])
      expect(matchCommand(cmd), cmd).toBeNull();
  });

  it('gives the token index and what stays readable, never the value', () => {
    const cmd = `PGPASSWORD=${SHORT} psql --password ${PW}`;
    const hits = secretValues(cmd);
    expect(hits).toEqual([
      { index: 0, rule: 'secret-env', keep: 'PGPASSWORD=' },
      { index: 3, rule: 'password-flag', keep: '' },
    ]);
    expect(tokenize(cmd)[3]).toBe(PW);
    expect(JSON.stringify(hits)).not.toContain(PW);
    expect(JSON.stringify(hits)).not.toContain(SHORT);
  });
});

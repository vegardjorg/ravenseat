// =============================================================
// codeMode.test.ts: C3 (Code Mode candidates, owner 23.11), the doctor half. Doctor shows ONE INFO row when Code Mode
// is on: CLAUDE_CODE_EXPERIMENTAL_CODE_MODE in the environment or in the env block of ~/.claude/settings.json, where a
// 0 in either place wins (code.claude.com/docs/en/code-mode, "Turn off Code Mode"). Read only: Ravenseat never sets
// the flag. codeMode.policy warn (default) or off; there is no deny.
// =============================================================
import { describe, it, expect } from 'vitest';

const CM = require('../codeMode.js');
const VAR = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE';
const user = (v: unknown) => JSON.stringify({ env: { [VAR]: v } });

describe('codeModeState', () => {
  it('on from the shell or from the user settings, off without either', () => {
    expect(CM.codeModeState({ env: { [VAR]: '1' }, userSettingsText: null })).toEqual({ on: true, source: 'environment' });
    expect(CM.codeModeState({ env: {}, userSettingsText: user('1') })).toEqual({ on: true, source: 'user settings' });
    expect(CM.codeModeState({ env: {}, userSettingsText: null })).toEqual({ on: false, source: null });
    expect(CM.codeModeState({ env: {}, userSettingsText: '{}' })).toEqual({ on: false, source: null });
  });

  it('a 0 in one place keeps it off, as Claude Code does', () => {
    expect(CM.codeModeState({ env: { [VAR]: '0' }, userSettingsText: user('1') }).on).toBe(false);
    expect(CM.codeModeState({ env: { [VAR]: '1' }, userSettingsText: user('0') }).on).toBe(false);
  });

  it('settings that do not parse, or an odd value, read as off and never throw', () => {
    expect(CM.codeModeState({ env: {}, userSettingsText: '{ not json' }).on).toBe(false);
    expect(CM.codeModeState({ env: {}, userSettingsText: JSON.stringify({ env: 'x' }) }).on).toBe(false);
    expect(CM.codeModeState({ env: { [VAR]: 'yes' }, userSettingsText: null }).on).toBe(false);
    expect(CM.codeModeState({ env: {}, userSettingsText: user(1) }).on).toBe(true);
  });
});

describe('the policy and the doctor row', () => {
  it('codeMode.policy is warn unless it says off; there is no deny', () => {
    expect(CM.policyOf({})).toBe('warn');
    expect(CM.policyOf({ codeMode: { policy: 'off' } })).toBe('off');
    expect(CM.policyOf({ codeMode: { policy: 'deny' } })).toBe('warn');
    expect(CM.POLICIES).toEqual(['warn', 'off']);
  });

  it('one INFO row when Code Mode is on and the policy is warn', () => {
    const rows = CM.doctorRows({ state: { on: true, source: 'user settings' }, policy: 'warn' });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('INFO');
    expect(rows[0].message).toContain('Code Mode is on');
    expect(rows[0].message).toContain('user settings');
    expect(rows[0].message).toMatch(/guards/);
    expect(rows[0].message).toMatch(/ravenseat cost/);
    expect(rows[0].fix).toContain('codeMode.policy off');
    expect(rows[0].message + rows[0].fix).not.toMatch(/[–—]/);
  });

  it('no row when Code Mode is off or the policy is off', () => {
    expect(CM.doctorRows({ state: { on: false, source: null }, policy: 'warn' })).toEqual([]);
    expect(CM.doctorRows({ state: { on: true, source: 'environment' }, policy: 'off' })).toEqual([]);
  });

  it('readState reads the env and the user settings file it is given, never writes', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
    try {
      fs.writeFileSync(path.join(dir, 'settings.json'), user('1'));
      const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
      expect(CM.readState({ env: { CLAUDE_CONFIG_DIR: dir } })).toEqual({ on: true, source: 'user settings' });
      expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe(before);
      expect(CM.readState({ env: { CLAUDE_CONFIG_DIR: path.join(dir, 'missing') } })).toEqual({ on: false, source: null });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

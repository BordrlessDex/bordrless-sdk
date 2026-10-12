/** A custom companion's script in a launch request (docs/scripts.md): read from `companion.script`, held to the program's bounds in the launch form's words. */
import { describe, expect, it } from 'vitest';
import { NO_RULES } from './policy.ts';
import { SCRIPT_BOUNDS, SCRIPT_INTERVAL_CHOICES_SECS, scriptInitDataLength, scriptProblem, scriptRequestOf } from './policy.ts';

const split = { buybackBps: 1_000, holdersBps: 0, beneficiaryBps: 2_000 };
const request = { potBps: 7_000, program: '11111111111111111111111111111111', interval: 60, initData: 'AQID', stateLen: 64 };

describe('scriptRequestOf', () => {
  it('reads the script, absent or malformed', () => {
    expect(scriptRequestOf({ split })).toBeNull();
    expect(scriptRequestOf({ split, script: null })).toBeNull();
    expect(scriptRequestOf('x')).toBeNull();
    expect(scriptRequestOf({ split, script: request })).toEqual(request);
    expect(scriptRequestOf({ split, script: { ...request, initData: undefined } })).toEqual({ ...request, initData: '' });
    for (const bad of [{ ...request, potBps: -1 }, { ...request, potBps: 10_001 }, { ...request, program: 'nope' }, { ...request, interval: '60' }, { ...request, interval: 1.5 }, { ...request, stateLen: 1.5 }, { ...request, initData: 'abc' }, { ...request, initData: 7 }, 'script']) {
      expect(scriptRequestOf({ split, script: bad }), JSON.stringify(bad)).toBe('malformed');
    }
  });
});

describe('scriptInitDataLength', () => {
  it('counts hex (with or without 0x) and base64 bytes, and refuses the rest', () => {
    expect(scriptInitDataLength('')).toBe(0);
    expect(scriptInitDataLength('ab')).toBe(1);
    expect(scriptInitDataLength('0xabcd')).toBe(2);
    expect(scriptInitDataLength('AQID')).toBe(3);
    expect(scriptInitDataLength('AQI=')).toBe(2);
    expect(scriptInitDataLength('AQ==')).toBe(1);
    expect(scriptInitDataLength('abc')).toBeNull();
    expect(scriptInitDataLength('A')).toBeNull();
    expect(scriptInitDataLength('A Q==')).toBeNull();
  });
});

describe('scriptProblem', () => {
  it('takes the bounds and every interval the form offers, and refuses the rest in plain words', () => {
    expect(scriptProblem(request, split, NO_RULES, 200)).toBeNull();
    for (const interval of SCRIPT_INTERVAL_CHOICES_SECS) expect(scriptProblem({ ...request, interval }, split, NO_RULES, 200)).toBeNull();
    expect(scriptProblem({ ...request, interval: SCRIPT_BOUNDS.minInterval, initData: 'ab'.repeat(SCRIPT_BOUNDS.maxInitLen), stateLen: SCRIPT_BOUNDS.maxStateLen }, split, NO_RULES, 200)).toBeNull();
    expect(scriptProblem({ ...request, interval: SCRIPT_BOUNDS.maxInterval, initData: '', stateLen: 0 }, split, NO_RULES, 200)).toBeNull();
    expect(scriptProblem({ ...request, potBps: 6_000 }, split, NO_RULES, 200)).toMatch(/add up to 100%/);
    expect(scriptProblem({ ...request, potBps: 0 }, { ...split, beneficiaryBps: 9_000 }, NO_RULES, 200)).toMatch(/add up to 100%/);
    expect(scriptProblem({ ...request, interval: 9 }, split, NO_RULES, 200)).toMatch(/10 seconds to a day/);
    expect(scriptProblem({ ...request, initData: 'ab'.repeat(513) }, split, NO_RULES, 200)).toMatch(/at most 512 bytes/);
    expect(scriptProblem({ ...request, initData: 'zz' }, split, NO_RULES, 200)).toMatch(/hex or base64/);
    expect(scriptProblem({ ...request, stateLen: -1 }, split, NO_RULES, 200)).toMatch(/0 to 10,240/);
    expect(scriptProblem({ ...request, stateLen: 10_241 }, split, NO_RULES, 200)).toMatch(/0 to 10,240/);
    expect(scriptProblem(request, split, { ...NO_RULES, creatorLockDays: 1 }, 200)).toMatch(/creator wallet lock/);
    expect(scriptProblem(request, split, NO_RULES, 0)).toMatch(/no creator fee/);
    expect(scriptProblem({ ...request, potBps: 5_000 }, { buybackBps: 0, holdersBps: 5_000, beneficiaryBps: 0 }, NO_RULES, 200)).toMatch(/holder rewards/);
    expect(scriptProblem({ ...request, potBps: 5_000 }, { buybackBps: 0, holdersBps: 5_000, beneficiaryBps: 0 }, { ...NO_RULES, holderFeeBuyBps: 100, holderFeeSellBps: 100 }, 200)).toBeNull();
  });
});

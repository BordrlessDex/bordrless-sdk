/** keeper.json's launch terms for the state (2026-10-13): what a site launch asks the companion to make for the script, and what companion_init gets. */
import { describe, expect, it } from 'vitest';
import { KEEPER_DEFAULT_STATE_LEN, keeperLaunchTerms, parseKeeperDeclaration } from './keeper.ts';

const base = '{"version":1,"holdings":null,"swapAccounts":true,"wallets":["9AJqXST4eM9xWCVKv4wqyzV4TtUSC1yx1nYc3Q6o6F2m"]';

describe('keeper.json stateLen and initData', () => {
  it('takes a state size and init data within the companion bounds, lower-cased hex, and leaves them out of the normal form when absent', () => {
    const ok = parseKeeperDeclaration(`${base},"stateLen":128,"initData":"AB01"}`);
    expect(ok.ok && ok.declaration.stateLen).toBe(128);
    expect(ok.ok && ok.declaration.initData).toBe('ab01');
    const none = parseKeeperDeclaration(`${base}}`);
    expect(none.ok && 'stateLen' in none.declaration).toBe(false);
    expect(none.ok && 'initData' in none.declaration).toBe(false);
    for (const bad of ['"stateLen":-1', '"stateLen":10241', '"stateLen":1.5', '"initData":"abc"', '"initData":"zz"', `"initData":"${'00'.repeat(513)}"`]) {
      const r = parseKeeperDeclaration(`${base},${bad}}`);
      expect(r.ok).toBe(false);
    }
  });
  it('gives a launch the declared state and init data, or room for most scripts and none', () => {
    const d = parseKeeperDeclaration(`${base},"stateLen":128,"initData":"ab01","payouts":false}`);
    expect(d.ok && keeperLaunchTerms(d.declaration)).toMatchObject({ stateLen: 128, initData: 'ab01', payouts: false });
    expect(keeperLaunchTerms(null)).toMatchObject({ stateLen: KEEPER_DEFAULT_STATE_LEN, initData: '', payouts: false, wallets: false });
    expect(KEEPER_DEFAULT_STATE_LEN).toBe(1_024);
  });
});

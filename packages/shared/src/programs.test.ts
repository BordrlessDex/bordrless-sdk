/**
 * The launch program's rule for a config's own hook (docs/hooks-v2.md §5.8): nobody can upgrade it,
 * or only Bordrless Studio's key or the protocol's can.
 */
import { describe, expect, it } from 'vitest';
import { LOTTERY_HOOK, PROGRAM_IDS, TOKEN_HOOK_FLAGS } from './programs.ts';
import { PROTOCOL_UPGRADE_AUTHORITY, STUDIO_UPGRADE_AUTHORITY, hookAuthorityAccepted, hookFinalCommand } from './studio.ts';

const HOOK = 'HooK1111111111111111111111111111111111111111';
const OTHER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

describe('a config’s own hook and who may upgrade it', () => {
  it('passes a config without a hook (the launchpad’s and the kit’s own programs)', () => {
    expect(hookAuthorityAccepted(null, null)).toBe(true);
  });

  it('passes an immutable hook, and one Studio’s key or the protocol’s can upgrade', () => {
    expect(hookAuthorityAccepted(HOOK, { upgradeAuthority: null, upgradeable: false })).toBe(true);
    expect(hookAuthorityAccepted(HOOK, { upgradeAuthority: STUDIO_UPGRADE_AUTHORITY, upgradeable: true })).toBe(true);
    expect(hookAuthorityAccepted(HOOK, { upgradeAuthority: PROTOCOL_UPGRADE_AUTHORITY, upgradeable: true })).toBe(true);
  });

  it('refuses a hook another key can upgrade, and claims nothing of one whose authority could not be read', () => {
    expect(hookAuthorityAccepted(HOOK, { upgradeAuthority: OTHER, upgradeable: true })).toBe(false);
    expect(hookAuthorityAccepted(HOOK, { upgradeAuthority: null, upgradeable: null })).toBe(true);
    expect(hookAuthorityAccepted(HOOK, null)).toBe(true);
  });

  it('gives the command that makes a hook immutable', () => {
    expect(hookFinalCommand(PROGRAM_IDS.taxHook)).toBe(`solana program set-upgrade-authority ${PROGRAM_IDS.taxHook} --final`);
    expect(hookFinalCommand()).toContain('<PROGRAM_ID>');
  });
});

describe('the lottery hook (programs/lottery_hook)', () => {
  it('names its program and exactly the callbacks a companion game launch accepts', () => {
    expect(LOTTERY_HOOK.program).toBe(PROGRAM_IDS.lotteryHook);
    expect(PROGRAM_IDS.lotteryHook).toBe('HqFWsCBQ416DAfevJ9TspyT5yXGGoYTCpcreiGkCgWcr');
    // before_transfer, before_burn, writes hook data: no deltas (no cut), no mint callbacks.
    expect(LOTTERY_HOOK.flags).toBe(TOKEN_HOOK_FLAGS.BEFORE_TRANSFER | TOKEN_HOOK_FLAGS.BEFORE_BURN | TOKEN_HOOK_FLAGS.WRITES_HOOK_DATA);
    expect(LOTTERY_HOOK.flags & TOKEN_HOOK_FLAGS.TRANSFER_RETURNS_DELTA).toBe(0);
  });
});

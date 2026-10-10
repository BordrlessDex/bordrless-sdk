/**
 * The independent phase-3a audit's fixes, client side (bordrless-programs
 * `programs/tests/tests/indep_3a_manip.rs`): a launch from a config made on a timelocked hook
 * passes the hook's `Timelock` last (X1); a game whose hook carries an audit tied to its code passes
 * the hook's ProgramData to every step that applies its terms (X4). Phase 1/2 builders' default
 * output is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as a from './addresses.ts';
import { NO_LAUNCH_RULES } from './accounts.ts';
import { timelockAddress } from './authority.ts';
import { companion, needsHookCode } from './companion.ts';
import { PROGRAM_ERRORS } from './errors.ts';
import { launch } from './instructions.ts';

const k = (): PublicKey => Keypair.generate().publicKey;

describe('X1: a launch from a config made on a timelocked hook', () => {
  const [creator, mint, treasury, hook] = [k(), k(), k(), k()];
  const args = { name: 'T', symbol: 'T', uri: 'ipfs://x', creatorFeeBps: 100, virtualQuote: 28_125_000_000n, rules: NO_LAUNCH_RULES };
  const customHook = { program: hook, extras: [{ pubkey: k(), isSigner: false, isWritable: true }] };
  const config = k();
  const plain = launch.createLaunch(creator, mint, treasury, a.BRIDGED_SOL_MINT, 30, args, { launchConfig: config, customHook });

  it('passes the hook’s Timelock last, after the extras, only when asked', () => {
    const flagged = launch.createLaunch(creator, mint, treasury, a.BRIDGED_SOL_MINT, 30, args, { launchConfig: config, customHook, hookTimelocked: true });
    expect(flagged.keys.length).toBe(plain.keys.length + 1);
    expect(flagged.keys.at(-1)).toEqual({ pubkey: timelockAddress(hook), isSigner: false, isWritable: false });
    expect(flagged.keys.slice(0, -1).map((m) => m.pubkey.toBase58())).toEqual(plain.keys.map((m) => m.pubkey.toBase58()));
    expect(flagged.data).toEqual(plain.data);
  });

  it('leaves every other launch as it was', () => {
    const noHook = launch.createLaunch(creator, mint, treasury, a.BRIDGED_SOL_MINT, 30, args, { hookTimelocked: true });
    expect(noHook.keys.some((m) => m.pubkey.equals(timelockAddress(hook)))).toBe(false);
    expect(launch.createLaunch(creator, mint, treasury, a.BRIDGED_SOL_MINT, 30, args, { launchConfig: config, customHook, hookTimelocked: false }).keys.length).toBe(plain.keys.length);
  });

  it('explains the refusals', () => {
    const launchErrors = [...PROGRAM_ERRORS.launch.entries()];
    expect(launchErrors.find(([, e]) => e.name === 'HookTimelockPending')?.[0]).toBe(6045);
    expect([...PROGRAM_ERRORS.companion.entries()].find(([, e]) => e.name === 'TimelockPending')?.[0]).toBe(6066);
  });
});

describe('X4: steps of a game whose hook carries a hashed audit', () => {
  const [cranker, mint, hook] = [k(), k(), k()];

  it('needs the hook’s code only for an audit with a recorded hash', () => {
    expect(needsHookCode(null)).toBe(false);
    expect(needsHookCode({ audited: false, auditedHash: null })).toBe(false);
    expect(needsHookCode({ audited: true, auditedHash: null })).toBe(false);
    expect(needsHookCode({ audited: true, auditedHash: 'ab'.repeat(32) })).toBe(true);
  });

  it('appends the ProgramData (and, for claim_fees, the game) once, read-only, after the step’s own accounts', () => {
    const claim = companion.claimFees(cranker, mint, hook);
    const before = claim.keys.map((m) => ({ ...m }));
    const withCode = companion.withHookCode(claim, hook, a.gameAddress(mint));
    expect(withCode.keys.slice(0, before.length)).toEqual(before);
    expect(withCode.keys.slice(before.length)).toEqual([
      { pubkey: a.programDataAddress(hook), isSigner: false, isWritable: false },
      { pubkey: a.gameAddress(mint), isSigner: false, isWritable: false },
    ]);
    // Idempotent: a builder that already passes it (create_game_v2) gets nothing twice.
    expect(companion.withHookCode(withCode, hook, a.gameAddress(mint)).keys.length).toBe(withCode.keys.length);
  });
});

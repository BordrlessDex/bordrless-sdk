import { describe, expect, it } from 'vitest';
import { EVENT_WORDS, EXPLORER_PROGRAM_NAMES, eventLabel, eventName, eventSubject, explorerProgramOf, programLabel } from './explorer.ts';
import { PROGRAM_IDS } from './programs.ts';

/** Every event name the IDLs declare (packages/sdk/idl/*.json), so the table cannot fall behind a program. */
const IDL_EVENTS = [
  'AuthoritySet', 'Burned', 'DelegateSet', 'FrozenSet', 'HoldingClosed', 'HoldingCreated', 'HookDataWritten', 'HookSet', 'MetadataUpdated', 'MintCreated', 'Minted', 'Transferred',
  'ConfigSet', 'CurveFinalized', 'LiquidityAdded', 'LiquidityRemoved', 'PoolCreated', 'ProtocolFeesCollected', 'Swapped',
  'CreatorFeesClaimed', 'Graduated', 'LaunchConfigCreated', 'LaunchCreated',
  'KitGraduated', 'KitInstalled', 'RewardsClaimed', 'RewardsShared',
  'Unwrapped', 'Wrapped', 'WrapperRegistered',
  'Stoked',
];

describe('the explorer’s words', () => {
  it('name every event of the IDLs, in plain words, with the account it is about', () => {
    for (const name of IDL_EVENTS) expect(EVENT_WORDS[name], name).toBeDefined();
    expect(eventLabel('Transferred')).toBe('Transfer');
    expect(eventLabel('Wrapped')).toBe('Bridged in');
    expect(eventLabel('Unwrapped')).toBe('Bridged out');
    expect(eventLabel('RewardsClaimed')).toBe('Rewards claimed');
    expect(eventLabel('PoolCreated')).toBe('Pool created');
    // The coder's camelCase reads the same.
    expect([eventName('kitInstalled'), eventLabel('kitInstalled'), eventLabel('swapped')]).toEqual(['KitInstalled', 'Rules installed', 'Swap']);
    // An event the table does not know keeps its name, spaced.
    expect(eventLabel('somethingNewHappened')).toBe('Something new happened');
    expect(eventLabel('')).toBe('');
  });

  it('pick the subject from the payload, and none where the table names none or the payload lacks it', () => {
    expect(eventSubject('transferred', { mint: 'M', source: 'S' })).toBe('M');
    expect(eventSubject('Swapped', { pool: 'P' })).toBe('P');
    expect(eventSubject('Wrapped', { wrappedMint: 'W', underlyingMint: 'U' })).toBe('W');
    expect(eventSubject('Transferred', {})).toBeNull();
    expect(eventSubject('Unheard', { mint: 'M' })).toBeNull();
  });

  it('group programs: the five of Bordrless by name, every other id as a hook', () => {
    expect(explorerProgramOf(PROGRAM_IDS.token)).toBe('token');
    expect(explorerProgramOf(PROGRAM_IDS.swap)).toBe('swap');
    expect(explorerProgramOf(PROGRAM_IDS.launch)).toBe('launch');
    expect(explorerProgramOf(PROGRAM_IDS.halfLife)).toBe('hook');
    expect(explorerProgramOf('11111111111111111111111111111111')).toBe('hook');
    expect([programLabel(PROGRAM_IDS.swap), programLabel(PROGRAM_IDS.halfLife), programLabel(PROGRAM_IDS.taxHook), programLabel('11111111111111111111111111111111')]).toEqual(['DEX', 'Half-Life', 'Tax hook', 'Hook']);
    expect(Object.keys(EXPLORER_PROGRAM_NAMES)).toEqual(['token', 'swap', 'bridge', 'launch', 'kit', 'hook']);
  });
});

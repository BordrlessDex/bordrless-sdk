import { describe, expect, it } from 'vitest';
import { KEEPER_MAX_LAUNCHER_SHARE_BPS, PAIR_DEFAULT_LAUNCHER_SHARE_BPS, SCRIPT_APPROVER, SCRIPT_PAYOUT_OPEN, explainProgramError, feeSplitOf, keeperLaunchTerms, launchFeesOf, pairLauncherShareBps, scriptAuthorShare, withLauncherShare } from './index.ts';
import { COMPANION_PROGRAM } from './addresses.ts';

describe('fee readers', () => {
  it('reads a launch and its companion as the two fees', () => {
    expect(launchFeesOf({ creatorFeeBps: 150 }, { split: { buybackBps: 0, holdersBps: 0, beneficiaryBps: 3_333 } })).toEqual({ creatorFeeBps: 50, companionFeeBps: 100 });
    expect(launchFeesOf({ creatorFeeBps: 200 }, null)).toEqual({ creatorFeeBps: 200, companionFeeBps: 0 });
  });
  it('reads a pair config launcher share', () => {
    const keeper = withLauncherShare(keeperLaunchTerms(null), 7_000);
    expect(pairLauncherShareBps({ requiredCompanion: { kind: 'script', program: 'x', workshopId: null, name: 'n', title: null, author: null, keeper } })).toBe(7_000);
    expect(pairLauncherShareBps({ requiredCompanion: { kind: 'script', program: 'x', workshopId: null, name: 'n', title: null, author: null } })).toBeNull();
    expect(pairLauncherShareBps({ requiredCompanion: { kind: 'none' } })).toBeNull();
    expect(pairLauncherShareBps(null)).toBeNull();
  });
  it('re-exports the shared helpers and constants', () => {
    expect(PAIR_DEFAULT_LAUNCHER_SHARE_BPS).toBe(5_000);
    expect(KEEPER_MAX_LAUNCHER_SHARE_BPS).toBe(9_500);
    expect(SCRIPT_PAYOUT_OPEN.stepBps).toBe(10_000);
    expect(SCRIPT_APPROVER.toBase58()).toBe('3onVUMKmJYmEqLpbUTv1bdLixowHJyiRPF4ApEW8ipJW');
    expect(feeSplitOf({ creatorFeeBps: 50, companionFeeBps: 50 }).potBps).toBe(5_000);
    expect(scriptAuthorShare(1_000n, 0n, 5_000)).toBe(250n);
  });
  it('explains NotTermsAuthority', () => {
    const e = explainProgramError(COMPANION_PROGRAM, 6094);
    expect(e.name).toBe('NotTermsAuthority');
    expect(e.explanation).toMatch(/script approver/);
  });
});

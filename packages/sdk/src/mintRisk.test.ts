/**
 * A mint's risk label (docs/dex.md §6.2): the words every surface uses for the authorities a mint
 * still carries, its hook's label folded in, "Fixed" when nothing can change.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { mintRiskOf, type HookRiskLabel, type MintRiskInput } from './risk.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
const fixed: MintRiskInput = { decimals: 6, supply: 1_000_000_000_000_000n, maxSupply: 1_000_000_000_000_000n, mintAuthority: null, freezeAuthority: null, hookAuthority: null, metadataAuthority: null, hookProgram: null };
const hookLabel = (over: Partial<HookRiskLabel>): HookRiskLabel => ({ program: k(), class: 'immutable', delaySecs: null, author: null, pending: null, timelockProgramUpgradeable: null, audited: false, blocked: false, potCap: null, provenance: 'none', studio: null, severity: 'medium', words: "Nobody can change this code. Bordrless hasn't checked it.", callees: [], ...over });

describe('mintRiskOf', () => {
  it('calls a mint with every authority revoked and no hook fixed', () => {
    expect(mintRiskOf(fixed, null)).toEqual({ severity: 'low', words: 'Fixed: nobody can mint, freeze, or change its code or name.', reasons: [{ kind: 'fixed', severity: 'low', words: 'Fixed: nobody can mint, freeze, or change its code or name.' }], held: [] });
  });

  it('names each held authority in the §6.2 order, the worst first', () => {
    const creator = k();
    const label = mintRiskOf({ ...fixed, mintAuthority: creator, freezeAuthority: creator, hookAuthority: creator, metadataAuthority: creator, maxSupply: 0n }, null);
    expect(label.severity).toBe('high');
    expect(label.words).toBe('Its creator can swap its hook for other code at any time.');
    expect(label.reasons.map((r) => [r.kind, r.severity])).toEqual([
      ['hook_authority', 'high'],
      ['freeze_authority', 'high'],
      ['mint_authority', 'high'],
      ['metadata_authority', 'medium'],
    ]);
    expect(label.reasons[2]!.words).toBe('Its creator can mint more, without limit.');
    expect(label.held.map((h) => h.kind)).toEqual(['mint', 'freeze', 'hook', 'metadata']);
    expect(label.held.every((h) => h.authority.equals(creator))).toBe(true);
  });

  it('grades a capped mint authority by how much more it can mint', () => {
    const small = mintRiskOf({ ...fixed, mintAuthority: k(), maxSupply: 1_040_000_000_000_000n }, null);
    expect(small.severity).toBe('medium');
    expect(small.words).toBe('Its creator can mint up to 40,000,000 more (4% of supply).');
    const big = mintRiskOf({ ...fixed, mintAuthority: k(), maxSupply: 2_000_000_000_000_000n }, null);
    expect([big.severity, big.words]).toEqual(['high', 'Its creator can mint up to 1,000,000,000 more (100% of supply).']);
    // A cap already reached: nothing more can be minted, so the authority is held but harmless.
    const reached = mintRiskOf({ ...fixed, mintAuthority: k() }, null);
    expect(reached.reasons.map((r) => [r.kind, r.severity])).toEqual([['mint_authority', 'low']]);
    expect(reached.severity).toBe('low');
    expect(reached.held.map((h) => h.kind)).toEqual(['mint']);
  });

  it('folds the hook’s own label in, and a gone hook program first', () => {
    const hooked = mintRiskOf({ ...fixed, hookProgram: k() }, hookLabel({ class: 'author', severity: 'high', words: 'Its owner can change this code at any time.' }));
    expect([hooked.severity, hooked.words]).toEqual(['high', 'Its owner can change this code at any time.']);
    expect(hooked.reasons.map((r) => r.kind)).toEqual(['hook']);
    const gone = mintRiskOf({ ...fixed, hookProgram: k(), metadataAuthority: k() }, hookLabel({ class: 'missing', severity: 'high', words: "This hook's program is gone: every transfer fails." }));
    expect(gone.reasons.map((r) => r.kind)).toEqual(['hook_missing', 'metadata_authority']);
    expect(gone.words).toBe("This hook's program is gone: every transfer fails.");
    // A hooked mint whose hook could not be read claims nothing of it.
    const unread = mintRiskOf({ ...fixed, hookProgram: k() }, null);
    expect([unread.severity, unread.reasons.length]).toEqual(['medium', 0]);
  });
});

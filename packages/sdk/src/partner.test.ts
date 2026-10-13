/** The partner fee's builders and decoders against the launchpad's IDL and its Rust client (`docs/partner-fee.md`). */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as a from './addresses.ts';
import { CODERS } from './coders.ts';
import { decodePartnerFee, feeSplit, MAX_PARTNER_SHARE_BPS, NO_LAUNCH_RULES } from './accounts.ts';
import { launch } from './instructions.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
const row = (m: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }): [string, boolean, boolean] => [m.pubkey.toBase58(), m.isSigner, m.isWritable];
const ARGS = { rules: NO_LAUNCH_RULES, creatorFeeBps: 100, customHook: null, customHookFlags: 0, label: 'Partner' };

describe('the partner fee', () => {
  it('makes a partner config: create_config’s accounts with the partner’s after the config, the args', () => {
    const [creator, config, partner] = [k(), k(), k()];
    const ix = launch.createPartnerConfig(creator, config, ARGS, partner, 2_500, { authorShareBps: 1_000 });
    expect(ix.keys.slice(0, 6).map(row)).toEqual([
      [creator.toBase58(), true, true],
      [a.LAUNCH_CONFIG.toBase58(), false, false],
      [config.toBase58(), true, true],
      [a.partnerFeeAddress(config).toBase58(), false, true],
      [a.LAUNCH_PROGRAM.toBase58(), false, false],
      [a.SYSTEM_PROGRAM.toBase58(), false, false],
    ]);
    const plain = launch.createConfig(creator, config, ARGS);
    expect(ix.keys.length).toBe(plain.keys.length + 1);
    const d = CODERS.launch.instruction.decode(ix.data) as { name: string; data: { authorShareBps: number; partnerShareBps: number; partner: PublicKey; cut: { maxBuyBps: number; maxSellBps: number } } };
    expect(d.name).toBe('createPartnerConfig');
    expect([d.data.authorShareBps, d.data.partnerShareBps, d.data.partner.toBase58(), d.data.cut.maxBuyBps, d.data.cut.maxSellBps]).toEqual([1_000, 2_500, partner.toBase58(), 0, 0]);
  });

  it('adds the partner’s accounts to every claim, after the author’s', () => {
    const [creator, mint, config, author, partner] = [k(), k(), k(), k(), k()];
    const sol = a.BRIDGED_SOL_MINT;
    const base = launch.claimCreatorFees(creator, mint, sol);
    const both = launch.claimCreatorFees(creator, mint, sol, { config, author }, { config, partner });
    expect(both.keys.slice(0, base.keys.length)).toEqual(base.keys);
    expect(both.keys.slice(base.keys.length).map(row)).toEqual([
      [config.toBase58(), false, false],
      [a.holdingAddress(sol, author).toBase58(), false, true],
      [a.partnerFeeAddress(config).toBase58(), false, true],
      [a.holdingAddress(sol, partner).toBase58(), false, true],
    ]);
    const byAuthor = launch.claimAuthorFees(author, mint, sol, config, creator, partner);
    expect(byAuthor.keys.slice(-2).map(row)).toEqual([
      [a.partnerFeeAddress(config).toBase58(), false, true],
      [a.holdingAddress(sol, partner).toBase58(), false, true],
    ]);
    expect(launch.claimAuthorFees(author, mint, sol, config, creator).keys.length).toBe(byAuthor.keys.length - 2);
  });

  it('distributes with no signer, in the program’s order', () => {
    const [mint, config, creator, partner, author] = [k(), k(), k(), k(), k()];
    const sol = a.BRIDGED_SOL_MINT;
    const ix = launch.distributeFees(mint, sol, config, creator, partner, author);
    expect(ix.keys.every((m) => !m.isSigner)).toBe(true);
    const launchKey = a.launchAddress(mint);
    expect(ix.keys.map(row)).toEqual([
      [launchKey.toBase58(), false, true],
      [a.partnerFeeAddress(config).toBase58(), false, true],
      [sol.toBase58(), false, false],
      [a.holdingAddress(sol, launchKey).toBase58(), false, true],
      [a.holdingAddress(sol, creator).toBase58(), false, true],
      [a.holdingAddress(sol, partner).toBase58(), false, true],
      [a.TOKEN_PROGRAM.toBase58(), false, false],
      [a.TOKEN_EVENT_AUTHORITY.toBase58(), false, false],
      [a.eventAuthority(a.LAUNCH_PROGRAM).toBase58(), false, false],
      [a.LAUNCH_PROGRAM.toBase58(), false, false],
      [config.toBase58(), false, false],
      [a.holdingAddress(sol, author).toBase58(), false, true],
    ]);
    expect((CODERS.launch.instruction.decode(ix.data) as { name: string }).name).toBe('distributeFees');
    expect(launch.distributeFees(mint, sol, config, creator, partner).keys.length).toBe(ix.keys.length - 2);
  });

  it('splits as the program does and decodes the partner account', async () => {
    expect(feeSplit(1_000n, 3_000, 2_000)).toEqual({ creator: 500n, author: 300n, partner: 200n });
    expect(feeSplit(7n, 3_333, 3_333)).toEqual({ creator: 3n, author: 2n, partner: 2n });
    expect(feeSplit(1_000n, 0, MAX_PARTNER_SHARE_BPS)).toEqual({ creator: 0n, author: 0n, partner: 1_000n });
    const [config, partner] = [k(), k()];
    const data = await CODERS.launch.accounts.encode('partnerFee', { version: 1, bump: 254, config, partner, shareBps: 2_500, paidTotal: new (await import('bn.js')).default(42), reserved: Array(32).fill(0) });
    expect(decodePartnerFee(data)).toEqual({ version: 1, bump: 254, config, partner, shareBps: 2_500, paidTotal: 42n });
  });
});

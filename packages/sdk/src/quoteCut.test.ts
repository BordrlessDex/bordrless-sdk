/**
 * A custom hook's SOL cut (bordrless-programs `docs/quote-cut.md`): the four accounts a trade passes
 * after the launch pool's four, as the pool's registry resolves them; the swap builder adding them
 * for every trader of such a launch and for no other launch; the caps decoded from the reserved
 * bytes; `create_quote_cut_config` against the IDL.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as a from './addresses.ts';
import { NO_LAUNCH_RULES, QUOTE_CUT_MAX_BPS, quoteCutCapsOf } from './accounts.ts';
import { CODERS } from './coders.ts';
import { encodeHookAccountList, launchPoolRegistryList, launchPoolRegistryListWithQuoteCut, poolHookAccounts } from './hooks.ts';
import { launch, launchKeysOf } from './instructions.ts';
import { hookStateAddress } from './template.ts';

const k = (): PublicKey => Keypair.generate().publicKey;
const disc = (name: string): Buffer => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const SOL = a.BRIDGED_SOL_MINT;
const metas = (m: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) => m.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable]);

describe('the SOL cut', () => {
  const hook = k();
  const mint = k();
  const trader = k();
  const custom = { program: hook, extras: [] };

  it('passes the hook, the trader’s holding, the hook’s state and the launchpad’s signer, as the registry resolves them', () => {
    const extras = a.quoteCutExtras(hook, mint, trader);
    expect(metas(extras)).toEqual([
      [hook.toBase58(), false, false],
      [a.holdingAddress(mint, trader).toBase58(), false, false],
      [hookStateAddress(hook, mint).toBase58(), false, true],
      [PublicKey.findProgramAddressSync([Buffer.from('quote-cut'), hook.toBuffer()], a.LAUNCH_PROGRAM)[0].toBase58(), false, false],
    ]);
    const pool = a.launchPoolAddress(mint, SOL, 30);
    const list = launchPoolRegistryListWithQuoteCut(a.holderVaultAddress(mint, SOL), a.kitConfigAddress(mint), hook);
    const resolved = poolHookAccounts(list, a.dexHookSigner(a.LAUNCH_PROGRAM), pool, mint, SOL, trader);
    expect(metas(resolved)).toEqual(metas([...a.launchHookExtras(mint, SOL), ...extras]));
    // Four entries more than an ordinary launch pool's registry.
    const plain = encodeHookAccountList(launchPoolRegistryList(a.holderVaultAddress(mint, SOL), a.kitConfigAddress(mint)));
    expect(encodeHookAccountList(list).length).toBeGreaterThan(plain.length);
  });

  it('every swap of such a launch carries them for its trader, and no other launch’s does', () => {
    const base = { mint, quoteMint: SOL, lpFeeBps: 30, rules: NO_LAUNCH_RULES, customHook: hook };
    const keys = launchKeysOf({ ...base, quoteCut: { maxBuyBps: 500, maxSellBps: 0 } }, custom);
    expect(keys.quoteCutHook?.equals(hook)).toBe(true);
    for (const direction of [0, 1] as const) {
      const ix = launch.swap(keys, trader, trader, direction, 1_000n, 0n);
      expect(metas(ix.keys.slice(-4))).toEqual(metas(a.quoteCutExtras(hook, mint, trader)));
    }
    const plainKeys = launchKeysOf({ ...base, quoteCut: null }, custom);
    expect(plainKeys.quoteCutHook).toBeUndefined();
    // The creator trading to itself is exempt: no accounts. Buying for someone else, it pays.
    const creator = k();
    const withCreator = launchKeysOf({ ...base, creator, quoteCut: { maxBuyBps: 500, maxSellBps: 0 } }, custom);
    expect(launch.swap(withCreator, creator, creator, 1, 1_000n, 0n).keys.length).toBe(launch.swap(keys, trader, trader, 1, 1_000n, 0n).keys.length - 4);
    expect(metas(launch.swap(withCreator, creator, trader, 1, 1_000n, 0n).keys.slice(-4))).toEqual(metas(a.quoteCutExtras(hook, mint, creator)));
    const older = launchKeysOf(base, custom);
    expect(launch.swap(older, trader, trader, 1, 1_000n, 0n).keys.length).toBe(launch.swap(keys, trader, trader, 1, 1_000n, 0n).keys.length - 4);
  });

  it('reads the caps from the reserved bytes, zeros being none', () => {
    const r = new Uint8Array(30);
    expect(quoteCutCapsOf(r, 1)).toBeNull();
    r[1] = 0xe8; r[2] = 0x03; r[3] = 0x2c; r[4] = 0x01;
    expect(quoteCutCapsOf(r, 1)).toEqual({ maxBuyBps: 1_000, maxSellBps: 300 });
    expect(QUOTE_CUT_MAX_BPS).toBe(1_000);
  });

  it('builds create_quote_cut_config as create_config’s accounts with the caps', () => {
    const creator = k();
    const config = k();
    const args = { rules: NO_LAUNCH_RULES, creatorFeeBps: 100, customHook: hook, customHookFlags: 1, label: 'Whale bait' };
    const ix = launch.createQuoteCutConfig(creator, config, args, 0, { maxBuyBps: 700, maxSellBps: 700 });
    expect(ix.data.subarray(0, 8).equals(disc('create_quote_cut_config'))).toBe(true);
    expect(metas(ix.keys)).toEqual(metas(launch.createConfig(creator, config, args).keys));
    const decoded = CODERS.launch.instruction.decode(ix.data) as { name: string; data: { authorShareBps: number; cut: { maxBuyBps: number; maxSellBps: number } } } | null;
    expect(decoded?.name).toBe('createQuoteCutConfig');
    expect(decoded?.data.authorShareBps).toBe(0);
    expect(decoded?.data.cut).toEqual({ maxBuyBps: 700, maxSellBps: 700 });
  });
});

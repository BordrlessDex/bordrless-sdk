/**
 * Native SOL held to the Rust reference, byte for byte: `vectors/native-sol.json`, which `vectors/native-sol.gen.rs` renders
 * from bordrless-programs' clients on branch `native-sol` (every new instruction's accounts and data, every new event's bytes).
 * Then the decoders of the flags in `reserved` (and the companion's tail at 300, 308 and 309 bytes), the readers of native
 * balances, and the high-level builders picking `swap_v2` for a native launch.
 */
import { describe, expect, it } from 'vitest';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { LP_FEE_BPS } from '@bordrless/shared';
import vectors from '../vectors/native-sol.json' with { type: 'json' };
import * as a from './addresses.ts';
import { RENT_SYSVAR } from './timelock.ts';
import { CODERS, IDL } from './coders.ts';
import { decodeKitConfig, decodeLaunch, decodeLaunchConfig, decodePool, kitModulesOf, type LaunchRulesData, type Pool } from './accounts.ts';
import { COMPANION_LEN, COMPANION_LEN_NATIVE, COMPANION_LEN_V1, companion, decodeCompanion } from './companion.ts';
import { decodeEventPayload, type SwappedEvent } from './events.ts';
import { kit, launch, launchKeys, launchKeysOf, swap, type SwapArgs } from './instructions.ts';
import {
  NATIVE_POOL_FILTERS,
  RENT_EXEMPT_EMPTY,
  classicSellCapacity,
  companionSolOf,
  kitRewardVaultOf,
  launchCreatorFeesOf,
  launchSwapCutsOf,
  pairSwappedNative,
  poolBufferDrift,
  poolLamportsQuote,
  poolQuoteBooks,
  poolQuoteStateOf,
  rentExemptMinimum,
  loadRent,
  setRent,
  rentOfSysvar,
  LEGACY_RENT_LAMPORTS_PER_BYTE,
  lamportsAboveRent,
  swapSolSide,
  typedNativeEvent,
  vaultSlotSolOf,
} from './native.ts';
import { router } from './router.ts';
import { decodeVault, vault, type VaultView } from './vault.ts';

type V = { program: string; accounts: [string, boolean, boolean][]; data: string };
const vec = vectors as unknown as Record<string, V | [string, boolean, boolean][] | string>;
const k = (n: number): PublicKey => new PublicKey(Buffer.alloc(32, n));
const SOL = a.BRIDGED_SOL_MINT;
const metas = (ix: TransactionInstruction): [string, boolean, boolean][] => ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]);
function same(name: string, ix: TransactionInstruction): void {
  const v = vec[name] as V;
  expect(ix.programId.toBase58(), name).toBe(v.program);
  expect(metas(ix), name).toEqual(v.accounts);
  expect(Buffer.from(ix.data).toString('hex'), name).toBe(v.data);
}
const args = (direction: 0 | 1): SwapArgs => ({ direction, amountIn: 1_000_000n, minAmountOut: 5n, inHookAccounts: 0, outHookAccounts: 0, hookData: Uint8Array.from([1, 2]) });
const RULES: LaunchRulesData = { holderFeeBuyBps: 100, holderFeeSellBps: 100, burnBuyBps: 10, burnSellBps: 0, maxWalletBps: 0, creatorLockSecs: 0, earlyWindowSecs: 0, earlyLockSecs: 0 };
const KEYS = launchKeys(k(7), SOL, LP_FEE_BPS, RULES);

describe('native-SOL builders are the Rust clients’', () => {
  it('the DEX: swap_v2 (with and without the bridge), create_native_pool and the four quote-form instructions', () => {
    same('swapV2Bridge', swap.swapV2({ trader: k(1), pool: k(2), baseMint: k(3), traderBase: k(4), traderQuote: k(1), hookProgram: k(5), baseMintWritable: true, withBridge: true }, args(1), [{ pubkey: k(20), isSigner: false, isWritable: true }, { pubkey: k(21), isSigner: false, isWritable: false }]));
    same('swapV2Plain', swap.swapV2({ trader: k(1), pool: k(2), baseMint: k(3), traderBase: k(4), traderQuote: k(14), hookProgram: null }, args(0)));
    same('migratePool', swap.migratePoolToNative(k(6), k(2), 777n));
    same('revertPool', swap.revertPoolToBridged(k(6), k(2)));
    same('rebalancePool', swap.rebalancePool(k(1), k(2)));
    same('setBufferTarget', swap.setBufferTarget(k(6), k(2), 5n));
    same('createNativePool', swap.createNativePool(k(1), k(1), k(13), k(3), { lpFeeBps: 30, hookProgram: null, hookFlags: 0, virtualBase: 0n, virtualQuote: 0n, baseAmount: 1000n, quoteAmount: 2000n, baseHookAccounts: 0, quoteHookAccounts: 0, hookData: new Uint8Array() }));
  });

  it('the launchpad: swap_v2 on a launch pool, the _sol claims, set_native_launches, migrate and revert', () => {
    expect(KEYS.modules).toBe(kitModulesOf(RULES));
    same('launchSwapV2Buy', launch.swapV2(KEYS, k(1), k(15), 1, 1000n, 1n));
    same('launchSwapV2Sell', launch.swapV2(KEYS, k(1), k(15), 0, 1000n, 1n));
    same('launchSwapV2NoBridge', launch.swapV2(KEYS, k(1), k(1), 1, 1000n, 1n, { withBridge: false }));
    same('claimCreatorSol', launch.claimCreatorFeesSol(k(11), k(7)));
    same('claimCreatorSolBoth', launch.claimCreatorFeesSol(k(11), k(7), { config: k(9), author: k(8) }, { config: k(9), partner: k(10) }));
    same('claimAuthorSol', launch.claimAuthorFeesSol(k(8), k(7), k(9), k(11), k(10)));
    same('claimAuthorSolNoPartner', launch.claimAuthorFeesSol(k(8), k(7), k(9), k(11)));
    same('distributeSol', launch.distributeFeesSol(k(7), k(9), k(11), k(10), k(8)));
    same('distributeSolNoAuthor', launch.distributeFeesSol(k(7), k(9), k(11), k(10)));
    same('setNativeLaunches', launch.setNativeLaunches(k(6), true));
    same('migrateLaunch', launch.migrateLaunchToNative(k(6), k(7), SOL, KEYS.modules));
    same('migrateLaunchNoKit', launch.migrateLaunchToNative(k(6), k(7), SOL, 0));
    same('migrateLaunchKitNoRewards', launch.migrateLaunchToNative(k(6), k(7), SOL, 2));
    same('revertLaunch', launch.revertLaunchToBridged(k(6), k(7), SOL, KEYS.modules));
  });

  it('the kit, the companion, hook_vault and the router', () => {
    same('kitClaimSol', kit.claimSol(k(1), k(7)));
    same('kitShareSol', kit.shareSol(k(1), k(7), 12345n));
    same('kitSetNative', kit.setNative(k(16), k(1), k(7), k(17), SOL, true, true));
    same('kitSetNativeBare', kit.setNative(k(16), k(1), k(7), null, SOL, false, false));
    same('companionMigrate', companion.migrateToNative(k(6), k(7)));
    same('companionRevert', companion.revertToBridged(k(6), k(7)));
    expect(companion.nativeAccounts(KEYS).map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable])).toEqual(vec.companionNativeAccounts);
    const view = { mint: k(7), nSlots: 3, slots: [{ policy: 'sellForSol', pendingSol: 5n }, { policy: 'burn', pendingSol: 0n }, { policy: 'sellBuyBurn', pendingSol: 9n }] } as unknown as VaultView;
    same('vaultMigrate', vault.setVaultNative(k(6), view, true));
    same('vaultRevert', vault.setVaultNative(k(6), view, false));
    const dex = swap.swapV2({ trader: k(1), pool: k(2), baseMint: k(3), traderBase: k(4), traderQuote: k(14), hookProgram: null }, args(0));
    same('routerSwapV2', router.swapV2(k(1), k(12), k(13), dex, 50, 99n));
    expect(() => router.swapV2(k(1), k(12), k(13), swap.swap({ trader: k(1), pool: k(2), baseMint: k(3), quoteMint: SOL, traderBase: k(4), traderQuote: k(14), hookProgram: null }, args(0)), 50)).toThrow(/swap_v2/);
  });
});

describe('the native events, as the programs emit them', () => {
  const ev = (program: 'swap' | 'launch' | 'kit' | 'companion', name: string) => {
    const d = decodeEventPayload(program, Buffer.from(vec[name] as string, 'hex'));
    expect(d, name).not.toBeNull();
    return typedNativeEvent({ ordinal: 0, program, programId: '', name: d!.name, data: d!.data });
  };
  it('reads SwappedNative, PoolQuoteFormChanged, LaunchNativeSet, NativeLaunchesSet, KitNativeSet and CompanionNativeSet', () => {
    expect(ev('swap', 'evSwappedNative')).toEqual({
      kind: 'swap.SwappedNative',
      pool: k(2).toBase58(),
      direction: 1,
      quoteLamports: 123n,
      quoteDeltas: [
        { account: k(30).toBase58(), amount: 7n, wrapped: false },
        { account: k(31).toBase58(), amount: 8n, wrapped: true },
      ],
      bufferQuote: 9n,
      poolLamports: 10n,
    });
    expect(ev('swap', 'evPoolQuoteFormChanged')).toEqual({ kind: 'swap.PoolQuoteFormChanged', pool: k(2).toBase58(), change: 2, native: true, unwrapped: 1n, wrapped: 2n, bufferQuote: 3n, bufferTarget: 4n, quoteReserve: 5n, protocolFeesQuote: 6n, poolLamports: 7n, ts: 8 });
    expect(ev('launch', 'evLaunchNativeSet')).toEqual({ kind: 'launch.LaunchNativeSet', launch: k(40).toBase58(), mint: k(7).toBase58(), native: true, moved: 55n, ts: 66 });
    expect(ev('launch', 'evNativeLaunchesSet')).toEqual({ kind: 'launch.NativeLaunchesSet', on: true, ts: 3 });
    expect(ev('kit', 'evKitNativeSet')).toEqual({ kind: 'kit.KitNativeSet', mint: k(7).toBase58(), native: true, moved: 11n, lamportsBase: 22n, ts: 33 });
    expect(ev('companion', 'evCompanionNativeSet')).toEqual({ kind: 'companion.CompanionNativeSet', companion: k(41).toBase58(), native: true, moved: 44n, spare: 45n });
  });

  it('pairs a Swapped with the SwappedNative after it, and reads the SOL side of either kind of swap', () => {
    const swapped = { program: 'swap', name: 'swapped', data: { pool: 'P' } } as const;
    const native = { program: 'swap', name: 'swappedNative', data: { pool: 'P' } } as const;
    const other = { program: 'token', name: 'transferred', data: {} } as const;
    expect(pairSwappedNative([swapped, native, other, swapped])).toEqual([{ swapped, native }, { swapped, native: null }]);
    const sw = { direction: 1, amountIn: 100n, deltasIn: [{ holding: 'H', amount: 3n }], deltasOut: [], deliveredOut: 0n } as unknown as SwappedEvent;
    expect(swapSolSide(sw, null)).toEqual({ native: false, solIn: 100n, solOut: 0n, quoteCuts: [{ account: 'H', amount: 3n }] });
    const n = ev('swap', 'evSwappedNative');
    if (n?.kind !== 'swap.SwappedNative') throw new Error('expected SwappedNative');
    expect(swapSolSide(sw, n)).toEqual({ native: true, solIn: 138n, solOut: 0n, quoteCuts: [{ account: k(30).toBase58(), amount: 7n }, { account: k(31).toBase58(), amount: 8n }] });
  });
});

describe('the flags in reserved', () => {
  /** An account of `program` with every field zero but `reserved`, whose bytes `set` writes at their indices, encoded by the IDL coder (an `Option` field's absence moves `reserved`, so it is never set by offset). */
  const encode = async (program: 'swap' | 'launch' | 'kit', account: string, set: Record<number, number[]>, patch: Record<string, unknown> = {}): Promise<Buffer> => {
    const coder = CODERS[program].accounts;
    const disc = (IDL[program] as unknown as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((x) => x.name.toLowerCase() === account.toLowerCase())!.discriminator;
    const zero = Buffer.alloc(coder.size(account));
    Buffer.from(disc).copy(zero);
    const raw = { ...(coder.decode(account, zero) as Record<string, unknown>), ...patch };
    const reserved = [...(raw.reserved as number[])];
    for (const [at, bytes] of Object.entries(set)) bytes.forEach((x, i) => (reserved[Number(at) + i] = x));
    return Buffer.from(await coder.encode(account, { ...raw, reserved }));
  };
  const u64 = (v: bigint): number[] => { const x = Buffer.alloc(8); x.writeBigUInt64LE(v); return [...x]; };

  it('reads a pool’s native flag, buffer and target at 351, 352 and 360', async () => {
    const data = await encode('swap', 'pool', { 0: [1], 1: u64(5_000n), 9: u64(7_000n) }, { hookProgram: a.LAUNCH_PROGRAM });
    expect(data.length).toBe(411);
    expect([data[171], data[351], data.readBigUInt64LE(352), data.readBigUInt64LE(360)]).toEqual([1, 1, 5_000n, 7_000n]);
    const p = decodePool(data);
    expect([p.quoteNative, p.bufferQuote, p.bufferTarget]).toEqual([true, 5_000n, 7_000n]);
    // A hook-less pool's `reserved` sits 32 bytes earlier (its `Option` takes one byte): the decoder reads it all the same.
    const bare = await encode('swap', 'pool', { 0: [1], 1: u64(1n) });
    expect(bare[319]).toBe(1);
    expect(decodePool(bare)).toMatchObject({ quoteNative: true, bufferQuote: 1n });
    expect(decodePool(await encode('swap', 'pool', {}))).toMatchObject({ quoteNative: false, bufferQuote: 0n, bufferTarget: 0n });
    expect([NATIVE_POOL_FILTERS[1].memcmp.offset, NATIVE_POOL_FILTERS[2].memcmp.offset]).toEqual([171, 351]);
  });

  it('reads a launch’s native flag (reserved[17]), the launchpad config’s, and a kit’s with its lamport base', async () => {
    expect(decodeLaunch(await encode('launch', 'launch', { 17: [1] })).isNative).toBe(true);
    expect(decodeLaunch(await encode('launch', 'launch', {})).isNative).toBe(false);
    expect(decodeLaunchConfig(await encode('launch', 'config', { 0: [1] })).nativeLaunches).toBe(true);
    const c = decodeKitConfig(await encode('kit', 'kitConfig', { 0: [1], 1: u64(1_461_600n) }));
    expect([c.isNative, c.lamportsBase]).toEqual([true, 1_461_600n]);
  });

  it('reads a companion at 300, 308 and 309 bytes: only a grown one can be native', () => {
    const disc = (IDL.companion as unknown as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((x) => x.name === 'Companion')!.discriminator;
    const of = (len: number, native = 0): Buffer => {
      const b = Buffer.alloc(len);
      Buffer.from(disc).copy(b);
      if (len === COMPANION_LEN_NATIVE) b[COMPANION_LEN] = native;
      return b;
    };
    expect([COMPANION_LEN_V1, COMPANION_LEN, COMPANION_LEN_NATIVE]).toEqual([300, 308, 309]);
    expect(decodeCompanion(of(300))).toMatchObject({ quoteCutClaimed: null, nativeSol: false });
    expect(decodeCompanion(of(308))).toMatchObject({ quoteCutClaimed: 0n, nativeSol: false });
    expect(decodeCompanion(of(309))).toMatchObject({ quoteCutClaimed: 0n, nativeSol: false });
    expect(decodeCompanion(of(309, 1))).toMatchObject({ quoteCutClaimed: 0n, nativeSol: true });
  });

  it('reads a hook vault’s native flag', () => {
    const size = CODERS.hookVault.accounts.size('vault');
    const disc = (IDL.hookVault as unknown as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((x) => x.name === 'Vault')!.discriminator;
    const b = Buffer.alloc(size);
    Buffer.from(disc).copy(b);
    expect(decodeVault(b).isNative).toBe(false);
    b[size - 64] = 1;
    expect(decodeVault(b).isNative).toBe(true);
  });
});

describe('native balances', () => {
  const pool = { quoteReserve: 10_000n, protocolFeesQuote: 500n, quoteNative: true, bufferQuote: 1_500n, bufferTarget: 1_000n } as Pool;
  it('a pool’s books, its lamports and its buffer', () => {
    expect([poolQuoteBooks(pool), poolLamportsQuote(pool), poolBufferDrift(pool), classicSellCapacity(pool)]).toEqual([10_500n, 9_000n, 500n, 1_500n]);
    const bridged = { ...pool, quoteNative: false, bufferQuote: 0n };
    expect([poolLamportsQuote(bridged), poolBufferDrift(bridged), classicSellCapacity(bridged)]).toEqual([0n, 0n, null]);
    expect(rentExemptMinimum(0)).toBe(890_880n);
    const info = { lamports: Number(rentExemptMinimum(411) + 9_000n), data: Buffer.alloc(411) };
    const st = poolQuoteStateOf({ ...pool, quoteVault: k(9) } as Pool, info, null);
    expect(st).toMatchObject({ native: true, books: 10_500n, lamportsQuote: 9_000n, vaultQuote: 1_500n, poolLamportsAboveRent: 9_000n, vaultBalance: 0n, invariantHolds: false });
  });

  it('creator fees, kit rewards, companion pots and vault slots read lamports when native', () => {
    expect(launchCreatorFeesOf({ isNative: true }, { lamports: Number(rentExemptMinimum(600) + 42n), data: Buffer.alloc(600) }, null)).toBe(42n);
    expect(launchCreatorFeesOf({ isNative: false }, null, null)).toBe(0n);
    expect(kitRewardVaultOf({ isNative: true, lamportsBase: 1_000n }, 1_250n, null)).toBe(250n);
    expect(kitRewardVaultOf({ isNative: true, lamportsBase: 1_000n }, 900n, null)).toBe(0n);
    expect(companionSolOf({ nativeSol: true }, RENT_EXEMPT_EMPTY + 7n, null)).toBe(7n);
    expect(vaultSlotSolOf({ isNative: true }, RENT_EXEMPT_EMPTY - 1n, null)).toBe(0n);
  });

  it('read rent at the cluster’s rate (the Rent sysvar), not the legacy one', async () => {
    // Mainnet, 15 Oct 2026: SIMD-0437-2, 5,080 lamports per byte-year, threshold 1.
    const sysvar = Buffer.alloc(17);
    sysvar.writeBigUInt64LE(5_080n, 0);
    sysvar.writeDoubleLE(1, 8);
    sysvar[16] = 50;
    try {
      expect(await loadRent({ getAccountInfo: async (key: PublicKey) => (key.equals(RENT_SYSVAR) ? ({ data: sysvar } as never) : null) })).toBe(650_240n);
      expect(rentExemptMinimum(411)).toBe(539n * 5_080n);
      expect(launchCreatorFeesOf({ isNative: true }, { lamports: Number(728n * 5_080n + 42n), data: Buffer.alloc(600) }, null)).toBe(42n);
      expect(companionSolOf({ nativeSol: true }, 650_240n + 7n, null)).toBe(7n);
      // The legacy rate on a mainnet account would have read 0 and under-counted every launch's fees.
      expect(lamportsAboveRent(728n * 5_080n + 42n, 600) > lamportsAboveRent(728n * 5_080n + 42n, 0) - 728n * 5_080n).toBe(true);
      // The old rate: 3,480 a byte-year, two years.
      setRent(rentOfSysvar(Buffer.concat([Buffer.from(new BigUint64Array([3_480n]).buffer), Buffer.from(new Float64Array([2]).buffer), Buffer.from([50])])));
      expect(rentExemptMinimum(0)).toBe(890_880n);
    } finally {
      setRent(LEGACY_RENT_LAMPORTS_PER_BYTE);
    }
  });

  it('a launch-pool swap’s cuts, wherever the launch keeps them', () => {
    const mint = k(7);
    const ev = (holdings: string[]) => ({ direction: 1, deltasIn: holdings.map((h, i) => ({ holding: h, amount: BigInt(i + 1) })), deltasOut: [], burnOut: 4n, burnIn: 0n }) as unknown as SwappedEvent;
    expect(launchSwapCutsOf(ev([a.launchAddress(mint).toBase58(), a.kitConfigAddress(mint).toBase58()]), mint, SOL)).toEqual({ creatorFee: 1n, holderFee: 2n, burn: 4n });
    expect(launchSwapCutsOf(ev([a.holdingAddress(SOL, a.launchAddress(mint)).toBase58(), a.holderVaultAddress(mint, SOL).toBase58()]), mint, SOL)).toEqual({ creatorFee: 1n, holderFee: 2n, burn: 4n });
  });
});

describe('the high-level builders pick the path per launch', () => {
  it('launch.swap builds swap_v2 for native keys and the classic swap otherwise; launchKeysOf reads the flag', () => {
    const name = (ix: TransactionInstruction): string => (CODERS.swap.instruction.decode(Buffer.from(ix.data)) as { name: string }).name;
    expect(name(launch.swap(KEYS, k(1), k(1), 1, 10n, 1n))).toBe('swap');
    expect(name(launch.swap({ ...KEYS, native: true }, k(1), k(1), 1, 10n, 1n))).toBe('swapV2');
    expect(metas(launch.swap({ ...KEYS, native: true }, k(1), k(15), 1, 1000n, 1n))).toEqual((vec.launchSwapV2Buy as V).accounts);
    const l = { mint: k(7), quoteMint: SOL, lpFeeBps: LP_FEE_BPS, rules: RULES, customHook: null };
    expect(launchKeysOf(l).native).toBeUndefined();
    expect(launchKeysOf({ ...l, isNative: true }).native).toBe(true);
    // The classic path is unchanged for everyone else, and stays reachable on a native launch.
    expect(metas(launch.swapClassic({ ...KEYS, native: true }, k(1), k(1), 1, 10n, 1n))).toEqual(metas(launch.swap(KEYS, k(1), k(1), 1, 10n, 1n)));
  });

  it('claims and swaps by form: claimCreatorFeesFor, kit.claimFor, swap.swapFor', () => {
    const name = (program: 'launch' | 'kit' | 'swap', ix: TransactionInstruction): string => (CODERS[program].instruction.decode(Buffer.from(ix.data)) as { name: string }).name;
    expect(name('launch', launch.claimCreatorFeesFor({ mint: k(7), quoteMint: SOL, isNative: true }, k(11)))).toBe('claimCreatorFeesSol');
    expect(name('launch', launch.claimCreatorFeesFor({ mint: k(7), quoteMint: SOL }, k(11)))).toBe('claimCreatorFees');
    expect(name('kit', kit.claimFor({ mint: k(7), rewardMint: SOL, isNative: true }, k(1)))).toBe('claimSol');
    expect(name('kit', kit.claimFor({ mint: k(7), rewardMint: SOL }, k(1)))).toBe('claim');
    const keys = { trader: k(1), pool: k(2), baseMint: k(3), quoteMint: SOL, traderBase: k(4), traderQuote: a.holdingAddress(SOL, k(1)), hookProgram: null };
    expect(name('swap', swap.swapFor({ quoteNative: false }, keys, args(1)))).toBe('swap');
    const v2 = swap.swapFor({ quoteNative: true }, keys, args(0), [], k(14));
    expect(name('swap', v2)).toBe('swapV2');
    expect(v2.keys[7]!.pubkey.equals(k(14))).toBe(true);
  });
});

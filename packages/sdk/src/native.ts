/**
 * Native SOL (bordrless-programs `docs/native-sol-migration.md`): a pool, a launch, a kit, a companion or a hook_vault slot
 * that holds SOL as lamports instead of bridged SOL (`A49oVh…`) in a holding. No address changes: a native pool keeps bridged
 * SOL as its `quote_mint` and in its seeds. What changes is where the SOL is, and so how it is read and which instruction moves it:
 *
 * | account | bridged form | native form | flag |
 * | --- | --- | --- | --- |
 * | DEX pool | quote vault | pool lamports above rent, plus a bridged-SOL buffer in the vault | `Pool.quoteNative` |
 * | launch | `holding(bridged, launch)` | launch lamports above rent | `Launch.isNative` |
 * | kit reward vault | `holding(bridged, kit config)` | kit config lamports above `lamportsBase` | `KitConfig.isNative` |
 * | companion | `holding(bridged, companion address)` | companion address lamports above rent(0) | `Companion.nativeSol` |
 * | hook_vault slot | `holding(bridged, slot owner)` | slot owner lamports above rent(0) | `Vault.isNative` |
 *
 * A native pool trades with `swap_v2` (`swap.swapV2`, `launch.swapV2`, or `launch.swap` with `native` or `poolNative` keys). The
 * old `swap` keeps working on it through the buffer: a buy's bridged SOL joins the buffer; a sell is paid from it, and what the
 * buffer can't cover is paid as SOL to the trader's wallet when the swap is top level, the trader owns the delivery holding and
 * the launch is native too. Otherwise (a CPI, a delegate, a held coin's bridged cuts) it fails with `BufferShort`.
 *
 * Pool reserves and TVL come from the pool's books (`quoteReserve + protocolFeesQuote`), never from the vault's balance, which
 * on a native pool is only the buffer.
 */
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { decodeHolding, decodeKitConfig, decodeLaunch, decodePool, type KitConfig, type Launch, type Pool } from './accounts.ts';
import * as a from './addresses.ts';
import { decodeCompanion, type Companion } from './companion.ts';
import type { DecodedEvent, SwappedEvent } from './events.ts';
import { eventKey } from './events.ts';
import { RENT_SYSVAR } from './timelock.ts';
import { decodeVault, slotOwner, type Vault } from './vault.ts';

// ---- rent --------------------------------------------------------------------------------------------

/** The legacy rent (3,480 lamports per byte-year over two years): what a reader assumes before `loadRent`. */
export const LEGACY_RENT_LAMPORTS_PER_BYTE = 6_960n;

/**
 * The cluster's rent, as its Rent sysvar says: lamports per byte-year and the exemption threshold. Mainnet changes it by
 * feature (SIMD-0194, then SIMD-0437's steps: 6,333, 5,080, 2,575, 1,322, 696 lamports per byte), so a reader that decides
 * what of an account's lamports is SOL above its rent must read it (`loadRent`) rather than assume one. Until then: legacy.
 */
let rent = { lamportsPerByteYear: LEGACY_RENT_LAMPORTS_PER_BYTE, threshold: 1 };

/** The Rent sysvar's data as rent: `lamports_per_byte_year` (u64), `exemption_threshold` (f64), `burn_percent` (u8). */
export function rentOfSysvar(data: Uint8Array): { lamportsPerByteYear: bigint; threshold: number } {
  const b = Buffer.from(data);
  if (b.length < 16) throw new Error('not a Rent sysvar');
  return { lamportsPerByteYear: b.readBigUInt64LE(0), threshold: b.readDoubleLE(8) };
}
/** Sets the rent the readers below use (from `rentOfSysvar`, or the lamports per byte with a threshold of 1). */
export function setRent(r: { lamportsPerByteYear: bigint; threshold: number } | bigint): void {
  rent = typeof r === 'bigint' ? { lamportsPerByteYear: r, threshold: 1 } : { ...r };
}
/** Reads the cluster's Rent sysvar and sets it (`setRent`); answers the rent-exempt minimum of an empty account. */
export async function loadRent(connection: Pick<Connection, 'getAccountInfo'>): Promise<bigint> {
  const info = await connection.getAccountInfo(RENT_SYSVAR, 'confirmed');
  if (!info) throw new Error('the Rent sysvar could not be read');
  setRent(rentOfSysvar(info.data));
  return rentExemptMinimum(0);
}

/** The rent-exempt minimum of an account of `dataLen` bytes at the cluster's rent (`loadRent`): as the runtime's `Rent::minimum_balance`. */
export const rentExemptMinimum = (dataLen: number): bigint => {
  const base = BigInt(dataLen + 128) * rent.lamportsPerByteYear;
  return Number.isInteger(rent.threshold) ? base * BigInt(rent.threshold) : BigInt(Math.floor(Number(base) * rent.threshold));
};
/** @deprecated The legacy rent-exempt minimum of an empty account (890,880): use `rentExemptMinimum(0)`, at the cluster's rent. */
export const RENT_EXEMPT_EMPTY = BigInt(128) * LEGACY_RENT_LAMPORTS_PER_BYTE;
/** An account's lamports above its rent-exempt minimum at the cluster's rent (0 when below). */
export const lamportsAboveRent = (lamports: bigint | number, dataLen: number): bigint => {
  const extra = BigInt(lamports) - rentExemptMinimum(dataLen);
  return extra > 0n ? extra : 0n;
};

// ---- pools -------------------------------------------------------------------------------------------

/** Whether a decoded pool is native (`Pool.quoteNative`); false for one decoded by older code. */
export const isNativePool = (pool: Partial<Pick<Pool, 'quoteNative'>>): boolean => pool.quoteNative === true;
/** A pool's whole quote by its books: `quoteReserve + protocolFeesQuote`, whatever its form (the TVL's quote side). */
export const poolQuoteBooks = (pool: Pick<Pool, 'quoteReserve' | 'protocolFeesQuote'>): bigint => pool.quoteReserve + pool.protocolFeesQuote;
/** A native pool's quote held as lamports above its rent: `books - buffer` (0 for a bridged pool, all of whose quote is in its vault). */
export const poolLamportsQuote = (pool: Pick<Pool, 'quoteReserve' | 'protocolFeesQuote'> & Partial<Pick<Pool, 'quoteNative' | 'bufferQuote'>>): bigint =>
  isNativePool(pool) ? poolQuoteBooks(pool) - (pool.bufferQuote ?? 0n) : 0n;
/** How far a native pool's buffer is from its target (positive: above it). 0 for a bridged pool. */
export const poolBufferDrift = (pool: Partial<Pick<Pool, 'quoteNative' | 'bufferQuote' | 'bufferTarget'>>): bigint =>
  isNativePool(pool) ? (pool.bufferQuote ?? 0n) - (pool.bufferTarget ?? 0n) : 0n;
/**
 * The most an old-style (`swap`) sell on a native pool can be paid in bridged SOL: its buffer. Beyond it, a top-level sell by
 * the delivery holding's owner gets the rest as SOL to its wallet; a CPI, a delegate's sell, or a held coin's bridged cuts beyond
 * it fail with `BufferShort`. Unlimited (null) on a bridged pool.
 */
export const classicSellCapacity = (pool: Partial<Pick<Pool, 'quoteNative' | 'bufferQuote'>>): bigint | null => (isNativePool(pool) ? (pool.bufferQuote ?? 0n) : null);

/** A pool's quote as it sits on chain: the books, and where they are (lamports on the pool, bridged SOL in the vault). */
export interface PoolQuoteState {
  native: boolean;
  /** `quoteReserve + protocolFeesQuote`. */
  books: bigint;
  /** The books held as lamports on the pool (0 bridged). */
  lamportsQuote: bigint;
  /** The books held in the quote vault: the buffer of a native pool, the whole books of a bridged one. */
  vaultQuote: bigint;
  /** The pool account's lamports above its rent-exempt minimum, as read (a donation shows here, never in the books). */
  poolLamportsAboveRent: bigint;
  /** The quote vault's balance as read. */
  vaultBalance: bigint;
  /** Whether the on-chain invariant holds: lamports cover `lamportsQuote`, the vault covers its part. */
  invariantHolds: boolean;
}

/** A pool's quote state from its account and its quote vault's account (either may be null when missing). */
export function poolQuoteStateOf(pool: Pool, poolInfo: Pick<AccountInfo<Buffer>, 'lamports' | 'data'> | null, vaultInfo: Pick<AccountInfo<Buffer>, 'data'> | null): PoolQuoteState {
  const native = isNativePool(pool);
  const books = poolQuoteBooks(pool);
  const lamportsQuote = poolLamportsQuote(pool);
  const vaultQuote = native ? (pool.bufferQuote ?? 0n) : books;
  const poolLamportsAboveRent = poolInfo ? lamportsAboveRent(poolInfo.lamports, poolInfo.data.length) : 0n;
  const vaultBalance = vaultInfo ? decodeHolding(vaultInfo.data).amount : 0n;
  return { native, books, lamportsQuote, vaultQuote, poolLamportsAboveRent, vaultBalance, invariantHolds: poolLamportsAboveRent >= lamportsQuote && vaultBalance >= vaultQuote };
}

/** Reads a pool and its quote vault and gives its quote state; null when the pool does not exist. */
export async function fetchPoolQuoteState(connection: Pick<Connection, 'getMultipleAccountsInfo'>, poolKey: PublicKey): Promise<{ pool: Pool; state: PoolQuoteState } | null> {
  const [info] = await connection.getMultipleAccountsInfo([poolKey]);
  if (!info) return null;
  const pool = decodePool(info.data);
  const [vault] = await connection.getMultipleAccountsInfo([pool.quoteVault]);
  return { pool, state: poolQuoteStateOf(pool, info, vault ?? null) };
}

/**
 * `getProgramAccounts` filters for the DEX's native pools that have a hook (every launch pool): 411 bytes, flag byte 1 at 351.
 * A hook-less pool's `reserved` starts 32 bytes earlier (its `Option` hook takes one byte), so its flag is at 319: list those
 * with `NATIVE_HOOKLESS_POOL_FILTERS`, or decode every pool (`decodePool` reads either).
 */
export const NATIVE_POOL_FILTERS = [{ dataSize: 411 }, { memcmp: { offset: 171, bytes: '2' } }, { memcmp: { offset: 351, bytes: '2' } }] as const;
export const NATIVE_HOOKLESS_POOL_FILTERS = [{ dataSize: 411 }, { memcmp: { offset: 171, bytes: '1' } }, { memcmp: { offset: 319, bytes: '2' } }] as const;

// ---- the quote a trader spends or gets ----------------------------------------------------------------

/**
 * What a trader can spend on a buy of a pool: its wallet's lamports (less `keepLamports` for fees and rent) on a native pool,
 * its holding of bridged SOL on a bridged one.
 */
export async function spendableQuote(connection: Pick<Connection, 'getBalance' | 'getAccountInfo'>, pool: Partial<Pick<Pool, 'quoteNative'>> & Pick<Pool, 'quoteMint'>, trader: PublicKey, keepLamports = 10_000_000n): Promise<bigint> {
  if (isNativePool(pool)) {
    const lamports = BigInt(await connection.getBalance(trader));
    return lamports > keepLamports ? lamports - keepLamports : 0n;
  }
  const info = await connection.getAccountInfo(a.holdingAddress(pool.quoteMint, trader));
  return info ? decodeHolding(info.data).amount : 0n;
}

// ---- launches ------------------------------------------------------------------------------------------

/** A launch's unclaimed creator fees from its accounts: the launch's lamports above rent when native, its quote holding's balance otherwise. */
export function launchCreatorFeesOf(launch: Partial<Pick<Launch, 'isNative'>>, launchInfo: Pick<AccountInfo<Buffer>, 'lamports' | 'data'> | null, quoteHoldingInfo: Pick<AccountInfo<Buffer>, 'data'> | null): bigint {
  if (launch.isNative) return launchInfo ? lamportsAboveRent(launchInfo.lamports, launchInfo.data.length) : 0n;
  return quoteHoldingInfo ? decodeHolding(quoteHoldingInfo.data).amount : 0n;
}

/** Reads a launch's unclaimed creator fees, whichever its form. */
export async function fetchLaunchCreatorFees(connection: Pick<Connection, 'getMultipleAccountsInfo'>, mint: PublicKey): Promise<{ launch: Launch; fees: bigint } | null> {
  const launchKey = a.launchAddress(mint);
  const [info] = await connection.getMultipleAccountsInfo([launchKey]);
  if (!info) return null;
  const launch = decodeLaunch(info.data);
  if (launch.isNative) return { launch, fees: launchCreatorFeesOf(launch, info, null) };
  const [holding] = await connection.getMultipleAccountsInfo([a.holdingAddress(launch.quoteMint, launchKey)]);
  return { launch, fees: launchCreatorFeesOf(launch, info, holding ?? null) };
}

/**
 * A launch-pool swap's fees by where they went, whichever its form: a native launch's creator fee is the delta to the launch
 * account itself and its holder fee the delta to the kit config; a bridged launch's are the deltas to its quote holding and to
 * the holder vault (`launchSwapCuts`).
 */
export function launchSwapCutsOf(ev: SwappedEvent, mint: PublicKey, quoteMint: PublicKey): { creatorFee: bigint; holderFee: bigint; burn: bigint } {
  const deltas = ev.direction === 1 ? ev.deltasIn : ev.deltasOut;
  const launchKey = a.launchAddress(mint);
  const creatorAt = new Set([launchKey.toBase58(), a.holdingAddress(quoteMint, launchKey).toBase58()]);
  const holderAt = new Set([a.kitConfigAddress(mint).toBase58(), a.holderVaultAddress(mint, quoteMint).toBase58()]);
  const sum = (at: Set<string>): bigint => deltas.filter((x) => at.has(x.holding)).reduce((t, x) => t + x.amount, 0n);
  return { creatorFee: sum(creatorAt), holderFee: sum(holderAt), burn: ev.direction === 1 ? ev.burnOut : ev.burnIn };
}

// ---- kits ---------------------------------------------------------------------------------------------

/** A kit's reward vault amount: the config's lamports above `lamportsBase` when native, the reward vault holding's balance otherwise. */
export function kitRewardVaultOf(config: Partial<Pick<KitConfig, 'isNative' | 'lamportsBase'>>, configLamports: bigint | number, rewardVaultInfo: Pick<AccountInfo<Buffer>, 'data'> | null): bigint {
  if (config.isNative) {
    const extra = BigInt(configLamports) - (config.lamportsBase ?? 0n);
    return extra > 0n ? extra : 0n;
  }
  return rewardVaultInfo ? decodeHolding(rewardVaultInfo.data).amount : 0n;
}

/** Reads a kit's reward vault amount, whichever its form. */
export async function fetchKitRewardVault(connection: Pick<Connection, 'getMultipleAccountsInfo'>, mint: PublicKey): Promise<{ config: KitConfig; vault: bigint } | null> {
  const [info] = await connection.getMultipleAccountsInfo([a.kitConfigAddress(mint)]);
  if (!info) return null;
  const config = decodeKitConfig(info.data);
  if (config.isNative) return { config, vault: kitRewardVaultOf(config, info.lamports, null) };
  const [vault] = config.rewardVault.equals(PublicKey.default) ? [null] : await connection.getMultipleAccountsInfo([config.rewardVault]);
  return { config, vault: kitRewardVaultOf(config, info.lamports, vault ?? null) };
}

// ---- companions and hook_vault slots ------------------------------------------------------------------

/** A companion's SOL (everything it sets aside): its companion address's (`companionCreatorAddress(mint)`) lamports above rent(0) when native, that address's holding of bridged SOL otherwise. */
export function companionSolOf(companion: Partial<Pick<Companion, 'nativeSol'>>, creatorLamports: bigint | number, creatorHoldingInfo: Pick<AccountInfo<Buffer>, 'data'> | null): bigint {
  if (companion.nativeSol) return lamportsAboveRent(creatorLamports, 0);
  return creatorHoldingInfo ? decodeHolding(creatorHoldingInfo.data).amount : 0n;
}

/** Reads a companion's SOL, whichever its form. */
export async function fetchCompanionSol(connection: Pick<Connection, 'getMultipleAccountsInfo'>, mint: PublicKey): Promise<{ companion: Companion; sol: bigint } | null> {
  const creator = a.companionCreatorAddress(mint);
  const [info, creatorInfo, holding] = await connection.getMultipleAccountsInfo([a.companionAddress(mint), creator, a.holdingAddress(a.BRIDGED_SOL_MINT, creator)]);
  if (!info) return null;
  const companion = decodeCompanion(info.data);
  return { companion, sol: companionSolOf(companion, creatorInfo?.lamports ?? 0, holding ?? null) };
}

/** A hook_vault slot's SOL: its owner's lamports above rent(0) when the vault is native, the owner's holding of bridged SOL otherwise. */
export function vaultSlotSolOf(vault: Partial<Pick<Vault, 'isNative'>>, ownerLamports: bigint | number, ownerHoldingInfo: Pick<AccountInfo<Buffer>, 'data'> | null): bigint {
  if (vault.isNative) return lamportsAboveRent(ownerLamports, 0);
  return ownerHoldingInfo ? decodeHolding(ownerHoldingInfo.data).amount : 0n;
}

/** Reads every slot's SOL of a hook vault, whichever its form. */
export async function fetchVaultSlotsSol(connection: Pick<Connection, 'getMultipleAccountsInfo'>, vaultKey: PublicKey): Promise<{ vault: Vault; sol: bigint[] } | null> {
  const [info] = await connection.getMultipleAccountsInfo([vaultKey]);
  if (!info) return null;
  const vault = decodeVault(info.data);
  const owners = Array.from({ length: vault.nSlots }, (_, i) => slotOwner(vault.mint, i));
  const infos = await connection.getMultipleAccountsInfo([...owners, ...owners.map((o) => a.holdingAddress(a.BRIDGED_SOL_MINT, o))]);
  return { vault, sol: owners.map((_, i) => vaultSlotSolOf(vault, infos[i]?.lamports ?? 0, infos[owners.length + i] ?? null)) };
}

// ---- events -------------------------------------------------------------------------------------------

/** One quote-side cut of a `swap_v2`: the account paid, the lamports, and whether it was wrapped into a holding of bridged SOL. */
export interface NativeDeltaPaid {
  account: string;
  amount: bigint;
  wrapped: boolean;
}

/**
 * swap `SwappedNative`, emitted right after the `Swapped` of a `swap_v2`: the lamports that left the trader (a buy) or the pool
 * (a sell), each quote-side cut, and the pool's quote after it. A `swap_v2`'s `Swapped` names wallets (not holdings) in its quote
 * side's deltas and as its sell's recipient: read the SOL side from here.
 */
export interface SwappedNativeEvent {
  kind: 'swap.SwappedNative';
  pool: string;
  direction: number;
  /** A buy: the lamports the trader paid the pool. A sell: the lamports delivered. */
  quoteLamports: bigint;
  quoteDeltas: NativeDeltaPaid[];
  bufferQuote: bigint;
  poolLamports: bigint;
}

/** `PoolQuoteFormChanged.kind`. */
export const POOL_QUOTE_FORM_KIND = { migrated: 0, reverted: 1, rebalanced: 2, targetSet: 3, bufferedAll: 4 } as const;

/** swap `PoolQuoteFormChanged`: a pool moved between bridged SOL in its vault and lamports on its account. */
export interface PoolQuoteFormChangedEvent {
  kind: 'swap.PoolQuoteFormChanged';
  pool: string;
  /** 0 migrated to native, 1 reverted to bridged, 2 rebalanced, 3 buffer target set, 4 buffered all (`POOL_QUOTE_FORM_KIND`). */
  change: number;
  native: boolean;
  unwrapped: bigint;
  wrapped: bigint;
  bufferQuote: bigint;
  bufferTarget: bigint;
  quoteReserve: bigint;
  protocolFeesQuote: bigint;
  poolLamports: bigint;
  ts: number;
}

/** launch `LaunchNativeSet`: a launch (and its kit) moved between bridged SOL and native SOL; `moved` its creator fees that changed form. */
export interface LaunchNativeSetEvent {
  kind: 'launch.LaunchNativeSet';
  launch: string;
  mint: string;
  native: boolean;
  moved: bigint;
  ts: number;
}

/** launch `NativeLaunchesSet`: the admin turned native launches on or off. */
export interface NativeLaunchesSetEvent {
  kind: 'launch.NativeLaunchesSet';
  on: boolean;
  ts: number;
}

/** kit `KitNativeSet`: a kit's reward vault moved between its holding and lamports on its config. */
export interface KitNativeSetEvent {
  kind: 'kit.KitNativeSet';
  mint: string;
  native: boolean;
  moved: bigint;
  lamportsBase: bigint;
  ts: number;
}

/** companion `CompanionNativeSet` (read with the companion among `eventsOf`'s programs): `spare` the companion address's spare lamports booked to the beneficiary. */
export interface CompanionNativeSetEvent {
  kind: 'companion.CompanionNativeSet';
  companion: string;
  native: boolean;
  moved: bigint;
  spare: bigint;
}

export type NativeTypedEvent = SwappedNativeEvent | PoolQuoteFormChangedEvent | LaunchNativeSetEvent | NativeLaunchesSetEvent | KitNativeSetEvent | CompanionNativeSetEvent;

type Data = Record<string, unknown>;
const s = (v: unknown): string => String(v);
const b = (v: unknown): bigint => BigInt(String(v));
const n = (v: unknown): number => Number(v);
const bool = (v: unknown): boolean => v === true || v === 'true';

/** The typed view of a native-SOL event (`typedEvent` reads the others); null for any other event. */
export function typedNativeEvent(ev: DecodedEvent): NativeTypedEvent | null {
  const d = ev.data;
  switch (eventKey(ev)) {
    case 'swap.SwappedNative':
      return {
        kind: 'swap.SwappedNative',
        pool: s(d.pool),
        direction: n(d.direction),
        quoteLamports: b(d.quoteLamports),
        quoteDeltas: (Array.isArray(d.quoteDeltas) ? (d.quoteDeltas as Data[]) : []).map((x) => ({ account: s(x.account), amount: b(x.amount), wrapped: bool(x.wrapped) })),
        bufferQuote: b(d.bufferQuote),
        poolLamports: b(d.poolLamports),
      };
    case 'swap.PoolQuoteFormChanged':
      return {
        kind: 'swap.PoolQuoteFormChanged',
        pool: s(d.pool),
        change: n(d.kind),
        native: bool(d.native),
        unwrapped: b(d.unwrapped),
        wrapped: b(d.wrapped),
        bufferQuote: b(d.bufferQuote),
        bufferTarget: b(d.bufferTarget),
        quoteReserve: b(d.quoteReserve),
        protocolFeesQuote: b(d.protocolFeesQuote),
        poolLamports: b(d.poolLamports),
        ts: n(d.ts),
      };
    case 'launch.LaunchNativeSet':
      return { kind: 'launch.LaunchNativeSet', launch: s(d.launch), mint: s(d.mint), native: bool(d.native), moved: b(d.moved), ts: n(d.ts) };
    case 'launch.NativeLaunchesSet':
      return { kind: 'launch.NativeLaunchesSet', on: bool(d.on), ts: n(d.ts) };
    case 'kit.KitNativeSet':
      return { kind: 'kit.KitNativeSet', mint: s(d.mint), native: bool(d.native), moved: b(d.moved), lamportsBase: b(d.lamportsBase), ts: n(d.ts) };
    case 'companion.CompanionNativeSet':
      return { kind: 'companion.CompanionNativeSet', companion: s(d.companion), native: bool(d.native), moved: b(d.moved), spare: b(d.spare) };
    default:
      return null;
  }
}

/**
 * The trade a `swap_v2` made, from its `Swapped` and the `SwappedNative` after it: the SOL side in lamports (what the trader
 * paid on a buy, what was delivered on a sell) and the quote-side cuts by account. For a classic swap (no `SwappedNative`) the SOL
 * side is `amountIn` on a buy and `deliveredOut` on a sell, in bridged SOL.
 */
export function swapSolSide(swapped: SwappedEvent, native: SwappedNativeEvent | null): { native: boolean; solIn: bigint; solOut: bigint; quoteCuts: { account: string; amount: bigint }[] } {
  const buy = swapped.direction === 1;
  if (native) {
    const cuts = native.quoteDeltas.reduce((t, x) => t + x.amount, 0n);
    return { native: true, solIn: buy ? native.quoteLamports + cuts : 0n, solOut: buy ? 0n : native.quoteLamports, quoteCuts: native.quoteDeltas.map((x) => ({ account: x.account, amount: x.amount })) };
  }
  const deltas = buy ? swapped.deltasIn : swapped.deltasOut;
  return { native: false, solIn: buy ? swapped.amountIn : 0n, solOut: buy ? 0n : swapped.deliveredOut, quoteCuts: deltas.map((x) => ({ account: x.holding, amount: x.amount })) };
}

/** Pairs each `Swapped` of a transaction's events with the `SwappedNative` right after it (null for a classic swap). */
export function pairSwappedNative<T extends Pick<DecodedEvent, 'program' | 'name' | 'data'>>(events: readonly T[]): { swapped: T; native: T | null }[] {
  const out: { swapped: T; native: T | null }[] = [];
  events.forEach((ev, i) => {
    if (eventKey(ev) !== 'swap.Swapped') return;
    const next = events[i + 1];
    const native = next && eventKey(next) === 'swap.SwappedNative' && String(next.data.pool) === String(ev.data.pool) ? next : null;
    out.push({ swapped: ev, native });
  });
  return out;
}

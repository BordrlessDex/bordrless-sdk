/**
 * Typed views of the programs' v2 accounts, decoded with the IDL coders (owner-independent: the
 * caller reads the account it means; the coder checks the discriminator). Field names are the
 * IDL's, camel-cased; u64 and u128 integers come back as bigint, i64 times as numbers, byte arrays
 * as Uint8Array.
 */
import BN from 'bn.js';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { KIT_MODULES, decodeKitHookData, kitMintFlags, type KitHookData, type KitRewards, type LaunchRules, type LaunchRulesInput, type RuleBounds } from '@bordrless/shared';
import { KIT_PROGRAM, launchAddress } from './addresses.ts';
import { CODERS, type ProgramName } from './coders.ts';

const big = (v: unknown): bigint => (v instanceof BN ? BigInt(v.toString(10)) : typeof v === 'bigint' ? v : BigInt(v as number));
const int = (v: unknown): number => Number(big(v));
const key = (v: unknown): PublicKey => (v instanceof PublicKey ? v : new PublicKey(v as string));
const optKey = (v: unknown): PublicKey | null => (v === null || v === undefined ? null : key(v));
const bytes = (v: unknown): Uint8Array => Uint8Array.from(v as ArrayLike<number>);

// ---- token standard --------------------------------------------------------------------------------

export interface Mint {
  version: number;
  decimals: number;
  supply: bigint;
  maxSupply: bigint;
  mintAuthority: PublicKey | null;
  freezeAuthority: PublicKey | null;
  hookAuthority: PublicKey | null;
  metadataAuthority: PublicKey | null;
  hookProgram: PublicKey | null;
  hookFlags: number;
  name: string;
  symbol: string;
  uri: string;
  createdAt: number;
  creator: PublicKey;
  /** v2: the bump of the token program's signer for this mint's hook (`["hook-authority", hook_program]`); 0 without a hook. */
  hookSignerBump: number;
}

export interface Holding {
  version: number;
  bump: number;
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  delegate: PublicKey | null;
  delegatedAmount: bigint;
  frozen: boolean;
  /** v2: the 64 bytes the mint's hook keeps for this holder (the kit's: `decodeKitHookData`). Zero until the hook writes them. */
  hookData: Uint8Array;
}

/** A `Holding` account is 204 bytes (hook data at byte 92 without a delegate, 124 with one). */
export const HOLDING_SIZE = 204;
/** A `KitConfig` account is 431 bytes, every field at a fixed offset. */
export const KIT_CONFIG_SIZE = 431;

// ---- DEX -------------------------------------------------------------------------------------------

export interface SwapConfig {
  admin: PublicKey;
  /** Protocol fee an ordinary pool (anyone's) copies at creation. */
  protocolFeeBps: number;
  feeCollector: PublicKey;
  treasury: PublicKey;
  poolCreationFeeLamports: bigint;
  paused: boolean;
  poolsCreated: bigint;
  /** Bordrless's share of what a launch pool's hooks cut, in basis points (2,500 = a quarter; §3.1): a curve a hook program creates copies it at creation and keeps it after graduation. */
  launchProtocolShareBps: number;
}

/** `Pool.feeModel`: a flat rate of the quote (ordinary pools) or a share of what the hooks cut (launch pools), fixed at creation (§3.1). */
export const FEE_MODEL_FLAT = 0;
export const FEE_MODEL_SHARE = 1;

export interface Pool {
  version: number;
  bump: number;
  lpMintBump: number;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  hookProgram: PublicKey | null;
  hookFlags: number;
  lpFeeBps: number;
  protocolFeeBps: number;
  baseReserve: bigint;
  quoteReserve: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
  lpSupply: bigint;
  /** Protocol fees accrued and not collected, always in the quote token (v2 has no base side). */
  protocolFeesQuote: bigint;
  curve: boolean;
  creator: PublicKey;
  createdAt: number;
  lastSwapAt: number;
  swapCount: bigint;
  baseVolume: bigint;
  quoteVolume: bigint;
  /** v2: the bump of the DEX's signer for this pool's hook (`["hook-authority", hook_program]`); 0 without a hook. */
  hookSignerBump: number;
  /** How Bordrless is paid (§3.1): `FEE_MODEL_FLAT` (`protocolFeeBps` of the quote) or `FEE_MODEL_SHARE` (`protocolShareBps` of the hooks' cuts). */
  feeModel: number;
  /** Under the share model, Bordrless's share of what the hooks cut, in basis points; 0 under the flat model. */
  protocolShareBps: number;
}

/** Whether a pool pays Bordrless a share of its hooks' cuts rather than a flat rate (`Pool::shares_cuts`). */
export const poolSharesCuts = (pool: Pick<Pool, 'feeModel'>): boolean => pool.feeModel === FEE_MODEL_SHARE;

// ---- bridge ----------------------------------------------------------------------------------------

export interface BridgeConfig {
  admin: PublicKey;
  paused: boolean;
  wrappers: bigint;
}

export interface Wrapper {
  bump: number;
  native: boolean;
  underlyingMint: PublicKey;
  underlyingProgram: PublicKey;
  wrappedMint: PublicKey;
  vault: PublicKey;
  decimals: number;
  totalWrapped: bigint;
  registeredAt: number;
  registrar: PublicKey;
}

// ---- launchpad -------------------------------------------------------------------------------------

export interface LaunchConfig {
  admin: PublicKey;
  treasury: PublicKey;
  quoteMint: PublicKey;
  launchFeeLamports: bigint;
  lpFeeBps: number;
  maxCreatorFeeBps: number;
  sniperWindowSecs: number;
  sniperStartBps: number;
  curveBps: number;
  supply: bigint;
  decimals: number;
  minVirtualQuote: bigint;
  maxVirtualQuote: bigint;
  paused: boolean;
  launches: bigint;
  /** v2: the bounds `create_launch` holds token rules to (§5.2). */
  ruleBounds: RuleBounds;
}

/** The token rules a launch fixes, as the program keeps them (`LaunchRules`: locks in seconds, counted from the launch). */
export interface LaunchRulesData {
  holderFeeBuyBps: number;
  holderFeeSellBps: number;
  burnBuyBps: number;
  burnSellBps: number;
  /** 0 = off; lifts at graduation. */
  maxWalletBps: number;
  /** 0 = off. */
  creatorLockSecs: number;
  /** 0 = off. */
  earlyWindowSecs: number;
  /** Above `earlyWindowSecs` when the lock is on, else 0. */
  earlyLockSecs: number;
}

/** No token rules. */
export const NO_LAUNCH_RULES: Readonly<LaunchRulesData> = { holderFeeBuyBps: 0, holderFeeSellBps: 0, burnBuyBps: 0, burnSellBps: 0, maxWalletBps: 0, creatorLockSecs: 0, earlyWindowSecs: 0, earlyLockSecs: 0 };

export interface Launch {
  version: number;
  bump: number;
  mint: PublicKey;
  creator: PublicKey;
  pool: PublicKey;
  quoteMint: PublicKey;
  /** 0 on the curve, 1 graduated. */
  status: number;
  creatorFeeBps: number;
  lpFeeBps: number;
  sniperWindowSecs: number;
  sniperStartBps: number;
  virtualQuote: bigint;
  virtualBase: bigint;
  graduationQuote: bigint;
  curveTokens: bigint;
  reserveTokens: bigint;
  reserveHolding: PublicKey;
  quoteHolding: PublicKey;
  lpHolding: PublicKey;
  createdAt: number;
  graduatedAt: number;
  /** Saturating display total; `claim_creator_fees` pays the quote holding's balance. */
  creatorFeesAccrued: bigint;
  creatorFeesClaimed: bigint;
  graduationTopup: bigint;
  graduationBurned: bigint;
  /** v2: the token rules, fixed at launch. */
  rules: LaunchRulesData;
  /** v2: the kit modules of `rules` (0: no kit, no token hook). */
  modules: number;
  /** v2: `PDA(["kit", mint], KIT_ID)`, derived whatever the modules. */
  kitConfig: PublicKey;
  /** v2: `holding(quote, kit_config)`, where holder fees go; derived whatever the modules. */
  holderVault: PublicKey;
  /** v2: the bump of the kit-caller PDA; 0 without a kit. */
  kitCallerBump: number;
  /** v2: unix seconds; 0 when off. */
  creatorUnlockAt: number;
  earlyWindowEnd: number;
  earlyUnlockAt: number;
  /** v2: the creator's own first buy took the normal LP fee inside the sniper window (once). */
  creatorBought: boolean;
  /** v2: saturating display totals. */
  holderFeesAccrued: bigint;
  burnedOnTrades: bigint;
  /** The `LaunchConfig` the launch was made from (§5.7); the default key for inline rules (`launchConfigOf` reads it as null). */
  config: PublicKey;
  /** The creator's own token hook (§5.8), from the config; null when the mint's hook is the kit or none. */
  customHook: PublicKey | null;
  /** The custom hook's token flags; 0 without one. */
  customHookFlags: number;
}

/** The `LaunchConfig` a launch was made from, or null for inline rules (the account keeps the default key then). */
export const launchConfigOf = (launch: Pick<Launch, 'config'>): PublicKey | null => (launch.config.equals(PublicKey.default) ? null : launch.config);

/** Whether the launch's token runs a creator's own hook (`Launch::has_custom_hook`). */
export const hasCustomHook = (launch: Pick<Launch, 'customHook'>): boolean => launch.customHook !== null;

/**
 * A `LaunchConfig` account (§5.7; not the launch program's `Config`, which is `LaunchConfig` here for
 * historical reasons): made by anyone with `create_config` as a keypair account, fixed once made,
 * usable for any number of launches. 176 bytes.
 */
export interface LaunchConfigAccount {
  version: number;
  /** Who made it. */
  creator: PublicKey;
  /** The token rules, within the launch config's bounds when made (checked again at launch). */
  rules: LaunchRulesData;
  creatorFeeBps: number;
  /** The creator's own token hook (§5.8); null for kit rules or none. */
  customHook: PublicKey | null;
  /** Its token flags; 0 without a hook. */
  customHookFlags: number;
  /** A short name, at most 32 bytes. */
  label: string;
  createdAt: number;
}

/** A `LaunchConfig` account is 176 bytes. */
export const LAUNCH_CONFIG_ACCOUNT_SIZE = 176;
/** The longest label a `LaunchConfig` takes, in bytes. */
export const LAUNCH_CONFIG_LABEL_MAX = 32;

// ---- the kit ---------------------------------------------------------------------------------------

/** A token's kit settings and reward accounting, at `["kit", mint]` (§4.3, with `stream_next` from the review fixes). */
export interface KitConfig {
  version: number;
  bump: number;
  kitCallerBump: number;
  /** Bit set: 1 holder rewards, 2 max wallet, 4 creator wallet lock, 8 early-buyer lock. */
  modules: number;
  /** Set by `graduate`: max wallet no longer applies. */
  graduated: boolean;
  eligible: bigint;
  minEligible: bigint;
  mint: PublicKey;
  launch: PublicKey;
  pool: PublicKey;
  creator: PublicKey;
  rewardMint: PublicKey;
  /** The default key when holder rewards are off. */
  rewardVault: PublicKey;
  supplyAtInit: bigint;
  maxWalletBps: number;
  maxWalletAmount: bigint;
  creatorUnlockAt: number;
  earlyWindowEnd: number;
  earlyUnlockAt: number;
  accPerShare: bigint;
  rem: bigint;
  held: bigint;
  seen: bigint;
  streamRemaining: bigint;
  streamLast: number;
  streamEnd: number;
  totalDistributed: bigint;
  totalClaimed: bigint;
  totalShared: bigint;
  createdAt: number;
  streamNext: bigint;
}

export interface TaxConfig {
  bump: number;
  mint: PublicKey;
  authority: PublicKey;
  feeBps: number;
  maxWalletBps: number;
  collectorHolding: PublicKey;
  collectorOwner: PublicKey;
  collected: bigint;
}

type Raw = Record<string, unknown>;

function decode(program: ProgramName, name: string, data: Buffer): Raw {
  return CODERS[program].accounts.decode(name, data) as Raw;
}

export const decodeMint = (data: Buffer): Mint => {
  const r = decode('token', 'mint', data);
  return {
    version: Number(r.version),
    decimals: Number(r.decimals),
    supply: big(r.supply),
    maxSupply: big(r.maxSupply),
    mintAuthority: optKey(r.mintAuthority),
    freezeAuthority: optKey(r.freezeAuthority),
    hookAuthority: optKey(r.hookAuthority),
    metadataAuthority: optKey(r.metadataAuthority),
    hookProgram: optKey(r.hookProgram),
    hookFlags: Number(r.hookFlags),
    name: String(r.name),
    symbol: String(r.symbol),
    uri: String(r.uri),
    createdAt: int(r.createdAt),
    creator: key(r.creator),
    hookSignerBump: Number(r.hookSignerBump),
  };
};

export const decodeHolding = (data: Buffer): Holding => {
  const r = decode('token', 'holding', data);
  return {
    version: Number(r.version),
    bump: Number(r.bump),
    mint: key(r.mint),
    owner: key(r.owner),
    amount: big(r.amount),
    delegate: optKey(r.delegate),
    delegatedAmount: big(r.delegatedAmount),
    frozen: Boolean(r.frozen),
    hookData: bytes(r.hookData),
  };
};

export const decodeSwapConfig = (data: Buffer): SwapConfig => {
  const r = decode('swap', 'config', data);
  return { admin: key(r.admin), protocolFeeBps: Number(r.protocolFeeBps), feeCollector: key(r.feeCollector), treasury: key(r.treasury), poolCreationFeeLamports: big(r.poolCreationFeeLamports), paused: Boolean(r.paused), poolsCreated: big(r.poolsCreated), launchProtocolShareBps: Number(r.launchProtocolShareBps) };
};

export const decodePool = (data: Buffer): Pool => {
  const r = decode('swap', 'pool', data);
  return {
    version: Number(r.version),
    bump: Number(r.bump),
    lpMintBump: Number(r.lpMintBump),
    baseMint: key(r.baseMint),
    quoteMint: key(r.quoteMint),
    lpMint: key(r.lpMint),
    baseVault: key(r.baseVault),
    quoteVault: key(r.quoteVault),
    hookProgram: optKey(r.hookProgram),
    hookFlags: Number(r.hookFlags),
    lpFeeBps: Number(r.lpFeeBps),
    protocolFeeBps: Number(r.protocolFeeBps),
    baseReserve: big(r.baseReserve),
    quoteReserve: big(r.quoteReserve),
    virtualBase: big(r.virtualBase),
    virtualQuote: big(r.virtualQuote),
    lpSupply: big(r.lpSupply),
    protocolFeesQuote: big(r.protocolFeesQuote),
    curve: Boolean(r.curve),
    creator: key(r.creator),
    createdAt: int(r.createdAt),
    lastSwapAt: int(r.lastSwapAt),
    swapCount: big(r.swapCount),
    baseVolume: big(r.baseVolume),
    quoteVolume: big(r.quoteVolume),
    hookSignerBump: Number(r.hookSignerBump),
    feeModel: Number(r.feeModel),
    protocolShareBps: Number(r.protocolShareBps),
  };
};

export const decodeBridgeConfig = (data: Buffer): BridgeConfig => {
  const r = decode('bridge', 'config', data);
  return { admin: key(r.admin), paused: Boolean(r.paused), wrappers: big(r.wrappers) };
};

export const decodeWrapper = (data: Buffer): Wrapper => {
  const r = decode('bridge', 'wrapper', data);
  return { bump: Number(r.bump), native: Boolean(r.native), underlyingMint: key(r.underlyingMint), underlyingProgram: key(r.underlyingProgram), wrappedMint: key(r.wrappedMint), vault: key(r.vault), decimals: Number(r.decimals), totalWrapped: big(r.totalWrapped), registeredAt: int(r.registeredAt), registrar: key(r.registrar) };
};

const ruleBounds = (v: unknown): RuleBounds => {
  const r = v as Raw;
  return {
    maxHolderFeeBps: Number(r.maxHolderFeeBps),
    maxBurnBps: Number(r.maxBurnBps),
    maxRulesFeeBps: Number(r.maxRulesFeeBps),
    minMaxWalletBps: Number(r.minMaxWalletBps),
    maxMaxWalletBps: Number(r.maxMaxWalletBps),
    maxCreatorLockSecs: Number(r.maxCreatorLockSecs),
    maxEarlyWindowSecs: Number(r.maxEarlyWindowSecs),
    maxEarlyLockSecs: Number(r.maxEarlyLockSecs),
  };
};

/** `LaunchRules` as the coder decodes it (in `Launch` and in `LaunchCreated`). */
export const launchRulesData = (v: unknown): LaunchRulesData => {
  const r = v as Raw;
  return {
    holderFeeBuyBps: Number(r.holderFeeBuyBps),
    holderFeeSellBps: Number(r.holderFeeSellBps),
    burnBuyBps: Number(r.burnBuyBps),
    burnSellBps: Number(r.burnSellBps),
    maxWalletBps: Number(r.maxWalletBps),
    creatorLockSecs: Number(r.creatorLockSecs),
    earlyWindowSecs: Number(r.earlyWindowSecs),
    earlyLockSecs: Number(r.earlyLockSecs),
  };
};

export const decodeLaunchConfig = (data: Buffer): LaunchConfig => {
  const r = decode('launch', 'config', data);
  return {
    admin: key(r.admin),
    treasury: key(r.treasury),
    quoteMint: key(r.quoteMint),
    launchFeeLamports: big(r.launchFeeLamports),
    lpFeeBps: Number(r.lpFeeBps),
    maxCreatorFeeBps: Number(r.maxCreatorFeeBps),
    sniperWindowSecs: int(r.sniperWindowSecs),
    sniperStartBps: Number(r.sniperStartBps),
    curveBps: Number(r.curveBps),
    supply: big(r.supply),
    decimals: Number(r.decimals),
    minVirtualQuote: big(r.minVirtualQuote),
    maxVirtualQuote: big(r.maxVirtualQuote),
    paused: Boolean(r.paused),
    launches: big(r.launches),
    ruleBounds: ruleBounds(r.ruleBounds),
  };
};

export const decodeLaunch = (data: Buffer): Launch => {
  const r = decode('launch', 'launch', data);
  return {
    version: Number(r.version),
    bump: Number(r.bump),
    mint: key(r.mint),
    creator: key(r.creator),
    pool: key(r.pool),
    quoteMint: key(r.quoteMint),
    status: Number(r.status),
    creatorFeeBps: Number(r.creatorFeeBps),
    lpFeeBps: Number(r.lpFeeBps),
    sniperWindowSecs: int(r.sniperWindowSecs),
    sniperStartBps: Number(r.sniperStartBps),
    virtualQuote: big(r.virtualQuote),
    virtualBase: big(r.virtualBase),
    graduationQuote: big(r.graduationQuote),
    curveTokens: big(r.curveTokens),
    reserveTokens: big(r.reserveTokens),
    reserveHolding: key(r.reserveHolding),
    quoteHolding: key(r.quoteHolding),
    lpHolding: key(r.lpHolding),
    createdAt: int(r.createdAt),
    graduatedAt: int(r.graduatedAt),
    creatorFeesAccrued: big(r.creatorFeesAccrued),
    creatorFeesClaimed: big(r.creatorFeesClaimed),
    graduationTopup: big(r.graduationTopup),
    graduationBurned: big(r.graduationBurned),
    rules: launchRulesData(r.rules),
    modules: Number(r.modules),
    kitConfig: key(r.kitConfig),
    holderVault: key(r.holderVault),
    kitCallerBump: Number(r.kitCallerBump),
    creatorUnlockAt: int(r.creatorUnlockAt),
    earlyWindowEnd: int(r.earlyWindowEnd),
    earlyUnlockAt: int(r.earlyUnlockAt),
    creatorBought: Boolean(r.creatorBought),
    holderFeesAccrued: big(r.holderFeesAccrued),
    burnedOnTrades: big(r.burnedOnTrades),
    config: key(r.config),
    customHook: optKey(r.customHook),
    customHookFlags: Number(r.customHookFlags),
  };
};

/** A `LaunchConfig` account (§5.7), by its IDL name `launchConfig`. */
export const decodeLaunchConfigAccount = (data: Buffer): LaunchConfigAccount => {
  const r = decode('launch', 'launchConfig', data);
  return {
    version: Number(r.version),
    creator: key(r.creator),
    rules: launchRulesData(r.rules),
    creatorFeeBps: Number(r.creatorFeeBps),
    customHook: optKey(r.customHook),
    customHookFlags: Number(r.customHookFlags),
    label: String(r.label),
    createdAt: int(r.createdAt),
  };
};

export const decodeKitConfig = (data: Buffer): KitConfig => {
  const r = decode('kit', 'kitConfig', data);
  return {
    version: Number(r.version),
    bump: Number(r.bump),
    kitCallerBump: Number(r.kitCallerBump),
    modules: Number(r.modules),
    graduated: Boolean(r.graduated),
    eligible: big(r.eligible),
    minEligible: big(r.minEligible),
    mint: key(r.mint),
    launch: key(r.launch),
    pool: key(r.pool),
    creator: key(r.creator),
    rewardMint: key(r.rewardMint),
    rewardVault: key(r.rewardVault),
    supplyAtInit: big(r.supplyAtInit),
    maxWalletBps: Number(r.maxWalletBps),
    maxWalletAmount: big(r.maxWalletAmount),
    creatorUnlockAt: int(r.creatorUnlockAt),
    earlyWindowEnd: int(r.earlyWindowEnd),
    earlyUnlockAt: int(r.earlyUnlockAt),
    accPerShare: big(r.accPerShare),
    rem: big(r.rem),
    held: big(r.held),
    seen: big(r.seen),
    streamRemaining: big(r.streamRemaining),
    streamLast: int(r.streamLast),
    streamEnd: int(r.streamEnd),
    totalDistributed: big(r.totalDistributed),
    totalClaimed: big(r.totalClaimed),
    totalShared: big(r.totalShared),
    createdAt: int(r.createdAt),
    streamNext: big(r.streamNext),
  };
};

export const decodeTaxConfig = (data: Buffer): TaxConfig => {
  const r = decode('taxHook', 'taxConfig', data);
  return { bump: Number(r.bump), mint: key(r.mint), authority: key(r.authority), feeBps: Number(r.feeBps), maxWalletBps: Number(r.maxWalletBps), collectorHolding: key(r.collectorHolding), collectorOwner: key(r.collectorOwner), collected: big(r.collected) };
};

// ---- bridges to the shared policy ------------------------------------------------------------------

/** The kit modules a set of on-chain rules installs (§5.1): 1 with a holder fee, 2 max wallet, 4 creator lock, 8 early-buyer lock. */
export function kitModulesOf(rules: LaunchRulesData): number {
  return (
    (rules.holderFeeBuyBps > 0 || rules.holderFeeSellBps > 0 ? KIT_MODULES.HOLDER_REWARDS : 0) |
    (rules.maxWalletBps > 0 ? KIT_MODULES.MAX_WALLET : 0) |
    (rules.creatorLockSecs > 0 ? KIT_MODULES.CREATOR_LOCK : 0) |
    (rules.earlyWindowSecs > 0 ? KIT_MODULES.EARLY_LOCK : 0)
  );
}

/** Whether the launch pool's hook burns on either side: swaps then pass the base mint writable (§2.6). */
export const rulesBurn = (rules: LaunchRulesData): boolean => rules.burnBuyBps > 0 || rules.burnSellBps > 0;

/** The on-chain rules of a launch request (`create_launch`'s `LaunchRules`): the creator lock from days to seconds. */
export function launchRulesFromInput(input: LaunchRulesInput): LaunchRulesData {
  return {
    holderFeeBuyBps: input.holderFeeBuyBps,
    holderFeeSellBps: input.holderFeeSellBps,
    burnBuyBps: input.burnBuyBps,
    burnSellBps: input.burnSellBps,
    maxWalletBps: input.maxWalletBps,
    creatorLockSecs: input.creatorLockDays * 86_400,
    earlyWindowSecs: input.earlyWindowSecs,
    earlyLockSecs: input.earlyLockSecs,
  };
}

/** The launch request's rules back from the on-chain ones (the creator lock in days, as the form chooses it). */
export function launchRulesInputOf(rules: LaunchRulesData): LaunchRulesInput {
  return {
    holderFeeBuyBps: rules.holderFeeBuyBps,
    holderFeeSellBps: rules.holderFeeSellBps,
    burnBuyBps: rules.burnBuyBps,
    burnSellBps: rules.burnSellBps,
    maxWalletBps: rules.maxWalletBps,
    creatorLockDays: rules.creatorLockSecs / 86_400,
    earlyWindowSecs: rules.earlyWindowSecs,
    earlyLockSecs: rules.earlyLockSecs,
  };
}

/** A launch's rules as the API shows them (`LaunchSummary.rules`), from the absolute times the `Launch` keeps (0 when off). */
export function apiLaunchRules(launch: Pick<Launch, 'rules' | 'creatorUnlockAt' | 'earlyWindowEnd' | 'earlyUnlockAt'>): LaunchRules {
  const r = launch.rules;
  return {
    holderFeeBuyBps: r.holderFeeBuyBps,
    holderFeeSellBps: r.holderFeeSellBps,
    burnBuyBps: r.burnBuyBps,
    burnSellBps: r.burnSellBps,
    maxWalletBps: r.maxWalletBps,
    creatorUnlockAt: launch.creatorUnlockAt > 0 ? launch.creatorUnlockAt : null,
    earlyWindowEndsAt: launch.earlyWindowEnd > 0 ? launch.earlyWindowEnd : null,
    earlyUnlockAt: launch.earlyUnlockAt > 0 ? launch.earlyUnlockAt : null,
    walletsOnly: r.holderFeeBuyBps > 0 || r.holderFeeSellBps > 0,
  };
}

/** The reward accounting of a `KitConfig`, as the shared mirror (`rewardsClaimable`, `rewardTotals`, `shareStartsAt`) takes it. */
export function kitRewardsOf(c: KitConfig): KitRewards {
  return {
    eligible: c.eligible,
    minEligible: c.minEligible,
    accPerShare: c.accPerShare,
    rem: c.rem,
    held: c.held,
    seen: c.seen,
    streamRemaining: c.streamRemaining,
    streamLast: c.streamLast,
    streamEnd: c.streamEnd,
    streamNext: c.streamNext,
    totalDistributed: c.totalDistributed,
    totalClaimed: c.totalClaimed,
    totalShared: c.totalShared,
    modules: c.modules,
  };
}

/** A holding's hook data read as the kit's (§4.4): snapshot, owed, early_locked. */
export const kitHookDataOf = (holding: Pick<Holding, 'hookData'>): KitHookData => decodeKitHookData(holding.hookData);

/** Whether the pool or the launch owns this: they earn no rewards, are never capped and cannot claim (§4.5). */
export const kitExcludes = (c: Pick<KitConfig, 'pool' | 'launch'>, owner: PublicKey): boolean => owner.equals(c.pool) || owner.equals(c.launch);

/**
 * §4.15: a token is a Bordrless launch with kit rules only when a `Launch` exists at `["launch",
 * mint]`, the mint names the kit as its hook with no hook authority and no mint authority, its hook
 * flags are the kit's for the config's modules, and the `KitConfig` at `["kit", mint]` has `launch`
 * equal to that `Launch` and `pool` equal to its pool. `launch` must be the launch program's account
 * at `launchAddress(mintKey)` and `config` the kit's account at `kitConfigAddress(mintKey)` (the
 * caller checks the owners when it reads them; the coders check the discriminators).
 */
export function isVerifiedKitToken(mintKey: PublicKey, mint: Mint, launch: Launch, config: KitConfig): boolean {
  return (
    launch.mint.equals(mintKey) &&
    mint.hookProgram !== null &&
    mint.hookProgram.equals(KIT_PROGRAM) &&
    mint.hookAuthority === null &&
    mint.mintAuthority === null &&
    mint.hookFlags === kitMintFlags(config.modules) &&
    config.mint.equals(mintKey) &&
    config.launch.equals(launchAddress(mintKey)) &&
    config.pool.equals(launch.pool)
  );
}

// ---- fetching --------------------------------------------------------------------------------------

/** Fetches and decodes one account; null when it does not exist. */
export async function fetchAccount<T>(connection: Connection, address: PublicKey, decoder: (data: Buffer) => T): Promise<T | null> {
  const info = await connection.getAccountInfo(address, 'confirmed');
  return info ? decoder(info.data) : null;
}

/** Decodes one of many fetched accounts; null for a missing one. */
export function decodeMany<T>(infos: (AccountInfo<Buffer> | null)[], decoder: (data: Buffer) => T): (T | null)[] {
  return infos.map((info) => (info ? decoder(info.data) : null));
}

/** The balance of a holding, 0 when it does not exist. */
export async function holdingBalance(connection: Connection, holding: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(holding, 'confirmed');
  return info ? decodeHolding(info.data).amount : 0n;
}

/** Decimals of an SPL mint (both token programs keep them at offset 44). */
export function splMintDecimals(data: Buffer): number {
  return data[44] ?? 0;
}

/** Amount of an SPL token account (offset 64). */
export function splTokenAmount(data: Buffer): bigint {
  return data.readBigUInt64LE(64);
}

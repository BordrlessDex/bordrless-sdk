/**
 * Coins quoted in tokens (docs/token-quotes.md §2.4): a coin launched against one to six real SPL Token
 * or Token-2022 mints, each its own DEX pool (a leg) of kind 2. The builders mirror
 * `bordrless_swap::client::{create_spl_pool, swap_spl, collect_protocol_fees_spl}` and
 * `bordrless_launch::client::{create_token_launch, open_leg, claim_creator_fees_token, leg_swap,
 * leg_swap_with, leg_hook_extras, LegKeys}` account for account; the data comes from the IDL coders.
 * The events' typed views (`SplPoolCreated`, `TokenLaunchCreated`, `LegOpened`,
 * `LegCreatorFeesClaimed`, phase 1's `TokenLaunchRules` and `LegsMaxWalletLifted`) and a leg swap's
 * creator fee (`legSwapCutsOf`) are here too.
 *
 * Phase 1 (docs/token-quotes.md §6.1.1): a coin quoted in tokens may carry the burn, max wallet and
 * the two locks. `createTokenLaunch` then sends its `rules` and, when they install the kit, the kit's
 * six accounts after the quote mints; `openLeg` the kit's three; a leg swap the kit's slice with the
 * coin's `Legs` on the coin's side and the mint writable when it burns; a transfer the kit's registry
 * for such a coin (`kitLegsRegistryList`: its third extra is a launchpad PDA named by the mint).
 * The creator lock and the early-buyer window and unlock run from when trading opens (the last
 * `open_leg`, review finding F1): the times kept on the `Launch`, the `KitConfig` and in
 * `TokenLaunchRules` count from the launch, and the ones in force add `legsLockDelay`
 * (`lockTimesInForce`; the last `open_leg` says them in `TokenLaunchLocks`).
 */
import BN from 'bn.js';
import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { kitModulesOf, rulesBurn, type LaunchRulesData, type LegsAccount } from './accounts.ts';
import * as a from './addresses.ts';
import { CODERS, type ProgramName } from './coders.ts';
import { decodeEventPayload, type DecodedEvent, type SwappedEvent } from './events.ts';
import { resolveHookAccounts, type HookAccountList, type TokenHook } from './hooks.ts';
import type { CreatePoolArgs, SwapArgs } from './instructions.ts';

const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const bn = (v: bigint | number): BN => new BN(v.toString());
const withEvents = (program: PublicKey, keys: AccountMeta[]): AccountMeta[] => [...keys, ro(a.eventAuthority(program)), ro(program)];
const tokenFixed = (): AccountMeta[] => [ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY)];
const enc = (s: string): Buffer => Buffer.from(s, 'utf8');
const pda = (seeds: Buffer[], program: PublicKey): PublicKey => PublicKey.findProgramAddressSync(seeds, program)[0];

function ix(program: PublicKey, coder: ProgramName, name: string, args: Record<string, unknown>, keys: AccountMeta[]): TransactionInstruction {
  return new TransactionInstruction({ programId: program, keys, data: CODERS[coder].instruction.encode(name, args) });
}

/** `LEG_HOOK_FLAGS`: a leg pool's hook flags (the launch pool's without `BEFORE_SWAP_OVERRIDES_FEE`). */
export const LEG_HOOK_FLAGS = 0x3c1;
/** The accounts of a leg's `swap_spl`: 16, then the leg's four hook extras; 25 with the kit's slice. */
export const LEG_SWAP_ACCOUNTS = 20;
export const LEG_SWAP_ACCOUNTS_WITH_KIT = 25;
/** `LaunchRules` in Borsh: five u16 and three u32. */
export const TOKEN_LAUNCH_RULES_BYTES = 22;

// ---- addresses ---------------------------------------------------------------------------------------

/** The `Legs` of a launch quoted in tokens: `["legs", mint]` under the launchpad. */
export const legsAddress = (mint: PublicKey): PublicKey => pda([enc('legs'), mint.toBuffer()], a.LAUNCH_PROGRAM);
/** A leg's creator-fee token account: `["leg-fees", mint, quote_mint]` under the launchpad (owned by the launch). */
export const legFeesAddress = (mint: PublicKey, quoteMint: PublicKey): PublicKey => pda([enc('leg-fees'), mint.toBuffer(), quoteMint.toBuffer()], a.LAUNCH_PROGRAM);
/** The quote vault of a pool quoted in an SPL token: the pool's associated token account of the quote under its program. */
export const splVaultAddress = (pool: PublicKey, quoteMint: PublicKey, quoteProgram: PublicKey): PublicKey => a.associatedTokenAddress(pool, quoteMint, quoteProgram);

/** What a client needs of one leg to open it, trade it and claim it (`bordrless_launch::client::LegKeys`). */
export interface LegKeys {
  /** The coin. */
  mint: PublicKey;
  /** The leg's quote mint. */
  quoteMint: PublicKey;
  /** Its program (SPL Token or Token-2022). */
  quoteProgram: PublicKey;
  /** The launch's LP fee (`Launch.lp_fee_bps`, part of the pool's address). */
  lpFeeBps: number;
}

/** A leg's pool: `["pool", mint, quote_mint, lp_fee_bps, LAUNCHPAD]` under the DEX. */
export const legPoolAddress = (keys: Pick<LegKeys, 'mint' | 'quoteMint' | 'lpFeeBps'>): PublicKey => a.launchPoolAddress(keys.mint, keys.quoteMint, keys.lpFeeBps);
/** A leg pool's quote vault. */
export const legQuoteVault = (keys: LegKeys): PublicKey => splVaultAddress(legPoolAddress(keys), keys.quoteMint, keys.quoteProgram);
/** `owner`'s associated token account of a leg's quote. */
export const legQuoteAccount = (keys: Pick<LegKeys, 'quoteMint' | 'quoteProgram'>, owner: PublicKey): PublicKey => a.associatedTokenAddress(owner, keys.quoteMint, keys.quoteProgram);
/** A leg's creator-fee account. */
export const legFeeAccount = (keys: Pick<LegKeys, 'mint' | 'quoteMint'>): PublicKey => legFeesAddress(keys.mint, keys.quoteMint);

// ---- the kit on a coin quoted in tokens (phase 1) --------------------------------------------------------

/** No rules: what `create_token_launch` reads when its data ends after `virtual_quotes`. */
export const NO_TOKEN_LAUNCH_RULES: LaunchRulesData = { holderFeeBuyBps: 0, holderFeeSellBps: 0, burnBuyBps: 0, burnSellBps: 0, maxWalletBps: 0, creatorLockSecs: 0, earlyWindowSecs: 0, earlyLockSecs: 0 };

/** Whether rules need anything on chain: any field above 0. */
export const hasTokenLaunchRules = (rules: LaunchRulesData | null | undefined): rules is LaunchRulesData => rules != null && Object.values(rules).some((v) => Number(v) > 0);

/** The kit's six accounts `create_token_launch` takes after the quote mints when its rules install the kit (`bordrless_launch::client::token_launch_kit_accounts`). */
export const tokenLaunchKitAccounts = (mint: PublicKey): AccountMeta[] => [ro(a.KIT_PROGRAM), ro(a.tokenHookSigner(a.KIT_PROGRAM)), rw(a.kitConfigAddress(mint)), rw(a.kitRegistryAddress(mint)), ro(a.kitCallerPda(mint).address), ro(a.KIT_EVENT_AUTHORITY)];

/** The kit's three extras on a coin quoted in tokens (`bordrless_kit::client::legs_hook_extras`): the config (w), the kit's id (no reward vault), the coin's `Legs` (r). */
export const legsHookExtras = (mint: PublicKey): AccountMeta[] => [rw(a.kitConfigAddress(mint)), ro(a.KIT_PROGRAM), ro(legsAddress(mint))];

/** The coin's token-hook slice on a DEX instruction (`bordrless_kit::client::legs_hook_slice`): the kit, the token program's signer of its callbacks, then `legsHookExtras`; 5 accounts. */
export const legsHookSlice = (mint: PublicKey): AccountMeta[] => [ro(a.KIT_PROGRAM), ro(a.tokenHookSigner(a.KIT_PROGRAM)), ...legsHookExtras(mint)];

/** The coin's slice on a leg's swaps (`bordrless_launch::client::leg_base_slice`): `legsHookSlice` when its rules install the kit, else none. */
export const legBaseSlice = (mint: PublicKey, modules: number): AccountMeta[] => (modules === 0 ? [] : legsHookSlice(mint));

/**
 * The kit's registry for a coin quoted in tokens (`["bordrless-hook-accounts", mint]` under the kit, written by `init_legs`):
 * `Key(kit_config)` w, `Key(KIT)` r, `Pda(LAUNCHPAD, ["legs", Account(1)])` r (Account(1) is the mint in the token program's
 * prefix `[hook signer, mint, source, destination, authority]`).
 */
export function kitLegsRegistryList(mint: PublicKey): HookAccountList {
  return {
    version: 1,
    accounts: [
      { writable: true, source: { kind: 'key', key: a.kitConfigAddress(mint) } },
      { writable: false, source: { kind: 'key', key: a.KIT_PROGRAM } },
      { writable: false, source: { kind: 'pda', program: a.LAUNCH_PROGRAM, seeds: [{ kind: 'literal', bytes: enc('legs') }, { kind: 'account', index: 1 }] } },
    ],
  };
}

/** Such a coin's hook for a token instruction without reading its registry: the kit, its signer, the three extras resolved as the token program will. */
export function kitLegsTokenHook(mint: PublicKey, source: PublicKey = PublicKey.default, destination: PublicKey = PublicKey.default, authority: PublicKey = PublicKey.default): TokenHook {
  const signer = a.tokenHookSigner(a.KIT_PROGRAM);
  return { program: a.KIT_PROGRAM, signer, extras: resolveHookAccounts(kitLegsRegistryList(mint), [signer, mint, source, destination, authority]) };
}

/** The coins the legs together have sold while max wallet waits (each leg's `sold`, `Legs` bytes 926 + 8·i; nothing is counted after the lift). */
export const legsSold = (legs: Pick<LegsAccount, 'legs'>): bigint => legs.legs.reduce((total, leg) => total + leg.sold, 0n);

/**
 * Whether max wallet still holds a buy on a leg landing now: not once `Legs` byte 918 says it lifted, nor once the legs' recorded
 * sales have reached `lift_at` (that trade's `after_swap` sets the byte before its coins reach the buyer, so it goes uncapped).
 * The trade that crosses `lift_at` is itself still capped.
 */
export const legsMaxWalletHolds = (legs: Pick<LegsAccount, 'legs' | 'liftAt' | 'lifted'>): boolean => !legs.lifted && !(legs.liftAt > 0n && legsSold(legs) >= legs.liftAt);

/** When trading opened on a coin quoted in tokens: the latest leg's `opened_at` once every leg is open (`Legs::trading_opened_at`); null before. */
export const legsTradingOpenedAt = (legs: Pick<LegsAccount, 'count' | 'opened' | 'legs'>): number | null =>
  legs.count > 0 && legs.opened >= legs.count ? legs.legs.slice(0, legs.count).reduce((latest, leg) => Math.max(latest, leg.openedAt), 0) : null;

/**
 * What the kit moves every lock time of a coin quoted in tokens by (`Legs::lock_delay`, docs/token-quotes.md §6.1.1): how long after
 * the launch (`createdAt`, the `Launch`'s) trading opened, or `now` itself before every leg is open (no lock has started then).
 */
export const legsLockDelay = (legs: Pick<LegsAccount, 'count' | 'opened' | 'legs'>, createdAt: number, now: number): number => Math.max(0, (legsTradingOpenedAt(legs) ?? now) - createdAt);

/** The lock times kept (counted from the launch; 0 when off), as they stand: each moved by `delay`, 0 staying 0 (`bordrless_kit::rules::lock_times`). */
export function lockTimesInForce<T extends { creatorUnlockAt: number; earlyWindowEnd: number; earlyUnlockAt: number }>(times: T, delay: number): T {
  const at = (t: number): number => (t === 0 ? 0 : t + delay);
  return { ...times, creatorUnlockAt: at(times.creatorUnlockAt), earlyWindowEnd: at(times.earlyWindowEnd), earlyUnlockAt: at(times.earlyUnlockAt) };
}

/** The extra accounts of a leg pool's callbacks, as its registry resolves them: the launch (w), the leg's fee account (w), the `Legs` (w), the kit config (r). */
export const legHookExtras =(mint: PublicKey, quoteMint: PublicKey): AccountMeta[] => [rw(a.launchAddress(mint)), rw(legFeesAddress(mint, quoteMint)), rw(legsAddress(mint)), ro(a.kitConfigAddress(mint))];

// ---- the DEX -------------------------------------------------------------------------------------------

export interface CreateSplPoolKeys {
  payer: PublicKey;
  /** Owns the base deposit's holding. */
  authority: PublicKey;
  /** The DEX config's treasury. */
  treasury: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  quoteProgram: PublicKey;
  /** The hook program's `["hook-authority"]`, which signs. */
  hookCaller: PublicKey;
}

export interface SwapSplKeys {
  trader: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  quoteProgram: PublicKey;
  /** The trader's base holding (or, on a buy, any holding of the base mint to deliver to). */
  traderBase: PublicKey;
  /** A token account of the quote: on a buy the trader's (it pays), on a sell any to deliver to. */
  traderQuote: PublicKey;
  hookProgram: PublicKey | null;
  /** Pass the base mint writable (a hook may burn base; never a leg). */
  baseMintWritable?: boolean;
}

export const splPool = {
  /** `create_spl_pool`: 18 accounts, then exactly the base mint's token-hook slice (`args.baseHookAccounts` long; none for a leg). */
  createSplPool(keys: CreateSplPoolKeys, args: CreatePoolArgs, baseSlice: AccountMeta[] = []): TransactionInstruction {
    const pool = a.poolAddress(keys.baseMint, keys.quoteMint, args.lpFeeBps, args.hookProgram);
    const metas = [
      rw(keys.payer, true),
      ro(keys.authority, true),
      rw(a.SWAP_CONFIG),
      rw(keys.treasury),
      ro(keys.baseMint),
      ro(keys.quoteMint),
      rw(pool),
      rw(a.vaultAddress(pool, keys.baseMint)),
      rw(splVaultAddress(pool, keys.quoteMint, keys.quoteProgram)),
      rw(a.holdingAddress(keys.baseMint, keys.authority)),
      ro(keys.hookCaller, true),
      ...tokenFixed(),
      ro(keys.quoteProgram),
      ro(a.ATA_PROGRAM),
      ro(a.SYSTEM_PROGRAM),
    ];
    const data = { args: { ...args, hookProgram: args.hookProgram ?? PublicKey.default, virtualBase: bn(args.virtualBase), virtualQuote: bn(args.virtualQuote), baseAmount: bn(args.baseAmount), quoteAmount: bn(args.quoteAmount), hookData: Buffer.from(args.hookData) } };
    return ix(a.SWAP_PROGRAM, 'swap', 'createSplPool', data, [...withEvents(a.SWAP_PROGRAM, metas), ...baseSlice]);
  },
  /** `swap_spl`: 16 accounts, then `extras` (the in and out token-hook slices, the pool hook's extras; the quote side's slice is empty). */
  swapSpl(keys: SwapSplKeys, args: SwapArgs, extras: AccountMeta[] = []): TransactionInstruction {
    const metas = [
      ro(keys.trader, true),
      ro(a.SWAP_CONFIG),
      rw(keys.pool),
      keys.baseMintWritable ? rw(keys.baseMint) : ro(keys.baseMint),
      ro(keys.quoteMint),
      rw(a.vaultAddress(keys.pool, keys.baseMint)),
      rw(splVaultAddress(keys.pool, keys.quoteMint, keys.quoteProgram)),
      rw(keys.traderBase),
      rw(keys.traderQuote),
      ro(keys.hookProgram ?? a.SWAP_PROGRAM),
      ro(keys.hookProgram ? a.dexHookSigner(keys.hookProgram) : a.SWAP_PROGRAM),
      ...tokenFixed(),
      ro(keys.quoteProgram),
    ];
    const data = { args: { ...args, amountIn: bn(args.amountIn), minAmountOut: bn(args.minAmountOut), hookData: Buffer.from(args.hookData) } };
    return ix(a.SWAP_PROGRAM, 'swap', 'swapSpl', data, [...withEvents(a.SWAP_PROGRAM, metas), ...extras]);
  },
  /** `collect_protocol_fees_spl`: anyone (`payer`, who pays the collector's token account if it must be made) moves a pool's protocol fees to `feeCollector`'s (the config's) associated token account of the quote. */
  collectProtocolFeesSpl(payer: PublicKey, pool: PublicKey, quoteMint: PublicKey, quoteProgram: PublicKey, feeCollector: PublicKey): TransactionInstruction {
    return ix(
      a.SWAP_PROGRAM,
      'swap',
      'collectProtocolFeesSpl',
      {},
      withEvents(a.SWAP_PROGRAM, [rw(payer, true), ro(a.SWAP_CONFIG), rw(pool), ro(quoteMint), rw(splVaultAddress(pool, quoteMint, quoteProgram)), ro(feeCollector), rw(a.associatedTokenAddress(feeCollector, quoteMint, quoteProgram)), ro(quoteProgram), ro(a.ATA_PROGRAM), ro(a.SYSTEM_PROGRAM)]),
    );
  },
};

// ---- the launchpad -----------------------------------------------------------------------------------

export interface CreateTokenLaunchArgs {
  name: string;
  symbol: string;
  uri: string;
  creatorFeeBps: number;
  /** One per quote mint, in the same order (raw units of each). */
  virtualQuotes: bigint[];
  /**
   * Phase 1's rules (docs/token-quotes.md §6.1): the burn, max wallet, the creator and early-buyer locks; no holder fee yet
   * (`HolderFeeOnTokenLaunch`). Absent or all zero: the data ends after `virtualQuotes`, exactly the call before phase 1,
   * which the launchpad reads as none before and after its upgrade.
   */
  rules?: LaunchRulesData | null;
}

export const tokenLaunch = {
  /**
   * `create_token_launch`: `mint` a fresh keypair that signs, `treasury` the launch config's treasury, `quoteMints` the legs'
   * quote mints in order (the remaining accounts), then the kit's six accounts when `args.rules` install the kit
   * (`tokenLaunchKitAccounts`; a burn alone takes none). The rules ride as the args' last field; none sends today's data.
   */
  createTokenLaunch(creator: PublicKey, mint: PublicKey, treasury: PublicKey, args: CreateTokenLaunchArgs, quoteMints: PublicKey[]): TransactionInstruction {
    const launch = a.launchAddress(mint);
    const rules = hasTokenLaunchRules(args.rules) ? args.rules : null;
    const metas = withEvents(a.LAUNCH_PROGRAM, [rw(creator, true), rw(a.LAUNCH_CONFIG), rw(treasury), rw(mint, true), rw(launch), rw(legsAddress(mint)), rw(a.holdingAddress(mint, launch)), ro(a.TOKEN_PROGRAM), ro(a.TOKEN_EVENT_AUTHORITY), ro(a.SYSTEM_PROGRAM)]);
    const kit = rules && kitModulesOf(rules) !== 0 ? tokenLaunchKitAccounts(mint) : [];
    const base = { name: args.name, symbol: args.symbol, uri: args.uri, creatorFeeBps: args.creatorFeeBps, virtualQuotes: args.virtualQuotes.map(bn) };
    // The coder writes the IDL's whole struct (rules required there); without rules their 22 bytes are dropped, which the launchpad reads as none.
    const data = CODERS.launch.instruction.encode('createTokenLaunch', { args: { ...base, rules: { ...(rules ?? NO_TOKEN_LAUNCH_RULES) } } });
    return new TransactionInstruction({ programId: a.LAUNCH_PROGRAM, keys: [...metas, ...quoteMints.map((q) => ro(q)), ...kit], data: rules ? data : data.subarray(0, data.length - TOKEN_LAUNCH_RULES_BYTES) });
  },
  /** `open_leg(index)`, `payer` paying the rent; `dexTreasury` the DEX config's treasury; `modules` the launch's kit modules (`Launch.modules`): with a kit its three accounts follow (`open_leg_with`). */
  openLeg(payer: PublicKey, dexTreasury: PublicKey, keys: LegKeys, index: number, modules = 0): TransactionInstruction {
    const ix = tokenLaunch.openLegWithoutKit(payer, dexTreasury, keys, index);
    if (modules !== 0) ix.keys.push(ro(a.KIT_PROGRAM), ro(a.tokenHookSigner(a.KIT_PROGRAM)), rw(a.kitConfigAddress(keys.mint)));
    return ix;
  },
  /** `open_leg(index)` of a launch without kit rules (`bordrless_launch::client::open_leg`). */
  openLegWithoutKit(payer: PublicKey, dexTreasury: PublicKey, keys: LegKeys, index: number): TransactionInstruction {
    const launch = a.launchAddress(keys.mint);
    const pool = legPoolAddress(keys);
    return ix(
      a.LAUNCH_PROGRAM,
      'launch',
      'openLeg',
      { index },
      withEvents(a.LAUNCH_PROGRAM, [
        rw(payer, true),
        ro(launch),
        rw(legsAddress(keys.mint)),
        ro(keys.mint),
        ro(keys.quoteMint),
        rw(legFeeAccount(keys)),
        rw(a.holdingAddress(keys.mint, launch)),
        rw(a.launchRegistryAddress(pool)),
        rw(a.SWAP_CONFIG),
        rw(dexTreasury),
        rw(pool),
        rw(a.vaultAddress(pool, keys.mint)),
        rw(legQuoteVault(keys)),
        ro(a.LAUNCH_HOOK_AUTHORITY),
        ro(a.SWAP_EVENT_AUTHORITY),
        ro(a.SWAP_PROGRAM),
        ro(a.TOKEN_PROGRAM),
        ro(a.TOKEN_EVENT_AUTHORITY),
        ro(keys.quoteProgram),
        ro(a.ATA_PROGRAM),
        ro(a.SYSTEM_PROGRAM),
      ]),
    );
  },
  /** `claim_creator_fees_token(index)` of the launch's `creator`, sent by `payer` (anyone; the creator's associated token account of the quote is made if missing, at the payer's cost). */
  claimCreatorFeesToken(payer: PublicKey, creator: PublicKey, keys: LegKeys, index: number): TransactionInstruction {
    return ix(
      a.LAUNCH_PROGRAM,
      'launch',
      'claimCreatorFeesToken',
      { index },
      withEvents(a.LAUNCH_PROGRAM, [rw(payer, true), ro(a.launchAddress(keys.mint)), rw(legsAddress(keys.mint)), ro(keys.quoteMint), rw(legFeeAccount(keys)), ro(creator), rw(legQuoteAccount(keys, creator)), ro(keys.quoteProgram), ro(a.ATA_PROGRAM), ro(a.SYSTEM_PROGRAM)]),
    );
  },
  /**
   * A `swap_spl` on a leg with the given token accounts: `traderBase` the coin holding (the trader's on a sell, the recipient's on
   * a buy), `traderQuote` the quote's token account (the trader's on a buy, the recipient's on a sell). With `rules`
   * (`Launch.rules`) that install the kit, the coin's slice (`legBaseSlice`, 5 accounts) goes on its side (`outHookAccounts` on a
   * buy, `inHookAccounts` on a sell) before the leg's four extras, and the mint is writable when they burn
   * (`leg_swap_with_slice`). 20 accounts without a kit, 25 with.
   */
  legSwapWith(keys: LegKeys, trader: PublicKey, traderBase: PublicKey, traderQuote: PublicKey, direction: 0 | 1, amountIn: bigint, minAmountOut: bigint, rules: LaunchRulesData | null = null): TransactionInstruction {
    const slice = rules ? legBaseSlice(keys.mint, kitModulesOf(rules)) : [];
    return splPool.swapSpl(
      { trader, pool: legPoolAddress(keys), baseMint: keys.mint, quoteMint: keys.quoteMint, quoteProgram: keys.quoteProgram, traderBase, traderQuote, hookProgram: a.LAUNCH_PROGRAM, baseMintWritable: rules ? rulesBurn(rules) : false },
      { direction, amountIn, minAmountOut, inHookAccounts: direction === 1 ? 0 : slice.length, outHookAccounts: direction === 1 ? slice.length : 0, hookData: new Uint8Array() },
      [...slice, ...legHookExtras(keys.mint, keys.quoteMint)],
    );
  },
  /** A `swap_spl` on a leg by `trader`, delivered to `recipient`: a buy pays from the trader's associated token account of the quote into the recipient's holding of the coin; a sell delivers to the recipient's associated token account of the quote. `rules` as `legSwapWith` (`leg_swap_with_rules`). */
  legSwap(keys: LegKeys, trader: PublicKey, recipient: PublicKey, direction: 0 | 1, amountIn: bigint, minAmountOut: bigint, rules: LaunchRulesData | null = null): TransactionInstruction {
    const [traderBase, traderQuote] = direction === 1 ? [a.holdingAddress(keys.mint, recipient), legQuoteAccount(keys, trader)] : [a.holdingAddress(keys.mint, trader), legQuoteAccount(keys, recipient)];
    return tokenLaunch.legSwapWith(keys, trader, traderBase, traderQuote, direction, amountIn, minAmountOut, rules);
  },
};

// ---- the kit (phase 1) -----------------------------------------------------------------------------------

export const kitLegs = {
  /**
   * The kit's `init_legs` (`bordrless_kit::client::init_legs`): signed by the launch's kit-caller PDA (so only the launchpad's
   * `create_token_launch` sends it, by CPI) and paid by `payer`; `args` the kit's `KitInitArgs` (no reward mint).
   */
  initLegs(kitCaller: PublicKey, payer: PublicKey, mint: PublicKey, args: Record<string, unknown> & { launch: PublicKey }): TransactionInstruction {
    return ix(
      a.KIT_PROGRAM,
      'kit',
      'initLegs',
      { args },
      withEvents(a.KIT_PROGRAM, [ro(kitCaller, true), rw(payer, true), ro(mint), ro(a.holdingAddress(mint, args.launch)), rw(a.kitConfigAddress(mint)), rw(a.kitRegistryAddress(mint)), ro(a.SYSTEM_PROGRAM)]),
    );
  },
};

// ---- events ------------------------------------------------------------------------------------------

const str = (v: unknown): string => String(v);
const big = (v: unknown): bigint => BigInt(String(v));
const num = (v: unknown): number => Number(v);

/** The DEX's `SplPoolCreated`: right after a kind-2 pool's `PoolCreated`. */
export interface SplPoolCreatedEvent {
  kind: 'swap.SplPoolCreated';
  pool: string;
  quoteMint: string;
  quoteProgram: string;
  quoteDecimals: number;
  quoteVault: string;
}

/** One leg's terms in `TokenLaunchCreated`. */
export interface LegTermsEvent {
  quoteMint: string;
  quoteProgram: string;
  decimals: number;
  virtualQuote: bigint;
  share: bigint;
  pool: string;
  feeAccount: string;
}

/** The launchpad's `TokenLaunchCreated` (no `LaunchCreated` for such a launch). */
export interface TokenLaunchCreatedEvent {
  kind: 'launch.TokenLaunchCreated';
  launch: string;
  mint: string;
  creator: string;
  legsAccount: string;
  name: string;
  symbol: string;
  uri: string;
  supply: bigint;
  decimals: number;
  creatorFeeBps: number;
  lpFeeBps: number;
  launchFeeLamports: bigint;
  legs: LegTermsEvent[];
  slot: bigint;
  ts: number;
}

/** The launchpad's `LegOpened`: the leg's pool exists (the DEX's `PoolCreated` and `SplPoolCreated` come before it in the same transaction). */
export interface LegOpenedEvent {
  kind: 'launch.LegOpened';
  launch: string;
  mint: string;
  index: number;
  quoteMint: string;
  pool: string;
  feeAccount: string;
  virtualQuote: bigint;
  share: bigint;
  /** Legs open now, this one included; trading starts when it equals `count`. */
  opened: number;
  count: number;
  payer: string;
  slot: bigint;
  ts: number;
}

/** The launchpad's `LegCreatorFeesClaimed`. */
export interface LegCreatorFeesClaimedEvent {
  kind: 'launch.LegCreatorFeesClaimed';
  launch: string;
  mint: string;
  index: number;
  quoteMint: string;
  creator: string;
  destination: string;
  amount: bigint;
  claimedTotal: bigint;
  slot: bigint;
  ts: number;
}

/** Phase 1: the launchpad's `TokenLaunchRules` (its lock times counted from the launch, not in force: `TokenLaunchLocks`), right after `TokenLaunchCreated` for a coin launched with rules (the kit's `KitInstalled` inside it when they install the kit). */
export interface TokenLaunchRulesEvent {
  kind: 'launch.TokenLaunchRules';
  launch: string;
  mint: string;
  rules: LaunchRulesData;
  modules: number;
  /** Null when the rules install no kit (a burn alone). */
  kitConfig: string | null;
  /** Unix seconds; 0 when off. */
  creatorUnlockAt: number;
  earlyWindowEnd: number;
  earlyUnlockAt: number;
  /** The legs' sales that lift max wallet; 0 without max wallet. */
  liftAt: bigint;
  ts: number;
}

/**
 * Phase 1 (F1): the last `open_leg` of a coin with the creator lock or the early-buyer lock: trading opened at `tradingOpenedAt`,
 * `delay` after the launch, and the three times in force (the `Launch`'s plus `delay`; 0 when off).
 */
export interface TokenLaunchLocksEvent {
  kind: 'launch.TokenLaunchLocks';
  launch: string;
  mint: string;
  tradingOpenedAt: number;
  delay: number;
  creatorUnlockAt: number;
  earlyWindowEnd: number;
  earlyUnlockAt: number;
  ts: number;
}

/** Phase 1: max wallet lifted on a coin quoted in tokens (`emit!`: a `Program data:` log of the launchpad, read with `legLogEventsOf`). */
export interface LegsMaxWalletLiftedEvent {
  kind: 'launch.LegsMaxWalletLifted';
  launch: string;
  mint: string;
  pool: string;
  sold: bigint;
  liftAt: bigint;
  ts: number;
}

export type LegEvent = SplPoolCreatedEvent | TokenLaunchCreatedEvent | LegOpenedEvent | LegCreatorFeesClaimedEvent | TokenLaunchRulesEvent | TokenLaunchLocksEvent | LegsMaxWalletLiftedEvent;

const rulesOfEvent = (r: Record<string, unknown>): LaunchRulesData => ({ holderFeeBuyBps: num(r.holderFeeBuyBps), holderFeeSellBps: num(r.holderFeeSellBps), burnBuyBps: num(r.burnBuyBps), burnSellBps: num(r.burnSellBps), maxWalletBps: num(r.maxWalletBps), creatorLockSecs: num(r.creatorLockSecs), earlyWindowSecs: num(r.earlyWindowSecs), earlyLockSecs: num(r.earlyLockSecs) });

/**
 * The launchpad's `LegsMaxWalletLifted` from a transaction's logs: the DEX calls the leg hook without the launchpad's event
 * authority, so the hook logs it with `emit!` (`Program data: <base64>` while the launchpad runs). Only that event is read, so
 * no other log ever enters the stored events; ordinals start at `first`.
 */
export function legLogEventsOf(logs: readonly string[], first = 0): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  const stack: string[] = [];
  const launchpad = a.LAUNCH_PROGRAM.toBase58();
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith('Program data: ') || stack[stack.length - 1] !== launchpad) continue;
    const payload = Buffer.from(line.slice('Program data: '.length).trim(), 'base64');
    if (!payload.subarray(0, 8).equals(LEGS_MAX_WALLET_LIFTED)) continue;
    // Flattened as every stored event is (`decodeEventPayload`): keys in base58, integers as decimal strings.
    const ev = decodeEventPayload('launch', payload);
    if (ev) out.push({ ordinal: first + out.length, program: 'launch', programId: launchpad, name: ev.name, data: ev.data });
  }
  return out;
}

/** `LegsMaxWalletLifted`'s discriminator (`sha256("event:LegsMaxWalletLifted")[..8]`). */
const LEGS_MAX_WALLET_LIFTED = Buffer.from([0xb2, 0x72, 0xea, 0xfd, 0xfd, 0x95, 0x68, 0x9f]);

/** The typed view of a quote-token event (`eventsOf`'s flattened data); null for any other event. */
export function typedLegEvent(ev: Pick<DecodedEvent, 'program' | 'name' | 'data'>): LegEvent | null {
  const d = ev.data;
  if (ev.program === 'launch' && ev.name === 'tokenLaunchRules') return { kind: 'launch.TokenLaunchRules', launch: str(d.launch), mint: str(d.mint), rules: rulesOfEvent(d.rules as Record<string, unknown>), modules: num(d.modules), kitConfig: d.kitConfig == null ? null : str(d.kitConfig), creatorUnlockAt: num(d.creatorUnlockAt), earlyWindowEnd: num(d.earlyWindowEnd), earlyUnlockAt: num(d.earlyUnlockAt), liftAt: big(d.liftAt), ts: num(d.ts) };
  if (ev.program === 'launch' && ev.name === 'tokenLaunchLocks') return { kind: 'launch.TokenLaunchLocks', launch: str(d.launch), mint: str(d.mint), tradingOpenedAt: num(d.tradingOpenedAt), delay: num(d.delay), creatorUnlockAt: num(d.creatorUnlockAt), earlyWindowEnd: num(d.earlyWindowEnd), earlyUnlockAt: num(d.earlyUnlockAt), ts: num(d.ts) };
  if (ev.program === 'launch' && ev.name === 'legsMaxWalletLifted') return { kind: 'launch.LegsMaxWalletLifted', launch: str(d.launch), mint: str(d.mint), pool: str(d.pool), sold: big(d.sold), liftAt: big(d.liftAt), ts: num(d.ts) };
  if (ev.program === 'swap' && ev.name === 'splPoolCreated') return { kind: 'swap.SplPoolCreated', pool: str(d.pool), quoteMint: str(d.quoteMint), quoteProgram: str(d.quoteProgram), quoteDecimals: num(d.quoteDecimals), quoteVault: str(d.quoteVault) };
  if (ev.program !== 'launch') return null;
  if (ev.name === 'tokenLaunchCreated') {
    const legs = (d.legs as Record<string, unknown>[]).map((l) => ({ quoteMint: str(l.quoteMint), quoteProgram: str(l.quoteProgram), decimals: num(l.decimals), virtualQuote: big(l.virtualQuote), share: big(l.share), pool: str(l.pool), feeAccount: str(l.feeAccount) }));
    return { kind: 'launch.TokenLaunchCreated', launch: str(d.launch), mint: str(d.mint), creator: str(d.creator), legsAccount: str(d.legsAccount), name: str(d.name), symbol: str(d.symbol), uri: str(d.uri), supply: big(d.supply), decimals: num(d.decimals), creatorFeeBps: num(d.creatorFeeBps), lpFeeBps: num(d.lpFeeBps), launchFeeLamports: big(d.launchFeeLamports), legs, slot: big(d.slot), ts: num(d.ts) };
  }
  if (ev.name === 'legOpened') return { kind: 'launch.LegOpened', launch: str(d.launch), mint: str(d.mint), index: num(d.index), quoteMint: str(d.quoteMint), pool: str(d.pool), feeAccount: str(d.feeAccount), virtualQuote: big(d.virtualQuote), share: big(d.share), opened: num(d.opened), count: num(d.count), payer: str(d.payer), slot: big(d.slot), ts: num(d.ts) };
  if (ev.name === 'legCreatorFeesClaimed') return { kind: 'launch.LegCreatorFeesClaimed', launch: str(d.launch), mint: str(d.mint), index: num(d.index), quoteMint: str(d.quoteMint), creator: str(d.creator), destination: str(d.destination), amount: big(d.amount), claimedTotal: big(d.claimedTotal), slot: big(d.slot), ts: num(d.ts) };
  return null;
}

/**
 * The creator fee a leg's `Swapped` paid (§2.4: the launchpad's answer is the creator fee alone, a
 * quote-side delta to the leg's fee account, from a buy's input or a sell's output), raw quote units.
 */
export function legSwapCutsOf(ev: Pick<SwappedEvent, 'deltasIn' | 'deltasOut'>, mint: PublicKey, quoteMint: PublicKey): { creatorFee: bigint } {
  const fees = legFeesAddress(mint, quoteMint).toBase58();
  const sum = [...ev.deltasIn, ...ev.deltasOut].filter((d) => d.holding === fees).reduce((t, d) => t + d.amount, 0n);
  return { creatorFee: sum };
}

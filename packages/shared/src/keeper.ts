/**
 * What a companion script asks Bordrless's keeper to bring to each step (docs/scripts.md "What a
 * script may ask the keeper for"): a script that pays holders needs their holdings (and where each
 * is paid) among its step's remaining accounts, and only the sender of a step chooses those. Builders
 * never run keepers and Bordrless writes no code per submission, so the script says it in data:
 * **`keeper.json`**, at the root of the submitted source, beside `src/` (where Cargo.toml sits in a
 * crate). The name says who reads it (Bordrless's keeper); JSON because the Workshop, the site, the
 * SDK and the keeper all read it with no parser of their own; outside `src/` because it is not Rust
 * and the build never sees it. It travels with the source: the review by AI reads it beside the code,
 * its bytes are part of the source's hash (so a changed declaration is reviewed and built again), and
 * the approval binds it (`workshop_items.approved_keeper_hash`): a declaration changed after approval
 * does not apply.
 *
 * A declaration says, once (version 1):
 *
 * - which holdings a step brings: the least and the most balance (base units, or a field of the
 *   script's state), a filter on each holding's 64 bytes of hook data (an unsigned little-endian
 *   field compared with a constant, the pool's price now, or the current epoch, floor(now / N), N a
 *   constant or a field of the script's state), and where each one is paid (its owner's wallet, its
 *   owner's bridged-SOL holding, its owner's associated token account of an SPL mint, or nowhere:
 *   the holding alone);
 * - how many a step brings, with the launch pool's swap accounts and without them, and whether it
 *   carries them (a script that trades its pot), the token's hook accounts (a script that moves the
 *   token without trading: a receipt), or the companion's payout accounts (a script made with
 *   `createScriptV2` whose hook records payouts);
 * - the round the keeper's cursor rotates by (seconds, or a field of the script's state);
 * - the wallets a step brings for the script's wallet answers (the companion's
 *   `allow_wallet_payouts`, 2026-10-13: a script that pays any wallet SOL within its payout terms
 *   names each by its key, which must be among the step's accounts): fixed addresses, or public keys
 *   in the script's state. A declaration with wallets may bring no holdings (`holdings` null).
 *
 * Coins quoted in tokens (docs/token-quotes.md §7, §7.4): `"quoteTokens": true` says the script runs on
 * them, its pot the whole creator fee in each leg's token (the companion address's associated token
 * accounts, which the keeper's claims fill); `"legs"` (required with it, never without) says which legs
 * each step brings: `true` every leg, or a list of leg indices. Per leg the step brings the leg's
 * `swap_spl` accounts for the companion address (the coin's token-hook slice with them), the coin's
 * `Legs`, and the companion address's associated token account of the leg's token, whether it exists
 * yet or not (`keeper/scriptExtras.ts`). The launch pool's swap accounts are a SOL coin's: on a token
 * coin a step brings the legs' instead.
 *
 * `parseKeeperDeclaration` holds a file to the schema and its bounds and answers the normal form (the
 * same schema, every default written out, amounts as strings of digits) or one sentence saying what
 * is wrong; `keeperWords` says a declaration in plain words. No Solana dependencies: the keeper's own
 * reading of a declaration is apps/server/src/keeper/scriptExtras.ts.
 */
import type { PayoutTermsRequest } from './api.ts';
import { PAYOUT_TERMS_BOUNDS, POOL_FEE_TIER_DEFAULT_BPS, SCRIPT_BOUNDS, TOKEN_DECIMALS, payoutTermsWithin } from './policy.ts';
import { FIXED_ADDRESSES, HOOK_DATA_LEN, NATIVE_MINT, PROGRAM_IDS } from './programs.ts';
import { decimalWords } from './rules.ts';

/** The file, at the root of the submitted source (beside `src/`): a companion script's, or a pair's companion half's. */
export const KEEPER_FILE = 'keeper.json';
/** The schema's version: the only one there is. */
export const KEEPER_VERSION = 1;

/** The bounds a declaration is held to. */
export const KEEPER_LIMITS = {
  /** The file's bytes (UTF-8). */
  bytes: 4_096,
  /** Holdings one step may bring (the keeper brings fewer when a step would not fit one transaction). */
  perStep: 16,
  /** A round or an epoch, seconds: from the shortest step interval to a year. */
  minSecs: SCRIPT_BOUNDS.minInterval,
  maxSecs: 31_536_000,
  /** The unit a hook-data field counts time in, seconds (an epoch's stamp: 300 for five minutes). */
  maxUnitSecs: 31_536_000,
  /** Wallets a step may bring (about 12 fit one transaction beside the protocol's lookup table on a plain coin; the keeper brings fewer when they do not). */
  wallets: 12,
  /** Figures a coin's page shows live from the script's accounts (`view`), and the most characters a figure's label has. */
  view: 6,
  viewLabel: 24,
  /** Seeds a hook account's address is made of (`view[].account.hook`), and the most bytes one literal seed has. */
  viewSeeds: 4,
  viewSeedBytes: 32,
  /** Pools a step brings beside the launch pool (`pools`), of every kind together. Each costs a step about nine accounts of its own, a Raydium pool nineteen. */
  pools: 3,
} as const;

const U64_MAX = (1n << 64n) - 1n;

/** Bytes of an unsigned little-endian field. */
export type KeeperWidth = 1 | 2 | 4 | 8;

/**
 * How a coin's page shows a figure of the script's state (keeper.json `view`, 16 Oct 2026; the
 * owner: a game's round and its current winner belong on the card): a plain `number`; `lamports`
 * as SOL; `tokens` of the coin; `bps` as a percentage; `time`, unix seconds, as how long until
 * it (or since); `secs`, a length of time; a `wallet` (32 bytes, base58; all zeros reads as none);
 * a `flag` (0 or not).
 */
export type KeeperViewAs = 'number' | 'lamports' | 'tokens' | 'bps' | 'time' | 'secs' | 'wallet' | 'flag';
export const KEEPER_VIEW_AS: readonly KeeperViewAs[] = ['number', 'lamports', 'tokens', 'bps', 'time', 'secs', 'wallet', 'flag'];

/**
 * One figure a coin's page shows live, read from an account of the coin's: the script's own state
 * (`"script"`), or an account of the coin's custom hook at the address its seeds give under the hook
 * program (`{ "hook": ["state", "mint"] }`: each seed a literal, or `"mint"` for the coin's mint).
 * `offset` and `width` say the bytes (32 for a wallet); `as` says how they read. Shown with the
 * script's figures on the coin's Rules card, within a second of the chain.
 */
export interface KeeperViewField {
  label: string;
  account: 'script' | { hook: string[] };
  offset: number;
  width: KeeperWidth | 32;
  as: KeeperViewAs;
}
const WIDTHS: readonly number[] = [1, 2, 4, 8];

/** An unsigned little-endian field of the script's own state account (`PDA(["script-state", mint])` under the companion), read fresh at each step. */
export interface KeeperStateField {
  offset: number;
  width: KeeperWidth;
}

/** A balance or a constant in base units: a string of digits, or a field of the script's state. */
export type KeeperAmount = string | { state: KeeperStateField };
/** A length of time in seconds: a whole number, or a field of the script's state. */
export type KeeperSeconds = number | { state: KeeperStateField };

export type KeeperCompare = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
export const KEEPER_COMPARES: readonly KeeperCompare[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'];

/**
 * What a hook-data field is compared with: the pool's price now (the companion's scale, 10^12 per
 * token unit, as `companionSpotPrice` reads it), a constant, or the current epoch, floor(now / secs).
 * With `fieldUnitSecs`, the field counts units of that many seconds (a hook that stamps
 * floor(now / 300)) and is compared in the epoch's own units: floor(field × fieldUnitSecs / secs).
 */
export type KeeperAgainst = 'poolPrice' | { const: string } | { epoch: { secs: KeeperSeconds; fieldUnitSecs: number | null } };

/** A filter on each holding's hook data: the unsigned little-endian field of `width` bytes at `offset`, compared with `against`. A holding passes when `field <compare> against` holds. */
export interface KeeperHookDataFilter {
  offset: number;
  width: KeeperWidth;
  compare: KeeperCompare;
  against: KeeperAgainst;
}

/**
 * Where each holding a step brings is paid: `owner` (its owner's wallet, writable, after the
 * holding), `ownerQuoteHolding` (its owner's bridged-SOL holding under the Bordrless token program,
 * `holdingAddress(BRIDGED_SOL_MINT, owner)`, writable, after the holding; a holder without one is
 * passed over), `ownerTokenAccount` (its owner's associated token account of `payMint`, under the
 * SPL Token or the Token-2022 program as the mint's owner says, writable, after the holding; a
 * holder without one is passed over; 19 Oct 2026: a pair that pays holders in wrapped Zcash it buys
 * on Raydium), or `none` (the holding alone).
 */
export type KeeperPayTo = 'none' | 'owner' | 'ownerQuoteHolding' | 'ownerTokenAccount';
export const KEEPER_PAY_TO: readonly KeeperPayTo[] = ['none', 'owner', 'ownerQuoteHolding', 'ownerTokenAccount'];

export interface KeeperHoldings {
  /** The least balance that counts, base units (at least 1). */
  minBalance: KeeperAmount;
  /** The most balance that counts, base units, inclusive; null: no most. */
  maxBalance: KeeperAmount | null;
  hookData: KeeperHookDataFilter | null;
  payTo: KeeperPayTo;
  /**
   * The SPL mint (base58) each holder is paid in: required with `payTo` `ownerTokenAccount`, refused
   * with any other. Absent otherwise: left out of the normal form, so a declaration approved before it
   * hashes as it did.
   */
  payMint?: string;
  /** Holdings a step brings when it carries the swap accounts, and when it does not (the one `swapAccounts` names is required; null: not said). */
  perStep: { withSwapAccounts: number | null; withoutSwapAccounts: number | null };
}

/**
 * A wallet a step brings for the script's wallet answers: a fixed address (base58), or the public key
 * in the 32 bytes at `offset` of the script's state, read fresh at each step (all zeros: none that step).
 */
export type KeeperWallet = string | { state: { offset: number } };

/** A mint a pool is named by (`pools[].base`, `.quote`): `"coin"`, the coin's own mint; `"sol"`, SOL (bridged SOL, the DEX's quote mint for it); or a mint's address in base58. */
export type KeeperPoolMint = 'coin' | 'sol' | string;

/**
 * A DEX pool each step brings beside the launch pool (17 Oct 2026; a builder's pair that adds a
 * coin/wBORDR pool's liquidity asked for it): a plain pool, with no pool hook, at the address its
 * two mints and its LP fee tier give (`poolAddress(base, quote, feeBps, null)`), whether or not it
 * exists yet (a script may create it). The step carries the pool's swap accounts for the companion
 * address as the SDK's `swap.swap` lists them (the pool, both mints, both vaults, the companion
 * address's holdings of both mints, the DEX's fixed accounts), the system program, the swap
 * program, each mint's token hook accounts, and with `liquidity` the pool's LP mint and the LP
 * holdings of the launch (the one graduation locks for good, where LiquidityTek mints its LP) and
 * of the companion address. The script finds what it needs among them by key.
 */
export interface KeeperPool {
  base: KeeperPoolMint;
  quote: KeeperPoolMint;
  /** The pool's LP fee, basis points, part of its address: any whole number the DEX takes, 0 to `KEEPER_MAX_POOL_FEE_BPS` (25 when absent; a builder's wBORDR/SOL pool is at 30, 17 Oct 2026). */
  feeBps: number;
  /** The step also brings the pool's LP mint and LP holdings: a script that adds liquidity to it. Default false. */
  liquidity: boolean;
}

/**
 * Another coin's launch pool each step brings (18 Oct 2026; a builder's pair that buys another
 * launched coin on every launch asked for it: a graduated coin's pool has the launch program as
 * its pool hook, so it is never a plain pool): `launch` is that coin's mint, and the step carries
 * the launchpad's swap accounts for the companion address trading it (as `swapAccounts` carries
 * the coin's own), that coin's hook accounts included. With `to: "launcher"` the step also brings
 * the launcher's (the companion's beneficiary's) holding of that coin, writable, for the swap's
 * recipient: a coin with holder rewards lets only wallets hold it, so a script delivers what it
 * buys to a wallet, never to the companion address. That holding must exist already (a swap
 * creates none).
 */
export interface KeeperLaunchPool {
  launch: string;
  to?: 'launcher';
}

/**
 * A Raydium concentrated-liquidity (CLMM) pool each step brings (19 Oct 2026; the owner: a pair
 * whose holders are paid pro rata in wrapped Zcash the pot buys on Raydium's ZEC/WSOL pool), so a
 * script can buy an outside SPL token: `raydiumClmm` is the pool's address, `buy` the mint the
 * script buys there (one of the pool's two mints; it pays with the other). At each step the keeper
 * reads the pool fresh and appends, in this order (`RAYDIUM_CLMM_STEP_ACCOUNTS`; the script maps
 * them to Raydium's `swap_v2`): 0 the CLMM program, 1 the pool's amm config, 2 the pool (writable),
 * 3 and 4 the companion address's associated token accounts of the input and the output mint
 * (writable), 5 and 6 the input and the output vault (writable), 7 the observation account
 * (writable), 8 the SPL Token program, 9 the Token-2022 program, 10 the SPL Memo program, 11 the
 * input mint, 12 the output mint, 13 the pool's tick array bitmap extension (writable), 14 to 16
 * the three tick arrays the swap reads in order from the price now (writable; one that does not
 * exist is named all the same), 17 the Associated Token Account program, 18 the System program.
 * A pool that can't be read is left out of the step, said in the log.
 */
export interface KeeperRaydiumPool {
  raydiumClmm: string;
  buy: string;
}

/** The accounts a Raydium pool adds to a step, in the order `KeeperRaydiumPool` says. */
export const RAYDIUM_CLMM_STEP_ACCOUNTS = 19;

/** What `pools[]` lists: a plain DEX pool, another coin's launch pool, or a Raydium pool. */
export type KeeperPoolEntry = KeeperPool | KeeperLaunchPool | KeeperRaydiumPool;
export const isLaunchPool = (p: KeeperPoolEntry): p is KeeperLaunchPool => 'launch' in p;
export const isRaydiumPool = (p: KeeperPoolEntry): p is KeeperRaydiumPool => 'raydiumClmm' in p;

/** The most a pool's LP fee can be on the DEX (`bordrless_swap::constants::MAX_LP_FEE_BPS`, 90%): what `pools[].feeBps` is held to. The site's create-pool form offers 25, 100 and 200; a pool made another way may have any fee. */
export const KEEPER_MAX_POOL_FEE_BPS = 9_000;

/** A declaration in its normal form: what `parseKeeperDeclaration` answers, what the Workshop stores and hashes, what the keeper reads. */
export interface KeeperDeclaration {
  version: 1;
  /** Which holdings a step brings; null: none (only beside `wallets`: a script that pays wallets alone). */
  holdings: KeeperHoldings | null;
  /** Each step carries the launch pool's swap accounts (what trading the pot needs; they hold the token's hook accounts too). */
  swapAccounts: boolean;
  /** A step without the swap accounts carries the token's custom hook accounts (its program, the token program's signer for it, its registry's extras): what moving the token inside a step needs. */
  hookAccounts: boolean;
  /**
   * Default false. The coin's mint is passed writable in every step: what a script that burns the coin (the token program's
   * `burn`) needs. With the swap accounts the mint already in them is made writable (their order unchanged); without them
   * it is appended last. Without it the mint is writable only on a launch with a burn rate, and a burn elsewhere fails the
   * whole step (`MintNotWritable`). A burn may take the coin down to the dev bag still held, never into it (`ScriptTookDevBag`).
   */
  mintWritable?: boolean;
  /** Each step carries the companion's payout accounts (`companion.payoutAccounts`): a script whose answers the companion pays and its hook records. */
  payouts: boolean;
  /** The round the keeper's cursor rotates by; null: none (the cursor never starts over). */
  roundSecs: KeeperSeconds | null;
  /**
   * The wallets each step brings (writable, with the payout terms) while the script's terms allow
   * wallet payouts (`allowWalletPayouts`), at most `KEEPER_LIMITS.wallets`. Absent when none: left out
   * of the normal form, so a declaration approved before wallets existed hashes as it did.
   */
  wallets?: KeeperWallet[];
  /**
   * How often its step runs, seconds (`SCRIPT_BOUNDS.minInterval` to `maxInterval`, 10 s to a day;
   * 2026-10-13): the launch's script interval, set from the item, never by the launcher. Absent: the
   * default `keeperStepSecs` works out. Left out of the normal form when absent, so a declaration
   * approved before it hashes as it did.
   */
  stepSecs?: number;
  /**
   * The state the companion makes for the script, bytes (0 to `SCRIPT_BOUNDS.maxStateLen`;
   * 2026-10-13): what a site launch asks for. Absent: `KEEPER_DEFAULT_STATE_LEN`. Left out of the
   * normal form when absent.
   */
  stateLen?: number;
  /** What `companion_init` gets at a site launch, hex (at most `SCRIPT_BOUNDS.maxInitLen` bytes). Absent: nothing. Left out of the normal form when absent. */
  initData?: string;
  /** Figures a coin's page shows live from the script's accounts (`KeeperViewField`, 16 Oct 2026); absent: none. Left out of the normal form when empty. */
  view?: KeeperViewField[];
  /** DEX pools each step brings beside the launch pool (`KeeperPool`, 17 Oct 2026), other coins' launch pools (`KeeperLaunchPool`, 18 Oct), or Raydium pools (`KeeperRaydiumPool`, 19 Oct), at most `KEEPER_LIMITS.pools` in all; absent: none. Left out of the normal form when empty. */
  pools?: KeeperPoolEntry[];
  /**
   * The launcher's share of each trade's fee on every launch with it, basis points of the whole (0
   * to `KEEPER_MAX_LAUNCHER_SHARE_BPS`; the pot gets the rest, at least a twentieth), fixed by the
   * builder (LiquidityTek, 15 Oct 2026: "0.5% to the launcher and 1.5% to the engine" of a 2% fee is
   * 2,500). Absent: a pair's split is the one its builder set on the config page, else even
   * (`withLauncherShare`, `PAIR_DEFAULT_LAUNCHER_SHARE_BPS`), never the launcher's to adjust; a
   * companion on its own leaves it to the launcher on the launch page. Left out of the normal form
   * when absent.
   */
  launcherShareBps?: number;
  /**
   * The payout terms a launch makes the script with (`create_script_v2`'s `PayoutTermsArgs`; 16 Oct
   * 2026, LiquidityTek's script holds the chain's terms to exact figures): `stepBps`, `holdingBps`
   * and `windowBps` (1 to 10,000) and `windowSecs` (`PAYOUT_TERMS_BOUNDS`, 10 s to a day). Absent:
   * a Workshop script launches with open terms (`SCRIPT_PAYOUT_OPEN` in the site: a step may pay the
   * whole pot, the window the shortest the program takes). Either way the launch's beneficiary or
   * the script approver may replace them after the launch (`set_payout_terms`). Left out of the
   * normal form when absent.
   */
  payoutTerms?: PayoutTermsRequest;
  /**
   * The script runs on coins quoted in tokens (docs/token-quotes.md §7.4): its pot is in the legs' tokens, which it trades on the legs
   * and pays out as tokens (or swaps to SOL on Raydium). Left out of the normal form unless true, so a declaration approved before hashes
   * as it did.
   */
  quoteTokens?: true;
  /** With `quoteTokens`: the legs each step brings, `true` for every leg of the coin or the leg indices (0 to 5, each once). Left out unless `quoteTokens`. */
  legs?: true | number[];
}

/** The most legs a coin quoted in tokens has (`MAX_QUOTE_TOKENS`): what `legs`' indices are held under. */
export const KEEPER_MAX_LEGS = 6;

/** The legs a declaration's step brings on a coin of `count` legs, in order: every leg for `legs: true`, the named ones the coin has otherwise; none without `legs`. */
export function keeperLegIndices(d: Pick<KeeperDeclaration, 'legs'>, count: number): number[] {
  if (d.legs === undefined) return [];
  const all = Array.from({ length: Math.min(count, KEEPER_MAX_LEGS) }, (_, i) => i);
  return d.legs === true ? all : d.legs.filter((i) => i < count).sort((x, y) => x - y);
}

/** The most of the fee a declaration (or the config page) may fix for the launcher: the pot gets at least a twentieth, a quarter of a percent of the largest fee (the companion program wants a part). */
export const KEEPER_MAX_LAUNCHER_SHARE_BPS = 9_500;

export type KeeperParse = { ok: true; declaration: KeeperDeclaration } | { ok: false; problem: string };

class KeeperProblem extends Error {}

/** Refuses with one sentence, the file named first. */
const fail = (sentence: string): never => {
  throw new KeeperProblem(`${KEEPER_FILE}: ${sentence}`);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An object with no field but `allowed`. */
function fieldsOf(v: unknown, at: string, allowed: readonly string[], shape: string): Record<string, unknown> {
  if (!isObject(v)) return fail(`${at} is ${shape}.`);
  for (const key of Object.keys(v)) if (!allowed.includes(key)) fail(`${at} has no field "${key.slice(0, 40)}" (it takes ${allowed.join(', ')}).`);
  return v;
}

const group = (n: number | bigint): string => n.toLocaleString('en-US');

function stateFieldOf(v: unknown, at: string): KeeperStateField {
  const o = fieldsOf(v, at, ['offset', 'width'], '{ "offset", "width" }: a field of the script’s state');
  const width = o.width;
  if (typeof width !== 'number' || !WIDTHS.includes(width)) return fail(`${at}.width is 1, 2, 4 or 8: the field’s bytes, unsigned little-endian.`);
  const offset = o.offset;
  const last = SCRIPT_BOUNDS.maxStateLen - width;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > last) return fail(`${at}.offset is a whole number from 0 to ${group(last)}: where the field starts in the script’s state.`);
  return { offset, width: width as KeeperWidth };
}

/** `{ "state": { "offset", "width" } }`. */
const fromState = (v: Record<string, unknown>, at: string): { state: KeeperStateField } => {
  const o = fieldsOf(v, at, ['state'], '{ "state": { "offset", "width" } }');
  return { state: stateFieldOf(o.state, `${at}.state`) };
};

function amountOf(v: unknown, at: string, min: bigint): KeeperAmount {
  if (isObject(v)) return fromState(v, at);
  let n: bigint | null = null;
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) n = BigInt(v);
  else if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) n = BigInt(v);
  if (n === null || n < min || n > U64_MAX) return fail(`${at} is a whole number of base units from ${group(min)} to ${group(U64_MAX)}, written as a string of digits ("20000000000000"), or { "state": { "offset", "width" } }.`);
  return n.toString();
}

function secondsOf(v: unknown, at: string): KeeperSeconds {
  if (isObject(v)) return fromState(v, at);
  if (typeof v !== 'number' || !Number.isInteger(v) || v < KEEPER_LIMITS.minSecs || v > KEEPER_LIMITS.maxSecs) {
    return fail(`${at} is a whole number of seconds from ${KEEPER_LIMITS.minSecs} to ${group(KEEPER_LIMITS.maxSecs)} (a year), or { "state": { "offset", "width" } }.`);
  }
  return v;
}

function againstOf(v: unknown, at: string): KeeperAgainst {
  if (v === 'poolPrice') return 'poolPrice';
  if (!isObject(v) || Object.keys(v).length !== 1) return fail(`${at} is "poolPrice", { "const": "<base units>" } or { "epoch": { "secs", "fieldUnitSecs" } }.`);
  if ('const' in v) {
    if (isObject(v.const)) return fail(`${at}.const is a string of digits: a constant, not a field of the state.`);
    return { const: amountOf(v.const, `${at}.const`, 0n) as string };
  }
  if ('epoch' in v) {
    const e = fieldsOf(v.epoch, `${at}.epoch`, ['secs', 'fieldUnitSecs'], '{ "secs", "fieldUnitSecs" }');
    const secs = secondsOf(e.secs, `${at}.epoch.secs`);
    const unit = e.fieldUnitSecs;
    if (unit !== undefined && unit !== null && (typeof unit !== 'number' || !Number.isInteger(unit) || unit < 1 || unit > KEEPER_LIMITS.maxUnitSecs)) {
      return fail(`${at}.epoch.fieldUnitSecs is a whole number of seconds from 1 to ${group(KEEPER_LIMITS.maxUnitSecs)}: the unit the field counts time in (300 when the hook stamps floor(now / 300)).`);
    }
    return { epoch: { secs, fieldUnitSecs: typeof unit === 'number' ? unit : null } };
  }
  return fail(`${at} is "poolPrice", { "const": "<base units>" } or { "epoch": { "secs", "fieldUnitSecs" } }.`);
}

function hookDataOf(v: unknown, at: string): KeeperHookDataFilter | null {
  if (v === undefined || v === null) return null;
  const o = fieldsOf(v, at, ['offset', 'width', 'compare', 'against'], '{ "offset", "width", "compare", "against" }, or null');
  const width = o.width;
  if (typeof width !== 'number' || !WIDTHS.includes(width)) return fail(`${at}.width is 1, 2, 4 or 8: the field’s bytes, unsigned little-endian.`);
  const offset = o.offset;
  const last = HOOK_DATA_LEN - width;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > last) return fail(`${at}.offset is a whole number from 0 to ${last}: a holding keeps ${HOOK_DATA_LEN} bytes of hook data.`);
  if (typeof o.compare !== 'string' || !(KEEPER_COMPARES as readonly string[]).includes(o.compare)) return fail(`${at}.compare is one of ${KEEPER_COMPARES.join(', ')}.`);
  return { offset, width: width as KeeperWidth, compare: o.compare as KeeperCompare, against: againstOf(o.against, `${at}.against`) };
}

function perStepCount(v: unknown, at: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > KEEPER_LIMITS.perStep) return fail(`${at} is a whole number from 1 to ${KEEPER_LIMITS.perStep}.`);
  return v;
}

function flagOf(v: unknown, at: string, fallback: boolean | null): boolean {
  if (v === undefined && fallback !== null) return fallback;
  if (typeof v !== 'boolean') return fail(`${at} is true or false.`);
  return v;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Whether a text is a public key in base58: exactly 32 bytes, as `new PublicKey` reads it (each leading "1" a zero byte). */
export function isBase58Key(text: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return false;
  let n = 0n;
  for (const ch of text) n = n * 58n + BigInt(BASE58.indexOf(ch));
  let bytes = text.length - text.replace(/^1+/, '').length;
  for (; n > 0n; n >>= 8n) bytes += 1;
  return bytes === 32;
}

/** The default key (the system program's): never a wallet a step pays. */
const DEFAULT_KEY = '11111111111111111111111111111111';
const PROTOCOL_KEYS: readonly string[] = Object.values(PROGRAM_IDS);

/** `wallets`: at most `KEEPER_LIMITS.wallets`, each an address or 32 bytes of the script's state, none named twice; [] when absent. */
function walletsOf(v: unknown, at: string): KeeperWallet[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > KEEPER_LIMITS.wallets) return fail(`${at} is a list of at most ${KEEPER_LIMITS.wallets} wallets, each an address ("<base58>") or { "state": { "offset" } }: a public key in the script’s state.`);
  const out: KeeperWallet[] = [];
  const seen = new Set<string>();
  v.forEach((w: unknown, i) => {
    const where = `${at}[${i}]`;
    let wallet: KeeperWallet;
    if (typeof w === 'string') {
      if (!isBase58Key(w)) fail(`${where} is an address in base58 (32 bytes).`);
      if (w === DEFAULT_KEY || PROTOCOL_KEYS.includes(w)) fail(`${where} is the default key or a Bordrless program: the companion never pays it.`);
      wallet = w;
    } else {
      const o = fieldsOf(w, where, ['state'], 'an address ("<base58>") or { "state": { "offset" } }');
      const s = fieldsOf(o.state, `${where}.state`, ['offset'], '{ "offset" }: where a public key (32 bytes) starts in the script’s state');
      const last = SCRIPT_BOUNDS.maxStateLen - 32;
      if (typeof s.offset !== 'number' || !Number.isInteger(s.offset) || s.offset < 0 || s.offset > last) fail(`${where}.state.offset is a whole number from 0 to ${group(last)}: where a public key (32 bytes) starts in the script’s state.`);
      wallet = { state: { offset: s.offset as number } };
    }
    const key = typeof wallet === 'string' ? wallet : `state:${wallet.state.offset}`;
    if (seen.has(key)) fail(`${where} is named twice.`);
    seen.add(key);
    out.push(wallet);
  });
  return out;
}

const BRIDGED_SOL = FIXED_ADDRESSES.bridgedSolMint;

/**
 * An SPL mint a declaration names outside the Bordrless token program (a Raydium pool's `buy`, the
 * `payMint` holders are paid in): a key in base58, never the coin (which trades on its own launch
 * pool), the default key, a Bordrless program or Bordrless's bridged SOL (an SPL account holds
 * wrapped SOL, `NATIVE_MINT`).
 */
function splMintOf(v: unknown, at: string, what: string): string {
  if (v === 'coin') return fail(`${at} is never the coin: the coin is a Bordrless token, not an SPL mint (${what}).`);
  if (typeof v !== 'string' || !isBase58Key(v)) return fail(`${at} is an SPL mint’s address in base58 (${what}; wrapped SOL is ${NATIVE_MINT}).`);
  if (v === DEFAULT_KEY || PROTOCOL_KEYS.includes(v) || v === BRIDGED_SOL) return fail(`${at} is an SPL mint, not the default key, a Bordrless program or Bordrless’s bridged SOL (wrapped SOL is ${NATIVE_MINT}).`);
  return v;
}

/** `pools`: at most `KEEPER_LIMITS.pools` entries, each a plain DEX pool by its two mints and its fee tier, another coin's launch pool by its mint, or a Raydium pool by its address and the mint bought there; none the coin's own launch pool, none named twice. */
function poolsOf(v: unknown): KeeperPoolEntry[] {
  if (!Array.isArray(v) || v.length > KEEPER_LIMITS.pools) return fail(`pools is a list of at most ${KEEPER_LIMITS.pools} pools a step brings beside the launch pool, each { "base", "quote", "feeBps", "liquidity" } (a DEX pool), { "launch", "to" } (another coin's launch pool) or { "raydiumClmm", "buy" } (a Raydium pool).`);
  const seen = new Set<string>();
  return v.map((item: unknown, i): KeeperPoolEntry => {
    const at = `pools[${i}]`;
    if (isObject(item) && 'raydiumClmm' in item) {
      // A Raydium concentrated-liquidity pool (19 Oct 2026): the keeper reads it fresh each step, so only its address and the side bought are declared.
      const r = fieldsOf(item, at, ['raydiumClmm', 'buy'], '{ "raydiumClmm": <pool>, "buy": <mint> }: a Raydium pool by its address and the mint the script buys there');
      const pool = r.raydiumClmm;
      if (typeof pool !== 'string' || !isBase58Key(pool)) return fail(`${at}.raydiumClmm is the Raydium pool’s address, in base58.`);
      if (pool === DEFAULT_KEY || PROTOCOL_KEYS.includes(pool) || pool === BRIDGED_SOL) fail(`${at}.raydiumClmm is a Raydium pool’s address, not the default key, a Bordrless program or a mint.`);
      if (r.buy === undefined || r.buy === null) fail(`${at}.buy is required: the mint the script buys on that pool, one of its two.`);
      const buy = splMintOf(r.buy, `${at}.buy`, 'the mint the script buys on that pool, one of its two');
      if (buy === pool) fail(`${at}.buy is one of the pool’s two mints, not the pool itself.`);
      const key = `raydium/${pool}`;
      if (seen.has(key)) fail(`${at} is named twice.`);
      seen.add(key);
      return { raydiumClmm: pool, buy };
    }
    if (isObject(item) && 'launch' in item) {
      const q = fieldsOf(item, at, ['launch', 'to'], '{ "launch": <mint>, "to"?: "launcher" }: another coin’s launch pool by its mint');
      const launch = q.launch;
      if (launch === 'coin') fail(`${at}.launch is another coin’s mint, never the coin’s own launch pool (that is swapAccounts).`);
      if (typeof launch !== 'string' || !isBase58Key(launch)) return fail(`${at}.launch is the other coin’s mint, in base58.`);
      if (launch === BRIDGED_SOL || launch === DEFAULT_KEY || PROTOCOL_KEYS.includes(launch)) fail(`${at}.launch is a launched coin’s mint, not SOL, the default key or a Bordrless program.`);
      if (q.to !== undefined && q.to !== null && q.to !== 'launcher') fail(`${at}.to is "launcher" (the step also brings the launcher’s holding of that coin, for the swap’s recipient) or left out.`);
      const key = `launch/${launch}`;
      if (seen.has(key)) fail(`${at} is named twice.`);
      seen.add(key);
      return { launch, ...(q.to === 'launcher' ? { to: 'launcher' as const } : {}) };
    }
    const p = fieldsOf(item, at, ['base', 'quote', 'feeBps', 'liquidity'], '{ "base", "quote", "feeBps", "liquidity" }: a DEX pool by its two mints and its LP fee tier, { "launch" }: another coin’s launch pool, or { "raydiumClmm", "buy" }: a Raydium pool');
    const mintOf = (x: unknown, side: 'base' | 'quote'): KeeperPoolMint => {
      if (x === 'coin' || x === 'sol') return x;
      if (typeof x !== 'string' || !isBase58Key(x)) return fail(`${at}.${side} is "coin" (the coin’s mint), "sol" (SOL), or a mint’s address in base58.`);
      if (x === BRIDGED_SOL) return 'sol';
      if (x === DEFAULT_KEY || PROTOCOL_KEYS.includes(x)) return fail(`${at}.${side} is the default key or a Bordrless program, not a mint.`);
      return x;
    };
    const base = mintOf(p.base, 'base');
    const quote = mintOf(p.quote, 'quote');
    if (base === 'sol') fail(`${at}.base is never "sol": SOL is a pool’s quote on the DEX.`);
    if (base === quote) fail(`${at}: base and quote are the same mint.`);
    if (base === 'coin' && quote === 'sol') fail(`${at} is the coin’s own launch pool: ask for it with swapAccounts.`);
    const feeBps: unknown = p.feeBps === undefined || p.feeBps === null ? POOL_FEE_TIER_DEFAULT_BPS : p.feeBps;
    if (typeof feeBps !== 'number' || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > KEEPER_MAX_POOL_FEE_BPS) return fail(`${at}.feeBps is the pool’s LP fee in basis points, part of its address: a whole number from 0 to ${group(KEEPER_MAX_POOL_FEE_BPS)} (${POOL_FEE_TIER_DEFAULT_BPS} when absent).`);
    const liquidity = flagOf(p.liquidity, `${at}.liquidity`, false);
    const key = `${base}/${quote}/${feeBps}`;
    if (seen.has(key)) fail(`${at} is named twice.`);
    seen.add(key);
    return { base, quote, feeBps, liquidity };
  });
}

/** `holdings`, held to the schema beside the flags it depends on. */
function holdingsOf(v: unknown, swapAccounts: boolean, payouts: boolean): KeeperHoldings {
  const h = fieldsOf(v, 'holdings', ['minBalance', 'maxBalance', 'hookData', 'payTo', 'payMint', 'perStep'], '{ "minBalance", "maxBalance", "hookData", "payTo", "payMint", "perStep" }');
  if (h.minBalance === undefined) fail('holdings.minBalance is required: the least balance that counts, base units.');
  const minBalance = amountOf(h.minBalance, 'holdings.minBalance', 1n);
  const maxBalance = h.maxBalance === undefined || h.maxBalance === null ? null : amountOf(h.maxBalance, 'holdings.maxBalance', 1n);
  if (typeof minBalance === 'string' && typeof maxBalance === 'string' && BigInt(maxBalance) < BigInt(minBalance)) fail('holdings.maxBalance is at least holdings.minBalance.');
  const hookData = hookDataOf(h.hookData, 'holdings.hookData');
  if (typeof h.payTo !== 'string' || !(KEEPER_PAY_TO as readonly string[]).includes(h.payTo)) fail(`holdings.payTo is one of ${KEEPER_PAY_TO.join(', ')}: where each holding is paid.`);
  const payTo = h.payTo as KeeperPayTo;
  // The companion pays a payout answer's holding to its owner itself (`payoutAccounts`): the step brings the owner, or the holding alone to be measured.
  if (payouts && (payTo === 'ownerQuoteHolding' || payTo === 'ownerTokenAccount')) fail('with payouts the companion pays each holding’s owner itself: holdings.payTo is owner (or none for a step that only measures).');
  // A token account is of one mint: the declaration names it, and nothing else takes one.
  const hasPayMint = h.payMint !== undefined && h.payMint !== null;
  if (payTo === 'ownerTokenAccount' && !hasPayMint) fail('holdings.payMint is required with payTo ownerTokenAccount: the SPL mint each holder is paid in.');
  if (payTo !== 'ownerTokenAccount' && hasPayMint) fail('holdings.payMint goes only with payTo ownerTokenAccount: it names the mint of the token account each holder is paid in.');
  const payMint = hasPayMint ? splMintOf(h.payMint, 'holdings.payMint', 'the mint of the token account each holder is paid in') : null;
  const p = fieldsOf(h.perStep, 'holdings.perStep', ['withSwapAccounts', 'withoutSwapAccounts'], '{ "withSwapAccounts", "withoutSwapAccounts" }: holdings a step brings');
  const perStep = { withSwapAccounts: perStepCount(p.withSwapAccounts, 'holdings.perStep.withSwapAccounts'), withoutSwapAccounts: perStepCount(p.withoutSwapAccounts, 'holdings.perStep.withoutSwapAccounts') };
  if (swapAccounts && perStep.withSwapAccounts === null) fail('holdings.perStep.withSwapAccounts is required while swapAccounts is true.');
  if (!swapAccounts && perStep.withoutSwapAccounts === null) fail('holdings.perStep.withoutSwapAccounts is required while swapAccounts is false.');
  return { minBalance, maxBalance, hookData, payTo, ...(payMint !== null ? { payMint } : {}), perStep };
}

/** The declaration in a parsed JSON value, held to the schema and its bounds: its normal form, or why not, in one sentence. */
export function keeperDeclarationOf(value: unknown): KeeperParse {
  try {
    const root = fieldsOf(value, 'the file', ['version', 'holdings', 'swapAccounts', 'hookAccounts', 'mintWritable', 'payouts', 'roundSecs', 'wallets', 'stepSecs', 'stateLen', 'initData', 'launcherShareBps', 'payoutTerms', 'view', 'pools', 'quoteTokens', 'legs'], 'one object');
    if (root.version !== KEEPER_VERSION) fail(`version is ${KEEPER_VERSION}, the only one there is.`);
    const wallets = walletsOf(root.wallets, 'wallets');
    // A script that pays wallets alone brings no holdings; nor need one that trades the legs of a coin quoted in tokens (§7.4: its legs are its step's accounts).
    const noHoldings = root.holdings === undefined || (root.holdings === null && (wallets.length > 0 || root.quoteTokens === true));
    if (noHoldings && wallets.length === 0 && !(root.holdings === null && root.quoteTokens === true)) fail('holdings is required: which holdings each step brings (null with wallets, or with quoteTokens and its legs).');
    const swapAccounts = flagOf(root.swapAccounts, 'swapAccounts', null);
    const hookAccounts = flagOf(root.hookAccounts, 'hookAccounts', false);
    const mintWritable = flagOf(root.mintWritable, 'mintWritable', false);
    const payouts = flagOf(root.payouts, 'payouts', false);
    const holdings = noHoldings ? null : holdingsOf(root.holdings, swapAccounts, payouts);
    const roundSecs = root.roundSecs === undefined || root.roundSecs === null ? null : secondsOf(root.roundSecs, 'roundSecs');
    const stepSecs = root.stepSecs === undefined || root.stepSecs === null ? null : stepSecsOf(root.stepSecs);
    const stateLen = root.stateLen === undefined || root.stateLen === null ? null : stateLenOf(root.stateLen);
    const initData = root.initData === undefined || root.initData === null ? null : initDataOf(root.initData);
    const launcherShareBps = root.launcherShareBps === undefined || root.launcherShareBps === null ? null : launcherShareOf(root.launcherShareBps);
    const payoutTerms = root.payoutTerms === undefined || root.payoutTerms === null ? null : payoutTermsOf(root.payoutTerms);
    const view = root.view === undefined || root.view === null ? [] : viewOf(root.view);
    const pools = root.pools === undefined || root.pools === null ? [] : poolsOf(root.pools);
    const quoteTokens = flagOf(root.quoteTokens, 'quoteTokens', false);
    const legs = legsOf(root.legs, quoteTokens);
    return { ok: true, declaration: { version: 1, holdings, swapAccounts, hookAccounts, ...(mintWritable ? { mintWritable } : {}), payouts, roundSecs, ...(wallets.length > 0 ? { wallets } : {}), ...(stepSecs !== null ? { stepSecs } : {}), ...(launcherShareBps !== null ? { launcherShareBps } : {}), ...(payoutTerms !== null ? { payoutTerms } : {}), ...(stateLen !== null ? { stateLen } : {}), ...(initData !== null ? { initData } : {}), ...(view.length > 0 ? { view } : {}), ...(pools.length > 0 ? { pools } : {}), ...(quoteTokens ? { quoteTokens: true as const } : {}), ...(legs !== null ? { legs } : {}) } };
  } catch (error) {
    if (error instanceof KeeperProblem) return { ok: false, problem: error.message };
    throw error;
  }
}

/**
 * `legs`: with `quoteTokens` only, and required with it (a script on a token coin has its pot in the legs' tokens and nothing to
 * spend them with but the legs): `true` (every leg) or the leg indices, 0 to 5, each once.
 */
function legsOf(v: unknown, quoteTokens: boolean): true | number[] | null {
  const absent = v === undefined || v === null;
  if (absent && quoteTokens) return fail('legs is required with quoteTokens: true for every leg of the coin, or [0, 2] for the legs a step brings (a script on a coin quoted in tokens has its pot in the legs’ tokens, and the legs’ accounts are what it trades and pays with).');
  if (absent) return null;
  if (!quoteTokens) return fail('legs goes only with quoteTokens: true (the legs are a coin quoted in tokens’).');
  if (v === true) return true;
  if (!Array.isArray(v) || v.length === 0 || v.length > KEEPER_MAX_LEGS) return fail(`legs is true (every leg) or a list of 1 to ${KEEPER_MAX_LEGS} leg indices, 0 to ${KEEPER_MAX_LEGS - 1}.`);
  const seen = new Set<number>();
  for (const [i, x] of v.entries()) {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= KEEPER_MAX_LEGS) fail(`legs[${i}] is a leg index, 0 to ${KEEPER_MAX_LEGS - 1}.`);
    if (seen.has(x as number)) fail(`legs[${i}] is named twice.`);
    seen.add(x as number);
  }
  return [...seen].sort((x, y) => x - y);
}

/** `view`: at most `KEEPER_LIMITS.view` figures, each a label, an account, the bytes and how they read. */
function viewOf(v: unknown): KeeperViewField[] {
  if (!Array.isArray(v) || v.length > KEEPER_LIMITS.view) return fail(`view is a list of at most ${KEEPER_LIMITS.view} figures a coin’s page shows from the script’s accounts.`);
  return v.map((item, i) => {
    const at = `view[${i}]`;
    const f = fieldsOf(item, at, ['label', 'account', 'offset', 'width', 'as'], '{ "label", "account", "offset", "width", "as" }');
    if (typeof f.label !== 'string' || f.label.trim().length === 0 || f.label.length > KEEPER_LIMITS.viewLabel) fail(`${at}.label is the figure’s name, 1 to ${KEEPER_LIMITS.viewLabel} characters.`);
    let account: KeeperViewField['account'];
    if (f.account === 'script') account = 'script';
    else {
      const a = fieldsOf(f.account, `${at}.account`, ['hook'], '"script", or { "hook": [seeds] }');
      const seeds = a.hook;
      if (!Array.isArray(seeds) || seeds.length === 0 || seeds.length > KEEPER_LIMITS.viewSeeds || !seeds.every((x) => typeof x === 'string' && x.length > 0 && utf8Length(x) <= KEEPER_LIMITS.viewSeedBytes)) {
        fail(`${at}.account.hook is the seeds of the hook’s account under its program: 1 to ${KEEPER_LIMITS.viewSeeds} strings of at most ${KEEPER_LIMITS.viewSeedBytes} bytes, "mint" for the coin’s mint.`);
      }
      account = { hook: seeds as string[] };
    }
    if (typeof f.offset !== 'number' || !Number.isInteger(f.offset) || f.offset < 0 || f.offset > SCRIPT_BOUNDS.maxStateLen) fail(`${at}.offset is where the figure’s bytes start: a whole number from 0 to ${group(SCRIPT_BOUNDS.maxStateLen)}.`);
    const as = f.as;
    if (typeof as !== 'string' || !KEEPER_VIEW_AS.includes(as as KeeperViewAs)) fail(`${at}.as is how the figure reads: ${KEEPER_VIEW_AS.join(', ')}.`);
    const width = f.width;
    const wallet = as === 'wallet';
    if (typeof width !== 'number' || (wallet ? width !== 32 : !WIDTHS.includes(width))) fail(wallet ? `${at}.width is 32 for a wallet.` : `${at}.width is the figure’s bytes: 1, 2, 4 or 8 (32 for a wallet, with "as": "wallet").`);
    return { label: (f.label as string).trim(), account, offset: f.offset as number, width: width as KeeperViewField['width'], as: as as KeeperViewAs };
  });
}

/** `stateLen`: a whole number of bytes, 0 to the companion's most. */
function stateLenOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > SCRIPT_BOUNDS.maxStateLen) return fail(`stateLen is the state the companion makes for the script: a whole number of bytes from 0 to ${group(SCRIPT_BOUNDS.maxStateLen)}.`);
  return v;
}

/** `initData`: hex, an even number of digits, at most the companion's most bytes; kept lower-case. */
function initDataOf(v: unknown): string {
  if (typeof v !== 'string' || !/^([0-9a-fA-F]{2})*$/.test(v) || v.length / 2 > SCRIPT_BOUNDS.maxInitLen) return fail(`initData is what companion_init gets, as hex: an even number of hex digits, at most ${SCRIPT_BOUNDS.maxInitLen} bytes.`);
  return v.toLowerCase();
}

/** `payoutTerms`: the four whole numbers within the companion program's bounds (`payoutTermsWithin`). */
function payoutTermsOf(v: unknown): PayoutTermsRequest {
  const t = fieldsOf(v, 'payoutTerms', ['stepBps', 'holdingBps', 'windowBps', 'windowSecs'], '{ "stepBps", "holdingBps", "windowBps", "windowSecs" }');
  const whole = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
  if (!whole(t.stepBps) || !whole(t.holdingBps) || !whole(t.windowBps) || !whole(t.windowSecs) || !payoutTermsWithin({ stepBps: t.stepBps, holdingBps: t.holdingBps, windowBps: t.windowBps, windowSecs: t.windowSecs })) {
    return fail(`payoutTerms is the script’s payout terms as the companion program takes them: stepBps, holdingBps and windowBps whole numbers from 1 to 10,000, windowSecs from ${PAYOUT_TERMS_BOUNDS.minWindowSecs} to ${group(PAYOUT_TERMS_BOUNDS.maxWindowSecs)} seconds.`);
  }
  return { stepBps: t.stepBps, holdingBps: t.holdingBps, windowBps: t.windowBps, windowSecs: t.windowSecs };
}

/** `launcherShareBps`: a whole number of basis points of the fee, 0 to the most the launcher may be fixed (the pot keeps a part). */
function launcherShareOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > KEEPER_MAX_LAUNCHER_SHARE_BPS) {
    return fail(`launcherShareBps is the launcher’s share of each trade’s fee on every launch, fixed: a whole number of basis points from 0 to ${group(KEEPER_MAX_LAUNCHER_SHARE_BPS)} (the pot gets the rest, at least a twentieth).`);
  }
  return v;
}

/** `stepSecs`: a whole number of seconds within the companion's step bounds. */
function stepSecsOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < SCRIPT_BOUNDS.minInterval || v > SCRIPT_BOUNDS.maxInterval) {
    return fail(`stepSecs is how often a step runs: a whole number of seconds from ${SCRIPT_BOUNDS.minInterval} to ${group(SCRIPT_BOUNDS.maxInterval)} (a day).`);
  }
  return v;
}

/** A step a minute: how often a script steps when its declaration names no round (or there is none), as the launch page started every custom hook before. */
export const DEFAULT_STEP_SECS = 60;
/** Steps a round, by default: a round of 300 s steps every 10 s, so 30 steps bring 30 times `perStep` holdings each round (90 for Whale Bait's 3). */
export const STEPS_PER_ROUND = 30;

/**
 * How often a script's step runs (the launch's script interval, 2026-10-13: the builder's, never the
 * launcher's): its declaration's `stepSecs`; else, with a round of a fixed length, a thirtieth of
 * it (`STEPS_PER_ROUND`, within the companion's bounds), so the keeper reaches thirty steps' worth
 * of holdings every round; else a step a minute (`DEFAULT_STEP_SECS`), also for a script with no
 * declaration.
 */
export function keeperStepSecs(d: Pick<KeeperDeclaration, 'stepSecs' | 'roundSecs'> | null | undefined): number {
  if (d?.stepSecs !== undefined) return d.stepSecs;
  const round = d?.roundSecs;
  if (typeof round === 'number') return Math.min(SCRIPT_BOUNDS.maxInterval, Math.max(SCRIPT_BOUNDS.minInterval, Math.floor(round / STEPS_PER_ROUND)));
  return DEFAULT_STEP_SECS;
}

/** What a launch takes from a script's declaration (the launch page's, 2026-10-13): how often a step runs, and whether its script pays wallets (its launch then allows wallet payouts, within its payout terms: the declaration's `payoutTerms`, else open terms). */
export interface KeeperLaunchTerms {
  stepSecs: number;
  wallets: boolean;
  /** The state the companion makes for it, bytes (`stateLen`; `KEEPER_DEFAULT_STATE_LEN` when the declaration says none). */
  stateLen: number;
  /** What `companion_init` gets, hex ('' for nothing). */
  initData: string;
  /** It pays holders through the companion's payout path (`payouts`): a launch makes its payout terms. */
  payouts: boolean;
  /** The launcher's share of the fee, fixed for every launch (`launcherShareBps`), basis points; null when the launcher chooses. Absent from older servers. */
  launcherShareBps?: number | null;
  /** The payout terms the launch makes the script with (`payoutTerms`); null: the script launches with open terms (`SCRIPT_PAYOUT_OPEN` in the site). Absent from older servers. */
  payoutTerms?: PayoutTermsRequest | null;
  /** It runs on coins quoted in tokens (`quoteTokens`, docs/token-quotes.md §7.4): the launch form offers it once tokens are picked. Absent from older servers (read as false). */
  quoteTokens?: boolean;
}

/** The state a site launch asks for when keeper.json says nothing: room for most scripts' state (rent about 0.008 SOL, the launcher's), harmless to one that keeps none. */
export const KEEPER_DEFAULT_STATE_LEN = 1_024;

/**
 * The terms with the launcher's share a pair's builder fixed on the Workshop's config page
 * (`workshop_items.launcher_share_bps`, 2026-10-15) when the declaration fixes none: keeper.json's
 * wins, being part of the approved source.
 */
export const withLauncherShare = (terms: KeeperLaunchTerms, share: number | null | undefined, fallback: number | null = null): KeeperLaunchTerms => (terms.launcherShareBps !== null && terms.launcherShareBps !== undefined ? terms : { ...terms, launcherShareBps: share ?? fallback });

/**
 * How a pair's config splits the fee until its builder sets the split (the owner, 2026-10-15: a
 * config built with a creator fee and a companion fee is never the launcher's to adjust): evenly,
 * half the fee the launcher's creator fee, half the pot's companion fee.
 */
export const PAIR_DEFAULT_LAUNCHER_SHARE_BPS = 5_000;

/** A declaration's launch terms; a script with none steps every `DEFAULT_STEP_SECS`, pays no wallet, gets `KEEPER_DEFAULT_STATE_LEN` bytes of state and no init data. */
export const keeperLaunchTerms = (d: KeeperDeclaration | null | undefined): KeeperLaunchTerms => ({ stepSecs: keeperStepSecs(d), wallets: (d?.wallets?.length ?? 0) > 0, stateLen: d?.stateLen ?? KEEPER_DEFAULT_STATE_LEN, initData: d?.initData ?? '', payouts: d?.payouts === true, launcherShareBps: d?.launcherShareBps ?? null, payoutTerms: d?.payoutTerms ?? null, ...(d?.quoteTokens ? { quoteTokens: true } : {}) });

/** Bytes of a text in UTF-8 (a lone surrogate counts as its replacement character, 3). */
export function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** A `keeper.json` as submitted: within its size, JSON, then the schema (`keeperDeclarationOf`). */
export function parseKeeperDeclaration(text: string): KeeperParse {
  const bytes = utf8Length(text);
  if (bytes > KEEPER_LIMITS.bytes) return { ok: false, problem: `${KEEPER_FILE} is at most ${group(KEEPER_LIMITS.bytes)} bytes; this one is ${group(bytes)}.` };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: `${KEEPER_FILE} is not JSON: check its quotes, commas and brackets (no comments, no trailing commas).` };
  }
  return keeperDeclarationOf(value);
}

/** The declaration in a canonical text (keys sorted, no spaces): what its hash is taken of, so the same declaration hashes the same however it was written. */
export function canonicalKeeperJson(d: KeeperDeclaration): string {
  const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  return JSON.stringify(sorted(d));
}

/** Whether a file of a submission is the declaration. */
export const isKeeperFile = (path: string): boolean => path === KEEPER_FILE;

// ---- in plain words -------------------------------------------------------------------------------------

/** A length of time as a word that goes before "epoch": 300 -> "5-minute", 3,600 -> "1-hour". */
function spanWord(secs: number): string {
  if (secs % 86_400 === 0) return `${secs / 86_400}-day`;
  if (secs % 3_600 === 0) return `${secs / 3_600}-hour`;
  if (secs % 60 === 0) return `${secs / 60}-minute`;
  return `${secs}-second`;
}

/** Base units as tokens: 20,000,000,000,000 -> "20M", 1,500,000,000 -> "1,500". */
function tokensWord(base: bigint, decimals: number): string {
  const one = 10n ** BigInt(decimals);
  for (const [unit, suffix] of [[1_000_000_000n, 'B'], [1_000_000n, 'M']] as const) {
    if (base >= unit * one && base % ((unit * one) / 10n) === 0n) return `${decimalWords(base / ((unit * one) / 10n), 1, 1)}${suffix}`;
  }
  return decimalWords(base, decimals, decimals);
}

/** "20M tokens", "1 token". */
const tokens = (base: bigint, decimals: number): string => {
  const w = tokensWord(base, decimals);
  return `${w} ${w === '1' ? 'token' : 'tokens'}`;
};

const COMPARE_WORDS: Record<KeeperCompare, string> = { eq: 'equal to', ne: 'not equal to', lt: 'below', lte: 'at or below', gt: 'above', gte: 'at or above' };

function balanceWords(h: KeeperHoldings, decimals: number): string {
  const low = typeof h.minBalance === 'string' ? (BigInt(h.minBalance) <= 1n ? null : `at least ${tokens(BigInt(h.minBalance), decimals)}`) : 'at least the balance its state sets';
  let high: string | null = null;
  if (typeof h.maxBalance === 'string') {
    const above = BigInt(h.maxBalance) + 1n;
    high = above % 10n ** BigInt(decimals) === 0n ? `under ${tokens(above, decimals)}` : `at most ${tokens(BigInt(h.maxBalance), decimals)}`;
  } else if (h.maxBalance) high = 'at most the balance its state sets';
  return low && high ? `with ${low} and ${high}` : low ? `with ${low}` : high ? `with ${high}` : '';
}

function filterWords(f: KeeperHookDataFilter | null, paid: boolean): string {
  if (!f) return '';
  const a = f.against;
  if (a === 'poolPrice') return `whose price in its hook data is ${COMPARE_WORDS[f.compare]} the pool’s price now`;
  if ('const' in a) return `whose hook data (bytes ${f.offset} to ${f.offset + f.width - 1}) is ${COMPARE_WORDS[f.compare]} ${group(BigInt(a.const))}`;
  const epoch = `this ${typeof a.epoch.secs === 'number' ? `${spanWord(a.epoch.secs)} ` : ''}epoch`;
  switch (f.compare) {
    case 'ne':
      return paid ? `not yet paid ${epoch}` : `not marked ${epoch}`;
    case 'eq':
      return `marked ${epoch}`;
    case 'lt':
      return `last marked before ${epoch}`;
    case 'lte':
      return `not marked after ${epoch}`;
    case 'gt':
      return `marked after ${epoch}`;
    case 'gte':
      return `marked ${epoch} or after`;
  }
}

/** An address cut short for words: "A7bd…QXaS". */
const shortKey = (key: string): string => `${key.slice(0, 4)}…${key.slice(-4)}`;
/** An SPL mint in words: "wrapped SOL" for `NATIVE_MINT`, else its address cut short. */
const splMintWord = (mint: string): string => (mint === NATIVE_MINT ? 'wrapped SOL' : shortKey(mint));

/** Where a holder is paid, in words after the holders: ", paid to their wallet". */
function payWords(h: KeeperHoldings): string {
  switch (h.payTo) {
    case 'owner':
      return ', paid to their wallet';
    case 'ownerQuoteHolding':
      return ', paid to their SOL holding';
    case 'ownerTokenAccount':
      return `, paid to their ${splMintWord(h.payMint ?? '')} token account`;
    case 'none':
      return '';
  }
}

/** How many holdings a step brings as declared: with the swap accounts when it carries them, else without; 0 without holdings (a script that pays wallets alone). */
export const keeperPerStep = (d: KeeperDeclaration): number => (d.holdings ? ((d.swapAccounts ? d.holdings.perStep.withSwapAccounts : d.holdings.perStep.withoutSwapAccounts) ?? 1) : 0);

/** The wallets a declaration brings, in words: "Each step brings up to 2 wallets the script may pay SOL to, while its launcher allows wallet payouts."; '' without. */
function walletWords(d: KeeperDeclaration): string {
  const n = d.wallets?.length ?? 0;
  return n === 0 ? '' : `Each step brings up to ${n} ${n === 1 ? 'wallet' : 'wallets'} the script may pay SOL to, while its launcher allows wallet payouts.`;
}

/**
 * The declaration in one plain sentence, for the item's page, the reading and the operator: "Each
 * step brings up to 3 holders with under 20M tokens not yet paid this 5-minute epoch, paid to their
 * SOL holding." An epoch whose length the script's state sets is "this epoch". The wallets a step
 * brings follow in a sentence of their own.
 */
export function keeperWords(d: KeeperDeclaration, decimals: number = TOKEN_DECIMALS): string {
  const n = keeperPerStep(d);
  const h = d.holdings;
  if (!h) return walletWords(d);
  const noun = h.payTo === 'none' ? (n === 1 ? 'holding' : 'holdings') : n === 1 ? 'holder' : 'holders';
  const parts = [`Each step brings up to ${n} ${noun}`, balanceWords(h, decimals), filterWords(h.hookData, h.payTo !== 'none')].filter((p) => p !== '');
  return [`${parts.join(' ')}${payWords(h)}.`, walletWords(d)].filter((p) => p !== '').join(' ');
}

/**
 * The rest of the declaration, a sentence each, for the review and the operator: what else each
 * step carries, and where a round's or an epoch's length comes from.
 */
const pctWord = (bps: number): string => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
/** A pool's mint in words: "the coin", "SOL", or "the mint APpT…ncwv". */
const poolMintWord = (m: KeeperPoolMint): string => (m === 'coin' ? 'the coin' : m === 'sol' ? 'SOL' : `the mint ${m.slice(0, 4)}…${m.slice(-4)}`);

export function keeperDetails(d: KeeperDeclaration): string[] {
  const out: string[] = [];
  const carries = [d.payouts ? 'the companion’s payout accounts' : null, d.swapAccounts ? 'the launch pool’s swap accounts' : d.hookAccounts ? 'the token’s hook accounts' : null].filter((x): x is string => x !== null);
  if (carries.length > 0) out.push(`Each step also carries ${carries.join(' and ')}.`);
  if (d.mintWritable) out.push('The coin’s mint is passed writable in every step (the script may burn the coin).');
  for (const p of d.pools ?? []) {
    if (isLaunchPool(p)) {
      out.push(`Each step also brings the launch pool of the coin ${p.launch.slice(0, 4)}…${p.launch.slice(-4)} (its launchpad swap accounts for the companion address)${p.to === 'launcher' ? ', with the launcher’s holding of that coin for the swap’s recipient' : ''}.`);
      continue;
    }
    if (isRaydiumPool(p)) {
      out.push(`Each step also brings the Raydium pool ${shortKey(p.raydiumClmm)} (a swap buying ${splMintWord(p.buy)} for the companion address, with its price-range accounts).`);
      continue;
    }
    out.push(`Each step also brings the DEX pool of ${poolMintWord(p.base)} and ${poolMintWord(p.quote)} at a ${pctWord(p.feeBps)} LP fee${p.liquidity ? ', with its LP mint and LP holdings (the script may add liquidity to it)' : ''}.`);
  }
  const other = d.holdings ? (d.swapAccounts ? d.holdings.perStep.withoutSwapAccounts : d.holdings.perStep.withSwapAccounts) : null;
  if (other !== null) out.push(`${d.swapAccounts ? 'Without' : 'With'} the swap accounts a step would bring up to ${other}.`);
  if (d.wallets) out.push(`The wallets (with the companion’s payout terms): ${d.wallets.map((w) => (typeof w === 'string' ? w : `the public key at byte ${w.state.offset} of the script’s state`)).join(', ')}.`);
  const f = d.holdings?.hookData ?? null;
  const field = (s: KeeperStateField): string => `the ${s.width * 8}-bit number at byte ${s.offset} of the script’s state`;
  if (f && typeof f.against === 'object' && 'epoch' in f.against) {
    const e = f.against.epoch;
    out.push(`An epoch is ${typeof e.secs === 'number' ? `${e.secs} seconds` : `${field(e.secs.state)} in seconds`}${e.fieldUnitSecs ? `; the hook data counts units of ${e.fieldUnitSecs} seconds` : ''}.`);
  }
  if (d.stepSecs !== undefined) out.push(`A step runs every ${d.stepSecs} seconds.`);
  if (d.payoutTerms) out.push(`Its payout terms: a step pays at most ${pctWord(d.payoutTerms.stepBps)} of the pot, one holding or wallet at most ${pctWord(d.payoutTerms.holdingBps)} of a step, and a window of ${group(d.payoutTerms.windowSecs)} seconds at most ${pctWord(d.payoutTerms.windowBps)} of the pot.`);
  if (d.launcherShareBps !== undefined) out.push(`Every launch keeps ${(d.launcherShareBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}% of each trade’s fee for the launcher, fixed; the pot gets the rest.`);
  if (d.quoteTokens) out.push(`It runs on coins quoted in tokens: each step there brings ${d.legs === true ? 'every leg' : `legs ${(d.legs ?? []).map((i) => i + 1).join(', ')}`} (the leg’s swap accounts for the companion address, the coin’s Legs and the companion address’s token account of the leg’s token) in place of the launch pool’s swap accounts.`);
  if (d.roundSecs !== null) out.push(`A round of the keeper’s (what it says once a round: a wait, nobody to bring) is ${typeof d.roundSecs === 'number' ? `${d.roundSecs} seconds` : `${field(d.roundSecs.state)} in seconds`}.`);
  return out;
}

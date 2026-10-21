/**
 * Quote tokens (docs/token-quotes.md; the owner, 19 Oct 2026): a coin may launch against one to six
 * real SPL Token or Token-2022 mints instead of native SOL, each its own pool (a "leg") holding an
 * equal share of the supply, coins only at the start, priced from the same opening market cap as a
 * SOL launch, never graduating. Native SOL stays the default and the common case; a coin is quoted
 * in SOL or in its tokens, never both (the owner: "the SOL pair defeats the whole purpose").
 *
 * What this module holds: the limits, the leg math the API and the SDK share, the Token-2022
 * extension policy the DEX applies when a leg opens (mirrored here so the site can say why a pasted
 * mint is refused before anything is signed), and the types the API answers with.
 */
import { OPENING_MCAP_USD, TOKEN_DECIMALS, TOKEN_SUPPLY } from './policy.ts';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './programs.ts';

/** The most quote tokens one coin launches against. */
export const MAX_QUOTE_TOKENS = 6;

/** The least virtual quote a leg opens with, raw units of its token: below it the opening price can't be told apart from zero. */
export const MIN_LEG_VIRTUAL_QUOTE = 1_000n;

/**
 * "Claim as SOL" (`POST /v1/creator/legs/prepare` with `as: 'sol'`, docs/token-quotes.md §7.3): each leg's creator fee claimed and
 * swapped to SOL through Jupiter in the same transaction. The slippage the creator may set, in basis points: 1% unless they say
 * otherwise, at most 10%.
 */
export const CLAIM_SOL_DEFAULT_SLIPPAGE_BPS = 100;
export const CLAIM_SOL_MAX_SLIPPAGE_BPS = 1_000;

/** A quote token's program, as the API and the SDK name it. */
export type QuoteTokenProgram = 'spl-token' | 'token-2022';

export const QUOTE_TOKEN_PROGRAM_IDS: Record<QuoteTokenProgram, string> = { 'spl-token': TOKEN_PROGRAM_ID, 'token-2022': TOKEN_2022_PROGRAM_ID };

/** The program of a mint by its owner's address; null for an account no token program owns. */
export const quoteTokenProgramOf = (owner: string): QuoteTokenProgram | null => (owner === TOKEN_PROGRAM_ID ? 'spl-token' : owner === TOKEN_2022_PROGRAM_ID ? 'token-2022' : null);

/**
 * Each leg's share of the supply, base units: the supply split evenly, the last leg taking what the
 * division leaves (so the shares always add up to the supply).
 */
export function legShares(count: number, supply: bigint = TOKEN_SUPPLY): bigint[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_QUOTE_TOKENS) throw new RangeError(`a coin launches against 1 to ${MAX_QUOTE_TOKENS} quote tokens`);
  const even = supply / BigInt(count);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? supply - even * BigInt(count - 1) : even));
}

/**
 * The virtual quote a leg opens with, raw units of its token, so the coin opens at `mcapUsd` (fully
 * diluted) in that token at `quoteUsd` a whole token. A leg holds `share` coins and no quote, with no
 * virtual base, so its opening price is `virtualQuote / share` and its price only rises as coins are
 * bought (a single-sided range from the opening price up, as a Meteora DAMM v2 position from that
 * price to the maximum): `virtualQuote = share / supply × mcapUsd / quoteUsd × 10^decimals`.
 *
 * `uiMultiplier` is a Token-2022 `ScaledUiAmount` mint's multiplier (1 for any other mint): its whole
 * tokens, as wallets and Jupiter count them, are `raw × multiplier / 10^decimals`, so a raw unit is
 * worth `quoteUsd × multiplier / 10^decimals` and the virtual quote is divided by the multiplier.
 */
export function legVirtualQuote(share: bigint, quoteUsd: number, quoteDecimals: number, mcapUsd: number = OPENING_MCAP_USD, supply: bigint = TOKEN_SUPPLY, uiMultiplier = 1): bigint {
  if (!(quoteUsd > 0) || !Number.isFinite(quoteUsd)) throw new RangeError('the quote token has no price');
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 18) throw new RangeError('a quote token has 0 to 18 decimals');
  if (!(uiMultiplier > 0) || !Number.isFinite(uiMultiplier)) throw new RangeError('a UI multiplier is positive');
  // The whole cap in the token's raw units, then this leg's part of it.
  const capRaw = BigInt(Math.round((mcapUsd / (quoteUsd * uiMultiplier)) * 10 ** quoteDecimals));
  return (capRaw * share) / supply;
}

/** A leg's price now, raw quote units per raw coin unit, as a number: (quote reserve + virtual quote) / coin reserve. */
export const legPrice = (quoteReserve: bigint, virtualQuote: bigint, baseReserve: bigint): number => (baseReserve > 0n ? Number(quoteReserve + virtualQuote) / Number(baseReserve) : 0);

/** A leg's price now in whole quote tokens per whole coin (whole as wallets count them: times a `ScaledUiAmount` mint's `uiMultiplier`, 1 for any other). */
export const legPriceWhole = (rawPrice: number, quoteDecimals: number, baseDecimals: number = TOKEN_DECIMALS, uiMultiplier = 1): number => rawPrice * 10 ** (baseDecimals - quoteDecimals) * uiMultiplier;

/**
 * Token-2022 mint extensions (spl-token-2022 `ExtensionType`, by number) and what a leg does with
 * each. The DEX refuses a quote mint carrying a refused one, or any number not listed; the API says so
 * before a launch is built. `risk` names what the site labels the token with.
 */
export const TOKEN_2022_MINT_EXTENSIONS: Record<number, { name: string; policy: 'allow' | 'refuse' | 'check'; risk?: QuoteTokenRisk }> = {
  1: { name: 'TransferFeeConfig', policy: 'refuse' },
  3: { name: 'MintCloseAuthority', policy: 'allow', risk: 'closeAuthority' },
  4: { name: 'ConfidentialTransferMint', policy: 'allow' },
  6: { name: 'DefaultAccountState', policy: 'check' },
  9: { name: 'NonTransferable', policy: 'refuse' },
  10: { name: 'InterestBearingConfig', policy: 'allow', risk: 'scaledAmount' },
  12: { name: 'PermanentDelegate', policy: 'allow', risk: 'permanentDelegate' },
  14: { name: 'TransferHook', policy: 'check', risk: 'hookAuthority' },
  16: { name: 'ConfidentialTransferFeeConfig', policy: 'refuse' },
  18: { name: 'MetadataPointer', policy: 'allow' },
  19: { name: 'TokenMetadata', policy: 'allow' },
  20: { name: 'GroupPointer', policy: 'allow' },
  21: { name: 'TokenGroup', policy: 'allow' },
  22: { name: 'GroupMemberPointer', policy: 'allow' },
  23: { name: 'TokenGroupMember', policy: 'allow' },
  24: { name: 'ConfidentialMintBurn', policy: 'refuse' },
  25: { name: 'ScaledUiAmount', policy: 'allow', risk: 'scaledAmount' },
  26: { name: 'Pausable', policy: 'check', risk: 'pausable' },
};

/**
 * What the site labels a quote token with (never a reason to refuse it): its issuer can freeze an
 * account (`freeze`), move tokens out of any account (`permanentDelegate`), pause every transfer
 * (`pausable`), add a transfer hook later (`hookAuthority`), close the mint (`closeAuthority`), or
 * scale how balances read (`scaledAmount`), or mint more of it (`mintAuthority`: a mint authority is
 * set); not on Jupiter's verified list (`unverified`); under $50,000 of liquidity on Jupiter
 * (`thinLiquidity`).
 */
export type QuoteTokenRisk = 'freeze' | 'mintAuthority' | 'permanentDelegate' | 'pausable' | 'hookAuthority' | 'closeAuthority' | 'scaledAmount' | 'unverified' | 'thinLiquidity';

/**
 * Why a mint can't be a quote token: not an SPL Token or Token-2022 mint; SOL or wrapped SOL (a coin
 * quoted in SOL launches as a SOL launch); a transfer fee; a transfer hook with a program set; not
 * transferable; new accounts frozen by default; confidential-only; an extension the DEX doesn't know;
 * paused now; a Bordrless token (a coin is never quoted in another Bordrless coin here: that is a DEX
 * pool); no USD price to open the leg at; the same token twice; and, beside another quote, a token
 * not on Jupiter's verified list with $50,000 of liquidity (`unverified_multi`: on a coin with several
 * legs, whoever can make one leg's token for nothing buys the coin cheaply there and sells it on the
 * other legs for their real tokens).
 */
export type QuoteTokenRefusal = 'not_a_mint' | 'sol' | 'staked_sol' | 'transfer_fee' | 'transfer_hook' | 'non_transferable' | 'frozen_by_default' | 'confidential' | 'unknown_extension' | 'paused' | 'bordrless_token' | 'no_price' | 'duplicate' | 'unverified_multi';

export const QUOTE_TOKEN_REFUSAL_WORDS: Record<QuoteTokenRefusal, string> = {
  not_a_mint: 'That address isn’t a token mint.',
  sol: 'SOL is the default quote. Pick it on its own.',
  staked_sol: 'Staked SOL counts as SOL here. Launch with SOL instead.',
  transfer_fee: 'This token charges a fee on every transfer, so a pool can’t hold it.',
  transfer_hook: 'This token runs a transfer hook, so a pool can’t move it.',
  non_transferable: 'This token can’t be transferred.',
  frozen_by_default: 'New accounts of this token start frozen.',
  confidential: 'This token moves only confidentially.',
  unknown_extension: 'This token has an extension pools don’t support yet.',
  paused: 'This token’s transfers are paused.',
  bordrless_token: 'Bordrless tokens pair in DEX pools, not as a launch’s quote.',
  no_price: 'This token has no price to open at yet.',
  duplicate: 'That token is already picked.',
  unverified_multi: 'A coin with more than one quote token takes only verified tokens with $50,000 of liquidity.',
};

/**
 * Why a coin quoted in tokens is kept off the board by default (`LaunchSummary.legsRisk`): it has two
 * or more legs and one of their tokens isn't on Jupiter's verified list (`unverifiedQuote`), so whoever
 * can make that token for nothing can drain the other legs. The API refuses such a launch; one made
 * straight on chain is indexed and labelled.
 */
export type LegsRisk = 'unverifiedQuote';

export const LEGS_RISK_WORDS: Record<LegsRisk, string> = {
  unverifiedQuote: 'One of this coin’s quote tokens isn’t verified: whoever can make that token can buy the coin cheaply on its leg and sell it on the others.',
};

/** A token a coin can be quoted in, as the API describes it to the launch form. */
export interface QuoteTokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  program: QuoteTokenProgram;
  logo: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** On Jupiter's verified list. */
  verified: boolean;
  risks: QuoteTokenRisk[];
  /**
   * A Token-2022 `ScaledUiAmount` mint's multiplier now (xStocks carry one): `raw` units read
   * `raw × uiMultiplier / 10^decimals` whole tokens, the unit `priceUsd` is per. Absent (1) for every
   * other mint, and from older servers.
   */
  uiMultiplier?: number;
}

/** `GET /v1/quote-tokens?q=`: the curated list (Jupiter's verified tokens with $50k of liquidity or more, SOL left out), or a search of it; a pasted mint is read with `quote-tokens/:mint`. */
export interface QuoteTokenList {
  tokens: QuoteTokenInfo[];
}

/** `GET /v1/quote-tokens/:mint`: a pasted mint read from the chain and Jupiter, or why it can't be a quote. */
export type QuoteTokenCheck = { ok: true; token: QuoteTokenInfo } | { ok: false; mint: string; reason: QuoteTokenRefusal; words: string };

/** One leg of a coin quoted in tokens, as the board and the token page get it. */
export interface LaunchLeg {
  index: number;
  pool: string;
  /** The leg's token; `uiMultiplier` as in `QuoteTokenInfo` (absent: 1). */
  quote: { mint: string; symbol: string; decimals: number; logo: string | null; program: QuoteTokenProgram; uiMultiplier?: number };
  /** Whole quote tokens per whole coin now (whole as wallets count them: the UI multiplier applied). */
  priceQuote: number;
  priceUsd: number | null;
  /** Quote tokens the leg holds, raw units. */
  liquidityQuote: string;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  /** Creator fees this leg has paid into its fee account and not yet claimed, raw quote units. */
  creatorFeesClaimable: string;
}

/** Token-2022's wrapped SOL (`spl_token_2022::native_mint`), which the launchpad refuses as a quote as it does SPL Token's (`SolQuoteToken`). */
export const NATIVE_MINT_2022 = '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP';

/** Whether a mint names SOL in either form (SPL Token's wrapped SOL or Token-2022's): SOL launches stay SOL launches. */
export const isSolMint = (mint: string): boolean => mint === NATIVE_MINT || mint === NATIVE_MINT_2022;

// ---- §7.5: holder rewards in the quote token and the SOL switch (docs/token-quotes.md §7.5.5) --------------------------

/**
 * A token launch's payouts (`LaunchPrepareRequest.payouts`, behind the API's `QUOTE_PAYOUTS_OPEN`): `sol` the DIY config's "Pay in SOL"
 * switch (off by default: every paid part, the launcher's, a companion's holders' part and the holder rewards, is in each leg's token;
 * on, they are sold to SOL on each token's reference pool), and a coin of two legs or more with holder rewards pays them in rounds of
 * `holderRoundSecs` (600 to 86,400; an hour when absent). Buyback and Snowball keep their pots in the tokens either way.
 */
export interface TokenPayoutsRequest {
  sol?: boolean;
  holderRoundSecs?: number;
}

/** How a coin quoted in tokens pays its holder rewards: in its one leg's token (claimed any time), in every leg's token by rounds (pushed each round), or in SOL (the switch). */
export type TokenRewardKind = 'token' | 'rounds' | 'sol';

/**
 * `GET /v1/quote-tokens/:mint/sol-switch`: whether a token can take the SOL switch. Its reference pool (Raydium AMM v4, CPMM, CLMM or
 * Pump AMM, against SOL or USDC, at least 100 SOL deep on its SOL side) registered on chain, or the deepest qualifying pool the launch's
 * setup registers; when none qualifies the form greys the switch with `reason` (the launch answers `sol_switch_unavailable`).
 */
export interface QuoteTokenSolSwitch {
  mint: string;
  available: boolean;
  reason: string | null;
  reference: { venue: string; pool: string; via: 'sol' | 'usdc'; depthLamports: string; feePpm: number; registered: boolean; paused: boolean } | null;
}

/** One leg's holder rewards on a coin quoted in tokens (`TokenRewardsSummary.legs`), raw units of its token. */
export interface TokenRewardsLeg {
  index: number;
  quoteMint: string;
  decimals: number;
  /** Holder fees the leg's trades paid into the kit's vault, all time. */
  accrued: string;
  /** Paid to holders from it: claimed (one leg) or paid by rounds; with the switch, sold to SOL. */
  paid: string;
}

/** A coin quoted in tokens' holder rewards as the board and the token page get them (`LaunchSummary.tokenRewards`). */
export interface TokenRewardsSummary {
  kind: TokenRewardKind;
  /** A rounds coin's round length; null otherwise. */
  roundSecs: number | null;
  legs: TokenRewardsLeg[];
  /** With the switch: lamports the legs' holder fees were sold for and shared; null otherwise. */
  swappedLamports: string | null;
  /** A rounds coin's current round (`⌊now / roundSecs⌋`) and when the next one starts; null otherwise. */
  round: number | null;
  nextRoundAt: number | null;
}

/** A wallet's holder rewards on a coin quoted in tokens (`RewardPosition.token`): what a claim pays now per leg, or a round's estimate. */
export interface TokenRewardPosition {
  kind: TokenRewardKind;
  legs: { index: number; quoteMint: string; symbol: string; decimals: number; claimable: string }[];
  /** Rounds: whether this round's pay is waiting for the holding (the keeper pushes it, or a claim sends `pay_round`). */
  roundPending: boolean | null;
}

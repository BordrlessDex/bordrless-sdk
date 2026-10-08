/**
 * The HTTP API between the site and the backend. Amounts in base units travel as decimal strings
 * (`Amount`), dollar figures as numbers, times as unix seconds. A figure the backend could not
 * read is null, never zero.
 */

export type Address = string;
/** Base units, as a decimal string. */
export type Amount = string;
export type Cluster = 'mainnet' | 'devnet' | 'localnet';
export type LaunchStatus = 'curve' | 'graduated';
export type Side = 'buy' | 'sell';

export interface QuoteToken {
  mint: Address;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number | null;
  /** The SPL mint behind it (the wSOL mint for native SOL). */
  underlyingMint: Address;
  native: boolean;
}

export interface Overview {
  cluster: Cluster;
  /** What launches are quoted in: bridged SOL. */
  quote: QuoteToken;
  solUsd: number | null;
  launches: number;
  graduated: number;
  volume24hUsd: number | null;
  trades24h: number;
  /** The platform's own token, once configured. */
  platformToken: BridgeAsset | null;
  /** Program addresses; `kit` is the v2 token-rules hook. */
  programs: { token: Address; swap: Address; bridge: Address; launch: Address; kit: Address };
  /** Each program's upgrade authority, read from its ProgramData account; null where it has not been read. */
  programInfo: Record<'token' | 'swap' | 'bridge' | 'launch' | 'kit', ProgramInfo | null>;
  /** Platform totals in lamports of bridged SOL; each null while the indexer does not track it. */
  totals: {
    /** Distributed to holders as holder rewards, all time. */
    rewardsDistributed: Amount | null;
    /** Over launch-pool swaps, the LP fee charged minus what the pool's base rate would have charged (a sell's, in tokens, at that swap's price). */
    sniperFeesKept: Amount | null;
    /** Over trade burns, the amount burned times that swap's pool price. */
    burnedValue: Amount | null;
    /** Creator fees taken, all time. */
    creatorFees: Amount | null;
  };
  launchFeeLamports: Amount;
  openingMcapUsd: number;
  explorer: string;
}

/** A launch's token rules, fixed at launch (docs/hooks-v2.md §5). Zeros and nulls for a launch without them. */
export interface LaunchRules {
  /** Holder rewards taken from buys; holder rewards are on when either side is above 0. */
  holderFeeBuyBps: number;
  /** Holder rewards taken from sells. */
  holderFeeSellBps: number;
  /** Share of a buy's tokens burned. */
  burnBuyBps: number;
  /** Share of a sell's tokens burned. */
  burnSellBps: number;
  /** Max wallet as a share of supply; 0 = off; lifts at graduation. */
  maxWalletBps: number;
  /** Creator wallet lock: when the creator's wallet can sell or send again, unix seconds; null when off. */
  creatorUnlockAt: number | null;
  /** Early-buyer lock: tokens bought before this time are locked, unix seconds; null when off. */
  earlyWindowEndsAt: number | null;
  /** Early-buyer lock: when those tokens unlock, unix seconds; null when off. */
  earlyUnlockAt: number | null;
  /** Holder rewards are on: no program can hold the token, so every pool trade happens on its launch pool. */
  walletsOnly: boolean;
}

/** The token rules a launch request chooses (docs/hooks-v2.md §7.1); all zero for none. */
export interface LaunchRulesInput {
  /** Holder rewards on buys. */
  holderFeeBuyBps: number;
  /** Holder rewards on sells. */
  holderFeeSellBps: number;
  /** Burn on buys. */
  burnBuyBps: number;
  /** Burn on sells. */
  burnSellBps: number;
  /** Max wallet as a share of supply; 0 = off. */
  maxWalletBps: number;
  /** Creator wallet lock in days; 0 = off. */
  creatorLockDays: number;
  /** Early-buyer lock: buys in this many seconds after launch are locked; 0 = off. */
  earlyWindowSecs: number;
  /** Early-buyer lock: seconds after launch when those tokens unlock (above `earlyWindowSecs`). */
  earlyLockSecs: number;
}

/**
 * A creator's own token hook on a launch (docs/hooks-v2.md §5.8): the program the mint names, its
 * token hook flags, and who can upgrade that program (null when it cannot be upgraded, or when it
 * has not been read). The site labels such a token "Custom hook, unverified" on every surface.
 */
export interface CustomHookInfo {
  program: Address;
  flags: number;
  /** The wallet that can change the hook's code; null when there is none, or when it has not been read (`upgradeable` tells which). */
  upgradeAuthority: Address | null;
  /** True: `upgradeAuthority` can upgrade it. False: nobody can (final). Null: not read, so nothing is claimed either way. */
  upgradeable: boolean | null;
}

/** How a pool's protocol fee is taken (§3.1): a flat rate of the quote (`protocolFeeBps`, ordinary pools), or a share of what the hooks cut (`protocolShareBps`, launch pools). */
export type ProtocolModel = 'flat' | 'share';

/**
 * What a `LaunchConfig` holds (§5.7): the rules and the creator fee a launch made from it gets, the
 * creator's own hook with its token flags (null for the kit, or no hook at all), and a label of at
 * most 32 bytes.
 */
export interface LaunchConfigData {
  rules: LaunchRulesInput;
  creatorFeeBps: number;
  customHook: { program: Address; flags: number } | null;
  label: string;
}

/**
 * `GET /v1/configs/:address?mint=<mint>`: a `LaunchConfig` read from the chain and checked as
 * `create_launch` would check it. `ready` is true when `problems` is empty and, with a custom hook
 * and a mint given, the hook's registry for that mint exists. `hookUpgradeAuthority` is the custom
 * hook program's upgrade authority (null when it cannot be upgraded, or without a hook);
 * `registryReady` is whether the hook has been prepared for `mint` (null without a hook or a mint).
 */
export interface ConfigInspection {
  address: Address;
  config: LaunchConfigData;
  /** The wallet that made the config. */
  creator: Address;
  ready: boolean;
  /** Why it could not launch as it is, one sentence each; empty when it could. */
  problems: string[];
  hookUpgradeAuthority: Address | null;
  /** As `CustomHookInfo.upgradeable`; null without a hook or when its program could not be read. */
  hookUpgradeable: boolean | null;
  registryReady: boolean | null;
  /** The hook is Half-Life: the launch prepares it for the mint and lights its furnace itself. */
  halfLife?: boolean;
  /** A listed config's author share of the creator fee (bps of it), paid on a launch by anyone but its author; 0 for a plain config. */
  authorShareBps: number;
  /** The hook was built and deployed by Studio: the launch prepares it for the mint itself (its standard `prepare`). */
  studioHook?: boolean;
}

/** Live figures of a launch's token rules; each null when the launch lacks the rule or it is not tracked. */
export interface RuleStats {
  /** Lamports distributed to holders as holder rewards, all time. */
  rewardsDistributed: Amount | null;
  /** Lamports holders have claimed, all time. */
  rewardsClaimed: Amount | null;
  /** Lamports sent to holders through "Share with holders", all time. */
  rewardsShared: Amount | null;
  /** Shared lamports not released to holders yet (a share streams over an hour). */
  rewardsStreaming: Amount | null;
  /** The reward vault's balance: earned and not claimed yet. */
  rewardsUnclaimed: Amount | null;
  /** Lamports of the last 24 hours: holder fees paid into the holder vault plus shares. */
  rewardsPaid24h: Amount | null;
  /** Token base units that earn holder rewards (the kit's eligible supply). */
  eligibleSupply: Amount | null;
  /** Base units burned on trades (not the graduation burn). */
  burned: Amount | null;
  /** The token's supply now, after every burn. */
  liveSupply: Amount | null;
  /** What the creator's wallet holds now. */
  creatorBalance: Amount | null;
  /** The max-wallet cap in base units, fixed at launch; null without max wallet. */
  maxWalletAmount: Amount | null;
  /** Max wallet has lifted (at graduation). */
  maxWalletLifted: boolean;
  /**
   * When a share made now would start streaming, unix seconds: now when nothing streams, otherwise
   * when the share streaming now ends ("If an earlier share is still streaming, yours starts when it
   * ends"). Null while nobody is eligible (a share is refused then), without holder rewards, or when
   * not read. Computed by `shareStartsAt` from the `KitConfig`; absent from backends that predate it.
   */
  shareStartsAt?: number | null;
}

/** A program's address and who can upgrade it. */
export interface ProgramInfo {
  address: Address;
  /** The upgrade authority; null when there is none or it could not be read. */
  upgradeAuthority: Address | null;
  /** Whether the program can still be upgraded; null when unknown. */
  upgradeable: boolean | null;
}

export interface LaunchSummary {
  mint: Address;
  name: string;
  symbol: string;
  image: string | null;
  description: string;
  creator: Address;
  pool: Address;
  status: LaunchStatus;
  createdAt: number;
  graduatedAt: number | null;
  quote: { mint: Address; symbol: string; decimals: number };
  /** Whole quote per whole token. */
  priceQuote: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  mcapQuote: number | null;
  /** 0 to 1 along the curve; 1 once graduated. */
  progress: number;
  liquidityQuote: Amount;
  liquidityUsd: number | null;
  volume24hQuote: Amount;
  volume24hUsd: number | null;
  trades24h: number;
  priceChange24h: number | null;
  holders: number;
  lastTradeAt: number | null;
  creatorFeeBps: number;
  lpFeeBps: number;
  protocolFeeBps: number;
  sniperWindowEndsAt: number;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  /** Token rules, fixed at launch. */
  rules: LaunchRules;
  /** The kit's config account (`["kit", mint]`) when the launch has kit rules, else null. */
  kitConfig: Address | null;
  /** The §7.1 preset whose rules and creator fee the launch matches exactly, 'custom' for other rules (or a config without a custom hook), 'custom-hook' for a config with one, null without rules. */
  preset: string | null;
  /** The `LaunchConfig` the launch was made from (§5.7); null for inline rules. */
  config: Address | null;
  /** The creator's own token hook (§5.8); null when the mint's hook is the kit or none. */
  customHook: CustomHookInfo | null;
  /** How Bordrless is paid on this launch's pool: 'share' (a share of what the rules collect, `protocolShareBps`) or 'flat' (`protocolFeeBps` of the quote). */
  protocolModel: ProtocolModel;
  /** Under the share model, Bordrless's share of the cuts in basis points (2,500 = a quarter); null under the flat model. */
  protocolShareBps: number | null;
  /** The pool's LP fee (the sniper fee included) goes to Bordrless in SOL: a launch pool created at or after the DEX upgrade of 2026-10-08 (`LP_FEE_TO_PROTOCOL_FROM_SLOT`). False on one created before it, whose LP fee stays in the pool. */
  lpFeeToProtocol: boolean;
  /** Total fee of a buy by the §7.3 formula, outside the sniper window. */
  buyFeeBps: number;
  /** Total fee of a sell by the §7.3 formula, outside the sniper window. */
  sellFeeBps: number;
  /** Lamports distributed to holders as holder rewards, all time; null without holder rewards or while not tracked. */
  rewardsDistributed: Amount | null;
  /** Lamports of the last 24 hours: holder fees paid into the holder vault plus shares; null likewise. */
  rewardsPaid24h: Amount | null;
  /** Base units burned on trades (not the graduation burn); null while not tracked. */
  burned: Amount | null;
  /** The creator wallet's share of the live supply, 0 to 1; null when unknown. */
  creatorShare: number | null;
}

export interface LaunchDetail extends LaunchSummary {
  decimals: number;
  supply: Amount;
  uri: string;
  baseReserve: Amount;
  quoteReserve: Amount;
  virtualBase: Amount;
  virtualQuote: Amount;
  graduationQuote: Amount;
  creatorFeesAccrued: Amount;
  creatorFeesClaimed: Amount;
  lpMint: Address;
  lpLocked: Amount;
  lpSupply: Amount;
  graduationTopup: Amount | null;
  graduationBurned: Amount | null;
  /** The launchpad: the hook of the launch's pool, the launch program for every launch. Not the mint's token hook (the kit on a launch with kit rules: `Overview.programs.kit`). */
  hookProgram: Address;
  /** Live figures of the token rules. */
  ruleStats: RuleStats;
  /** The bridged-SOL holding holder rewards are paid from; null without holder rewards. */
  holderVault: Address | null;
}

/** `GET /v1/launches?sort=`: newest first by default; `rewards24h` most paid to holders in 24 h first; `fees` lowest buy-then-sell fee first. */
export type LaunchSort = 'new' | 'mcap' | 'volume' | 'trending' | 'graduated' | 'rewards24h' | 'fees';
/** `GET /v1/launches?rules=a,b`: only launches that have every rule listed (`custom_hook`: launched with a creator's own hook). */
export type RuleFilter = 'rewards' | 'burn' | 'max_wallet' | 'creator_lock' | 'early_lock' | 'custom_hook';

export interface LaunchList {
  launches: LaunchSummary[];
  total: number;
}

export interface Trade {
  signature: string;
  slot: number;
  ts: number;
  trader: Address;
  side: Side;
  baseAmount: Amount;
  quoteAmount: Amount;
  /** Whole quote per whole token, as executed. */
  priceQuote: number;
  priceUsd: number | null;
  lpFeeBps: number;
  /** The owner of the holding the output was delivered to. */
  recipient: Address;
  /** Lamports of bridged SOL paid to the creator. */
  creatorFee: Amount;
  /** Lamports of bridged SOL paid to holders as holder rewards. */
  holderFee: Amount;
  /** Token base units burned. */
  burn: Amount;
}

/** `GET /v1/launches/:mint/candles?unit=usd|quote`: oldest first. In dollars, a candle no SOL price can tell (none when it traded, none now) is left out, never sent as 0. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume in the chart's unit (whole quote, or dollars). */
  v: number;
}

export interface Holder {
  owner: Address;
  amount: Amount;
  share: number;
  label: 'pool' | 'launch' | 'creator' | null;
  /** This owner earns holder rewards: false for the pool and the launch, and for every owner of a launch without them. */
  earnsRewards: boolean;
}

export interface WalletBalances {
  lamports: Amount;
  bridgedSol: Amount;
  token: Amount | null;
  lp: Amount | null;
}

export interface PortfolioEntry {
  mint: Address;
  symbol: string;
  name: string;
  image: string | null;
  decimals: number;
  amount: Amount;
  priceUsd: number | null;
  valueUsd: number | null;
  kind: 'launch' | 'bridged' | 'lp' | 'other';
  launchStatus: LaunchStatus | null;
  /** For a bridged asset: what it unwraps to. For an LP: its pool. */
  link: Address | null;
  /** Holder rewards the wallet can claim for this token, lamports; null when not known or not applicable. */
  claimableRewards: Amount | null;
  /** Tokens the wallet cannot sell or send yet, until when and why; null when none are locked. */
  locked: { amount: Amount; until: number; reason: 'creator_lock' | 'early_lock' } | null;
  /** For a launch token with a creator's own hook (§5.8): the hook, so the row can say so; null otherwise (absent from backends that predate it). */
  customHook?: CustomHookInfo | null;
}

/** A launch the wallet created, with the creator fee waiting for it (`Portfolio.created`). */
export interface CreatedLaunch {
  mint: Address;
  symbol: string;
  name: string;
  image: string | null;
  status: LaunchStatus;
  creatorFeeBps: number;
  /** Lamports of bridged SOL accrued and not yet claimed (the launch's quote holding, what a claim pays); null when the chain could not be read. */
  claimable: Amount | null;
  /** Lamports claimed here, all time; null when not known. */
  claimedTotal?: Amount | null;
}

export interface Portfolio {
  owner: Address;
  lamports: Amount;
  /** What the wallet holds, plus launches it no longer holds when it has holder rewards to claim there. */
  entries: PortfolioEntry[];
  totalUsd: number | null;
  /** The launches this wallet created, those with fees to claim first (absent from backends that predate it). */
  created: CreatedLaunch[];
}

/** Native SOL (bridged on the way in, unbridged on the way out) or bridged SOL already held. */
export type SolMode = 'SOL' | 'BSOL';

export interface SwapQuoteRequest {
  mint: Address;
  side: Side;
  /** Input amount in base units: quote (bridged SOL) for a buy, the token for a sell. */
  amount: Amount;
  slippageBps: number;
}

export interface SwapQuote {
  side: Side;
  amountIn: Amount;
  /** What reaches the wallet: after a buy's burn, or after a sell's creator and holder fees. */
  amountOut: Amount;
  minAmountOut: Amount;
  lpFeeBps: number;
  lpFee: Amount;
  protocolFee: Amount;
  creatorFee: Amount;
  /** Bridged SOL paid to holders as holder rewards. */
  holderFee: Amount;
  /** Token base units burned. */
  burn: Amount;
  /** Total fee of this side by the §7.3 formula at this moment, the sniper fee included while elevated. */
  totalFeeBps: number;
  /** Whole quote per whole token, all fees and the burn included. */
  effectivePrice: number;
  /** Tokens the recipient can still receive under max wallet; null when no cap applies. */
  maxWalletLeft: Amount | null;
  /** The input that fills that allowance; null when no cap applies. */
  maxInForWallet: Amount | null;
  /** Why this trade cannot be made now, and until when (unix seconds); null when it can. */
  blocked: { reason: 'max_wallet' | 'creator_lock' | 'early_lock'; until: number | null } | null;
  /** A buy in the early-buyer window: when its tokens unlock (unix seconds); null otherwise. */
  lockedUntil: number | null;
  /** Whole quote per whole token, as this trade would execute. */
  priceQuote: number;
  /** How far the curve moves the price for this trade, fees excluded (they are their own lines). */
  priceImpactBps: number;
  /** This buy crosses the graduation threshold; the backend appends the graduation to it. */
  graduates: boolean;
  /** The most that can be bought before the curve is empty, or null off the curve. */
  maxAmountIn: Amount | null;
  elevatedFee: boolean;
  quoteUsd: number | null;
  tradeUsd: number | null;
  /**
   * On a token with a creator's own hook (§5.8): what the hook took from this trade, measured by a
   * dry run when the trade was prepared (base units of what you receive; `amountOut` and
   * `minAmountOut` then follow what actually arrives). Null when not measured (a quote alone, or
   * the dry run could not be made). Absent on every other token.
   */
  hookCut?: Amount | null;
}

export interface SwapPrepareRequest extends SwapQuoteRequest {
  owner: Address;
  solMode: SolMode;
}

export interface PreparedTx {
  /** Base64 of the unsigned transaction. */
  transaction: string;
  version: 'legacy' | 'v0';
  stage: number;
  label: string;
  /** Keys the browser holds that must also sign (a launch's fresh mint). */
  /** Keys the browser holds that sign after the wallet: a launch's fresh mint, a new launch config. */
  extraSigners: ('mint' | 'config')[];
}

export interface SwapPrepareResponse {
  transactions: PreparedTx[];
  quote: SwapQuote;
}

export interface SubmitRequest {
  transactions: { transaction: string; stage: number; label: string }[];
  mint?: Address;
  intentId?: string;
}

export type TxState = 'waiting' | 'pending' | 'confirmed' | 'failed' | 'expired';

export interface TxStatus {
  signature: string;
  label: string;
  stage: number;
  state: TxState;
  error: string | null;
}

export interface Submission {
  id: string;
  state: 'pending' | 'confirmed' | 'failed' | 'expired';
  transactions: TxStatus[];
  mint: Address | null;
  error: string | null;
}

export interface UploadResponse {
  uploadId: string;
  metadataUri: string;
  imageUri: string;
}

export interface LaunchPrepareRequest {
  creator: Address;
  uploadId: string;
  creatorFeeBps: number;
  /** Lamports of SOL the creator buys with in the same approval; 0 or absent for none. */
  devBuyLamports?: Amount;
  /** Token rules, fixed at launch; all zero for none (the backend also reads a request without them as none). */
  rules: LaunchRulesInput;
  /**
   * Build your own (§5.7): the `LaunchConfig` to launch from. The backend reads it, checks it again
   * and builds `create_launch` with it; `rules` and `creatorFeeBps` must then equal the config's
   * (what the site showed is what launches), and a custom hook's accounts are resolved for `mint`.
   */
  config?: Address;
  /**
   * A companion (docs/companions.md): the launch's creator is a program, so its creator fees are
   * bought back and burned, streamed to holders or paid to the launcher by code, with no keeper.
   * The launcher is the beneficiary; a first buy is then the companion's, vesting to them over
   * `vestDays`. Not with the creator wallet lock or a custom hook; the holders' templates need
   * holder rewards.
   */
  companion?: { template: CompanionTemplate; vestDays?: number };
}

/** The companion templates (`COMPANION_TEMPLATES` in the SDK). */
export type CompanionTemplate = 'buysItself' | 'rugProofDev' | 'buybackAndReward';

export interface LaunchPrepareResponse {
  intentId: string;
  mint: Address;
  transactions: PreparedTx[];
  openingMcapUsd: number;
  virtualQuote: Amount;
  graduationQuote: Amount;
  graduationMcapUsd: number;
  /** The largest first buy, lamports, whose tokens stay within max wallet at the opening reserves with the creator's first-buy fees; null without max wallet. */
  devBuyMaxLamports: Amount | null;
  /** Total fee of a buy under these rules by the §7.3 formula, outside the sniper window. */
  buyFeeBps: number;
  /** Total fee of a sell under these rules by the §7.3 formula, outside the sniper window. */
  sellFeeBps: number;
}

// ---- holder rewards (docs/hooks-v2.md §4, §8.1) ------------------------------------------------------
//   GET  /v1/rewards/:owner          -> RewardsList
//   POST /v1/rewards/prepare         -> { transactions: PreparedTx[] }
//   POST /v1/share/prepare           -> { transactions: PreparedTx[] }
//   GET  /v1/launches/:mint/rewards  -> { events: RewardEvent[] }

/** A wallet's holder rewards in one launch. */
export interface RewardPosition {
  mint: Address;
  symbol: string;
  name: string;
  image: string | null;
  decimals: number;
  /** Token base units the wallet holds now (0 when it sold out with rewards left to claim). */
  balance: Amount;
  /** Lamports a claim would pay now. */
  claimable: Amount;
  /** Lamports the wallet has claimed here, all time; null when not tracked. */
  claimed: Amount | null;
}

export interface RewardsList {
  owner: Address;
  positions: RewardPosition[];
  /** Lamports claimable across every position. */
  totalClaimable: Amount;
}

/** Claim holder rewards: up to about 4 mints per transaction. */
export interface RewardsPrepareRequest {
  owner: Address;
  mints: Address[];
  /** Unwrap the bridged SOL to SOL and close the temporary holding. */
  unwrap: boolean;
}

// ---- sending a token of the standard -----------------------------------------------------------------
//   POST /v1/transfer/prepare        -> TransferPrepareResponse

/**
 * Send `amount` of `mint` from the owner's holding to `to`'s (made on the way when missing, the
 * sender paying its rent). Wallets cannot build this themselves: the token program's transfer takes
 * the mint's hook accounts, which the backend resolves. A holding under the creator lock or the
 * early-buyer lock is refused with the lock (code `locked`), as the program would refuse it.
 */
export interface TransferPrepareRequest {
  owner: Address;
  mint: Address;
  to: Address;
  /** Base units of the token. */
  amount: Amount;
}

export interface TransferPrepareResponse {
  transactions: PreparedTx[];
  /** Lamports the sender pays for the recipient's holding; 0 when it already exists. */
  rentLamports: Amount;
}

// ---- creator fees ------------------------------------------------------------------------------------
//   POST /v1/creator/prepare         -> { transactions: PreparedTx[] }

/** Claim the creator fees of launches the owner created: up to about 4 mints per transaction, paid as SOL. */
export interface CreatorPrepareRequest {
  owner: Address;
  mints: Address[];
}

/** Share with holders: send SOL that every holder of the token receives pro rata. */
export interface SharePrepareRequest {
  owner: Address;
  mint: Address;
  /** Lamports; at least 0.001 SOL. */
  amount: Amount;
  solMode: SolMode;
}

/** A claim or a share in one launch. */
export interface RewardEvent {
  kind: 'claim' | 'share';
  owner: Address;
  /** Lamports. */
  amount: Amount;
  ts: number;
  signature: string;
}

export interface BridgeAsset {
  underlyingMint: Address;
  underlyingProgram: Address;
  wrappedMint: Address | null;
  registered: boolean;
  native: boolean;
  symbol: string;
  name: string;
  image: string | null;
  decimals: number;
  totalWrapped: Amount | null;
  /** Dollars per whole token: SOL from the SOL feed, any other mint from Jupiter's price API (mainnet only); null where none is known. */
  priceUsd: number | null;
  /** Price times the underlying mint's supply; null unless both are known. */
  mcapUsd: number | null;
  /** The underlying mint's supply in base units; null where it has not been read. */
  supply: Amount | null;
  featured: boolean;
  /**
   * The Bordrless DEX pool of the bridged version against bridged SOL, where it trades on the
   * standard (the platform token's page charts and trades this one); null while none has been
   * opened. Absent from backends that predate it.
   */
  pool?: BridgePool | null;
}

/** A bridged token's pool on the DEX (`BridgeAsset.pool`): where it is, since when, and its last price. */
export interface BridgePool {
  address: Address;
  /** Unix seconds the pool was opened. */
  createdAt: number;
  /** Unix seconds of its last indexed trade; null before the first. */
  lastTradeAt: number | null;
  /** Whole bridged SOL per whole token at the last trade (or from the reserves); null when it cannot be read. */
  priceQuote: number | null;
  /** The same in dollars; null without a SOL price. */
  priceUsd: number | null;
  lpFeeBps: number;
  /** The flat protocol rate of the quote on this pool (ordinary pools; 0 under the share model). */
  protocolFeeBps: number;
  /** The LP fee goes to Bordrless in SOL (a launch pool since the upgrade of 2026-10-08, `LP_FEE_TO_PROTOCOL_FROM_SLOT`); false when it stays in the pool, as an ordinary pool's always does. */
  lpFeeToProtocol: boolean;
  baseReserve: Amount;
  quoteReserve: Amount;
  volume24hUsd: number | null;
}

export interface BridgeAssets {
  assets: BridgeAsset[];
}

export interface BridgeBalances {
  underlying: Amount;
  wrapped: Amount;
}

export interface BridgePrepareRequest {
  owner: Address;
  underlyingMint: Address;
  direction: 'wrap' | 'unwrap';
  amount: Amount;
}

export interface BridgePrepareResponse {
  transactions: PreparedTx[];
  /** The asset was not registered yet; the transaction registers it first (the owner pays the rent). */
  registers: boolean;
}

export interface PoolSummary {
  pool: Address;
  baseMint: Address;
  quoteMint: Address;
  baseSymbol: string;
  quoteSymbol: string;
  baseImage: string | null;
  baseDecimals: number;
  quoteDecimals: number;
  lpMint: Address;
  lpFeeBps: number;
  /** The flat protocol rate of the quote; 0 under the share model. */
  protocolFeeBps: number;
  /** How Bordrless is paid on this pool (§3.1); absent from backends that predate the share model, which the site reads as 'flat'. */
  protocolModel?: ProtocolModel;
  /** Under the share model, Bordrless's share of what the hooks cut, in basis points; null (or absent) under the flat model. */
  protocolShareBps?: number | null;
  /** The LP fee goes to Bordrless in SOL (a launch pool since the upgrade of 2026-10-08); false when it stays in the pool. Absent from backends that predate it. */
  lpFeeToProtocol?: boolean;
  hookProgram: Address | null;
  /** The base token's creator-written hook (§5.8), for a launch pool whose token has one; null or absent otherwise. */
  customHook?: CustomHookInfo | null;
  curve: boolean;
  baseReserve: Amount;
  quoteReserve: Amount;
  lpSupply: Amount;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  createdAt: number;
  launchMint: Address | null;
}

export interface PoolList {
  pools: PoolSummary[];
}

export interface LiquidityQuoteRequest {
  pool: Address;
  action: 'add' | 'remove';
  baseAmount?: Amount;
  quoteAmount?: Amount;
  lpAmount?: Amount;
}

export interface LiquidityQuote {
  action: 'add' | 'remove';
  baseAmount: Amount;
  quoteAmount: Amount;
  lpAmount: Amount;
  /** Share of the pool after the action, 0 to 1. */
  share: number;
}

export interface LiquidityPrepareRequest extends LiquidityQuoteRequest {
  owner: Address;
  slippageBps: number;
}

export interface LiquidityPrepareResponse {
  transactions: PreparedTx[];
  quote: LiquidityQuote;
}

export interface ApiErrorBody {
  error: string;
  code?: string;
}

// ---- the explorer (GET /v1/explorer/...) --------------------------------------------------------------

/** Which of the standard's programs emitted an event: the five of Bordrless, or any hook program (`hook`). */
export type ExplorerProgram = 'token' | 'swap' | 'bridge' | 'launch' | 'kit' | 'hook';

/** What an address turned out to be, in the order the backend looks: a mint, a pool, a bridge wrapper, a holding, a program, a wallet, a launch config, or nothing it knows. */
export type ExplorerKind = 'mint' | 'pool' | 'wrapper' | 'holding' | 'program' | 'wallet' | 'config' | 'unknown';

export interface ExplorerStats {
  /** Mints of the standard the indexer has seen. */
  mints: number;
  /** Holdings with a balance. */
  holdings: number;
  /** Transactions indexed (distinct signatures), all time and in the last 24 hours. */
  transactions: number;
  transactions24h: number;
  /** The newest slot indexed; null before the first event. */
  newestSlot: number | null;
}

/** A token an event's amounts are in. */
export interface ExplorerToken {
  mint: Address;
  symbol: string;
  decimals: number;
}

/** One decoded event of `chain_events`, as the explorer shows it. */
export interface ExplorerEvent {
  signature: string;
  ordinal: number;
  slot: number;
  blockTime: number | null;
  /** The program id that emitted it. */
  program: Address;
  /** The IDL's event name in PascalCase (`Transferred`, `Swapped`, `KitInstalled`). */
  name: string;
  /** The account the event is mostly about (the mint, the pool, the holding, ...); null when it has none. */
  subject: Address | null;
  /** The decoded fields: keys as the SDK's coder gives them (camelCase), pubkeys as base58, integers as decimal strings. */
  payload: Record<string, unknown>;
  /** The tokens its amounts are in, where the indexer knows them: the event's own mint (or the pool's base), and the pool's quote. */
  base: ExplorerToken | null;
  quote: ExplorerToken | null;
}

export interface ExplorerEvents {
  events: ExplorerEvent[];
  /** The cursor for the page after this one (`before=`); null on the last page. */
  next: string | null;
}

/** `GET /v1/explorer/tx/:signature`: a transaction the indexer has, with every event it decoded, in order. */
export interface ExplorerTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** The program ids its events came from, first seen first. */
  programs: Address[];
  events: ExplorerEvent[];
}

export interface ExplorerMint {
  mint: Address;
  name: string;
  symbol: string;
  image: string | null;
  decimals: number;
  supply: Amount;
  maxSupply: Amount;
  creator: Address;
  createdAt: number;
  kind: 'launch' | 'bridged' | 'lp' | 'other';
  mintAuthority: Address | null;
  freezeAuthority: Address | null;
  hookAuthority: Address | null;
  metadataAuthority: Address | null;
  hookProgram: Address | null;
  hookFlags: number;
  /** Holdings with a balance. */
  holders: number;
}

export interface ExplorerHolder {
  owner: Address;
  holding: Address;
  amount: Amount;
  /** Of the supply, 0 to 1. */
  share: number;
}

/** A pool as the explorer lists it on a mint's page, or shows it on its own. */
export interface ExplorerPool {
  pool: Address;
  baseMint: Address;
  quoteMint: Address;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseReserve: Amount;
  quoteReserve: Amount;
  lpMint: Address;
  lpSupply: Amount;
  lpFeeBps: number;
  protocolFeeBps: number;
  protocolModel: ProtocolModel;
  protocolShareBps: number | null;
  /** The LP fee goes to Bordrless in SOL (a launch pool since the upgrade of 2026-10-08); false when it stays in the pool. */
  lpFeeToProtocol: boolean;
  hookProgram: Address | null;
  hookFlags: number;
  curve: boolean;
  creator: Address;
  createdAt: number;
  swapCount: number;
  volume24hUsd: number | null;
  /** The launch this is the pool of, if any. */
  launchMint: Address | null;
}

export interface ExplorerHolding {
  holding: Address;
  mint: Address;
  owner: Address;
  amount: Amount;
  symbol: string;
  name: string;
  image: string | null;
  decimals: number;
  /** Dollars, where the token has a pool against bridged SOL and SOL has a price. */
  valueUsd: number | null;
}

export interface ExplorerProgramInfo extends ProgramInfo {
  /** The program's name on the standard ("Token", "DEX", "Half-Life"); a hook the site does not know is "Hook". */
  name: string;
  /** Events indexed, by event name, most first. */
  counts: { name: string; count: number }[];
}

export interface ExplorerWrapper {
  wrapper: Address;
  underlyingMint: Address;
  underlyingProgram: Address;
  wrappedMint: Address;
  vault: Address;
  decimals: number;
  native: boolean;
  totalWrapped: Amount;
  name: string;
  symbol: string;
  image: string | null;
  registrar: Address;
  registeredAt: number;
}

/** A `LaunchConfig` (docs/hooks-v2.md §5.7) as its `LaunchConfigCreated` event told it, and the launches made from it. */
export interface ExplorerConfig {
  config: Address;
  creator: Address | null;
  label: string | null;
  creatorFeeBps: number | null;
  customHook: Address | null;
  customHookFlags: number | null;
  rules: Record<string, unknown> | null;
  launches: { mint: Address; name: string; symbol: string; image: string | null }[];
}

/** A short reference to a token, for lists. */
export interface ExplorerTokenRef {
  mint: Address;
  name: string;
  symbol: string;
  image: string | null;
}

/** `GET /v1/explorer/address/:address`: what lives at an address, by kind. Every kind carries the newest events touching it. */
export type ExplorerAddress = { address: Address; events: ExplorerEvent[] } & (
  | { kind: 'mint'; mint: ExplorerMint; launch: { status: LaunchStatus } | null; wrapper: { underlyingMint: Address; native: boolean } | null; pools: ExplorerPool[]; holders: ExplorerHolder[] }
  | { kind: 'pool'; pool: ExplorerPool; trades: Trade[] }
  | { kind: 'wrapper'; wrapper: ExplorerWrapper }
  | { kind: 'holding'; holding: ExplorerHolding }
  | { kind: 'program'; program: ExplorerProgramInfo }
  | { kind: 'wallet'; holdings: ExplorerHolding[]; totalUsd: number | null; created: ExplorerTokenRef[] }
  | { kind: 'config'; config: ExplorerConfig }
  | { kind: 'unknown' }
);

/** One answer to a search: an address resolved to its kind, a transaction, or a mint whose name or ticker matched. */
export interface ExplorerHit {
  kind: ExplorerKind | 'tx';
  address: Address;
  name: string | null;
  symbol: string | null;
  image: string | null;
}

export interface ExplorerSearch {
  query: string;
  hits: ExplorerHit[];
}

/**
 * `POST /v1/config/prepare`: a `LaunchConfig` made from the launch page (Build your own, §5.7), for a
 * hook program of the creator's own. `config` is the address of a keypair the browser made; it signs
 * after the wallet. The kit's rules can't go with a hook of one's own, so a config carries burn and a
 * creator fee only.
 */
export interface ConfigPrepareRequest {
  creator: Address;
  config: Address;
  customHook: Address;
  /** `TOKEN_HOOK_FLAGS`: at least one callback, no unknown bit. */
  customHookFlags: number;
  burnBuyBps: number;
  burnSellBps: number;
  creatorFeeBps: number;
  /** At most 32 bytes. */
  label: string;
}

export interface ConfigPrepareResponse {
  config: Address;
  transactions: PreparedTx[];
}

/** `GET /v1/hooks/:program?mint=`: a hook program as the launch page checks it, and whether it is prepared for the mint. */
export interface HookInspection {
  program: Address;
  /** Deployed as a program on this cluster. */
  executable: boolean;
  /** None of Bordrless's own programs. */
  ownProgram: boolean;
  upgradeAuthority: Address | null;
  upgradeable: boolean | null;
  /** With a mint: the registry it must write for that mint, `["bordrless-hook-accounts", mint]` under the program. */
  registry: Address | null;
  /** With a mint: whether that registry exists and decodes. */
  registryReady: boolean | null;
  /** The registry's extra accounts, once it exists; a launch fits at most `maxExtras`. */
  extras: number | null;
  maxExtras: number;
  /** Why it can't be launched with yet, one sentence each. */
  problems: string[];
}


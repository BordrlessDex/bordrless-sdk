/**
 * The HTTP API between the site and the backend. Amounts in base units travel as decimal strings
 * (`Amount`), dollar figures as numbers, times as unix seconds. A figure the backend could not
 * read is null, never zero.
 */
import type { RulesReadout } from './rules.ts';
import type { KeeperLaunchTerms } from './keeper.ts';
import type { WorkshopFigures, WorkshopReading } from './workshop.ts';

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
/** A hook's code, upgrade authority and attestations read from the chain. checkedAt is Unix seconds. */
export interface HookRiskStatus {
  status: 'available' | 'unavailable';
  checkedAt: number;
  class?: 'immutable' | 'timelocked' | 'managed' | 'author' | 'missing';
  delaySecs?: number | null;
  pending?: { hash: string; eta: number } | null;
  audited?: 'current' | 'stale' | false;
  blocked?: boolean;
  provenance?: 'protocol' | 'studio' | 'unattested' | 'none';
  studio?: { buildHash: string; simPass: boolean; cutMaxBps: number; current: boolean; revoked?: boolean } | null;
  severity: 'low' | 'medium' | 'high';
  words: string;
}

export interface CustomHookInfo {
  program: Address;
  flags: number;
  /** The wallet that can change the hook's code; null when there is none, or when it has not been read (`upgradeable` tells which). */
  upgradeAuthority: Address | null;
  /** True: `upgradeAuthority` can upgrade it. False: nobody can (final). Null: not read, so nothing is claimed either way. */
  upgradeable: boolean | null;
  /** What the hook does, for a hook Studio built (`HookAbout`); null (or absent) for any other, which the site describes from its flags. */
  about?: HookAbout | null;
  /** Live code and attestation status, including hooks built outside Studio. */
  risk?: HookRiskStatus | null;
  /**
   * Bordrless's own words for a Workshop hook (`HookReading`), filled on a launch's own page
   * (`LaunchDetail`): null for a hook deployed outside the Workshop; absent from older servers and
   * from lists.
   */
  workshop?: HookReading | null;
  /**
   * A composed hook's rule set (docs/rules-lane.md §4): the hook is the rules engine and the set is
   * the `RuleSet` bound to the launch's config, as the chain holds it (`RulesReadout`: its bytes and
   * what they say). The one place the set travels: `workshop` beside it is the synthetic reading
   * (`lane: 'rules'`, the words alone). Null for any other hook, or a set that could not be read;
   * absent from older servers and from lists.
   */
  rules?: RulesReadout | null;
  /**
   * Its SOL cut (`QuoteCutInfo`), read live from the launch on a launch's own page (`LaunchDetail`):
   * null when the launch takes none or could not be read; absent from older servers and from lists.
   */
  quoteCut?: QuoteCutInfo | null;
}

/**
 * A custom hook's SOL cut (the launchpad of 13 Oct: a config made with `create_quote_cut_config`): on
 * a trade the launchpad asks the hook for a rate, at most its side's cap, and takes it from the
 * trade's SOL with the creator fee (a buy's SOL in, a sell's SOL out). It takes no tokens, and a send
 * pays none of it.
 */
export interface QuoteCutInfo {
  /** The caps, basis points of the trade's SOL (each at most 1,000). */
  maxBuyBps: number;
  maxSellBps: number;
  /** SOL the cut has taken so far, lamports (part of the creator fees); '0' for a config, which has taken nothing. */
  takenLamports: Amount;
}

/**
 * Bordrless's own words for a custom hook or companion that came through the Workshop, wherever a
 * launcher or a buyer meets it (the owner, 2026-10-12: the site reads and puts official wording from
 * Bordrless's checks, like "it takes 2% of every sell by a wallet over $1,000"): the item (its page
 * is /workshop/<id>), the AI's reading of its source (what it does, the most it takes, what to
 * watch), the largest cut of one transfer the trading test measured (a hook; null for a companion,
 * which has no trading test) and the reading's verdict (`pass`: no finding above low; `warn`: a
 * medium finding; `fail`: a high or critical one, shown as it is: in the reading lane the words
 * show anyway, and an item the owner approved with it says so). The reading is the Workshop's one AI
 * pass since 2026-10-13; an item read before without a verdict keeps its security review's.
 * Served for an item that is approved and deployed (the Workshop lane), or matched (the reading
 * lane, docs/workshop.md "The reading lane": the builder deployed the program themselves, and the
 * words show while the code on chain stays the build Bordrless checked). A composed hook
 * (docs/rules-lane.md §4) answers a synthetic one: `lane` and `verdict` `rules`, its words read
 * from the rule set bound to the config (the set itself is `customHook.rules`), no measured cut,
 * and `workshopId` '' while it is not listed.
 */
export interface HookReading {
  workshopId: string;
  name: string;
  author: Address;
  /** A hook on trades (a hook item, or a pair's hook half), or a companion on the creator fee (a companion item, or a pair's script half). */
  kind: 'hook' | 'companion';
  reading: WorkshopReading | null;
  measuredCutBps: number | null;
  /** `rules`: a composed hook's, read from its rules (no review, no build, no trading test). */
  verdict: 'pass' | 'warn' | 'fail' | 'rules' | null;
  /** Who approved it: the checks ('auto', a clean pass) or the operator; null for items approved before that was kept, and for the reading lane (nothing is approved). */
  approvedBy?: 'auto' | 'operator' | null;
  /** `workshop`: Bordrless deployed it under its own key; `reading`: its builder deployed it, and Bordrless read the source that matches it; `rules`: composed from Bordrless rules and run by the rules engine. Absent from older servers: `workshop`. */
  lane?: 'workshop' | 'reading' | 'rules';
  /** With a `fail` verdict: the titles of the reading's first findings (the most severe first), for the site to say what failed. Absent otherwise. */
  findings?: string[];
}

/**
 * Bordrless's official summary of a hook Studio deployed: written once by the assistant from the
 * deployed source (comments and strings blanked), its flags and its review, then never changed and
 * never the author's to edit. A new build is a new program, with a summary of its own.
 */
export interface HookSummary {
  /** At most `HOOK_SUMMARY_LIMITS.title` characters. */
  title: string;
  /** One or two plain sentences: what the hook does to transfers, buys and sells. */
  text: string;
  /** The build it was written for (sha256 of the deployed binary); null when the build had none. */
  buildHash: string | null;
  at: number;
}

/** Figures the behaviour simulator measured on a hook (numbers, never model text). Reserved: not filled yet. */
export interface HookMeasured {
  /** The largest cut seen on one transfer, bps of it. */
  maxCutBps: number | null;
  /** Transfers it refused, of `runs`. */
  refusals: number | null;
  runs: number | null;
}

/**
 * What a token hook Studio built does (`GET /v1/hooks/:program/about`, and on `CustomHookInfo.about`,
 * `LaunchConfigData.customHook.about`, `MarketplaceListing.hookAbout`): Bordrless's official summary
 * first, the author's own words second. Null for a hook Studio didn't build.
 */
export interface HookAbout {
  program: Address;
  risk?: HookRiskStatus | null;
  /** The Studio project's name, as its author called it. */
  title: string;
  /** Bordrless's summary; null until it is written (the site then says what the flags allow). */
  summary: HookSummary | null;
  /** "What your hook does", in the author's words (at most `HOOK_ABOUT_CHARS`); empty when none was written. */
  about: string;
  studioProject: string;
  /** The worst verdict of Studio's automated checks of the deployed source (not an audit); null when none is kept. */
  reviewVerdict: 'pass' | 'warn' | null;
  /** sha256 of the deployed binary. */
  buildHash: string | null;
  /** Studio keeps its source for anyone to read. */
  sourceAvailable: boolean;
  /** The marketplace listing that shows its source (its Studio config, when listed); null when not listed. */
  listing: Address | null;
  /** Reserved for the behaviour simulator's figures; absent for now. */
  measured?: HookMeasured | null;
}

/** "What your hook does": the most an author writes, in characters (the Studio field and what is served). */
export const HOOK_ABOUT_CHARS = 280;
/** The official summary's limits, in characters. */
export const HOOK_SUMMARY_LIMITS = { title: 40, text: 320 } as const;

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
  customHook: {
    program: Address;
    flags: number;
    /** As `CustomHookInfo.about`. */
    about?: HookAbout | null;
    risk?: HookRiskStatus | null;
    /** As `CustomHookInfo.rules`: a composed hook's rule set, read from the `RuleSet` bound to this config; null for any other hook or an unbound one. Absent from older servers. */
    rules?: RulesReadout | null;
    /** As `CustomHookInfo.quoteCut`: the SOL cut's caps of a config made with `create_quote_cut_config` (`takenLamports` '0': a config has taken nothing); null for any other config. Absent from older servers. */
    quoteCut?: QuoteCutInfo | null;
  } | null;
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
  /** A partner config's partner share of the creator fee (bps of it, docs/partner-fee.md), paid on every launch whoever makes it; 0 or absent for any other config. */
  partnerShareBps?: number;
  /** The partner it pays (its holding of bridged SOL receives the share); null without one. */
  partner?: Address | null;
  /** The hook was built and deployed by Studio: the launch prepares it for the mint itself (its standard `prepare`). */
  studioHook?: boolean;
  /**
   * The hook is a game hook made in Studio (docs/games.md "Phase 2"): its kind and the constants
   * its source fixes. The config then launches a jackpot or streak coin through the companion
   * (`companion.game` of that kind); null or absent for any other hook, and for a Workshop pair's
   * hook (its own script stands in for the game companion: `requiredCompanion`).
   */
  game?: import('./studio.ts').StudioGameSettings | null;
  /**
   * The companion a launch of this config must come with (the shape the on-chain `LaunchConfig`
   * field will take, docs/HANDOFF-2026-10-12.md §4.5): `game` when the config's hook is a game hook
   * (what `game` says), `script` when its hook belongs to a Workshop pair (docs/workshop.md
   * "Pairs": the launch sends `companion.script` with that program, or is refused
   * `companion_required`), else `none`. Absent from older servers.
   */
  requiredCompanion?: RequiredCompanion;
  /**
   * Bordrless's own words for the config's custom hook (`HookReading`) when it is a Workshop hook
   * (or a pair's hook) that is approved and deployed, or a composed hook's synthetic reading
   * (`lane: 'rules'`; its set is `config.customHook.rules`); null for a hook deployed outside the
   * Workshop, one no longer approved, or the rules engine with no set bound. Absent from older servers.
   */
  hook?: HookReading | null;
}

/** What a config's launch must come with: nothing in particular, a game of a kind, or a Workshop pair's script. */
export type RequiredCompanion =
  | { kind: 'none' }
  | { kind: 'game'; game: GameKindName }
  | {
      kind: 'script';
      /** The pair's companion script program: what `companion.script.program` must be (a preset's: the script its launch request names, `companion.lossCover` for Lossback). */
      program: Address;
      /** The pair's Workshop item (its page is /workshop/<id>), its name, its reading's title and its author. A Bordrless preset (`preset`) has no item and no author: both null. */
      workshopId: string | null;
      name: string;
      title: string | null;
      author: Address | null;
      /** A Bordrless preset the config's hook belongs to: `lossCover` (docs/loss-cover.md; the site says Lossback), whose launch request is `companion.lossCover`, not `companion.script`. Absent for a pair and from older servers. */
      preset?: 'lossCover';
      /** Bordrless's reading of the pair (one for both halves), as `HookReading.reading`. Absent from older servers. */
      reading?: WorkshopReading | null;
      /** A companion script has no trading test: never a measured cut. */
      measuredCutBps?: null;
      /** The pair's verdict (its reading's, one for both halves), as `HookReading.verdict`. Absent from older servers. */
      verdict?: 'pass' | 'warn' | 'fail' | null;
      /** What a launch with the pair's script takes from its keeper.json (`WorkshopItem.keeper`): how often a step runs, whether it pays wallets. Absent for a preset and from older servers. */
      keeper?: KeeperLaunchTerms | null;
    };

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
  /** Phase 3a: present (true) when the upgrade authority is the program's own `hook_timelock` account. */
  timelocked?: boolean;
}

/** Who a launch's creator fee goes to, read from the chain (docs/companions.md "Who may hold a launch's creator fee on the site"): a wallet, the companion program's pot, a program nobody can upgrade (shown, labelled), or a program someone can still upgrade (the launch is hidden). Null until read. */
export type CreatorKind = 'wallet' | 'companion' | 'program' | 'program-immutable';

export interface LaunchSummary {
  mint: Address;
  name: string;
  symbol: string;
  image: string | null;
  description: string;
  creator: Address;
  /** Who the creator fee goes to; absent from older servers. */
  creatorKind?: CreatorKind | null;
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
  /** The program that is this launch's creator (docs/companions.md), as a list names it: null for a launch whose creator is a wallet; absent from an older backend. `LaunchDetail.companion` has its live figures. */
  companionTag?: CompanionTag | null;
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
  /** The program that is this launch's creator (docs/companions.md), read live; null for a launch whose creator is a wallet. */
  companion: CompanionSummary | null;
  /**
   * What its Workshop custom hook or companion has done on this coin (`WorkshopFigures`, `coins` 1):
   * its hook's cuts, its companion's pot in and out. Null for a coin with neither from the Workshop,
   * or when they can't be read; absent from older servers.
   */
  workshopFigures?: WorkshopFigures | null;
}

/** `GET /v1/launches?sort=`: newest first by default; `rewards24h` most paid to holders in 24 h first; `fees` lowest buy-then-sell fee first. */
export type LaunchSort = 'new' | 'mcap' | 'volume' | 'trending' | 'graduated' | 'rewards24h' | 'fees';
/** `GET /v1/launches?rules=a,b`: only launches that have every rule listed (`custom_hook`: launched with a creator's own hook). */
/** The board's filters: kit rules, and the pre-built hooks by name (2026-10-12: Snowball, the Jackpot draw, Half-Life, buy back & burn, the Workshop's last-buyer and streak games, Lossback as `loss_cover`). `custom_hook` stays for older links. */
export type RuleFilter = 'rewards' | 'burn' | 'max_wallet' | 'creator_lock' | 'early_lock' | 'custom_hook' | 'snowball' | 'jackpot' | 'last_buyer' | 'streak' | 'half_life' | 'buyback' | 'loss_cover';

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
  /**
   * A buy past the end of the curve (docs/hooks-v2.md §3.1): the part of `amountIn` the swap uses,
   * the smallest input that sells the curve out; the rest never leaves the wallet (the backend
   * unwraps it back to SOL in the same transaction). The figures are of this part: `amountOut`,
   * the fees, `effectivePrice`, `tradeUsd`; `minAmountOut` is for the whole `amountIn` at the same
   * rate, as the program holds a filled buy to it pro rata. Null when the whole input is used.
   */
  amountUsed?: Amount | null;
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
   * Where the creator fee goes when it isn't all paid to the launcher (docs/companions.md): the
   * launch's creator is then a program, a companion, that buys the token back and burns it,
   * streams to holders or pays the launcher, by `split` (basis points summing to 10,000), with no
   * keeper. A `template` names one of the three preset splits (kept for older clients). The
   * launcher is the beneficiary; a first buy is then the companion's, vesting to them over
   * `vestDays` (0 to 365, default 30). Refused (`companion_rules`) with the creator wallet lock, a
   * launch config (listed or not, with or without a hook), no creator fee, a share for holders
   * without holder rewards, or a split that doesn't add up.
   */
  companion?: CompanionRequest;
}

/**
 * A launch's companion as the launch request names it: a split of the creator fee, or one of the
 * preset splits by name; with `game`, a lottery coin (docs/games.md): the split's holders' share is
 * then 0 and the pot's part (`game.potBps`) makes the four add up to 10,000.
 */
export type CompanionRequest = ({ split: CompanionSplitBps; vestDays?: number; game?: GameRequest; snowball?: SnowballRequest; script?: ScriptRequest; lossCover?: LossCoverRequest } | { template: CompanionTemplate; vestDays?: number }) & CompanionExtras;

/**
 * What any companion request may add (2026-10-13, docs/payees-and-wallet-payouts.md), each set once
 * before the launch, the mint signing:
 * - `payees`: up to 10 wallets that share the launcher's part of the creator fee (the split's
 *   `beneficiaryBps`), each a fixed share of that part (1 to 10,000 basis points, 10,000 in all at
 *   most); the launcher keeps the rest. Not the launcher, the companion or its creator address, each
 *   named once. Bounds: `payeesProblem`. The setup carries `set_payees`, in its own transaction when
 *   the setup leaves no room (a Lossback or custom hook's setup).
 * - `allowWalletPayouts`: a custom hook's script with payout terms (`script.payout`, made with
 *   `create_script_v2`) may also pay any wallet SOL from the pot, within those terms. Refused
 *   (`companion_rules`) on any other companion: `walletPayoutsProblem`.
 */
export interface CompanionExtras {
  payees?: PayeeRequest[];
  allowWalletPayouts?: boolean;
}

/** A wallet that shares the launcher's part of the creator fee (`set_payees`): its share of that part, basis points. */
export interface PayeeRequest {
  wallet: Address;
  bps: number;
}

/** A payee as the token page shows it (`CompanionSummary.payees`): its share of the launcher's part, what it was paid and what it is owed (its account could not take it yet), lamports. */
export interface PayeeSummary {
  wallet: Address;
  bps: number;
  paid: Amount;
  owed: Amount;
}

/**
 * A Lossback coin as the launch request names it (docs/loss-cover.md; the programs and the policy
 * say Loss cover): the companion's pot pays every holder under water the same share of what they
 * are down, in rounds of `roundSecs`, once the pot holds `minPotLamports`; a holding counts from
 * `minHolding` base units and gets `coverBps` of its loss covered when the pot can. The split's
 * buyback and holders' parts are 0; the pot's part is what the split's launcher part leaves
 * (10,000 with a launcher part of 0). Everything else (the step, the shares per step, holding and
 * round, the least loss, the wait after a buy) is fixed by `LOSS_COVER_DEFAULTS`. Bounds:
 * `lossCoverProblem`. Refused (`companion_rules`) beside a game, a Snowball or a script, and
 * (`loss_cover_off`) while Lossback launches are closed or the creator fee has no config.
 */
export interface LossCoverRequest {
  roundSecs: number;
  minPotLamports: Amount;
  coverBps: number;
  minHolding: Amount;
}

/**
 * The terms a Lossback coin runs on, as the chain holds them: the script's six (`CoverState`:
 * `coverBps`, `minHolding`, `minLossLamports`, `minAgeSecs`, `roundSecs`, `minPotLamports`), the
 * companion's payout terms (`PayoutTerms`: `stepBps`, `holdingBps`, `roundBps` is `window_bps`,
 * the window is the round) and the step (`Script.interval`).
 */
export interface LossCoverTerms {
  roundSecs: number;
  stepSecs: number;
  stepBps: number;
  holdingBps: number;
  roundBps: number;
  coverBps: number;
  minHolding: Amount;
  minLossLamports: Amount;
  minAgeSecs: number;
  minPotLamports: Amount;
}

/** A Lossback coin's figures as its token page shows them (`CompanionSummary.lossCover`), read from the chain and the indexer's payouts. */
export interface LossCoverSummary {
  /** The hook program, its state for the mint (`["state", mint]`), the script program, its state (`["script-state", mint]`) and the payout terms (`["payout-terms", mint]`). */
  hook: Address;
  hookState: Address;
  script: Address;
  scriptState: Address;
  payoutTerms: Address;
  /** The pot (`Companion.pendingPot`), lamports. */
  pot: Amount;
  /** Lamports paid to holders all time, and entries recorded all time (touches included), the terms'. */
  paidTotal: Amount;
  payouts: number;
  /** Distinct holdings paid above 0 so far (the indexer's `script_payouts`). */
  holdersCovered: number;
  /** The round the script last stepped in (0 before the first), and the round the clock is in now. */
  round: number;
  currentRound: number;
  /** The share of its uncovered loss each holder is paid this round: `min(10,000, b / l_prev)` in basis points; 0 in a round that only measures. */
  roundShareBps: number;
  /** The round's budget (the pot at its first step), what it has paid and what is left. */
  roundBudget: Amount;
  roundPaid: Amount;
  roundBudgetLeft: Amount;
  /** The uncovered loss measured over the previous round (what this round's share is computed from) and so far this round. */
  lossPrev: Amount;
  lossCur: Amount;
  /** Holdings measured this round, and rounds stepped so far. */
  measured: number;
  rounds: number;
  /** When the round the script last stepped in began (0 before the first), when the current round ends, when a holder was last paid (0: never), when the next step may run. */
  lastRoundAt: number;
  nextRoundAt: number;
  lastPaidAt: number;
  nextStepAt: number;
  /** Whether the pot holds the least a round starts with. */
  minPotMet: boolean;
  terms: LossCoverTerms;
}

/**
 * `GET /v1/companion/:mint/cover/:owner`: one holder's own cover on a Lossback coin, from the
 * holding's record (the hook data), the pool's price now and the script's round.
 */
export interface LossCoverHoldingSummary {
  owner: Address;
  holding: Address;
  /** Whether the owner holds the token (a holding with a record); every figure is 0 without one. */
  holds: boolean;
  /** Tokens held, base units; the tokens the record covers (the balance as of its last write). */
  balance: Amount;
  recorded: Amount;
  /** The average entry price (lamports per base unit times 10^12) and in SOL per whole token; the pool's price now the same way. */
  entry: Amount;
  entrySolPerToken: number;
  spot: Amount;
  spotSolPerToken: number;
  /** Lamports the holding is down (0 above water), the part the cover applies to, what it has been paid, and what it is still owed. */
  loss: Amount;
  covered: Amount;
  paid: Amount;
  owed: Amount;
  /** What the current round would pay it at the round's share, lamports (0 in a measuring round, or when not eligible). */
  payNow: Amount;
  /** Whether a step would take it now, and why not in one sentence. */
  eligible: boolean;
  reason: string | null;
  /** The round it was last measured or paid in (0: never), whether that is the current round, and when the holding's wait after its last buy ends. */
  lastRound: number;
  paidThisRound: boolean;
  countsFrom: number;
  /** The current round, and when it ends. */
  round: number;
  nextRoundAt: number;
}

/**
 * A custom companion as the launch request names it (2026-10-12, docs/scripts.md): a Workshop
 * script (`program`, a companion item that Bordrless approved, deployed and approved on chain)
 * decides what the companion's pot does. The pot is `potBps` of every creator-fee claim (with the
 * split's parts it adds up to 10,000); the companion calls the script's `companion_step` at most
 * once every `interval` seconds (10 to a day), from a minute after the launch; `initData` is what
 * the script's `companion_init` gets once (base64 or hex, at most 512 bytes; empty for none) and
 * `stateLen` the size of the state the companion makes for it (0 to 10,240 bytes; the Workshop
 * item's reading says what the script needs). Bounds: `scriptProblem`. Refused (`companion_rules`)
 * beside a game or a Snowball, and (`script_not_approved`) when the program is not an approved,
 * deployed Workshop companion whose on-chain approval holds.
 */
export interface ScriptRequest {
  potBps: number;
  program: Address;
  interval: number;
  initData: string;
  stateLen: number;
  /** Payout terms (2026-10-13): the script is made with `create_script_v2`, its payouts bound by them; absent, `create_script` (no payouts). Bounds: `scriptProblem`. */
  payout?: PayoutTermsRequest;
}

/**
 * A script's payout terms as a launch request names them (the companion's `PayoutTerms`, made by
 * `create_script_v2`): the most one step pays (`stepBps` of the pot at the step's start), the most
 * one holding or wallet gets of a step's budget (`holdingBps`), and the most a window pays
 * (`windowBps` of the pot at the window's first step), the window `windowSecs` long (10 s to a day).
 */
export interface PayoutTermsRequest {
  stepBps: number;
  holdingBps: number;
  windowBps: number;
  windowSecs: number;
}

/** A custom companion's script as its token page shows it (`CompanionSummary.script`), read from the chain and the Workshop. */
export interface ScriptSummary {
  /** Its account, `PDA(["script", mint])` under the companion program. */
  address: Address;
  /** The script program (a Workshop companion item's, deployed under Bordrless's key). */
  program: Address;
  /** Its author, paid half of what every fee claim takes from the launch; null when none (or the author launched it themselves: no extra share). */
  author: Address | null;
  /** The least time between steps, seconds. */
  interval: number;
  /** When it last stepped (unix seconds; 0: not yet). */
  lastAt: number;
  /** When the next step may run (a minute after the launch at the earliest). */
  nextStepAt: number;
  /** Steps run so far. */
  steps: number;
  /** SOL the script may spend (the companion's pot), lamports. */
  pot: Amount;
  /** The pot's part of every fee claim. */
  potBps: number;
  /** What the author has been paid so far, lamports. */
  authorPaid: Amount;
  /** The size of the script's state the companion made, bytes (0: none). */
  stateLen: number;
  /** The Workshop item it came from: its id (its page is /workshop/<id>), name and the AI reading's title; null for a script approved outside the Workshop. */
  workshopId: string | null;
  name: string | null;
  title: string | null;
  /**
   * Whether Bordrless checked and approved the code: a Workshop script. False for an immutable
   * program launched unreviewed (docs/scripts.md "Unreviewed scripts": no Workshop item, no author,
   * no author's share), which the site names "Custom hook (unreviewed)". Absent from older servers.
   */
  reviewed?: boolean;
  /** Bordrless's reading of the Workshop item it came from (`HookReading.reading`); null for a script outside the Workshop. Absent from older servers. */
  reading?: WorkshopReading | null;
  /** The verdict of that item's reading (`HookReading.verdict`); null for a script outside the Workshop. Absent from older servers. */
  verdict?: 'pass' | 'warn' | 'fail' | null;
  /**
   * `reading` when the script was deployed by its builder (immutable, outside the Workshop) and a
   * reading-lane item matches its code: Bordrless's words show with `reviewed` false. Absent for a
   * Workshop script and from older servers.
   */
  lane?: 'workshop' | 'reading';
  /** Its payout terms let it pay any wallet SOL from the pot (`allow_wallet_payouts`, `PayoutTerms.reserved[0]`, 2026-10-13); absent otherwise and from older servers. */
  walletPayouts?: true;
}

/**
 * A Snowball companion as the launch request names it (2026-10-12): the companion's part of every
 * creator fee claim (`potBps`; with the split's parts it adds up to 10,000) fills a pot that makes
 * volume in the token on its own pool, once every `interval` seconds: a buy of `buyBps` of the pot
 * when the price falls `buyStepBps` below its reference, a sell of `sellBps` of its tokens when it
 * rises `sellStepBps` above, and with `flatTrades` a trade anyway when it hasn't moved (on the side
 * that rebalances what it holds). One trade moves at most `poolBps` of the pool's SOL side. The
 * presets are `SNOWBALL_PRESETS`; bounds `snowballProblem`.
 */
export interface SnowballRequest {
  potBps: number;
  buyStepBps: number;
  sellStepBps: number;
  buyBps: number;
  sellBps: number;
  poolBps: number;
  interval: number;
  flatTrades: boolean;
}

/** A Snowball's terms without its part of the fee: what a preset sets and the custom controls change. */
export type SnowballTerms = Omit<SnowballRequest, 'potBps'>;

/** A Snowball's market maker as its token page shows it (`CompanionSummary.snowball`), read from the chain. */
export interface SnowballSummary {
  /** Its account, `PDA(["snowball", mint])` under the companion program. */
  address: Address;
  buyStepBps: number;
  sellStepBps: number;
  buyBps: number;
  sellBps: number;
  /** The most one trade moves, as a share of the pool's SOL side. */
  poolBps: number;
  /** The least time between trades, seconds. */
  interval: number;
  /** It trades every interval even when the price hasn't moved. */
  flatTrades: boolean;
  /** SOL it holds to buy with (the companion's pot), lamports. */
  pot: Amount;
  /** Tokens it holds to sell, base units. */
  tokensHeld: Amount;
  /** The next buy waits for the price at or below `buyBelow`, the next sell at or above `sellAbove` (SOL per whole token). */
  buyBelow: number;
  sellAbove: number;
  buys: number;
  sells: number;
  /** SOL spent on buys and received from sells, lamports; tokens bought and sold, base units. */
  solSpent: Amount;
  solReceived: Amount;
  tokensBought: Amount;
  tokensSold: Amount;
  /** When it last traded or followed the price (unix seconds; 0: not yet). */
  lastAt: number;
}

/** The kinds of game a companion runs (the companion's `GameKind`): the lottery (phase 1), the last-buyer jackpot and the holding streak (phase 2). */
export type GameKindName = 'lottery' | 'jackpot' | 'streak' | 'strategy';

/**
 * A game coin's game as the launch request names it: a lottery on Bordrless's lottery hook, or a
 * jackpot or a streak on a game hook made in Studio (docs/games.md "Phase 2"), whose config the
 * request's `config` must name (the kind's settings are the hook's constants: the timer and the
 * minimum buy, the epoch, the minimum streak and weight; `ConfigInspection.game` shows them).
 */
export type GameRequest = LotteryRequest | JackpotRequest | StreakRequest;

/** A jackpot coin's game as the launch request names it (`create_game_v2`): the pot's part, the minimum pot and what a settle pays; the timer and the minimum buy are the hook's. */
export interface JackpotRequest {
  kind: 'jackpot';
  potBps: number;
  /** A round is paid only while the pot holds at least this, lamports: 0.1 to 1,000 SOL (a round settled below it pays nothing). */
  minPotLamports: Amount;
  /** The part of the pot a settle pays the last buyer, basis points: 10% to 100%. */
  prizeBps: number;
}

/** A streak coin's game as the launch request names it (`create_game_v2`): the pot's part, the minimum pot, what an epoch shares and the least a close leaves for claims; the epoch, the minimum streak and weight are the hook's. */
export interface StreakRequest {
  kind: 'streak';
  potBps: number;
  /** An epoch is closed only while the pot holds at least this, lamports: 0.1 to 1,000 SOL. */
  minPotLamports: Amount;
  /** The part of the pot an epoch shares among its holders, basis points: 10% to 100%. */
  prizeBps: number;
  /** The least a close leaves for claims, seconds: 5 minutes to a day, at most half an epoch. */
  claimWindowSecs: number;
}

/**
 * A lottery coin's game as the launch request names it (docs/games.md "The companion's game"):
 * every setting `create_game` fixes before the launch. Bounds: `LOTTERY_LIMITS` (`lotteryProblem`).
 */
export interface LotteryRequest {
  kind: 'lottery';
  /** A round's length, seconds: an hour to 30 days. Every holder's tokens held since a round began are their tickets in it. */
  roundSecs: number;
  /** The pot's part of every creator fee claim, basis points: with the split's buyback and launcher parts it adds up to 10,000. */
  potBps: number;
  /** No draw while the pot holds less, lamports: 0.1 to 1,000 SOL. */
  minPotLamports: Amount;
  /** The part of the pot one draw pays, basis points: 10% to 100%. */
  prizeBps: number;
  /** How long each claim attempt stays open, seconds: 5 minutes to a day. */
  claimWindowSecs: number;
  /** Attempts a draw makes before it rolls over, 1 to 16; all of them within half a round. */
  maxAttempts: number;
}

/** A game coin's settings as its token page shows them (`CompanionSummary.game`): fixed at the launch, and the hook's terms. A jackpot's and a streak's kind settings (phase 2) are the hook's. */
export interface GameSummary {
  kind: GameKindName;
  /** The game's account, `PDA(["game", mint])` under the companion program. */
  address: Address;
  /** The coin's token hook, which keeps the tickets (the lottery hook, or a game hook made in Studio). */
  hook: Address;
  /** A lottery's round, a streak's epoch; 0 for a jackpot. */
  roundSecs: number;
  potBps: number;
  minPot: Amount;
  prizeBps: number;
  /** A lottery's claim attempt window, the least a streak's close leaves for claims; 0 for a jackpot. */
  claimWindowSecs: number;
  /** A lottery's attempts per draw; 0 otherwise. */
  maxAttempts: number;
  /** Jackpot: a round ends this long after its last qualifying buy, and the least a qualifying buy delivers (base units). Absent or 0 for the other kinds. */
  timerSecs?: number;
  minTokens?: Amount;
  /** Streak: by an epoch's end a holding must have sent nothing for this long, and the least weight that shares (base units). Absent or 0 for the other kinds. */
  minStreakSecs?: number;
  minWeight?: Amount;
  /** The most the pot may hold while the hook is not audited (lamports); null for an audited hook. */
  potCap: Amount | null;
  audited: boolean;
  /** Bordrless stopped this hook's games: the pot and its share go to the buyback and are burned. */
  blocked: boolean;
  /** Prizes paid so far, lamports, and how many. */
  prizesTotal: Amount;
  prizesPaid: number;
}

/** Why a round paid no prize (the companion's `RolloverReason`). */
export type GameRolloverReason = 'noTickets' | 'roundForgotten' | 'noClaim' | 'oracleSilent' | 'blocked' | 'late' | 'oracleUnreadable' | 'oracleUnpaid';

/** One round's draw as the indexer saw it (`GameStatus.draws`), newest first. */
export interface GameDraw {
  round: number;
  /** When the round ended (its tickets final), unix seconds. */
  roundEndsAt: number;
  /** `requested`: ORAO asked; `revealed`: its answer stored, claims open; `paid`: the prize paid; `rolledOver`: no prize. */
  status: 'requested' | 'revealed' | 'paid' | 'rolledOver';
  /** The round's ticket total, base units. */
  total: Amount;
  /** ORAO's request account for the round's seed; null when no seed was committed. */
  request: Address | null;
  winner: Address | null;
  /** Lamports paid; null unless paid. */
  prize: Amount | null;
  /** The ticket attempt that paid, 0-based; null unless paid. */
  attempt: number | null;
  reason: GameRolloverReason | null;
  /** The transaction of the draw's last step, and when it landed. */
  signature: string;
  at: number | null;
}

/** The caller's place in the current round (`GameStatus.you`, with `?wallet=`). */
export interface GameYou {
  wallet: Address;
  /** Tokens the wallet holds, base units. */
  balance: Amount;
  /** Its tickets in the current round, base units (its range's weight); 0 until it is written this round. */
  tickets: Amount;
  /** The wallet's holding has been written this round (it traded, or was entered): its tickets are registered. */
  entered: boolean;
  /** Its share of the round's tickets so far, 0 to 1; null without tickets. */
  odds: number | null;
  /** Its tickets in the round before (the one a draw may be for now). */
  previousTickets: Amount;
  /** A jackpot (phase 2): the wallet's place in it. Absent for the other kinds. */
  jackpot?: JackpotYou | null;
  /** A streak (phase 2): the wallet's weight and share. Absent for the other kinds. */
  streak?: StreakYou | null;
}

/** The caller's place in a jackpot (`GameYou.jackpot`). */
export interface JackpotYou {
  /** The number of the wallet's first qualifying buy since it last sent anything; '0' after any send (the mark). */
  mark: Amount;
  /** The wallet is the current round's last qualifying buyer. */
  lastBuyer: boolean;
  /** Among the rounds over and not settled, those this wallet would be paid for if settled now (it still holds what it bought). */
  wins: number;
}

/** The caller's place in a streak (`GameYou.streak`). */
export interface StreakYou {
  /** The wallet's weight in the current epoch, base units ('0' until registered: `enter` registers it, a trade writes it). */
  weight: Amount;
  /** Whether a holding that sends nothing until the epoch's end will share (it has held long enough, at least the minimum weight). */
  qualifies: boolean;
  /** The claim epoch (the one open for claims): the wallet's weight in it and the share it can claim now, lamports; '0' after a claim or a send. */
  claimWeight: Amount;
  claimShare: Amount;
  /** The wallet's receipt of the claim epoch exists: its share was paid. */
  claimed: boolean;
}

/** A jackpot round as the status lists it (`JackpotStatus.open`, `JackpotStatus.rounds`): its number, buyer, the amount bought and when, and what became of it. */
export interface JackpotRound {
  /** The round's number: that of its last qualifying buy. */
  number: number;
  buyer: Address;
  amount: Amount;
  /** When its last qualifying buy landed (its timer ran out `timerSecs` later). */
  boughtAt: number;
  /** `open`: over, not settled yet; `paid`; `unfunded`: closed paying nothing (the pot below its minimum); `forfeited`: the buyer sold or sent, or can't be paid. */
  status: 'open' | 'paid' | 'unfunded' | 'forfeited';
  prize: Amount | null;
  reason: 'notHeld' | 'unpayable' | 'stale' | null;
  signature: string | null;
  at: number | null;
}

/** A jackpot coin's live state (`GameStatus.jackpot`, docs/games.md "The jackpot"). */
export interface JackpotStatus {
  /** The current round's last qualifying buyer, what they bought and when; null before the first qualifying buy. */
  lastBuyer: Address | null;
  lastAmount: Amount;
  lastBuyAt: number | null;
  /** When the current round's timer runs out (the last buyer is paid if they still hold); null without a buy. */
  timerEndsAt: number | null;
  /** Qualifying buys so far (the current round's number), and the last round settled. */
  buys: number;
  paidBuys: number;
  /** Buys count only while the coin is on its curve: once graduated, the jackpot ends (the round under way is still paid). */
  onCurve: boolean;
  /** Rounds over and not settled yet, oldest first (a keeper settles them within seconds). */
  open: JackpotRound[];
  /** Rounds settled, as the indexer saw them, newest first. */
  rounds: JackpotRound[];
}

/** A streak epoch as the status lists it (`StreakStatus.epochs`): what the indexer saw of it. */
export interface StreakEpoch {
  epoch: number;
  epochEndsAt: number;
  /** `closed`: its pot fixed, claims open; `ended`: claims over; `rolledOver`: no pot (no weight, or closed too late). */
  status: 'closed' | 'ended' | 'rolledOver';
  /** Its weight total and its pot, lamports. */
  total: Amount;
  pot: Amount;
  /** Paid out so far, lamports, and how many claims. */
  paid: Amount;
  claims: number;
  signature: string | null;
  at: number | null;
}

/** A streak coin's live state (`GameStatus.streak`, docs/games.md "The streak"). */
export interface StreakStatus {
  /** The claim epoch: the one whose claims are open, its pot, total, what it paid so far and when its claims end; null while none is open. */
  claim: { epoch: number; pot: Amount; total: Amount; paid: Amount; claimsEndAt: number } | null;
  /** The epoch before the current one: over, not closed yet (a keeper closes it); null once closed or rolled over. */
  closing: { epoch: number; total: Amount; closeBy: number } | null;
  /** Epochs closed, ended or rolled over, as the indexer saw them, newest first. */
  epochs: StreakEpoch[];
}

/** A game coin's live state (`CompanionStatus.game`, docs/games.md): the pot, the round (a streak's epoch), the caller's place in it and the history. A lottery's draw and draws; a jackpot's and a streak's under their own names. */
export interface GameStatus extends GameSummary {
  /** Bridged SOL the pot holds, lamports. */
  pot: Amount;
  /** Chain time the status was read at, unix seconds. */
  now: number;
  /** The current round (`floor(now / roundSecs)`) and when it ends. */
  round: number;
  roundEndsAt: number;
  /** Tickets registered in the current round so far, base units (the hook's header). */
  tickets: Amount;
  /** The round before, and its tickets: what the next draw is for once the round ends. */
  previousRound: number;
  previousTickets: Amount;
  /** The least the pot must hold for a round to be drawn (the minimum, or the cap when lower; 0.1 SOL once dormant). */
  drawThreshold: Amount;
  /** The draw in progress, when one is. */
  draw: { round: number; status: 'requested' | 'revealed'; request: Address; prize: Amount; revealedAt: number | null; claimsEndAt: number } | null;
  lastWinner: Address | null;
  you: GameYou | null;
  draws: GameDraw[];
  /** A jackpot's live state (phase 2); absent or null for the other kinds. */
  jackpot?: JackpotStatus | null;
  /** A streak's live state (phase 2); absent or null for the other kinds. */
  streak?: StreakStatus | null;
}

/** `POST /v1/game/claim/prepare`: a streak holder's own `claim_share` of the claim epoch (docs/games.md "The streak"): paid to the wallet, which pays its receipt's rent (back once the epoch's claims end, `close_receipt`). */
export interface GameClaimRequest {
  wallet: Address;
  mint: Address;
}

export interface GameClaimResponse {
  transactions: PreparedTx[];
  /** The epoch claimed and the share it pays, lamports (before the sender's bounty, which is the wallet's own here). */
  epoch: number;
  share: Amount;
}

/** `POST /v1/game/enter/prepare`: a holder's own `enter` (docs/games.md): their whole balance registered as tickets for the current round, when the holding was not written this round yet. */
export interface GameEnterRequest {
  wallet: Address;
  mint: Address;
}

export interface GameEnterResponse {
  transactions: PreparedTx[];
  /** The round the tickets count in. */
  round: number;
}

/** The companion templates (`COMPANION_SPLITS`; `COMPANION_TEMPLATES` in the SDK). */
export type CompanionTemplate = 'buysItself' | 'rugProofDev' | 'buybackAndReward';

/** What a companion does with every creator fee it claims, in basis points summing to 10,000. */
export interface CompanionSplitBps {
  /** Bought back on the token's own pool and burned. */
  buybackBps: number;
  /** Streamed to holders through the kit (the launch has holder rewards). */
  holdersBps: number;
  /** Paid to the launcher (the beneficiary), in SOL. */
  beneficiaryBps: number;
}

/**
 * A launch's companion as a list names it (2026-10-12): what takes its creator fee, fixed at launch, without
 * the live figures (`CompanionSummary` has those), so a card can say "Snowball 2%" without reading the chain.
 */
export interface CompanionTag {
  split: CompanionSplitBps;
  /** The game it runs and the pot's part of every fee claim; null without a game. */
  game: { kind: GameKindName; potBps: number } | null;
  /** A Snowball: its pot makes a market in the token (its part of the fee is what the split leaves). */
  snowball: boolean;
  /** A custom companion (2026-10-12): a Workshop script spends its pot. Absent from tags stored before scripts. */
  script?: boolean;
  /** A Lossback coin (docs/loss-cover.md): its script is the Loss cover script. Absent from tags stored before Lossback, and from every other tag. */
  lossCover?: boolean;
}

/** A launch's companion as its token page shows it (`LaunchDetail.companion`): lamports and token base units as strings. */
export interface CompanionSummary {
  /** The companion's account, `PDA(["companion", mint])` under the companion program. */
  address: Address;
  /** The wallet that launched it: paid its part of the fees, and the dev bag as it vests. */
  beneficiary: Address;
  /** The template whose split this is; null for another split. */
  template: CompanionTemplate | null;
  split: CompanionSplitBps;
  /** Creator fees the companion has claimed, all time. */
  claimed: Amount;
  /** Spent buying the token back on its pool. */
  boughtBack: Amount;
  /** Tokens those buybacks burned. */
  burned: Amount;
  /** Shared with holders through the kit. */
  shared: Amount;
  /** Paid to the launcher. */
  paidToLauncher: Amount;
  /** Claimed and waiting for its step: the next buyback, the next share, the launcher's next payout. */
  pending: { buyback: Amount; holders: Amount; launcher: Amount };
  /** The launcher's first buy, held by the companion: its tokens, the part vested now, the part sent to the launcher, and when the vest ends; null without one. */
  devBag: { total: Amount; vested: Amount; released: Amount; vestEndsAt: number } | null;
  /** When the next buyback may run while SOL waits for one (it also waits while the price runs above its reference); null otherwise. */
  nextBuybackAt: number | null;
  /** The lottery this companion runs (docs/games.md): its settings and the hook's terms; null for a companion without a game. */
  game: GameSummary | null;
  /** A Snowball's market maker (2026-10-12); null for any other companion. */
  snowball: SnowballSummary | null;
  /** A custom companion's script (2026-10-12, docs/scripts.md); null for any other companion; absent from older servers. */
  script?: ScriptSummary | null;
  /** A Lossback coin's figures (docs/loss-cover.md); null for any other companion (a Lossback coin's `script` is set too); absent from older servers. */
  lossCover?: LossCoverSummary | null;
  /** The wallets that share the launcher's part (`set_payees`, 2026-10-13); null for a companion without payees (or whose payees can't be read); absent from older servers. */
  payees?: PayeeSummary[] | null;
}

/**
 * `GET /v1/companion/:mint`: a mint's companion as a launch that may not have finished needs it.
 * `none`: no companion was set up for the mint; `set-up`: set up, its launch not made (its funding
 * can be taken back, `refundable`); `launched`.
 */
export interface CompanionStatus {
  mint: Address;
  state: 'none' | 'set-up' | 'launched';
  /** The wallet it pays; null with none. */
  beneficiary: Address | null;
  /** Lamports a refund returns now; null unless `set-up`. */
  refundable: Amount | null;
  /** The lottery this companion runs, live (docs/games.md), the caller's tickets with `?wallet=`; null for a companion without a game (absent from older servers). */
  game?: GameStatus | null;
  /** A custom companion's script, once launched (docs/scripts.md); null for any other companion (absent from older servers, and before the launch). */
  script?: ScriptSummary | null;
  /** A Lossback coin's figures, once launched (docs/loss-cover.md); null for any other companion (absent from older servers, and before the launch). */
  lossCover?: LossCoverSummary | null;
}

/** `POST /v1/companion/refund/prepare`: a companion's funding back to the wallet that set it up, for a launch that never happened. The mint's key signs it after the wallet. */
export interface CompanionRefundRequest {
  wallet: Address;
  mint: Address;
}

export interface CompanionRefundResponse {
  transaction: PreparedTx;
  /** Lamports it returns. */
  refundable: Amount;
}

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
  /**
   * The platform token on the overview only: base units bought back from protocol revenue and held
   * by the treasury (docs page /docs/tokenomics): its holding of the bridged version, plus the SPL
   * version it holds that is still to be bridged. Read live from the chain; null when it could not
   * be read. Absent from backends that predate it and from any other asset.
   */
  boughtBack?: Amount | null;
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

// ---- creating a pool (docs/dex.md §3) ------------------------------------------------------------------
//   POST /v1/pool/quote               -> PoolCreateQuote
//   POST /v1/pool/prepare             -> PoolCreatePrepareResponse
//   POST /v1/lp/burn/prepare          -> LpBurnPrepareResponse
//   POST /v1/token/authority/prepare  -> AuthorityPrepareResponse

/** Which of a mint's four authorities (`set_authority`'s kinds). */
export type MintAuthorityKind = 'mint' | 'freeze' | 'hook' | 'metadata';

/** One fact of a mint's risk label (docs/dex.md §6.2), in the words every surface uses. */
export interface MintRiskReason {
  kind: 'hook_missing' | 'hook_authority' | 'freeze_authority' | 'mint_authority' | 'hook' | 'metadata_authority' | 'fixed';
  severity: 'low' | 'medium' | 'high';
  words: string;
}

/** A mint's risk label: the highest severity, its first sentence, every reason, and the authorities still held (and by whom). */
export interface MintRisk {
  severity: 'low' | 'medium' | 'high';
  words: string;
  reasons: MintRiskReason[];
  /** The authorities still set on the mint, each with its key. */
  held: { kind: MintAuthorityKind; authority: Address }[];
}

/** The base token of a pool to be created, as the mint account has it. */
export interface PoolCreateToken {
  mint: Address;
  symbol: string;
  name: string;
  decimals: number;
  image: string | null;
  supply: Amount;
  /** 0 when unlimited. */
  maxSupply: Amount;
  creator: Address;
  hookProgram: Address | null;
  /** How the site names it (from addresses, never from names): a launch of the launchpad, a bridged asset, or a free mint. */
  identity: 'launch' | 'bridged' | 'free';
}

/** A pool of the same pair that exists already: the depth, the price and the tier. */
export interface ExistingPool {
  pool: Address;
  lpFeeBps: number;
  hookProgram: Address | null;
  /** The launchpad made it: its launch pool. */
  launch: boolean;
  curve: boolean;
  baseReserve: Amount;
  quoteReserve: Amount;
  /** Whole quote per whole token; null while the pool has no reserves. */
  priceQuote: number | null;
  tvlUsd: number | null;
}

export interface PoolCreateQuoteRequest {
  baseMint: Address;
  /** One of `POOL_FEE_TIERS_BPS`. */
  lpFeeBps: number;
  /** The wallet, for its balances; the quote stands without one. */
  owner?: Address;
  /** Base units of the token to deposit. */
  baseAmount?: Amount;
  /** Lamports of SOL (bridged in the same transaction) to deposit. */
  quoteAmount?: Amount;
}

/** The first deposit as quoted: the price it sets, the LP it mints and the FDV it implies. */
export interface PoolCreateDeposit {
  baseAmount: Amount;
  quoteAmount: Amount;
  /** `isqrt(base · quote) − 1,000`, 9 decimals. */
  lpAmount: Amount;
  /** Whole SOL per whole token. */
  priceQuote: number;
  /** Fully diluted value in lamports (the price times `maxSupply`, or `supply` when unlimited), as a decimal string. */
  fdvLamports: Amount;
  fdvUsd: number | null;
}

export interface PoolCreateQuote {
  token: PoolCreateToken;
  quoteMint: Address;
  quoteSymbol: string;
  quoteDecimals: number;
  lpFeeBps: number;
  /** The DEX config's flat protocol rate of the quote side, which the new pool copies at creation. */
  protocolFeeBps: number;
  /** The pool this pair, tier and no hook would live at. */
  pool: Address;
  lpMint: Address;
  /** That pool, when it exists already (the form then offers to add liquidity instead). */
  exists: ExistingPool | null;
  /** Every other pool of the pair (the launch pool, other tiers, hooked ones), deepest first. */
  otherPools: ExistingPool[];
  /** The wallet's balances, with an owner. */
  balances: { lamports: Amount; base: Amount; bridgedSol: Amount } | null;
  deposit: PoolCreateDeposit | null;
  risk: MintRisk;
  /** Rent the creator pays for the new accounts (the pool, the LP mint, two vaults, the LP holding, and the quote holding when missing). */
  rentLamports: Amount;
  solUsd: number | null;
}

export interface PoolCreatePrepareRequest {
  owner: Address;
  baseMint: Address;
  lpFeeBps: number;
  baseAmount: Amount;
  quoteAmount: Amount;
  /** Burn the LP in a second transaction, a permanent lock (docs/dex.md §5.1). */
  burnLp?: boolean;
}

export interface PoolCreatePrepareResponse {
  transactions: PreparedTx[];
  quote: PoolCreateQuote;
  pool: Address;
  lpMint: Address;
}

/** Burn LP of a pool the wallet holds: all of it, or `amount` (9 decimals). */
export interface LpBurnPrepareRequest {
  owner: Address;
  pool: Address;
  amount?: Amount;
}

export interface LpBurnPrepareResponse {
  transactions: PreparedTx[];
  /** LP burned, 9 decimals. */
  amount: Amount;
}

/** Revoke authorities the wallet holds on a mint, for ever (`set_authority(kind, None)` for each). */
export interface AuthorityPrepareRequest {
  owner: Address;
  mint: Address;
  kinds: MintAuthorityKind[];
}

export interface AuthorityPrepareResponse {
  transactions: PreparedTx[];
  kinds: MintAuthorityKind[];
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


// ---- accounts and trading wallets --------------------------------------------------------------------
//   POST /v1/account/session                 -> AccountSessionResponse        the signup wallet signs `accountSignInMessage`
//   GET  /v1/account/wallets                  -> AccountWallets                the session's trading wallets (public keys only)
//   POST /v1/account/wallets                  -> AccountWallets                register one; the trading wallet co-signs `tradingWalletMessage`
//   POST /v1/account/wallets/:pubkey/revoke   -> AccountWallets
//   POST /v1/account/withdraw/prepare         -> AccountWithdrawPrepareResponse a plain SOL transfer from a registered trading wallet
//   POST /v1/account/withdraw/send            -> AccountWithdrawSendResponse    the signed transfer, sent and followed
//
// An account is a wallet: the one a visitor connected (their signup wallet), or, without one, a
// trading wallet generated in their browser. Trading wallets are keypairs made and kept in the
// browser; Bordrless stores their public keys and labels under the account, never a secret.

/** Trading wallets an account may have registered at once. */
export const MAX_TRADING_WALLETS = 5;

/** The header the account session travels in, browser → site proxy → backend. The same token serves Studio (`STUDIO_SESSION_HEADER`). */
export const ACCOUNT_SESSION_HEADER = 'x-studio-session';

/** The message a wallet signs to sign in to Bordrless: no transaction, nothing moves. */
export function accountSignInMessage(wallet: Address, nonce: string, issuedAt: string): string {
  return ['Sign in to Bordrless', '', 'This signature proves you own this wallet. It does not move funds or approve any transaction.', '', `Wallet: ${wallet}`, `Nonce: ${nonce}`, `Issued: ${issuedAt}`].join('\n');
}

/** The message a trading wallet signs to be registered under an account: proof the key exists and is held by whoever holds the account. */
export function tradingWalletMessage(account: Address, publicKey: Address): string {
  return ['Bordrless trading wallet', '', 'This wallet was generated in your browser for trading on Bordrless and belongs to the account below.', '', `Account: ${account}`, `Wallet: ${publicKey}`].join('\n');
}

export interface AccountSessionRequest {
  wallet: Address;
  /** The exact message signed (`accountSignInMessage`). */
  message: string;
  /** Base58 ed25519 signature of the message's UTF-8 bytes. */
  signature: string;
}

export interface AccountSessionResponse {
  token: string;
  wallet: Address;
  /** Unix seconds. */
  expiresAt: number;
}

export interface AccountWallet {
  publicKey: Address;
  label: string;
  /** Unix seconds. */
  createdAt: number;
  revokedAt: number | null;
}

export interface AccountWallets {
  account: Address;
  /** Active registrations, oldest first. */
  wallets: AccountWallet[];
  max: number;
}

export interface AccountWalletRegisterRequest {
  publicKey: Address;
  /** At most 32 characters. */
  label: string;
  /** Base58 ed25519 signature by `publicKey` of `tradingWalletMessage(account, publicKey)`. */
  signature: string;
}

/** A plain SOL transfer out of a registered trading wallet (to the signup wallet, usually). */
export interface AccountWithdrawPrepareRequest {
  /** The trading wallet that pays and signs. */
  wallet: Address;
  to: Address;
  lamports: Amount;
}

export interface AccountWithdrawPrepareResponse {
  transactions: PreparedTx[];
  /** The network fee the transfer pays, lamports. */
  feeLamports: Amount;
}

export interface AccountWithdrawSendRequest {
  /** Base64 of the signed transaction from `AccountWithdrawPrepareResponse`. */
  transaction: string;
}

export interface AccountWithdrawSendResponse {
  signature: string;
  state: 'confirmed' | 'failed' | 'expired' | 'pending';
  error: string | null;
}

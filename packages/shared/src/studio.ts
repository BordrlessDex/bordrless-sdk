/**
 * Studio and the config marketplace: the shapes the site and the backend exchange.
 *
 * Studio is where anyone designs a launch config, and optionally a token hook of their own, with an
 * assistant that knows the Bordrless programs; has it reviewed; pays the rent for Bordrless to build
 * and deploy the hook (Bordrless keeps its upgrade authority: the creator never holds it); makes the
 * config; and may list it on the marketplace, where every launch someone else makes from it pays
 * them half its creator fee, if it has one (`AUTHOR_SHARE_BPS`, `create_listed_config`,
 * docs/hooks-v2.md §5.7). That half is all a creator gets from listing.
 *
 * A Studio hook is written against one template (`STUDIO_TEMPLATE`): an Anchor program with a fixed
 * `Cargo.toml` and the standard `prepare` (`STUDIO_PREPARE`), so the site can prepare any Studio hook
 * for a new mint without knowing its code. The backend refuses source that leaves the template's
 * limits (`StaticCheck`) before it is built, reviewed or paid for.
 */
import type { Address, HookAbout, PreparedTx } from './api.ts';
import { TOKEN_HOOK_FLAGS as HOOK_FLAG_BITS } from './programs.ts';

// ---- projects ---------------------------------------------------------------------------------------

/** One source file of a hook. Only `src/**.rs` files; `Cargo.toml` is the template's and never sent. */
export interface StudioFile {
  /** Relative path, e.g. `src/lib.rs`. */
  path: string;
  content: string;
}

/**
 * What a project becomes: a config of existing rules alone, or a config with its own hook program.
 * A hook project whose state starts with the game ticket standard's header is a game hook
 * (docs/games.md "Phase 2"): read from its source (`detectGameSettings`), never chosen, and its
 * config launches a jackpot, streak or lottery coin through the companion.
 */
export type StudioKind = 'config' | 'hook';

/** The kinds of game a game hook keeps the score of (the companion's `GameKind`). */
export type StudioGameKind = 'lottery' | 'jackpot' | 'streak';
export const STUDIO_GAME_KINDS: readonly StudioGameKind[] = ['lottery', 'jackpot', 'streak'];

/**
 * A game hook's companion draft (docs/games.md "The companion's game", phase 2): what the launch
 * fixes with `create_game_v2` besides the hook's own constants. The split with the pot: the pot's
 * part and the buyback's, the launcher's what is left (no holders' part: a game coin has no kit).
 * The kind's settings (the timer, the minimum buy; the epoch, the minimum streak and weight; a
 * lottery's rounds) are the hook's constants, read from its source (`detectGameSettings`), never
 * typed: the companion checks them against the hook's kind header.
 */
export interface StudioGameDraft {
  potBps: number;
  buybackBps: number;
  /** No settle, close or draw while the pot holds less: 0.1 to 1,000 SOL. */
  minPotLamports: string;
  /** The part of the pot a settle, an epoch or a draw pays: 10% to 100%. */
  prizeBps: number;
  /** Streak: the least a close leaves for claims (5 minutes to a day, at most half an epoch); lottery: each attempt's window; 0 for a jackpot. */
  claimWindowSecs: number;
  /** Lottery only: attempts per draw (1 to 16); 0 otherwise. */
  maxAttempts: number;
}

/**
 * A game hook's kind and settings as its source fixes them (p2-n: the starters' settings are their
 * code's): the state struct's first field is the crate's `GameHeader`, its second the kind header
 * (`JackpotHeader` / `StreakHeader`; neither: a lottery), and the settings are what the headers are
 * made with (`JackpotHeader::new(timer, min_tokens)`, `StreakHeader::new(min_streak, min_weight)`,
 * `GameHeader::new(mint, round_secs, now)`). Amounts are base units as strings.
 */
export interface StudioGameSettings {
  kind: StudioGameKind;
  /** Jackpot: a round ends this long after its last qualifying buy. 0 otherwise. */
  timerSecs: number;
  /** Jackpot: the least a qualifying buy delivers. '0' otherwise. */
  minTokens: string;
  /** Streak: the epoch; lottery: the round. 0 for a jackpot. */
  roundSecs: number;
  /** Streak: by an epoch's end a holding must have sent nothing for this long. 0 otherwise. */
  minStreakSecs: number;
  /** Streak: the least weight that shares. '0' otherwise. */
  minWeight: string;
}

/** The hook flags every game hook runs on: `BEFORE_TRANSFER | BEFORE_BURN | WRITES_HOOK_DATA` (`GameKind::hook_flags`, 145), the only set the companion's launch accepts. */
export const GAME_HOOK_FLAGS = 145;

/**
 * The companion draft a game hook starts with (the docs' examples: 70% of the fee to the pot, 30%
 * bought back; a jackpot paying half the pot from 0.5 SOL; a streak sharing the whole pot from 0.1
 * SOL with an hour at least for claims; a lottery paying the whole pot from 0.5 SOL, 8 attempts of
 * 10 minutes).
 */
export function gameDraftDefaults(kind: StudioGameKind): StudioGameDraft {
  if (kind === 'jackpot') return { potBps: 7_000, buybackBps: 3_000, minPotLamports: '500000000', prizeBps: 5_000, claimWindowSecs: 0, maxAttempts: 0 };
  if (kind === 'streak') return { potBps: 7_000, buybackBps: 3_000, minPotLamports: '100000000', prizeBps: 10_000, claimWindowSecs: 3_600, maxAttempts: 0 };
  return { potBps: 7_000, buybackBps: 3_000, minPotLamports: '500000000', prizeBps: 10_000, claimWindowSecs: 600, maxAttempts: 8 };
}

/** The launch config a project makes (the arguments of `create_config` / `create_listed_config`). */
export interface StudioConfigDraft {
  /** At most 32 bytes. */
  label: string;
  creatorFeeBps: number;
  burnBuyBps: number;
  burnSellBps: number;
  /** Kit rules, for a `config` project only (a hook of one's own excludes them). */
  holderFeeBuyBps: number;
  holderFeeSellBps: number;
  maxWalletBps: number;
  creatorLockDays: number;
  earlyWindowSecs: number;
  earlyLockSecs: number;
  /** `TOKEN_HOOK_FLAGS` the hook runs on, for a `hook` project; 0 for a `config` project. */
  hookFlags: number;
  /** List it on the marketplace (made with `create_listed_config`). Never for a game hook: the companion refuses a config that pays an author. */
  listed: boolean;
  /** A game hook's companion draft (the split with the pot, the minimum pot, the prize, the claim window); null or absent otherwise. The backend fills it with the kind's defaults when the source becomes a game hook. */
  game?: StudioGameDraft | null;
  /**
   * The author's share of the creator fee on others' launches, bps of it. Not the author's to choose:
   * the backend holds it at `AUTHOR_SHARE_BPS` when listed and 0 when not, whatever is sent.
   */
  authorShareBps: number;
}

/** Where a project stands, in the order the Studio walks it. */
export type StudioStage = 'draft' | 'reviewed' | 'built' | 'paid' | 'deploying' | 'deployed' | 'configured' | 'listed';

export interface StudioProjectSummary {
  id: string;
  owner: Address;
  name: string;
  kind: StudioKind;
  stage: StudioStage;
  /** The deployed hook, once deployed. */
  programId: Address | null;
  /** The config made from it, once made. */
  config: Address | null;
  updatedAt: number;
}

export interface StudioProject extends StudioProjectSummary {
  /** A one-paragraph description, shown on the marketplace when listed. */
  description: string;
  files: StudioFile[];
  draft: StudioConfigDraft;
  /**
   * A hook project's game, as its source reads (`detectGameSettings`): its kind and the constants
   * the companion will check against the hook's kind header. Null when the source is not a game
   * hook (no `GameHeader` state, or settings that can't be read); absent for a config project.
   */
  game?: StudioGameSettings | null;
  /** The last review of the current source; null when the source changed since. */
  review: StudioReview | null;
  /** The last build of the current source; null when the source changed since. */
  build: StudioBuild | null;
  deploy: StudioDeploy | null;
  createdAt: number;
}

export interface StudioProjectCreateRequest {
  name: string;
  kind: StudioKind;
  /** Start from a template (`STUDIO_STARTERS`), or blank; the game starters make a game hook. */
  starter?: string;
}

/** A save: any of the fields; files replace the whole set. Changing files drops the review and the build. */
export interface StudioProjectUpdateRequest {
  name?: string;
  description?: string;
  files?: StudioFile[];
  draft?: Partial<StudioConfigDraft>;
}

// ---- sign-in ----------------------------------------------------------------------------------------

/** `POST /v1/studio/session`: the wallet signs `message` (from `studioSignInMessage`), the backend answers a session token. */
export interface StudioSessionRequest {
  wallet: Address;
  /** The exact message signed. */
  message: string;
  /** Base58 ed25519 signature of the message's UTF-8 bytes. */
  signature: string;
}

export interface StudioSessionResponse {
  token: string;
  wallet: Address;
  expiresAt: number;
  /** What the assistant still allows this wallet today. */
  quota: StudioQuota;
}

export interface StudioQuota {
  /** Assistant messages left today (UTC). */
  messagesLeft: number;
  messagesPerDay: number;
  /** The assistant is off for everyone (no key, or today's budget spent). */
  assistantOff: boolean;
}

/** The message a wallet signs to use Studio: no transaction, nothing moves. */
export function studioSignInMessage(wallet: Address, nonce: string, issuedAt: string): string {
  return ['Sign in to Bordrless Studio', '', 'This signature proves you own this wallet. It does not move funds or approve any transaction.', '', `Wallet: ${wallet}`, `Nonce: ${nonce}`, `Issued: ${issuedAt}`].join('\n');
}

/** The header the session token travels in, browser → site proxy → backend. */
export const STUDIO_SESSION_HEADER = 'x-studio-session';

// ---- the assistant ----------------------------------------------------------------------------------

export interface StudioMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Markdown. An assistant message may carry proposals (below) as fenced blocks. */
  content: string;
  at: number;
  /** For an assistant message: the changes it proposes, parsed from its fenced blocks. */
  proposal: StudioProposal | null;
}

/**
 * What an assistant reply proposes: whole files (```rust file=src/lib.rs fences) and config
 * fields (a ```json studio-config fence). The Studio shows them as a diff to apply or dismiss.
 */
export interface StudioProposal {
  files: StudioFile[];
  draft: Partial<StudioConfigDraft> | null;
  /** Applied by the user (the project's files or draft were replaced by it). */
  applied: boolean;
}

/** `POST /v1/studio/projects/:id/chat`: one user message; the reply is produced in the background. */
export interface StudioChatRequest {
  content: string;
}

export interface StudioChatResponse {
  job: string;
  /** The user's message as stored. */
  message: StudioMessage;
  quota: StudioQuota;
}

/** `GET /v1/studio/chat/:job`: the reply so far; poll until `state` is not `running`. */
export interface StudioChatJob {
  job: string;
  state: 'running' | 'done' | 'failed';
  /** The reply's text so far (all of it once done). */
  text: string;
  /** Once done: the stored message, its proposal parsed. */
  message: StudioMessage | null;
  error: string | null;
}

// ---- review and build -------------------------------------------------------------------------------

/** One of the template's limits, checked on the source before anything else (no model involved). */
export interface StaticCheck {
  id: string;
  ok: boolean;
  /** What is checked, in words. */
  label: string;
  /** Where it failed: `src/lib.rs:42` and the offending text. */
  detail: string | null;
}

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface ReviewFinding {
  severity: FindingSeverity;
  title: string;
  detail: string;
  /** `src/lib.rs:42`, when it points at a line. */
  location: string | null;
}

/**
 * `POST /v1/studio/projects/:id/review`: the static checks, then the automated security review (two
 * independent model runs, the worse kept). Every run of a source (and the hook flags read from it,
 * `detectHookFlags`) is kept: the review shown is the worst of them, its findings merged, and a
 * source that failed once stays failed (only a change to the source clears it). Automated checks,
 * not an audit.
 */
export interface StudioReview {
  /** `fail`: a static check failed or a critical/high finding; deploy is refused. The worst of every run of this source and these flags. */
  verdict: 'pass' | 'warn' | 'fail';
  checks: StaticCheck[];
  findings: ReviewFinding[];
  /** A short paragraph: what the hook does, as the reviewer read it. */
  summary: string;
  /** sha256 of the source reviewed. */
  sourceHash: string;
  /** The hook flags the source was reviewed with, read from the source itself (`detectHookFlags`). Absent on reviews made before flags were recorded. */
  hookFlags?: number;
  /** How many review runs of this source and these flags the verdict and findings merge. */
  runs?: number;
  at: number;
}

/** `POST /v1/studio/projects/:id/build`: compiled by the build worker in the verifiable-build image. */
export interface StudioBuild {
  state: 'queued' | 'building' | 'ok' | 'failed';
  /** The program id the source was built for (its `declare_id!`), reserved for this project. */
  programId: Address;
  /** sha256 of the program binary (what `solana-verify get-executable-hash` prints). */
  hash: string | null;
  bytes: number | null;
  /** The compiler's output, its tail. */
  log: string;
  sourceHash: string;
  at: number;
  /** Studio's trading test of what was built (the worker's simulator): a deploy needs `pass`. Absent on builds from before it. */
  sim?: StudioSim | null;
  /**
   * The Studio template's commit the worker built against (40 hex characters; the worker's
   * `STUDIO_TEMPLATE_COMMIT`). Studio's attestation records it, so anyone can rebuild the hook.
   * Absent on builds from before it, or from a worker that does not report it.
   */
  templateCommit?: string | null;
}

/** The simulator's verdict on a build: launched, bought, sold and sent by several wallets over a simulated year. */
export interface StudioSim {
  pass: boolean;
  /** Why it failed, in the simulator's words (the first few). */
  reasons: string[];
  /** The most the hook took from one transfer, in bps, and the cap it was held to. */
  cutMaxBps: number | null;
  capBps: number | null;
  /** Operations the hook refused. */
  refusedTotal: number;
  /** The simulator's version (recorded in Studio's attestation); absent from workers that don't report it. */
  version?: number | null;
  /** What the test can't see (amount triggers, wallets it never used, after a year). */
  notes: string[];
  /** A game hook's scenarios (the jackpot's or the streak's, docs/games-handover.md phase 2 item 4): absent on a hook that is not a game's, or on builds from before them. */
  game?: StudioSimGame | null;
}

/** The simulator's game scenarios on a game hook: the header and the marks or weights checked against a plain model of the rules, and the fairness of the payouts the rules would make. */
export interface StudioSimGame {
  kind: StudioGameKind;
  pass: boolean;
  /** Each check that failed, in the simulator's words (the first few). */
  failed: string[];
  /** Rounds (a jackpot) or epochs (a streak) the scenario ran. */
  periods: number;
  /** The largest difference between a wallet's share of the payouts and its share of what it held, in bps, over the fairness run; null when it did not run. */
  fairnessMaxBps: number | null;
}

// ---- deploy -----------------------------------------------------------------------------------------

/** `POST /v1/studio/projects/:id/deploy/quote`: what deploying the built hook costs, in lamports. */
export interface StudioDeployQuote {
  /** Rent of the program's data account (the binary plus room to upgrade: `maxDataLen`). */
  programDataRent: string;
  /** Rent of the program account. */
  programRent: string;
  /** Transaction fees of writing and deploying it. */
  fees: string;
  /** Bordrless's service fee. */
  service: string;
  total: string;
  maxDataLen: number;
  /** The wallet the payment goes to (Studio's deployer). */
  payTo: Address;
  /** The payment transaction: a plain SOL transfer of `total` with a memo naming this deploy. */
  transactions: PreparedTx[];
  /** The quote holds until then (unix seconds). */
  expiresAt: number;
}

/**
 * The upgrade authority is not part of the request: Bordrless keeps it on every hook Studio deploys
 * (`StudioDeploy.upgradeAuthority`). The creator never holds it, and Studio never makes a program
 * final. The backend ignores an `authority` an older site still sends.
 */
export interface StudioDeployRequest {
  /** The confirmed payment transaction. */
  paymentSignature: string;
}

/** `handing_over`: the program is deployed and its upgrade authority goes from Studio's deployer to Bordrless's upgrade key. */
export type StudioDeployState = 'awaiting_payment' | 'paid' | 'writing' | 'deploying' | 'handing_over' | 'deployed' | 'failed' | 'refunded';

export interface StudioDeploy {
  state: StudioDeployState;
  programId: Address;
  /** Lamports paid, and the payment. */
  paid: string | null;
  paymentSignature: string | null;
  /** Bytes written of the binary, while writing. */
  written: number;
  bytes: number;
  deploySignature: string | null;
  /**
   * Who holds its upgrade authority once deployed: Bordrless's upgrade key (the backend's
   * STUDIO_UPGRADE_AUTHORITY, `STUDIO_UPGRADE_AUTHORITY` above by default), never the creator; null until
   * the deploy finishes.
   */
  upgradeAuthority: Address | null;
  error: string | null;
  refundSignature: string | null;
  at: number;
}

// ---- the config ---------------------------------------------------------------------------------------

/** `POST /v1/studio/projects/:id/config/prepare`: `create_config` or `create_listed_config` for the draft. */
export interface StudioConfigPrepareRequest {
  /** A fresh keypair's address the browser made; it signs after the wallet. */
  config: Address;
}

export interface StudioConfigPrepareResponse {
  config: Address;
  transactions: PreparedTx[];
}

// ---- the marketplace ----------------------------------------------------------------------------------

export interface MarketplaceListing {
  config: Address;
  author: Address;
  /** The config's on-chain label. */
  label: string;
  /** The author's title and description (from Studio), or the label alone. */
  title: string;
  description: string;
  authorShareBps: number;
  creatorFeeBps: number;
  burnBuyBps: number;
  burnSellBps: number;
  holderFeeBuyBps: number;
  holderFeeSellBps: number;
  maxWalletBps: number;
  customHook: Address | null;
  customHookFlags: number;
  /** The hook was built and deployed by Studio from source anyone can read. */
  studioSource: boolean;
  /** Who can upgrade the hook now (null: final, or no hook). */
  hookUpgradeAuthority: Address | null;
  /**
   * The worst verdict of the automated checks over every review run of the deployed source (not an
   * audit, and not a seal); null when Studio did not build the hook or has no review of it.
   */
  reviewVerdict: 'pass' | 'warn' | 'fail' | null;
  /** What its hook does, when Studio built it: Bordrless's summary and the author's words (`HookAbout`); null or absent otherwise. */
  hookAbout?: HookAbout | null;
  launches: number;
  /** Paid to the author so far, lamports. */
  authorEarned: string;
  volumeUsd: number | null;
  createdAt: number;
}

export interface MarketplaceListResponse {
  listings: MarketplaceListing[];
  total: number;
}

export interface MarketplaceDetail extends MarketplaceListing {
  /** The hook's source when Studio built it. */
  files: StudioFile[] | null;
  buildHash: string | null;
  review: StudioReview | null;
  /** Launches made from it, newest first. */
  recentLaunches: { mint: Address; symbol: string; name: string; image: string | null; createdAt: number }[];
}

/** `POST /v1/author/prepare`: a config author's claims of their share, on up to four launches a transaction, paid as SOL. */
export interface AuthorPrepareRequest {
  author: Address;
  /** The launches to claim on; all with something to claim when absent. */
  mints?: Address[];
}

export interface AuthorEarnings {
  author: Address;
  /** Waiting to be claimed on each launch: the author's part of what the launch holds. */
  launches: { mint: Address; symbol: string; config: Address; claimable: string; paid: string }[];
  claimable: string;
  paid: string;
}

// ---- constants ----------------------------------------------------------------------------------------

/** Bordrless Studio's upgrade key: the upgrade authority of every hook Studio deploys (STUDIO_UPGRADE_AUTHORITY defaults to it). */
export const STUDIO_UPGRADE_AUTHORITY = 'CS1NRyXNCPxEUP4CRoa26cHQSeSJCxXh5SPijwFhDW6W';
/** The protocol's own upgrade authority (Half-Life, tax_hook). */
export const PROTOCOL_UPGRADE_AUTHORITY = '5xsibKwtiN6ruxsYrEyWVpV3KcwuzSPbQd1n28a7spEd';
/**
 * `bordrless_launch::constants::HOOK_UPGRADE_AUTHORITIES`: besides no one at all, the only keys that
 * may hold a custom hook's upgrade authority for `create_config` to accept it (docs/hooks-v2.md §5.8).
 */
export const HOOK_UPGRADE_AUTHORITIES: readonly string[] = [STUDIO_UPGRADE_AUTHORITY, PROTOCOL_UPGRADE_AUTHORITY];

/** The one sentence the site gives a config whose hook someone outside Bordrless can upgrade. */
export const HOOK_AUTHORITY_PROBLEM = 'This config’s hook can be upgraded by someone outside Bordrless, so it can’t launch here.';

/** The error code the backend refuses such a config with (`POST /v1/launch/prepare`). */
export const HOOK_AUTHORITY_CODE = 'hook_upgrade_authority';

/** The Solana CLI command that makes a deployed hook immutable (signed by its current upgrade authority): the way a hook built outside Studio can launch. */
export const hookFinalCommand = (program = '<PROGRAM_ID>'): string => `solana program set-upgrade-authority ${program} --final`;

/**
 * The launch program's rule for a config's own hook (`create_config`, docs/hooks-v2.md §5.8), on its
 * upgrade info: accepted when nobody can upgrade it (`upgradeable: false`), when its upgrade
 * authority is one of `HOOK_UPGRADE_AUTHORITIES` (Bordrless Studio's key or the protocol's), or when
 * it is its own `hook_timelock` account (`timelocked`, phase 3a: the caller derives
 * `PDA(["timelock", hook], hook_timelock)` and compares; the launch program also checks the delay). Only a
 * hook some other key is known to be able to upgrade is refused: one whose upgrade info could not be
 * read is not (the launch program checked it when the config was made; the SDK's
 * `hookAuthorityProblem` and the marketplace watch read it the same way). A config without a hook
 * (`customHook` null: the launchpad's and the kit's own programs) passes.
 */
export function hookAuthorityAccepted(customHook: string | null, hook: { upgradeAuthority: string | null; upgradeable: boolean | null; timelocked?: boolean } | null): boolean {
  if (customHook === null || hook === null || hook.upgradeable !== true || hook.upgradeAuthority === null) return true;
  // Phase 3a: a hook behind its own `hook_timelock` (a public delay of at least 3 days) is accepted too.
  if (hook.timelocked === true) return true;
  return HOOK_UPGRADE_AUTHORITIES.includes(hook.upgradeAuthority);
}

/** `bordrless_launch::constants::MAX_AUTHOR_SHARE_BPS`: half the creator fee, the most the program lets a listed config pay its author. */
export const MAX_AUTHOR_SHARE_BPS = 5_000;
/**
 * The only share Studio lists with: a listed config's author gets half the creator fee of every
 * launch someone else makes from it (nothing when the config has no creator fee). It is not the
 * author's to choose. A config listed straight through the SDK may carry less, so the marketplace
 * always shows the share that is on chain.
 */
export const AUTHOR_SHARE_BPS = 5_000;

/**
 * The standard `prepare` of a Studio hook: `prepare()` (no arguments) with the accounts
 * `[payer (signer, writable), mint, state = PDA(["state", mint], hook) (writable), registry =
 * PDA(["bordrless-hook-accounts", mint], hook) (writable), system program]`. It creates the hook's
 * state for the mint and writes its registry; anyone may send it, once per mint.
 */
export const STUDIO_PREPARE = { instruction: 'prepare', stateSeed: 'state' } as const;

/** Limits of a project's source. */
export const STUDIO_LIMITS = { files: 8, bytes: 120_000, messageChars: 8_000 } as const;

/**
 * Starters a new hook project can begin from (the template's `src/lib.rs` variants). Those with
 * `game` make a game hook (the reference game hooks of docs/games.md "Studio game hooks", written on
 * the `bordrless-game` crate). A Studio lottery starter is not written yet (it would be
 * `lottery_hook`'s rules with the standard `prepare` and `ROUND_SECS` as a constant).
 */
export const STUDIO_STARTERS: readonly { id: string; name: string; blurb: string; game?: StudioGameKind }[] = [
  { id: 'blank', name: 'Blank hook', blurb: 'The template: every callback stubbed, nothing taken, nothing refused.' },
  { id: 'sell-tax', name: 'Sell tax to a wallet', blurb: 'A cut of every sell sent to a wallet you choose; buys and transfers pass free.' },
  { id: 'cooldown', name: 'Transfer cooldown', blurb: 'A holding that received tokens cannot send them on for a while, stamped in its hook data.' },
  { id: 'jackpot', game: 'jackpot', name: 'Last-buyer jackpot', blurb: 'Every buy of at least MIN_TOKENS restarts a TIMER_SECS countdown; when it runs out, the last buyer who still holds is paid a share of the pot.' },
  { id: 'streak', game: 'streak', name: 'Diamond-hands streak', blurb: 'Each epoch, part of the pot is shared among the holders who held through it without sending a token, in proportion to what they held.' },
];

/** What each game kind is called on the site: "Jackpot coin". */
export const GAME_KIND_WORDS: Readonly<Record<StudioGameKind | 'strategy', string>> = { lottery: 'Lottery coin', jackpot: 'Jackpot coin', streak: 'Streak coin', strategy: 'Strategy coin' };

// ---- the hook's flags, read from its source ---------------------------------------------------------

/** Comments, string and char literals blanked (newlines kept), so only code is read. */
function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') (depth += 1), (i += 2);
        else if (src[i] === '*' && src[i + 1] === '/') (depth -= 1), (i += 2);
        else {
          if (src[i] === '\n') out += '\n';
          i += 1;
        }
      }
    } else if (c === 'r' && (n === '"' || n === '#') && !/[A-Za-z0-9_]/.test(src[i - 1] ?? '')) {
      let j = i + 1;
      let hashes = 0;
      while (src[j] === '#') (hashes += 1), (j += 1);
      if (src[j] !== '"') {
        out += c;
        i += 1;
        continue;
      }
      const end = '"' + '#'.repeat(hashes);
      const close = src.indexOf(end, j + 1);
      i = close < 0 ? src.length : close + end.length;
      out += ' ';
    } else if (c === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
      i += 1;
      out += ' ';
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** A function's body (between its braces), or null when it isn't there. */
function bodyOf(code: string, name: string): string | null {
  const m = new RegExp(`\\bfn\\s+${name}\\s*\\(`).exec(code);
  if (!m) return null;
  const open = code.indexOf('{', m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < code.length; k += 1) {
    if (code[k] === '{') depth += 1;
    else if (code[k] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, k);
    }
  }
  return null;
}

/** The Studio template's untouched callbacks: a callback left like this does nothing, so it isn't subscribed. */
const STUB_BODIES = new Set(['check_call(&ctx,&args)?;Ok(HookReturn::default())', 'check_call(&ctx,&args)']);

const CALLBACK_FLAGS: readonly [string, number][] = [
  ['before_transfer', HOOK_FLAG_BITS.BEFORE_TRANSFER],
  ['after_transfer', HOOK_FLAG_BITS.AFTER_TRANSFER],
  ['before_mint', HOOK_FLAG_BITS.BEFORE_MINT],
  ['after_mint', HOOK_FLAG_BITS.AFTER_MINT],
  ['before_burn', HOOK_FLAG_BITS.BEFORE_BURN],
  ['after_burn', HOOK_FLAG_BITS.AFTER_BURN],
];

/**
 * The token hook flags a Studio hook needs, read from its own source (never chosen by hand): each
 * callback whose body the author changed from the template's stub; cuts (TRANSFER_RETURNS_DELTA)
 * when before_transfer runs and the code builds a `Delta` or fills `deltas`; hook data
 * (WRITES_HOOK_DATA) when the code sets a holding's `source_hook_data`/`destination_hook_data`
 * (reading `args.…_hook_data` needs no flag). It leans to including a bit: a flag the code doesn't
 * use is harmless, a missing one makes the token program refuse the hook's answer. 0: the hook does
 * nothing yet.
 */
export function detectHookFlags(files: readonly { path: string; content: string }[]): number {
  const code = files.filter((f) => f.path.endsWith('.rs')).map((f) => codeOnly(f.content)).join('\n');
  let flags = 0;
  for (const [name, bit] of CALLBACK_FLAGS) {
    const body = bodyOf(code, name);
    if (body !== null && !STUB_BODIES.has(body.replace(/\s+/g, ''))) flags |= bit;
  }
  if (flags & HOOK_FLAG_BITS.BEFORE_TRANSFER && (/\bDelta\s*\{/.test(code) || /\bdeltas\s*:/.test(code) || /\.deltas\b/.test(code))) flags |= HOOK_FLAG_BITS.TRANSFER_RETURNS_DELTA;
  if (flags && /(?<!args\.)\b(source|destination)_hook_data\b/.test(code)) flags |= HOOK_FLAG_BITS.WRITES_HOOK_DATA;
  return flags;
}

// ---- a game hook's kind and settings, read from its source --------------------------------------------

/** The index just past the bracket matching the one at `open`, or the end. */
function closeOf(code: string, open: number): number {
  let depth = 0;
  for (let j = open; j < code.length; j += 1) {
    const ch = code[j];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return code.length;
}

/** The arguments of the call whose opening parenthesis is at `open`, as written (split on commas at depth 0). */
function argsOf(code: string, open: number): string[] {
  const inner = code.slice(open + 1, closeOf(code, open) - 1);
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let j = 0; j < inner.length; j += 1) {
    const ch = inner[j];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(inner.slice(from, j));
      from = j + 1;
    }
  }
  if (inner.slice(from).trim()) out.push(inner.slice(from));
  return out.map((a) => a.trim());
}

/**
 * A constant expression of the source, evaluated: integer literals (with `_` and a type suffix),
 * `+ - * /` and parentheses, and the names of other `const`s (followed up to a depth of 8). Null
 * for anything else (a call, a runtime value, an unknown name, a division by zero).
 */
function evalConst(code: string, expr: string, depth = 0): bigint | null {
  const text = expr.replace(/\s+/g, '');
  if (!text || depth > 8) return null;
  let i = 0;
  const peek = (): string => text[i] ?? '';
  const primary = (): bigint | null => {
    if (peek() === '(') {
      i += 1;
      const v = sum();
      if (peek() !== ')') return null;
      i += 1;
      return v;
    }
    if (peek() === '-') {
      i += 1;
      const v = primary();
      return v === null ? null : -v;
    }
    const lit = /^(0x[0-9a-fA-F_]+|\d[\d_]*)(u8|u16|u32|u64|u128|i8|i16|i32|i64|i128|usize|isize)?/.exec(text.slice(i));
    if (lit) {
      i += lit[0].length;
      try {
        return BigInt(lit[1]!.replace(/_/g, ''));
      } catch {
        return null;
      }
    }
    const name = /^(?:(?:crate|self|super)::)*([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i));
    if (!name) return null;
    i += name[0].length;
    const def = new RegExp(`\\bconst\\s+${name[1]}\\s*:\\s*[A-Za-z0-9_:<>]+\\s*=([^;]*);`).exec(code);
    if (!def) return null;
    return evalConst(code, def[1]!, depth + 1);
  };
  const product = (): bigint | null => {
    let v = primary();
    while (v !== null && (peek() === '*' || peek() === '/')) {
      const op = peek();
      i += 1;
      const r = primary();
      if (r === null) return null;
      if (op === '/') {
        if (r === 0n) return null;
        v /= r;
      } else v *= r;
    }
    return v;
  };
  const sum = (): bigint | null => {
    let v = product();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = peek();
      i += 1;
      const r = product();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return i === text.length ? v : null;
}

/** The arguments `Name::new(…)` is called with in `code` (the first call), evaluated; null when there is none or one can't be read. */
function newArgs(code: string, name: string, count: number): (bigint | null)[] | null {
  const m = new RegExp(`\\b${name}\\s*::\\s*new\\s*\\(`).exec(code);
  if (!m) return null;
  const args = argsOf(code, m.index + m[0].length - 1);
  if (args.length !== count) return null;
  return args.map((a) => evalConst(code, a));
}

const within = (v: bigint | null, max: bigint): v is bigint => v !== null && v >= 0n && v <= max;
const U32 = 0xffff_ffffn;
const U64 = 0xffff_ffff_ffff_ffffn;

/**
 * A game hook's kind and settings from its source (docs/games.md "Studio game hooks", p2-n):
 * the state struct whose first field is the crate's `GameHeader` names the kind by its second
 * field (`JackpotHeader`, `StreakHeader`; neither: a lottery), and the settings are the arguments
 * the headers are made with in `prepare`: `JackpotHeader::new(timer_secs, min_tokens)`,
 * `StreakHeader::new(min_streak_secs, min_weight)` and `GameHeader::new(mint, round_secs, now)`,
 * each a constant expression (`const` names followed). Null when the source is not a game hook, or
 * a setting can't be read from it (the backend then refuses the config: the companion would check
 * the setting against the hook's header and refuse the setup).
 */
export function detectGameSettings(files: readonly { path: string; content: string }[]): StudioGameSettings | null {
  const code = files.filter((f) => f.path.endsWith('.rs')).map((f) => codeOnly(f.content)).join('\n');
  const state = /\bstruct\s+\w+\s*(?:<[^>{]*>)?\s*\{\s*(?:#\s*\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?\w+\s*:\s*(?:(?:::)?bordrless_game\s*::\s*)?GameHeader\s*,\s*(?:#\s*\[[^\]]*\]\s*)*(?:(?:pub(?:\s*\([^)]*\))?\s+)?\w+\s*:\s*(?:(?:::)?bordrless_game\s*::\s*)?(JackpotHeader|StreakHeader)\b)?/.exec(code);
  if (!state) return null;
  const kind: StudioGameKind = state[1] === 'JackpotHeader' ? 'jackpot' : state[1] === 'StreakHeader' ? 'streak' : 'lottery';
  const header = newArgs(code, 'GameHeader', 3);
  if (!header) return null;
  const roundSecs = header[1] ?? null;
  if (!within(roundSecs, U32)) return null;
  const out: StudioGameSettings = { kind, timerSecs: 0, minTokens: '0', roundSecs: Number(roundSecs), minStreakSecs: 0, minWeight: '0' };
  if (kind === 'jackpot') {
    const j = newArgs(code, 'JackpotHeader', 2);
    if (!j || !within(j[0] ?? null, U32) || !within(j[1] ?? null, U64)) return null;
    out.timerSecs = Number(j[0]);
    out.minTokens = j[1]!.toString();
  } else if (kind === 'streak') {
    const s = newArgs(code, 'StreakHeader', 2);
    if (!s || !within(s[0] ?? null, U32) || !within(s[1] ?? null, U64)) return null;
    out.minStreakSecs = Number(s[0]);
    out.minWeight = s[1]!.toString();
  }
  return out;
}

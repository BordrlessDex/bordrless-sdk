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

/** What a project becomes: a config of existing rules alone, or a config with its own hook program. */
export type StudioKind = 'config' | 'hook';

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
  /** List it on the marketplace (made with `create_listed_config`). */
  listed: boolean;
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
  /** Start from a template (`STUDIO_STARTERS`), or blank. */
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
  /** What the test can't see (amount triggers, wallets it never used, after a year). */
  notes: string[];
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
 * upgrade info: accepted when nobody can upgrade it (`upgradeable: false`), or when its upgrade
 * authority is one of `HOOK_UPGRADE_AUTHORITIES` (Bordrless Studio's key or the protocol's). Only a
 * hook some other key is known to be able to upgrade is refused: one whose upgrade info could not be
 * read is not (the launch program checked it when the config was made; the SDK's
 * `hookAuthorityProblem` and the marketplace watch read it the same way). A config without a hook
 * (`customHook` null: the launchpad's and the kit's own programs) passes.
 */
export function hookAuthorityAccepted(customHook: string | null, hook: { upgradeAuthority: string | null; upgradeable: boolean | null } | null): boolean {
  if (customHook === null || hook === null || hook.upgradeable !== true || hook.upgradeAuthority === null) return true;
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

/** Starters a new hook project can begin from (the template's `src/lib.rs` variants). */
export const STUDIO_STARTERS: readonly { id: string; name: string; blurb: string }[] = [
  { id: 'blank', name: 'Blank hook', blurb: 'The template: every callback stubbed, nothing taken, nothing refused.' },
  { id: 'sell-tax', name: 'Sell tax to a wallet', blurb: 'A cut of every sell sent to a wallet you choose; buys and transfers pass free.' },
  { id: 'cooldown', name: 'Transfer cooldown', blurb: 'A holding that received tokens cannot send them on for a while, stamped in its hook data.' },
];

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

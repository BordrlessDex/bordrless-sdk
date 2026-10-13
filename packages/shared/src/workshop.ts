/**
 * The Workshop (2026-10-12): hooks and companions anyone writes with the SDK and their own agent.
 * The builder submits the source; Bordrless does the rest on its own machines (docs/workshop.md):
 *
 * 1. **Checks**, automatic, on Bordrless's backend and its sandboxed builder: the template's static
 *    rules, a security review by AI (two independent runs, the worse kept) looking for anything
 *    malicious, the build, the trading test (a hook), and the AI's plain reading (what it does, the
 *    most it takes, a description).
 * 2. **Approval** by Bordrless.
 * 3. **Deploy**: the builder pays what deploying it costs (its rent, the fees and Bordrless's fee,
 *    quoted first; Bordrless's fee goes to the revenue wallet) and Bordrless deploys it with
 *    Bordrless's upgrade key. The builder never holds the upgrade authority.
 * 4. **Credit**: a hook's builder makes its launch config, listed, and earns `AUTHOR_SHARE_BPS` (half)
 *    of the creator fee of every launch someone else makes with it, fixed on chain. A companion's
 *    builder is paid the same half by the companion program. A builder may take nothing instead
 *    (`authorShareBps` 0, the owner, 2026-10-13): a hook's config is then made unlisted on chain
 *    (`create_config`, no author share) and still shown on the shelves and the marketplace as theirs;
 *    a companion's (or a pair's) script is approved on chain naming no author (the default key).
 *
 * Built on Studio's backend pipeline (studio_projects: review, build, trading test, deploy,
 * config); Studio's own pages are gone. Companions wait in a queue until the companion program's
 * script upgrade and the builder's script template are live (`queued`).
 *
 * **Pairs** (the owner, 2026-10-12: a hook and its companion are not separate anywhere a builder or
 * a launcher sees them). A `pair` is a trade hook plus the companion script that runs with it (the
 * hook keeps the score in the holdings, the script holds the pot and pays), submitted as one item
 * with both sources (`files`, `scriptFiles`), checked as two Studio projects, approved once (both
 * builds bound), deployed with one payment, and listed as one config that requires its companion:
 * `ConfigInspection.requiredCompanion` says so, and a launch of the config without the pair's
 * script, or of the script from another config, is refused (`companion_required`,
 * `config_required`). A pair's `program` is its hook's; `scriptProgram` its script's.
 *
 * **The reading lane** (the owner, 2026-10-12; docs/workshop.md "The reading lane"). A builder who
 * deployed their own hook or companion (the self-serve lane: immutable or not, never under
 * Bordrless's key) submits the source with the program's address (`WorkshopSubmitRequest.program`).
 * The item is `lane: 'reading'`: the same fee, the same checks, and then the build's executable hash
 * is compared with the code on chain. Equal, the item is `matched` and Bordrless's reading and
 * verdict show wherever the program appears (the launch page's config readout, the token page),
 * while the code on chain stays that build. Nothing is deployed, no key of Bordrless's is involved,
 * no author share, nothing on the Workshop's shelves; the item's page is public once matched.
 */
import type { Address, PreparedTx } from './api.ts';
import { AUTHOR_SHARE_BPS, type StudioFile } from './studio.ts';

export type WorkshopKind = 'hook' | 'companion' | 'pair';
export const WORKSHOP_KINDS: readonly WorkshopKind[] = ['hook', 'companion', 'pair'];

/**
 * Which lane an item is in: `workshop` (Bordrless checks, approves and deploys it under its own key)
 * or `reading` (the builder deployed it themselves; Bordrless reads and checks the source and, when
 * the build matches the program on chain, its words show wherever the program is used) or `rules`
 * (docs/rules-lane.md §4: a composed hook, listed by its config; its program is the rules engine,
 * its words are read from the rule set bound to the config, approved at once with no checks, no
 * build, no trading test and no fee). Absent from older servers: read as `workshop`.
 */
export type WorkshopLane = 'workshop' | 'reading' | 'rules';
export const WORKSHOP_LANES: readonly WorkshopLane[] = ['workshop', 'reading', 'rules'];

/**
 * Where a submission stands: `unpaid` (taken; nothing runs until its builder pays the submission
 * fee, `WorkshopFee`), `checking` (the automatic checks are running), `queued` (a companion, until
 * the script upgrade is live), `pending` (passed, waiting for Bordrless's approval), `approved` (its
 * builder can pay to deploy it), `rejected` (by the checks or by Bordrless, with the reason),
 * `revoked` (taken down after approval), `matched` (a reading-lane item: the checks passed and the
 * build equals the code on chain, so its reading is attached; terminal). A reading-lane item is
 * never `pending` or `approved`: there is nothing to approve or deploy.
 */
export type WorkshopStatus = 'unpaid' | 'checking' | 'queued' | 'pending' | 'approved' | 'rejected' | 'revoked' | 'matched';

/**
 * The submission fee (the owner, 2026-10-12): every submission costs a fixed amount of SOL, paid by
 * its builder to Bordrless's treasury before its checks run (the API's `WORKSHOP_SUBMIT_LAMPORTS`,
 * 0.1 SOL unless set; 0 makes submissions free). It pays for the review by AI, the build and the
 * trading test, and for the programs Bordrless deploys and keeps. It is not refunded, approved or
 * not. Fixes to a submission that is not approved yet cost nothing more.
 */
export interface WorkshopFee {
  /** Lamports, as a decimal string: what this submission was quoted when it was taken. */
  lamports: string;
  /** Bordrless's treasury. */
  payTo: Address;
  /** The memo the payment carries, which makes it this submission's. */
  memo: string;
  /** The payment's transaction signature once Bordrless saw it on chain; null while unpaid. */
  paid: string | null;
}

/** `GET /v1/workshop/fee`: what a submission costs now, for the pages that say so before anything is sent. */
export interface WorkshopFeeResponse {
  lamports: string;
  payTo: Address;
}

/** `POST /v1/workshop/:id/fee/quote`, as its builder: the fee and the one payment to sign (it lives about a minute). */
export interface WorkshopFeeQuote extends WorkshopFeeResponse {
  memo: string;
  transactions: PreparedTx[];
  /** Unix seconds. */
  expiresAt: number;
}

/** `POST /v1/workshop/:id/pay`: the fee's payment, checked on chain; the checks start. */
export interface WorkshopPayRequest {
  paymentSignature: string;
}

/** What a submission may hold: the Rust sources of Bordrless's template (its Cargo.toml and crates are Bordrless's). */
export const WORKSHOP_LIMITS = {
  /** Source files, and their bytes in all (the builder's limits). */
  files: 8,
  bytes: 120_000,
  /** The name, in characters. */
  name: 32,
  /** The builder's own words. */
  notes: 600,
  /** Submissions one wallet may make in a day. */
  perDay: 6,
} as const;

/** A submission's file path: a Rust source under src/, lower-case names (the builder's rule). */
export const WORKSHOP_PATH = /^src\/[a-z0-9_]+(\/[a-z0-9_]+)*\.rs$/;
export const workshopPathOk = (path: string): boolean => WORKSHOP_PATH.test(path);

/** The longest each part of the AI's reading may be. */
export const WORKSHOP_READING_LIMITS = { title: 48, does: 160, totalText: 80, description: 600, watch: 5, watchText: 140 } as const;

export type WorkshopWatchSeverity = 'high' | 'medium' | 'low';

/**
 * What Bordrless's AI wrote about a submission from its source: a title, what it does in one
 * sentence, the most it takes (`total`: for a hook, the largest cut of one trade in basis points of
 * its amount, null when the code reads it from an account it doesn't bound; for a companion, the most
 * of its pot one step spends), a plain description, and what a launcher should watch for. Read by
 * AI from the code, not an audit.
 */
export interface WorkshopReading {
  title: string;
  does: string;
  total: { bps: number | null; text: string };
  description: string;
  watch: { severity: WorkshopWatchSeverity; text: string }[];
  /** Unix seconds. */
  at: number;
}

/** One automatic check, as the item's page shows it. */
export interface WorkshopCheck {
  id: 'rules' | 'review' | 'build' | 'test' | 'reading';
  label: string;
  state: 'waiting' | 'running' | 'passed' | 'warned' | 'failed' | 'skipped';
  /** One plain sentence: what it found, or why it failed. */
  detail: string | null;
}

/** A finding of the security review. */
export interface WorkshopFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
}

/** Where its deploy stands: Studio's deploy states, or null before it is paid for. */
export type WorkshopDeployState = 'awaiting_payment' | 'paid' | 'writing' | 'deploying' | 'handing_over' | 'deployed' | 'failed' | 'refunded';

/** A Workshop item as a card shows it. */
export interface WorkshopItem {
  /** Its id (a uuid): its page is /workshop/<id>. */
  id: string;
  kind: WorkshopKind;
  name: string;
  author: Address;
  status: WorkshopStatus;
  reading: WorkshopReading | null;
  readingState: 'waiting' | 'done' | 'failed';
  /** Its program: reserved once built, live once deployed (`deployed`). A pair's is its hook's. */
  program: Address | null;
  /** Live on chain: for a pair, both halves. */
  deployed: boolean;
  /**
   * The script half's program: a pair's companion script (reserved once built, live once
   * `scriptDeployed`), a companion's own (`program` again); null for a hook. Absent from older servers.
   */
  scriptProgram?: Address | null;
  /** Whether the script half is deployed (a pair's script; a companion's own program); false for a hook. Absent from older servers. */
  scriptDeployed?: boolean;
  /** A hook's listed launch config, once its builder made it (what the launch page launches from). */
  config: Address | null;
  /** The largest cut of one transfer the trading test measured (a hook), basis points. */
  measuredCutBps: number | null;
  launches: number;
  /** Unix seconds. */
  submittedAt: number;
  approvedAt: number | null;
  /**
   * A companion, or a pair's script (docs/scripts.md): whether the companion program's on-chain
   * approval of its deployed code holds now (`pnpm admin workshop approve-script`), which a launch
   * with it needs; false until it is written, or once the code changed or the approval was revoked.
   * Null for a hook; absent from older servers.
   */
  scriptApproved?: boolean | null;
  /** Its lane (`WorkshopLane`); absent from older servers: `workshop`. A reading-lane item's `program` is the builder's own, from the start; a rules-lane item's is the rules engine and its `config` the composed config it was listed by. */
  lane?: WorkshopLane;
  /**
   * A reading-lane item: whether its build's executable hash equals the code on chain (true:
   * `matched`; false: `rejected` with the mismatch in `reviewNote`); null until its checks finish.
   * Null for a Workshop-lane item; absent from older servers.
   */
  matched?: boolean | null;
  /**
   * What its builder takes of the creator fee of every launch someone else makes with it, bps of the
   * fee (`WORKSHOP_AUTHOR_SHARES_BPS`): `AUTHOR_SHARE_BPS` (half), or 0 when they chose to take
   * nothing (a hook's config made unlisted on chain, a script approved naming no author). Recorded at
   * the submission; a hook's is chosen again at its config step, until the config is made. 0 for a
   * reading-lane item (it pays nobody). Absent from older servers: `AUTHOR_SHARE_BPS`.
   */
  authorShareBps?: number;
}

/** What a reading-lane item's match compared, and who can change the program (`WorkshopDetail.match`). */
export interface WorkshopMatch {
  /** The executable hash of the code on chain (hex): the one compared once the checks finished, else as read now; null when the program could not be read. */
  chainHash: string | null;
  /** The executable hash of Bordrless's build of the source; null before it is built. */
  buildHash: string | null;
  /** The program's upgrade authority; null when it has none (immutable), or when it could not be read (`immutable` tells which). */
  upgradeAuthority: Address | null;
  /** True: nobody can change its code. False: `upgradeAuthority` can. Null: not read. */
  immutable: boolean | null;
}

/** A half's security review, as the item's page shows it. */
export interface WorkshopReviewSummary {
  verdict: 'pass' | 'warn' | 'fail';
  summary: string;
  findings: WorkshopFinding[];
}

/** A half's build: the executable hash Bordrless approves and deploys, its size, the template commit. */
export interface WorkshopBuildSummary {
  hash: string;
  bytes: number;
  templateCommit: string | null;
}

/** Where a half's deploy stands. */
export interface WorkshopDeploySummary {
  state: WorkshopDeployState;
  upgradeAuthority: Address | null;
  error: string | null;
}

/** One item in full. */
export interface WorkshopDetail extends WorkshopItem {
  /** The executable hash of the build Bordrless approved (what its deploy and, for a companion, its on-chain approval are bound to; a pair's hook's); null before approval. Absent from older servers. */
  approvedHash?: string | null;
  /** A pair: the executable hash of the companion script's build Bordrless approved (what its deploy and its on-chain approval are bound to); null before approval, and for a hook or a companion. Absent from older servers. */
  approvedScriptHash?: string | null;
  notes: string;
  /** Its source: a hook's, a companion's, or a pair's hook's. */
  files: StudioFile[];
  /** A pair's companion script source; empty for a hook or a companion. Absent from older servers. */
  scriptFiles?: StudioFile[];
  /** A hook's callbacks (`TOKEN_HOOK_FLAGS`), read from its source (a pair's hook's); 0 for a companion. */
  hookFlags: number;
  /** The checks: a hook's or a companion's, or a pair's hook half's (its rules, review, build, trading test) with the reading, which is one for the item. */
  checks: WorkshopCheck[];
  /** A pair's companion script half: its rules, review and build (no trading test; the reading is in `checks`). Empty for a hook or a companion. Absent from older servers. */
  scriptChecks?: WorkshopCheck[];
  review: WorkshopReviewSummary | null;
  /** A pair's companion script review. Absent from older servers. */
  scriptReview?: WorkshopReviewSummary | null;
  test: { pass: boolean; reasons: string[]; cutMaxBps: number | null; notes: string[] } | null;
  build: WorkshopBuildSummary | null;
  /** A pair's companion script build. Absent from older servers. */
  scriptBuild?: WorkshopBuildSummary | null;
  deploy: WorkshopDeploySummary | null;
  /** A pair's companion script deploy. Absent from older servers. */
  scriptDeploy?: WorkshopDeploySummary | null;
  /** A listed config's creator fee, once made. */
  creatorFeeBps: number | null;
  /** Bordrless's note on a rejection or a revocation, or why the checks stopped it. */
  reviewNote: string | null;
  /** The submission fee it was quoted and whether it is paid; null when it was taken free. Absent from older servers. */
  fee?: WorkshopFee | null;
  /** Who approved it: the checks ('auto', a clean pass) or the operator; null before approval. Absent from older servers. */
  approvedBy?: 'auto' | 'operator' | null;
  /** A reading-lane item: the hashes compared and who can change the program; null for a Workshop-lane item. Absent from older servers. */
  match?: WorkshopMatch | null;
}

export interface WorkshopListResponse {
  items: WorkshopItem[];
  total: number;
}

/**
 * `POST /v1/workshop/submit`, as the signed-in wallet (the Studio session header). A pair sends both
 * halves: `files` (the hook's `src/**`) and `scriptFiles` (the companion script's), each within
 * `WORKSHOP_LIMITS`; both are refused if either breaks its template's path rules. A pair's hook may
 * be a game hook (its state starts with `GameHeader`: the pair's script reads the score); a lone
 * hook may not (`game_hook`).
 *
 * With `program`, the submission is a reading-lane one (`WorkshopLane`): the builder deployed that
 * program themselves, and Bordrless reads and checks the source and compares its build with the
 * code on chain. A hook or a companion only: a pair is refused (`reading_lane_pairs`, 400). The
 * program must be deployed through the upgradeable loader (`program_not_deployed`, 400); one with a
 * submission already is refused (`program_taken`, 409: send a fix to that one).
 */
export interface WorkshopSubmitRequest {
  kind: WorkshopKind;
  name: string;
  notes: string;
  files: StudioFile[];
  /** A pair's companion script source; ignored for a hook or a companion. */
  scriptFiles?: StudioFile[];
  /** The program's address when the builder deployed it themselves (the reading lane). */
  program?: Address;
  /** What its builder takes (`WORKSHOP_AUTHOR_SHARES_BPS`): `AUTHOR_SHARE_BPS` when absent, 0 to take nothing. A companion's or a pair's script is approved on chain with it; a hook's is its config step's first choice. */
  authorShareBps?: number;
}

/**
 * `POST /v1/workshop/:id/files`: a fix of a submission not approved yet (its checks run again). A
 * hook or a companion sends `files`; a pair sends `files` (its hook), `scriptFiles` (its companion
 * script), or both.
 */
export interface WorkshopFilesRequest {
  files?: StudioFile[];
  scriptFiles?: StudioFile[];
}

/** One program's deploy cost, lamports as decimal strings: rent (the binary with room to upgrade), the transaction fees, Bordrless's fee, the total. */
export interface WorkshopDeployCost {
  rent: string;
  fees: string;
  service: string;
  total: string;
}

/**
 * `POST /v1/workshop/:id/deploy/quote`: what deploying it costs, and the payment to sign. A pair's
 * quote covers both programs: `rent`, `fees`, `service` and `total` are the sums, `parts` each
 * half's, and the one transaction pays both (two transfers to the deployer and two memos, one per
 * program); `WorkshopDeployRequest` then carries its one signature.
 */
export interface WorkshopDeployQuote extends WorkshopDeployCost {
  payTo: Address;
  transactions: PreparedTx[];
  /** Unix seconds. */
  expiresAt: number;
  /** A pair: each half's cost; null for a hook or a companion. Absent from older servers. */
  parts?: { hook: WorkshopDeployCost; script: WorkshopDeployCost } | null;
}

/** `POST /v1/workshop/:id/deploy`: the confirmed payment. */
export interface WorkshopDeployRequest {
  paymentSignature: string;
}

/** The creator fees a hook's builder may list its config with (they earn `AUTHOR_SHARE_BPS` of it). */
export const WORKSHOP_CONFIG_FEES_BPS: readonly number[] = [50, 100, 200];

/**
 * What a Workshop builder may take of the creator fee of others' launches (the owner, 2026-10-13):
 * `AUTHOR_SHARE_BPS` (half, the default), or nothing. Nothing in between: the shelves read "50%" or
 * "0%" to the builder, and the backend refuses any other share (`author_share`).
 */
export const WORKSHOP_AUTHOR_SHARES_BPS: readonly number[] = [AUTHOR_SHARE_BPS, 0];

/** `POST /v1/workshop/:id/config/prepare`: the builder's listed launch config on their deployed hook (a pair's: on its hook, requiring its script). */
export interface WorkshopConfigPrepareRequest {
  creatorFeeBps: number;
  /**
   * A hook's: what its builder takes (`WORKSHOP_AUTHOR_SHARES_BPS`); the item's recorded choice when
   * absent. 0 makes the config with `create_config` (no author share), still on the shelves and the
   * marketplace. A pair's config never pays an author (its builder is paid by its script's approval):
   * a pair refuses a share other than the one it was submitted with (`author_share_fixed`).
   */
  authorShareBps?: number;
  /** The address of a keypair the browser made; it signs after the wallet. */
  config: Address;
}

export interface WorkshopConfigPrepareResponse {
  config: Address;
  transactions: PreparedTx[];
}

export interface WorkshopConfigConfirmRequest {
  config: Address;
}

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
 *   owner's bridged-SOL holding, or nowhere: the holding alone);
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
 * `parseKeeperDeclaration` holds a file to the schema and its bounds and answers the normal form (the
 * same schema, every default written out, amounts as strings of digits) or one sentence saying what
 * is wrong; `keeperWords` says a declaration in plain words. No Solana dependencies: the keeper's own
 * reading of a declaration is apps/server/src/keeper/scriptExtras.ts.
 */
import { SCRIPT_BOUNDS, TOKEN_DECIMALS } from './policy.ts';
import { HOOK_DATA_LEN, PROGRAM_IDS } from './programs.ts';
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
} as const;

const U64_MAX = (1n << 64n) - 1n;

/** Bytes of an unsigned little-endian field. */
export type KeeperWidth = 1 | 2 | 4 | 8;
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
 * passed over), or `none` (the holding alone).
 */
export type KeeperPayTo = 'none' | 'owner' | 'ownerQuoteHolding';
export const KEEPER_PAY_TO: readonly KeeperPayTo[] = ['none', 'owner', 'ownerQuoteHolding'];

export interface KeeperHoldings {
  /** The least balance that counts, base units (at least 1). */
  minBalance: KeeperAmount;
  /** The most balance that counts, base units, inclusive; null: no most. */
  maxBalance: KeeperAmount | null;
  hookData: KeeperHookDataFilter | null;
  payTo: KeeperPayTo;
  /** Holdings a step brings when it carries the swap accounts, and when it does not (the one `swapAccounts` names is required; null: not said). */
  perStep: { withSwapAccounts: number | null; withoutSwapAccounts: number | null };
}

/**
 * A wallet a step brings for the script's wallet answers: a fixed address (base58), or the public key
 * in the 32 bytes at `offset` of the script's state, read fresh at each step (all zeros: none that step).
 */
export type KeeperWallet = string | { state: { offset: number } };

/** A declaration in its normal form: what `parseKeeperDeclaration` answers, what the Workshop stores and hashes, what the keeper reads. */
export interface KeeperDeclaration {
  version: 1;
  /** Which holdings a step brings; null: none (only beside `wallets`: a script that pays wallets alone). */
  holdings: KeeperHoldings | null;
  /** Each step carries the launch pool's swap accounts (what trading the pot needs; they hold the token's hook accounts too). */
  swapAccounts: boolean;
  /** A step without the swap accounts carries the token's custom hook accounts (its program, the token program's signer for it, its registry's extras): what moving the token inside a step needs. */
  hookAccounts: boolean;
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
}

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

/** `holdings`, held to the schema beside the flags it depends on. */
function holdingsOf(v: unknown, swapAccounts: boolean, payouts: boolean): KeeperHoldings {
  const h = fieldsOf(v, 'holdings', ['minBalance', 'maxBalance', 'hookData', 'payTo', 'perStep'], '{ "minBalance", "maxBalance", "hookData", "payTo", "perStep" }');
  if (h.minBalance === undefined) fail('holdings.minBalance is required: the least balance that counts, base units.');
  const minBalance = amountOf(h.minBalance, 'holdings.minBalance', 1n);
  const maxBalance = h.maxBalance === undefined || h.maxBalance === null ? null : amountOf(h.maxBalance, 'holdings.maxBalance', 1n);
  if (typeof minBalance === 'string' && typeof maxBalance === 'string' && BigInt(maxBalance) < BigInt(minBalance)) fail('holdings.maxBalance is at least holdings.minBalance.');
  const hookData = hookDataOf(h.hookData, 'holdings.hookData');
  if (typeof h.payTo !== 'string' || !(KEEPER_PAY_TO as readonly string[]).includes(h.payTo)) fail(`holdings.payTo is one of ${KEEPER_PAY_TO.join(', ')}: where each holding is paid.`);
  const payTo = h.payTo as KeeperPayTo;
  // The companion pays a payout answer's holding to its owner itself (`payoutAccounts`): the step brings the owner, or the holding alone to be measured.
  if (payouts && payTo === 'ownerQuoteHolding') fail('with payouts the companion pays each holding’s owner itself: holdings.payTo is owner (or none for a step that only measures).');
  const p = fieldsOf(h.perStep, 'holdings.perStep', ['withSwapAccounts', 'withoutSwapAccounts'], '{ "withSwapAccounts", "withoutSwapAccounts" }: holdings a step brings');
  const perStep = { withSwapAccounts: perStepCount(p.withSwapAccounts, 'holdings.perStep.withSwapAccounts'), withoutSwapAccounts: perStepCount(p.withoutSwapAccounts, 'holdings.perStep.withoutSwapAccounts') };
  if (swapAccounts && perStep.withSwapAccounts === null) fail('holdings.perStep.withSwapAccounts is required while swapAccounts is true.');
  if (!swapAccounts && perStep.withoutSwapAccounts === null) fail('holdings.perStep.withoutSwapAccounts is required while swapAccounts is false.');
  return { minBalance, maxBalance, hookData, payTo, perStep };
}

/** The declaration in a parsed JSON value, held to the schema and its bounds: its normal form, or why not, in one sentence. */
export function keeperDeclarationOf(value: unknown): KeeperParse {
  try {
    const root = fieldsOf(value, 'the file', ['version', 'holdings', 'swapAccounts', 'hookAccounts', 'payouts', 'roundSecs', 'wallets'], 'one object');
    if (root.version !== KEEPER_VERSION) fail(`version is ${KEEPER_VERSION}, the only one there is.`);
    const wallets = walletsOf(root.wallets, 'wallets');
    // A script that pays wallets alone brings no holdings.
    const noHoldings = root.holdings === undefined || (root.holdings === null && wallets.length > 0);
    if (noHoldings && wallets.length === 0) fail('holdings is required: which holdings each step brings.');
    const swapAccounts = flagOf(root.swapAccounts, 'swapAccounts', null);
    const hookAccounts = flagOf(root.hookAccounts, 'hookAccounts', false);
    const payouts = flagOf(root.payouts, 'payouts', false);
    const holdings = noHoldings ? null : holdingsOf(root.holdings, swapAccounts, payouts);
    const roundSecs = root.roundSecs === undefined || root.roundSecs === null ? null : secondsOf(root.roundSecs, 'roundSecs');
    return { ok: true, declaration: { version: 1, holdings, swapAccounts, hookAccounts, payouts, roundSecs, ...(wallets.length > 0 ? { wallets } : {}) } };
  } catch (error) {
    if (error instanceof KeeperProblem) return { ok: false, problem: error.message };
    throw error;
  }
}

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

const PAY_WORDS: Record<KeeperPayTo, string> = { owner: ', paid to their wallet', ownerQuoteHolding: ', paid to their SOL holding', none: '' };

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
  return [`${parts.join(' ')}${PAY_WORDS[h.payTo]}.`, walletWords(d)].filter((p) => p !== '').join(' ');
}

/**
 * The rest of the declaration, a sentence each, for the review and the operator: what else each
 * step carries, and where a round's or an epoch's length comes from.
 */
export function keeperDetails(d: KeeperDeclaration): string[] {
  const out: string[] = [];
  const carries = [d.payouts ? 'the companion’s payout accounts' : null, d.swapAccounts ? 'the launch pool’s swap accounts' : d.hookAccounts ? 'the token’s hook accounts' : null].filter((x): x is string => x !== null);
  if (carries.length > 0) out.push(`Each step also carries ${carries.join(' and ')}.`);
  const other = d.holdings ? (d.swapAccounts ? d.holdings.perStep.withoutSwapAccounts : d.holdings.perStep.withSwapAccounts) : null;
  if (other !== null) out.push(`${d.swapAccounts ? 'Without' : 'With'} the swap accounts a step would bring up to ${other}.`);
  if (d.wallets) out.push(`The wallets (with the companion’s payout terms): ${d.wallets.map((w) => (typeof w === 'string' ? w : `the public key at byte ${w.state.offset} of the script’s state`)).join(', ')}.`);
  const f = d.holdings?.hookData ?? null;
  const field = (s: KeeperStateField): string => `the ${s.width * 8}-bit number at byte ${s.offset} of the script’s state`;
  if (f && typeof f.against === 'object' && 'epoch' in f.against) {
    const e = f.against.epoch;
    out.push(`An epoch is ${typeof e.secs === 'number' ? `${e.secs} seconds` : `${field(e.secs.state)} in seconds`}${e.fieldUnitSecs ? `; the hook data counts units of ${e.fieldUnitSecs} seconds` : ''}.`);
  }
  if (d.roundSecs !== null) out.push(`A round of the keeper’s (what it says once a round: a wait, nobody to bring) is ${typeof d.roundSecs === 'number' ? `${d.roundSecs} seconds` : `${field(d.roundSecs.state)} in seconds`}.`);
  return out;
}

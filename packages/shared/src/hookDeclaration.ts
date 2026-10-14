/**
 * What a hook asks of the launch config it runs under (docs/workshop.md "A hook's SOL cut"): a hook
 * that takes SOL on trades implements the launchpad's `quote_cut` (bordrless-programs
 * `docs/quote-cut.md`, live since the launchpad of 13 Oct 2026), and the launchpad asks it only on a
 * coin whose config was made with `create_quote_cut_config`, which records the most it may take of
 * each side. Builders never make that config (the Workshop does, from the approved source), so the
 * hook says its caps in data: **`hook.json`**, at the root of the hook's submitted source, beside
 * `src/` (where its Cargo.toml would be), as a companion script's `keeper.json` sits beside its own.
 * The name says whose it is (the hook's, read by the Workshop when it makes the config); JSON for the
 * same reason as keeper.json (the Workshop, the site and the SDK read it with no parser of their
 * own); outside `src/` because it is not Rust and the build never sees it. It travels with the
 * source: the review by AI reads it beside the code, its bytes are part of the source's hash (a
 * changed declaration is reviewed again), and the approval binds it
 * (`workshop_items.approved_hook_hash`): the config is made with the approved caps, never a later
 * file's.
 *
 * A declaration says, once (version 1), the SOL cut's caps: `quoteCut.maxBuyBps`, the most of a
 * buy's SOL in (1 to 1,000 basis points: the launchpad asks the hook on every buy, so the buy cap is
 * above 0; the hook may still answer 0), and `quoteCut.maxSellBps`, the most of a sell's SOL out (0
 * to 1,000; 0 and the launchpad never asks on sells). The launchpad takes min(answer, cap). A hook
 * with a `quote_cut` instruction must declare its caps, and a declaration without one is refused
 * (the static checks, apps/server/src/studio/checks.ts).
 *
 * `parseHookDeclaration` holds a file to the schema and its bounds and answers the normal form or one
 * sentence saying what is wrong; `hookDeclarationWords` says it in plain words. No Solana
 * dependencies: the SDK's `launch.createQuoteCutConfig` takes `quoteCut` as it is.
 */
import { LAUNCH_PROTOCOL_SHARE_BPS } from './policy.ts';
import { utf8Length } from './keeper.ts';
import { pctWords } from './rules.ts';

/** The file, at the root of a hook's submitted source (beside `src/`): a hook's, or a pair's hook half's. */
export const HOOK_FILE = 'hook.json';
/** The schema's version: the only one there is. */
export const HOOK_DECLARATION_VERSION = 1;

/** The bounds a declaration is held to. */
export const HOOK_DECLARATION_LIMITS = {
  /** The file's bytes (UTF-8). */
  bytes: 1_024,
  /** The most a SOL cut may take of either side, bps (the launchpad's `QUOTE_CUT_MAX_BPS`: 10%). */
  maxCutBps: 1_000,
} as const;

/** The caps of a hook's SOL cut, bps of a buy's SOL in and a sell's SOL out: the SDK's `QuoteCutCaps`, as `create_quote_cut_config` takes them. */
export interface HookQuoteCut {
  maxBuyBps: number;
  maxSellBps: number;
}

/** A declaration in its normal form: what `parseHookDeclaration` answers, what the Workshop stores and hashes, what the config is made with. */
export interface HookDeclaration {
  version: 1;
  quoteCut: HookQuoteCut;
}

export type HookDeclarationParse = { ok: true; declaration: HookDeclaration } | { ok: false; problem: string };

class HookDeclarationProblem extends Error {}

/** Refuses with one sentence, the file named first. */
const fail = (sentence: string): never => {
  throw new HookDeclarationProblem(`${HOOK_FILE}: ${sentence}`);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An object with no field but `allowed`. */
function fieldsOf(v: unknown, at: string, allowed: readonly string[], shape: string): Record<string, unknown> {
  if (!isObject(v)) return fail(`${at} is ${shape}.`);
  for (const key of Object.keys(v)) if (!allowed.includes(key)) fail(`${at} has no field "${key.slice(0, 40)}" (it takes ${allowed.join(', ')}).`);
  return v;
}

const group = (n: number): string => n.toLocaleString('en-US');

/** A cap: a whole number of basis points from `min` to the launchpad's most. */
function capOf(v: unknown, at: string, min: number, why: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > HOOK_DECLARATION_LIMITS.maxCutBps) return fail(`${at} is a whole number of basis points from ${min} to ${group(HOOK_DECLARATION_LIMITS.maxCutBps)} (10%): ${why}.`);
  return v;
}

/** The declaration in a parsed JSON value, held to the schema and its bounds: its normal form, or why not, in one sentence. */
export function hookDeclarationOf(value: unknown): HookDeclarationParse {
  try {
    const root = fieldsOf(value, 'the file', ['version', 'quoteCut'], 'one object');
    if (root.version !== HOOK_DECLARATION_VERSION) fail(`version is ${HOOK_DECLARATION_VERSION}, the only one there is.`);
    if (root.quoteCut === undefined || root.quoteCut === null) fail('quoteCut is required: the most the hook’s quote_cut may take of a buy’s SOL and of a sell’s.');
    const q = fieldsOf(root.quoteCut, 'quoteCut', ['maxBuyBps', 'maxSellBps'], '{ "maxBuyBps", "maxSellBps" }: the SOL cut’s caps in basis points');
    if (q.maxBuyBps === undefined) fail('quoteCut.maxBuyBps is required: the most of a buy’s SOL the hook may take.');
    if (q.maxSellBps === undefined) fail('quoteCut.maxSellBps is required: the most of a sell’s SOL the hook may take (0 for none).');
    // The launchpad asks the hook on every buy (it may answer 0 there): a config's buy cap is above 0 (`QuoteCut::valid`).
    const maxBuyBps = capOf(q.maxBuyBps, 'quoteCut.maxBuyBps', 1, 'the launchpad asks the hook on every buy, so the buy cap is above 0 (the hook may still answer 0)');
    const maxSellBps = capOf(q.maxSellBps, 'quoteCut.maxSellBps', 0, '0 and the launchpad never asks the hook on sells');
    return { ok: true, declaration: { version: 1, quoteCut: { maxBuyBps, maxSellBps } } };
  } catch (error) {
    if (error instanceof HookDeclarationProblem) return { ok: false, problem: error.message };
    throw error;
  }
}

/** A `hook.json` as submitted: within its size, JSON, then the schema (`hookDeclarationOf`). */
export function parseHookDeclaration(text: string): HookDeclarationParse {
  const bytes = utf8Length(text);
  if (bytes > HOOK_DECLARATION_LIMITS.bytes) return { ok: false, problem: `${HOOK_FILE} is at most ${group(HOOK_DECLARATION_LIMITS.bytes)} bytes; this one is ${group(bytes)}.` };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: `${HOOK_FILE} is not JSON: check its quotes, commas and brackets (no comments, no trailing commas).` };
  }
  return hookDeclarationOf(value);
}

/** The declaration in a canonical text (keys sorted, no spaces): what its hash is taken of, so the same declaration hashes the same however it was written. */
export function canonicalHookJson(d: HookDeclaration): string {
  return JSON.stringify({ quoteCut: { maxBuyBps: d.quoteCut.maxBuyBps, maxSellBps: d.quoteCut.maxSellBps }, version: d.version });
}

/** Whether a file of a submission is the declaration. */
export const isHookFile = (path: string): boolean => path === HOOK_FILE;

/** The declaration among a source's files, or null when there is none or it does not read as the schema (the static checks refuse that). */
export function hookDeclarationOfFiles(files: readonly { path: string; content: string }[]): HookDeclaration | null {
  const file = files.find((f) => f.path === HOOK_FILE);
  if (!file) return null;
  const parsed = parseHookDeclaration(file.content);
  return parsed.ok ? parsed.declaration : null;
}

// ---- in plain words -------------------------------------------------------------------------------------

/** What a trader pays at most on a side: the cut and Bordrless's share of it on top, as of the creator fee (25%: a 10% cap is up to 12.5%). */
export const quoteCutPaidBps = (capBps: number): number => capBps + Math.ceil((capBps * LAUNCH_PROTOCOL_SHARE_BPS) / 10_000);

/**
 * The SOL cut in one plain sentence, for the item's page, the reading and the operator: "Takes up to
 * 8% of a buy’s SOL, as its quote_cut answers each buy, and nothing on sells; it goes to the creator
 * fee."
 */
export function quoteCutWords(cut: HookQuoteCut): string {
  if (cut.maxSellBps === 0) return `Takes up to ${pctWords(cut.maxBuyBps)} of a buy’s SOL, as its quote_cut answers each buy, and nothing on sells; it goes to the creator fee.`;
  return `Takes up to ${pctWords(cut.maxBuyBps)} of a buy’s SOL and up to ${pctWords(cut.maxSellBps)} of a sell’s, as its quote_cut answers each trade; it goes to the creator fee.`;
}

/** The rest, a sentence each: what a trader pays with Bordrless's share, and who pays none. */
export function quoteCutDetails(cut: HookQuoteCut): string[] {
  const paid = cut.maxSellBps === 0 ? `up to ${pctWords(quoteCutPaidBps(cut.maxBuyBps))} of a buy` : `up to ${pctWords(quoteCutPaidBps(cut.maxBuyBps))} of a buy and ${pctWords(quoteCutPaidBps(cut.maxSellBps))} of a sell`;
  return [`Bordrless’s ${pctWords(LAUNCH_PROTOCOL_SHARE_BPS)} is charged on it as on the creator fee, so a trader pays ${paid}.`, 'The coin’s creator trading for itself pays none (for a coin with a companion, every trade the companion makes).'];
}

/** The declaration in one plain sentence (`quoteCutWords`). */
export const hookDeclarationWords = (d: HookDeclaration): string => quoteCutWords(d.quoteCut);

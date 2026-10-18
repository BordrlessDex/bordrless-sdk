/**
 * What a Workshop hook takes of a buy and of a sell: the one answer every page draws from (the owner,
 * 18 Oct 2026, B²: the item card said "Sell 1%" while the reading's rules said 3% in a dip and the
 * coin's fee table "up to 3%"; "fix it systematically so we prevent further issues with our system
 * reading it before our AI summary"). The numbers come from what is structured, never from the AI's
 * prose while anything structured says the side:
 *
 * 1. the reading's rules (`WorkshopReadingRule.bps`, read from the code, one row a tier): the most
 *    they say on the side, "up to" when they vary or a rule's rate is one the code doesn't bound;
 * 2. the summary's sentence for the side, only when the reading has no rule on it (its first
 *    sentence's largest rate: a later sentence carries thresholds, "15% under its level");
 * 3. the reading's total, when it has neither (readings written before the rules);
 *
 * held to the caps of its SOL cut (hook.json, `HookQuoteCut`), when it takes one: the launchpad
 * takes min(answer, cap), so a cap is the most a side can ever pay in SOL. A side's rate is the
 * larger of the cap and what the reading says, "up to" when the two differ or the reading's rate
 * moves. A hook whose flags let it take none of the tokens (`tokens: false`) takes only its SOL cut:
 * its rules describe that cut, which the cap bounds, so the cap is its rate. A buy cap at the
 * launchpad's floor (1 bp: asked on every buy) beside a reading that takes nothing of a buy is
 * nothing (the hook keeps the floor to be asked, never to take).
 *
 * The reader holds the summary to the same numbers (apps/server/src/workshop/reader.ts
 * `understatedSides`): a side's sentence that says less than its rules or caps is asked again.
 */
import { HOOK_QUOTE_CUT_FLOOR_BPS, type HookQuoteCut } from './hookDeclaration.ts';
import type { WorkshopReading, WorkshopReadingRule } from './workshop.ts';

/** One side's rate: `bps` the most it takes (0 for nothing; null when no rate can say it: "a cut"), `upTo` when the rate moves. Null when nothing says the side. */
export type SideRate = { bps: number | null; upTo: boolean } | null;
export type HookSide = 'buy' | 'sell';
export interface HookSideRates {
  buy: SideRate;
  sell: SideRate;
}

/** Words that say a rate moves ("up to 7.8%", "about 0.8% ... rising to"): the side takes up to its top rate, not one rate. */
export const RATE_VARIES = /\b(up to|about|rising|falling|from|grows|the more|bigger|larger|smaller)\b/i;

const NOTHING: SideRate = { bps: 0, upTo: false };

/** The rules on one side: a buy's (and a trade's), a sell's (and a trade's), a transfer's. */
export const rulesOnSide = (rules: readonly WorkshopReadingRule[], side: HookSide | 'transfer'): WorkshopReadingRule[] => rules.filter((r) => r.on === side || (side !== 'transfer' && r.on === 'trade'));

/**
 * One side's rate from a reading's rules: null without a rule on the side; else the top rate of its
 * rules, "up to" when they vary (several rates, words that say it moves, or one the code doesn't
 * bound), "a cut" (bps null) when no rule on it names a rate.
 */
export function rateFromRules(rules: readonly WorkshopReadingRule[], side: HookSide): SideRate {
  const own = rulesOnSide(rules, side);
  if (own.length === 0) return null;
  const rates = own.map((r) => r.bps);
  const numbers = rates.filter((b): b is number => b !== null);
  const max = numbers.length ? Math.max(...numbers) : null;
  const varies = rates.includes(null) || new Set(numbers).size > 1 || own.some((r) => RATE_VARIES.test(r.text));
  if (max === 0 && !rates.includes(null)) return NOTHING;
  if (max === null || max === 0) return { bps: null, upTo: false };
  return { bps: max, upTo: varies };
}

/**
 * One side's rate from its summary sentence (the rate comes first in it, the reader's shape):
 * "Nothing is taken." takes nothing; otherwise the largest percentage of the first sentence that
 * holds one (a later sentence may carry a threshold, never the rate), "up to" it when the rate moves
 * (several rates, the words that say it varies, or a free case beside a paid one); a sentence with
 * no rate at all is "a cut". Null for an empty side.
 */
export function rateFromSummary(text: string | null | undefined): SideRate {
  const said = text?.trim() ?? '';
  if (!said) return null;
  const sentences = said.split(/(?<=[.;])\s+/);
  const withRate = sentences.find((s) => /\d%/.test(s));
  const free = /^nothing is taken/i.test(said);
  if (!withRate) return free ? NOTHING : { bps: null, upTo: false };
  const rates = [...withRate.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
  const max = Math.max(...rates);
  if (max === 0) return NOTHING;
  const varies = new Set(rates).size > 1 || free || RATE_VARIES.test(said);
  return { bps: Math.round(max * 100), upTo: varies };
}

/**
 * Both sides of a hook, from its reading and the caps of its SOL cut (see the top of this file).
 * Null when nothing says either side: no reading and no cap, or a reading with no rule, no summary
 * sentence and no total (a companion's).
 */
export function hookSideRates(reading: Partial<Pick<WorkshopReading, 'rules' | 'summary' | 'total'>> | null | undefined, opts: { /** The caps of its SOL cut (hook.json); null or absent for a hook that takes none. */ caps?: HookQuoteCut | null; /** Whether its flags let it take a cut of the tokens (`TRANSFER_RETURNS_DELTA`); absent: as if they do. */ tokens?: boolean } = {}): HookSideRates | null {
  const caps = opts.caps ?? null;
  const tokens = opts.tokens ?? true;
  const rules = (reading?.rules ?? []).filter((r) => r.on !== 'step');
  const s = reading?.summary;
  const hasSaid = Boolean(s?.buys || s?.sells);
  const total = reading?.total ?? null;
  const hasCaps = caps !== null && (caps.maxBuyBps > 0 || caps.maxSellBps > 0);
  if (!hasSaid && rules.length === 0 && !total && !hasCaps) return null;
  const side = (name: HookSide): SideRate => {
    const cap = caps ? (name === 'buy' ? caps.maxBuyBps : caps.maxSellBps) : 0;
    const ruled = rateFromRules(rules, name);
    const said = hasSaid ? rateFromSummary(name === 'buy' ? s?.buys : s?.sells) : null;
    // A reading with rules but none on this side takes nothing on it; one with neither rules nor summary says its total on both.
    const whole: SideRate = !hasSaid && rules.length === 0 && total ? { bps: total.bps, upTo: RATE_VARIES.test(total.text ?? '') } : null;
    const base: SideRate = ruled ?? said ?? (!hasSaid && rules.length > 0 ? NOTHING : whole);
    if (cap <= 0) return base;
    if (name === 'buy' && cap <= HOOK_QUOTE_CUT_FLOOR_BPS && base !== null && base.bps === 0) return base;
    if (base === null) return { bps: cap, upTo: true };
    if (base.bps === null) return tokens ? base : { bps: cap, upTo: true };
    if (!tokens) return { bps: cap, upTo: base.upTo || base.bps !== cap };
    return cap > base.bps ? { bps: cap, upTo: true } : base;
  };
  return { buy: side('buy'), sell: side('sell') };
}
